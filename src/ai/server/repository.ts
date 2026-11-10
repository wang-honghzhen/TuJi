import { updateDirectoryVersions } from './directGraph';
import { bindSubgraphVersions } from './subgraphVersions';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_SOUND_SETTINGS } from '@/shared/soundSettings';
import { DEFAULT_PERSONALIZATION, normalizePersonalizationSettings } from '@/shared/canvasBackgrounds';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AppSnapshot, ContextManifest, WorkspaceEvent } from '../domain';
import { DEFAULT_PROVIDER } from '../domain';
import { DEFAULT_CONTEXT_PRESET } from '../contextCapacity';
import { capturePresentation } from './presentationLog';
import { installContextStorage } from './storageV3';

const collections = ['sessions', 'workspaces', 'inheritanceEdges', 'snapshots', 'tasks', 'messages', 'steps',
  'changes', 'reviewChanges', 'toolCalls', 'artifacts', 'contextManifests', 'events', 'presentationParts', 'userNotePages', 'chatTurnBookmarks'] as const;
export const now = () => new Date().toISOString();
export const id = (prefix = '') => prefix + randomUUID();
export const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
/** A durable manifest is an index of what a request contained, not a copy of the prompt.
 *  The rendered messages are rebuilt on demand, provider-private continuation must never be
 *  written to disk, and the item bodies are the largest records in the database. */
const MANIFEST_ITEM_TEXT_LIMIT = 600;
export function storableManifest(manifest: ContextManifest): ContextManifest {
  const {stageDraft:_stage,...publicManifest}=manifest;
  return { ...publicManifest, messages: [],
    items: manifest.items.map(item => {
      let text = item.text;
      if (item.category === 'current_protocol') {
        try { const value: unknown = JSON.parse(text);
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            const record = value as Record<string, unknown>; delete record.responseItems; delete record.reasoningContent; text = JSON.stringify(record);
          }
        } catch { /* Non-protocol source remains visible. */ }
      }
      return { ...item, text: text.length > MANIFEST_ITEM_TEXT_LIMIT
        ? `${text.slice(0, MANIFEST_ITEM_TEXT_LIMIT)}…[仅保留前 ${MANIFEST_ITEM_TEXT_LIMIT} 字符，原 ${text.length} 字符]` : text };
    }) };
}
export function emptyState(): AppSnapshot {
  return { schemaVersion: 3, canvasVersionProtocol:{version:1},graph: null, graphRevision: 0, canvasGraphReferences: {}, sessionReferences: {}, sessions: [], workspaces: [], inheritanceEdges: [], snapshots: [],
    tasks: [], messages: [], steps: [], changes: [], reviewChanges: [], toolCalls: [], artifacts: [], contextManifests: [], events: [], presentationParts: [], userNotePages: [], chatTurnBookmarks: [],
    provider: { ...DEFAULT_PROVIDER }, soundSettings: { ...DEFAULT_SOUND_SETTINGS }, personalizationSettings: { ...DEFAULT_PERSONALIZATION }, credentialConfigured: false, setupCompleted: false, lastSeq: 0 };
}

