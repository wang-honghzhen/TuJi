import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const CONTEXT_STORAGE_VERSION = 3;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function databaseFingerprint(db: DatabaseSync) {
  return digest([db.prepare("SELECT key,body FROM metadata WHERE key!='runtime_owner' ORDER BY key").all(),
    db.prepare('SELECT kind,id,body FROM records ORDER BY kind,id').all()]);
}
function inventory(directory: string): Array<{ path: string; bytes: number; sha256: string }> {
  if (!existsSync(directory)) return [];
  const files: Array<{ path: string; bytes: number; sha256: string }> = [];
  const visit = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const target = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) files.push({ path: path.relative(directory, target), bytes: statSync(target).size,
        sha256: createHash('sha256').update(readFileSync(target)).digest('hex') });
    }
  };
  visit(directory); return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** A one-time backed-up reset. Old conversation protocols are never loaded into the runtime. */
export function installContextStorage(db: DatabaseSync, location: string, artifactDirectory = path.join(path.dirname(location), 'artifacts')) {
  const version = db.prepare("SELECT body FROM metadata WHERE key='schemaVersion'").get();
  const installed=version?Number(JSON.parse(String(version.body))):0;
  if(installed===CONTEXT_STORAGE_VERSION)return {changed:false};
  if(installed>CONTEXT_STORAGE_VERSION)throw new Error('数据库来自更新版本，拒绝重置；请使用对应应用版本。');
  const hasData = Boolean(db.prepare('SELECT 1 FROM records LIMIT 1').get()
    || db.prepare("SELECT 1 FROM metadata WHERE key NOT IN ('runtime_owner','schemaVersion') LIMIT 1").get());
  let backupPath: string | undefined;
  const original = databaseFingerprint(db);
  if (hasData && location !== ':memory:') {
    const directory = path.join(path.dirname(location), 'backups', `context-v3-${Date.now()}-${randomUUID().slice(0, 8)}`);
    mkdirSync(directory, { recursive: true });
    backupPath = path.join(directory, 'previous.sqlite');
    // VACUUM INTO includes committed WAL data and creates a standalone restore image.
    db.prepare('VACUUM INTO ?').run(backupPath);
    const restored = new DatabaseSync(backupPath, { readOnly: true });
    try {
      if (restored.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' || databaseFingerprint(restored) !== original)
        throw new Error('上下文切换备份校验失败；保留旧数据库，未执行重置。');
    } finally { restored.close(); }
    writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ format: 'qixue-context-reset-backup-v3', createdAt: new Date().toISOString(),
      database: 'previous.sqlite', fingerprint: original, artifactDirectory: path.resolve(artifactDirectory), files: inventory(artifactDirectory),
      restore: '停止服务；将 previous.sqlite 复制回原数据库路径，移走同名 -wal/-shm，并使用备份时的旧应用。附件文件按清单保留。' }, null, 2));
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    if (databaseFingerprint(db) !== original) throw new Error('备份后数据库发生变化，未执行上下文切换。');
    const meta = new Map(db.prepare('SELECT key,body FROM metadata').all().map(row => [String(row.key), JSON.parse(String(row.body))]));
    const records = db.prepare("SELECT kind,id,body FROM records WHERE kind IN ('reviewChanges','changes','artifacts','userNotePages')").all().map(row => ({ kind: String(row.kind), id: String(row.id), body: JSON.parse(String(row.body)) }));
    const put = db.prepare('INSERT INTO records(kind,id,body) VALUES(?,?,?)');
    const setMeta = db.prepare('INSERT INTO metadata(key,body) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body');
    db.exec('DELETE FROM records');
    // Review data has a separate collection: it can support undo, never become inherited memory.
    for (const record of records) if (record.kind === 'reviewChanges' || record.kind === 'changes' && record.body.status !== 'proposed')
      put.run('reviewChanges', record.id, JSON.stringify(record.body));
    for (const record of records) if (record.kind === 'artifacts' || record.kind === 'userNotePages') put.run(record.kind, record.id, JSON.stringify(record.body));
    const graph = meta.get('graph') as { canvases?: Array<{ canvasId: string; mode?: string }> } | null;
    const createdAt = new Date().toISOString();
    for (const canvas of graph?.canvases ?? []) {
      if (canvas.mode === 'temporary') continue;
      const sessionId = `session:${randomUUID()}`, workspaceId = `workspace:${randomUUID()}`;
      put.run('sessions', sessionId, JSON.stringify({ id: sessionId, workspaceId, canvasId: canvas.canvasId, mode: canvas.mode ?? 'explore',
        title: '新建会话（发送第一条消息后改名）', titleSource: 'pending', lifecycle: 'active', createdAt }));
      put.run('workspaces', workspaceId, JSON.stringify({ id: workspaceId, sessionId, workNotes: [], pinnedNotes: [], snapshotIds: [], artifactIds: [],
        sessionContext: { version: 3, taskOrder: [], residentTaskIds: [], excludedTaskIds: [], historicalSummaryCounts: {},
          settled: { revision: 1, taskIds: [], at: createdAt } } }));
    }
    const keep = new Set(['runtime_owner', 'graph', 'graphRevision', 'directoryVersions', 'canvasGraphReferences', 'canvasReviewStates',
      'provider', 'soundSettings', 'personalizationSettings', 'setupCompleted']);
    for (const key of meta.keys()) if (!keep.has(key)) db.prepare('DELETE FROM metadata WHERE key=?').run(key);
    // Canvas identities survive the reset; extend their counters for the v3
    // session/task reference kinds without reallocating any existing identity.
    const references=meta.get('canvasGraphReferences') as Record<string,{next:Record<string,number>}>|undefined;
    if(references){for(const table of Object.values(references))table.next={...table.next,h:table.next.h??1,k:table.next.k??1};
      setMeta.run('canvasGraphReferences',JSON.stringify(references));}
    for (const [key, value] of Object.entries({ schemaVersion: CONTEXT_STORAGE_VERSION, canvasVersionProtocol: { version: 1 }, sessionReferences: {}, lastSeq: 0,
      contextStorageReset: { version: 3, completedAt: createdAt, backupPath: backupPath ?? null, previousFingerprint: original } })) setMeta.run(key, JSON.stringify(value));
    db.exec('COMMIT');
    return { changed: hasData, backupPath };
  } catch (cause) { db.exec('ROLLBACK'); throw cause; }
}
