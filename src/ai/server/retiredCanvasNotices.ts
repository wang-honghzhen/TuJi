import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { AppSnapshot } from '../domain';
import { hash, Repository } from './repository';

// This is an upgrade reader only. Active notification types no longer include canvas edits.
type LegacyRow = Record<string, any>;
const removed = Symbol('removed');
const row = (value: unknown): value is LegacyRow => !!value && typeof value === 'object' && !Array.isArray(value);
const parsed = (value: string): unknown => { try { return JSON.parse(value); } catch { return undefined; } };
const legacyEntry = (entry: LegacyRow) => !!entry.userCanvasEdit || entry.contextUpdate?.kind === 'canvas'
  || /^(user-canvas-edit:|user-edit-deferred:)/.test(entry.id ?? '');

/** Remove application-owned notice records, never search/replace ordinary authored prose. */
export function purgeRetiredCanvasNotices(state: AppSnapshot): boolean {
  const before = JSON.stringify(state);
  const workspaces = state.workspaces as LegacyRow[], snapshots = state.snapshots as LegacyRow[];
  const containers = [...workspaces, ...snapshots], retired = new Set<string>();
  const discover = (value: unknown, recordId?: string): void => {
    if (typeof value === 'string') { const data=parsed(value); if(data!==undefined)discover(data,recordId); return; }
    if (Array.isArray(value)) { value.forEach(item=>discover(item,recordId)); return; }
    if (!row(value)) return;
    const id=typeof value.recordId==='string'?value.recordId:recordId;
    if((value.user_edit?.kind==='canvas_edit'||value.kind==='canvas_edit')&&(id||typeof value.id==='string'))retired.add(id??value.id);
    for(const [key,item] of Object.entries(value)) {
      // Authored message text/arguments are not executable archive wrappers.
      if(['text','arguments'].includes(key))continue;
      if(typeof item!=='string'||['content','result','serializedResult'].includes(key))discover(item,id);
    }
  };
  for (const container of containers) {
    for (const notice of [...container.taskNotices ?? [], ...container.pendingTaskNotices?.changes ?? []])
      if (notice.kind === 'canvas_edit') retired.add(notice.id);
    for (const stage of [container.contextStage, container.promptFork?.stage])
      for (const entry of stage?.entries ?? []) {
        if (legacyEntry(entry)) retired.add(entry.id);
        discover(entry.messages,entry.noticeId);discover(entry.wireMessages,entry.noticeId);
      }
    for(const read of container.frozenReads??[])discover(read.pages);
    for(const call of container.toolCalls??[])if(/^context_(read_|restore_)/.test(call.name))discover(call.result);
  }
  for(const call of state.toolCalls)if(/^context_(read_|restore_)/.test(call.name))discover(call.result);
  for(const manifest of state.contextManifests){manifest.items.forEach(item=>discover(item.text));discover(manifest.messages);}
  const isRetired = (value: unknown) => typeof value === 'string' && retired.has(value);
  const referenceKeys = new Set(['id', 'callId', 'recordId', 'noticeId', 'summaryId', 'rootId', 'parentId', 'entryId', 'pointerId']);
  const references = (value: unknown, recordId?: string): boolean => {
    if (typeof value === 'string') { const data = parsed(value); return data !== undefined && references(data,recordId); }
    if (Array.isArray(value)) return value.some(item => isRetired(item) || references(item,recordId));
    if (!row(value)) return false;
    const id=typeof value.recordId==='string'?value.recordId:recordId;
    if (((value.user_edit?.kind === 'canvas_edit' || value.kind === 'canvas_edit')&&(id||typeof value.id==='string')) || legacyEntry(value)) return true;
    return Object.entries(value).some(([key, item]) => !['text','arguments'].includes(key)
      && (referenceKeys.has(key) && isRetired(item) || references(item,id)));
  };
  const scrub = (value: unknown): unknown | typeof removed => {
    if (Array.isArray(value)) return value.map(scrub).filter(item => item !== removed);
    if (!row(value)) return value;
    if (value.user_edit?.kind === 'canvas_edit' || value.kind === 'canvas_edit'
      || [...referenceKeys].some(key => isRetired(value[key]))) return removed;
    const result: LegacyRow = {};
    for (const [key, item] of Object.entries(value)) {
      // Only execution/archive envelopes contain encoded record bodies.
      if (typeof item === 'string' && ['content', 'result', 'serializedResult', 'receipt'].includes(key)) {
        const decoded = parsed(item);
        if (decoded !== undefined && references(decoded)) {
          const clean = scrub(decoded);
          if (clean !== removed) result[key] = JSON.stringify(clean);
          continue;
        }
      }
      const clean = scrub(item); if (clean !== removed) result[key] = clean;
    }
    return result;
  };
  const unavailable = JSON.stringify({ status: 'unavailable', code: 'RETIRED_CONTEXT_RECORD', message: '此历史读取包含已移除的画布改动通知，请按需读取仍可用的任务原始记录。' });
  const calls = [...state.toolCalls, ...snapshots.flatMap(s => s.toolCalls ?? [])] as LegacyRow[];
  const summaries = containers.flatMap(c => c.summaries ?? []) as LegacyRow[];
  const changedCalls = new Set<string>();
  // A restored record can itself have been summarized or restored by a later call.
  let expanded: boolean;
  do {
    const size = retired.size;
    for (const summary of summaries) if (references([summary.coverage, summary.children, summary.sourceRefs])) retired.add(summary.id);
    for (const call of calls) {
      if (!/^context_(read_|restore_)/.test(call.name)) continue;
      if (!references([call.result, call.readPageOrigins, call.summaryOrigins, call.resultSources])) continue;
      if (changedCalls.has(call.id)) continue;
      changedCalls.add(call.id); retired.add(call.id);
    }
    for (const workspace of workspaces) for (const read of workspace.frozenReads ?? [])
      if (references([read.pages, read.pageCoverage, read.originResultIds, read.summaryOrigin, read.recordDirectory]) || isRetired(read.callId)) retired.add(read.id);
    expanded = retired.size !== size;
  } while (expanded);
  const hasLegacy = retired.size > 0 || workspaces.some(w => w.canvasEdits || w.contextStage?.canvasEditBatch || w.promptFork?.stage?.canvasEditBatch);
  if (!hasLegacy) return false;

  for (const call of calls) if (changedCalls.has(call.id)) {
    const data = parsed(call.result ?? '');
    const clean = data === undefined ? removed : scrub(data);
    const result=clean===removed?undefined:JSON.stringify(clean);
    // Fragmented archive pages may have no record envelope to edit safely.
    call.result = result===undefined||references(clean)||result===call.result&&references([call.readPageOrigins,call.summaryOrigins,call.resultSources]) ? unavailable : result;
    delete call.readPageOrigins; delete call.summaryOrigins; delete call.readPageRefs;
    delete call.resultReadHashes; delete call.canvasOrigins; delete call.resultSources;
    delete call.resultImages; delete call.firstDelivery;
  }
  for (const container of containers) {
    if (container.taskNotices) container.taskNotices = container.taskNotices.filter((n: LegacyRow) => n.kind !== 'canvas_edit');
    const pending = container.pendingTaskNotices;
    if (pending?.changes.some((n: LegacyRow) => n.kind === 'canvas_edit')) {
      pending.changes = pending.changes.filter((n: LegacyRow) => n.kind !== 'canvas_edit'); pending.revision++;
    }
    const affectedTasks = new Set<string>((container.summaries ?? []).filter((s: LegacyRow) => retired.has(s.id)).flatMap((s: LegacyRow) => s.coverage.map((c: LegacyRow) => c.taskId)));
    if (container.summaries) container.summaries = container.summaries.filter((s: LegacyRow) => !retired.has(s.id));
    const context = container.sessionContext;
    if (context) {
      context.receiptedNoticeIds = (context.receiptedNoticeIds ?? []).filter((id: string) => !retired.has(id));
      delete context.settled;
      for (const taskId of affectedTasks) { delete context.historicalSummaryCounts?.[taskId]; delete context.countedSummaryRounds?.[taskId]; }
    }
    delete container.canvasEdits;
    const stage = container.contextStage;
    if (stage) {
      stage.entries = stage.entries.filter((e: LegacyRow) => !legacyEntry(e) && !references(e));
      const entries = new Set(stage.entries.map((e: LegacyRow) => e.id));
      stage.eventIds = (stage.eventIds ?? []).filter((id: string) => entries.has(id));
      stage.baselineObservations = (stage.baselineObservations ?? []).filter((o: LegacyRow) => !references(o) && (!o.entryId || entries.has(o.entryId)));
      stage.receiptedNoticeIds = (stage.receiptedNoticeIds ?? []).filter((id: string) => !retired.has(id));
      for (const key of ['canvasEditBatch', 'taskNoticeBatch', 'lastRequest', 'retentionDraft', 'pendingNoticeAttempt', 'summaryRegions', 'frozenReadDrafts', 'compactionAttempt']) delete stage[key];
      stage.recoveryRequired = true;
    }
    delete container.promptFork; delete container.noticeMaintenanceAttempt;
    if (container.frozenReads) container.frozenReads = container.frozenReads.filter((r: LegacyRow) => !retired.has(r.id));
    if (container.readRetention) for (const ledger of [container.readRetention.receipts, container.readRetention.writeReceipts])
      if (ledger) for (const id of Object.keys(ledger)) if (retired.has(id) || references(ledger[id])) delete ledger[id];
  }
  for (const ledger of [state.contextRetention?.receipts, state.contextRetention?.writeReceipts])
    if (ledger) for (const id of Object.keys(ledger)) if (retired.has(id) || references(ledger[id])) delete ledger[id];
  for (const message of [...state.messages, ...snapshots.flatMap(s => s.messages ?? [])] as LegacyRow[]) {
    // Explicitly attached task progress is structured data; message.text stays intact.
    if (message.selectedProgress) message.selectedProgress = scrub(message.selectedProgress);
    if (message.progressSelection) message.progressSelection = message.progressSelection.map((s: LegacyRow) => ({ ...s, recordIds: s.recordIds?.filter((id: string) => !retired.has(id)) }));
  }
  for (const task of state.tasks) { delete task.checkpoint; delete task.responseReadHashes; }
  for (const manifest of state.contextManifests) {
    manifest.items = manifest.items.filter(item => !item.derivedFrom.some(id => retired.has(id)) && !references(item.text));
    manifest.messages = []; delete manifest.stageDraft;
    manifest.canvasChecks = manifest.canvasChecks?.filter(o => !references(o));
  }
  for (const part of state.presentationParts ?? []) if (part.calls) part.calls = part.calls.map(call =>
    changedCalls.has(call.id) ? structuredClone(state.toolCalls.find(c => c.id === call.id) ?? call) : call);
  for (const snapshot of snapshots) snapshot.contentHash = hash({ ...snapshot, contentHash: undefined });
  return before !== JSON.stringify(state);
}

/** Back up committed application data before the single atomic upgrade transaction. */
export function migrateRetiredCanvasNotices(repo: Repository): void {
  const candidate = structuredClone(repo.state);
  if (!purgeRetiredCanvasNotices(candidate)) return;
  if (repo.location !== ':memory:') {
    const directory = path.join(path.dirname(path.resolve(repo.location)), 'migration-backups');
    mkdirSync(directory, { recursive: true });
    const backup = { format: 'qixue-canvas-notice-retirement-v1', createdAt: new Date().toISOString(), data: repo.state, checksum: hash(repo.state) };
    const file = path.join(directory, `canvas-notices-${backup.checksum}.json`);
    if (!existsSync(file)) writeFileSync(file, JSON.stringify(backup), { flag: 'wx', mode: 0o600 });
    else {
      const saved=JSON.parse(readFileSync(file,'utf8'));
      if(saved.checksum!==backup.checksum||hash(saved.data)!==backup.checksum)throw new Error('画布通知迁移备份校验失败，原始数据未修改');
    }
  }
  repo.transaction(state => Object.assign(state, candidate));
}