/** What one committed transaction changed: the UI applies this instead of a whole new snapshot. */
export interface RepositoryUpdate {
  lastSeq: number;
  records: Array<{ collection: typeof collections[number]; id: string; record?: unknown }>;
  meta: Record<string, unknown>;
}
export interface Repository {
  subscribe(listener: (update: RepositoryUpdate) => void): () => void;
}/** Values the renderer may receive: provider continuation and private reasoning never leave here. */
export function publicRecord(collection: string, record: unknown): unknown {
  // A missing record is a deletion marker. Preserve it so JSON omits the body
  // and the renderer removes the row instead of trying to redact its fields.
  if (record === undefined) return undefined;
  if(collection==='artifacts'){const a=record as import('../domain').Artifact;return {...a,chunkCount:a.chunks.length,chunks:[]};}
  if(collection==='snapshots'){const copy=structuredClone(record) as import('../domain').MemorySnapshot;copy.artifacts=copy.artifacts?.map(a=>({...a,chunkCount:a.chunks.length,chunks:[]}));return copy;}
  if (collection === 'workspaces') { const copy=structuredClone(record) as Record<string,unknown>; delete copy.promptFork; delete copy.readRetention; delete copy.minimalWebReads; delete copy.frozenReads; const stage=copy.contextStage as Record<string,unknown>|undefined; if(stage){delete stage.entries;delete stage.lastRequest;delete stage.frozenReadDrafts;} return copy; }
  if (collection !== 'tasks' && collection !== 'contextManifests') return record;
  const copy = structuredClone(record) as Record<string, unknown>;
  if (collection === 'tasks') { delete copy.responseReadHashes; const checkpoint = copy.checkpoint as { protocol?: unknown } | undefined; if (checkpoint) checkpoint.protocol = []; }
  return copy;
}
/** Graph data, receipts, checkpoints and events share one SQLite commit boundary. */
export class Repository {
  readonly db: DatabaseSync;
  state: AppSnapshot;
  private listeners = new Set<(update: RepositoryUpdate) => void>();
  private inTransaction = false;
  private stored = new Map<string, string>();
  credential = '';
  /** Private host-only connection; excluded from state, exports, and event payloads. */
  summaryConnection?: { provider: import('../domain').ProviderConfig; credential?: string };
  webConnection?: import('./webTools').WebConnection;
  artifactDirectory?: string;
  private readonly ownerToken = randomUUID();
  private closed = false;
  /** Where this state lives, so a caller can copy it for an offline look at durable data. */
  readonly location: string;
  constructor(path: string, options: { artifactDirectory?: string } = {}) {
    this.artifactDirectory = options.artifactDirectory;
    this.location = path;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id));');
    // A process-local state cache has exactly one writer. Claim ownership under
    // SQLite's lock, so a second desktop/browser service cannot lose updates.
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const row = this.db.prepare("SELECT body FROM metadata WHERE key='runtime_owner'").get();
      if (row) {
        const owner = JSON.parse(String(row.body)) as { pid: number };
        let alive = true;
        try { process.kill(owner.pid, 0); } catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
        if (alive) throw new Error('此数据目录已有本地服务在运行，请连接现有服务或使用另一数据目录。');
      }
      this.db.prepare("INSERT INTO metadata(key,body) VALUES('runtime_owner',?) ON CONFLICT(key) DO UPDATE SET body=excluded.body").run(JSON.stringify({ pid: process.pid, token: this.ownerToken }));
      this.db.exec('COMMIT');
    } catch (cause) { try { this.db.exec('ROLLBACK'); } catch { /* Claim may not have begun. */ } this.db.close(); throw cause; }
    try { installContextStorage(this.db, path, options.artifactDirectory); } catch (cause) {
      this.db.prepare("DELETE FROM metadata WHERE key='runtime_owner' AND json_extract(body,'$.token')=?").run(this.ownerToken);this.db.close();throw cause;
    }
    this.state = emptyState();
    for (const row of this.db.prepare('SELECT key,body FROM metadata').all()) {
      const key = String(row.key); this.stored.set(`meta:${key}`, String(row.body));
      if (['schemaVersion', 'canvasVersionProtocol', 'graph', 'graphRevision', 'directoryVersions', 'canvasGraphReferences', 'canvasReviewStates', 'sessionReferences', 'contextRetention', 'provider', 'attachmentLimits', 'soundSettings', 'personalizationSettings', 'setupCompleted', 'lastSeq'].includes(key)) (this.state as unknown as Record<string, unknown>)[key] = JSON.parse(String(row.body));
    }
    this.state.personalizationSettings = normalizePersonalizationSettings(this.state.personalizationSettings);
    // Existing configured profiles retain their setup; a former empty default receives DeepSeek defaults.
    if (!this.stored.has('meta:setupCompleted')) {
      this.state.setupCompleted = this.stored.has('meta:provider') && Boolean(this.state.provider.model);
      if (!this.state.provider.model) this.state.provider = { ...DEFAULT_PROVIDER };
    }
    for (const row of this.db.prepare('SELECT kind,id,body FROM records ORDER BY rowid').all()) {
      const kind = String(row.kind) as typeof collections[number];
      if (!collections.includes(kind)) continue;
      (this.state[kind] as unknown[]).push(JSON.parse(String(row.body)));
      this.stored.set(`${kind}:${String(row.id)}`, String(row.body));
    }
    bindSubgraphVersions(this.state.graph, this.state.directoryVersions);
    if(!this.stored.has('meta:canvasVersionProtocol')&&(this.state.tasks.length||this.state.messages.length||this.state.snapshots.length||this.state.workspaces.some(w=>w.contextStage||w.summaries?.length)))delete this.state.canvasVersionProtocol;
    // Only profiles saved before presets existed migrate. Later user choices survive restart.
    if (this.state.provider.contextPresetTokens === undefined) {
      try { this.transaction(state => { state.provider.contextPresetTokens = DEFAULT_CONTEXT_PRESET; }); }
      catch (cause) { try { this.close(); } catch { /* Preserve the migration failure. */ } throw cause; }
    }
  }
  subscribe(listener: (update: RepositoryUpdate) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  transaction<T>(action: (state: AppSnapshot) => T): T {
    if (this.inTransaction) return action(this.state);
    const before = structuredClone(this.state);
    bindSubgraphVersions(before.graph, before.directoryVersions);
    const priorStored = new Map(this.stored);
    const written = new Map<string, { collection: typeof collections[number]; id: string; record?: unknown }>();
    const meta = new Map<string, unknown>();
    this.inTransaction = true;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const result = action(this.state);
      updateDirectoryVersions(before,this.state);
      capturePresentation(before,this.state);
      const putMeta = this.db.prepare('INSERT INTO metadata(key,body) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body');
      for (const key of ['schemaVersion', 'canvasVersionProtocol', 'graph', 'graphRevision', 'directoryVersions', 'canvasGraphReferences', 'canvasReviewStates', 'sessionReferences', 'contextRetention', 'provider', 'attachmentLimits', 'soundSettings', 'personalizationSettings', 'setupCompleted', 'lastSeq'] as const) {
        const body = JSON.stringify(this.state[key] ?? (key === 'soundSettings' ? DEFAULT_SOUND_SETTINGS : null));
        if (body !== this.stored.get(`meta:${key}`)) { putMeta.run(key, body); this.stored.set(`meta:${key}`, body); meta.set(key, this.state[key]); }
      }
      const put = this.db.prepare('INSERT INTO records(kind,id,body) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body');
      const remove = this.db.prepare('DELETE FROM records WHERE kind=? AND id=?');
      // Group once instead of copying and scanning the entire cache for every collection.
      const storedKeysByKind = new Map<string, string[]>();
      for (const key of this.stored.keys()) {
        const kind = key.slice(0, key.indexOf(':'));
        if (kind === 'meta') continue;
        const keys = storedKeysByKind.get(kind);
        if (keys) keys.push(key); else storedKeysByKind.set(kind, [key]);
      }
      for (const kind of collections) {
        const present = new Set<string>();
        for (const record of this.state[kind] ?? []) {
          const key = `${kind}:${record.id}`; present.add(key);
          const body = JSON.stringify(record);
          if (body !== this.stored.get(key)) { put.run(kind, record.id, body); this.stored.set(key, body); written.set(key, { collection: kind, id: record.id, record }); }
        }
        for (const key of storedKeysByKind.get(kind) ?? []) if (!present.has(key)) {
          const id = key.slice(kind.length + 1);
          remove.run(kind, id); this.stored.delete(key); written.set(key, { collection: kind, id });
        }
      }
      this.db.exec('COMMIT');
      this.inTransaction = false;
      // Notifications never precede the durable commit, and listener failure cannot undo it.
      const update: RepositoryUpdate = { lastSeq: this.state.lastSeq, records: [...written.values()], meta: Object.fromEntries(meta) };
      for (const listener of this.listeners) { try { listener(update); } catch { /* UI reconnects from durable seq. */ } }
      return result;
    } catch (cause) {
      try { this.db.exec('ROLLBACK'); } catch { /* BEGIN may have failed. */ }
      this.state = before; bindSubgraphVersions(this.state.graph, this.state.directoryVersions);
      this.stored = priorStored; this.inTransaction = false; throw cause;
    }
  }
  event(workspaceId: string, type: string, payload: Record<string, unknown> = {}, taskId?: string, stepId?: string): WorkspaceEvent {
    if (!this.inTransaction) throw new Error('Events must be appended inside the state transaction');
    const seq = 1 + this.state.events.reduce((n, e) => e.workspaceId === workspaceId ? Math.max(n, e.seq) : n, 0);
    const event = { id: id('event:'), seq, globalSeq: ++this.state.lastSeq, workspaceId, taskId, stepId, type, payload, createdAt: now() };
    this.state.events.push(event); return event;
  }
  publicSnapshot(includeArtifactBodies=false): AppSnapshot {
    const state = structuredClone(this.state); state.credentialConfigured = Boolean(this.credential);
    for (const task of state.tasks) { if (task.checkpoint) task.checkpoint.protocol = []; }
    for (const manifest of state.contextManifests) for (const message of manifest.messages) { delete message.responseItems; delete message.reasoningContent; }
    for(const w of state.workspaces) {delete w.promptFork;delete w.readRetention;delete w.minimalWebReads;delete w.frozenReads; if(w.contextStage){w.contextStage.entries=[];delete w.contextStage.lastRequest;delete w.contextStage.frozenReadDrafts;}}
    if(!includeArtifactBodies){state.artifacts=state.artifacts.map(a=>publicRecord('artifacts',a) as import('../domain').Artifact);state.snapshots=state.snapshots.map(s=>publicRecord('snapshots',s) as import('../domain').MemorySnapshot);}
    return state;
  }
  close() {
    if (this.closed) return;
    try {
      this.db.prepare("DELETE FROM metadata WHERE key='runtime_owner' AND json_extract(body,'$.token')=?").run(this.ownerToken);
    } finally {
      this.db.close(); this.closed = true;
    }
  }
}
