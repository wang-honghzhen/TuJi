import type { AppSnapshot, ChangeSet, Task, ToolCallRecord } from '../domain';
import type { ReviewAction, ReviewDelta, ReviewGhost, ReviewPreview, ReviewUnit } from '../reviewTypes';
import type { GraphState } from '@/v3/types';
import { buildRenderModel } from '@/v3/layout';
import { normalizeStructureSelection } from '@/v3/structure';
import { getCanvasPaths } from '@/v3/paths';
import { normalizedGraph, graphDiff, memberIds } from './graph';
import { hash, id, now } from './repository';
import { requireValue } from './errors';
import { allReviewChanges, reviewEntries, reviewGroups, reviewUnitRefs } from '../changeReview';

const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const memberships = new Set(['childIds', 'childNodeIds', 'childDocumentIds', 'memberIds', 'subjectIds', 'nodeReferenceIds', 'excludedDocumentIds']);
const ignored = new Set(['rev', 'updatedAt', 'collapsed']);
function semantic(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semantic);
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => !ignored.has(k) && k !== 'placements').map(([k, v]) => [k, semantic(v)]));
}
const same = (a: unknown, b: unknown) => hash(a === undefined ? null : a) === hash(b === undefined ? null : b);
const comparable = (d: ReviewDelta, a: unknown, b: unknown) => same(d.layout ? a : semantic(a), d.layout ? b : semantic(b));

/** Membership edits are individual entries, never whole-list snapshots. */
export function reviewDeltas(before: GraphState, after: GraphState): ReviewDelta[] {
  const result: ReviewDelta[] = [];
  for (const patch of graphDiff(before, after)) {
    const walk = (a: unknown, b: unknown, path: string[]) => {
      if (same(a, b) || ignored.has(path.at(-1) ?? '')) return;
      const base = { collection: patch.collection, id: patch.id, path };
      if (path.includes('placements')) {
        if (path.at(-1) === 'placements') {
          for (const key of new Set([...Object.keys(object(a) ? a : {}), ...Object.keys(object(b) ? b : {})]))
            walk(object(a) ? a[key] : undefined, object(b) ? b[key] : undefined, [...path, key]);
        } else result.push({ ...base, before: a, after: b, layout: true });
      } else if (memberships.has(path.at(-1) ?? '') && (a === undefined || Array.isArray(a)) && (b === undefined || Array.isArray(b))) {
        const old = (a ?? []) as string[], next = (b ?? []) as string[];
        for (const member of new Set([...old, ...next])) if (old.includes(member) !== next.includes(member))
          result.push({ ...base, member, before: old.includes(member), after: next.includes(member), beforeIndex: old.indexOf(member) });
      } else if (object(a) && object(b)) {
        for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[key], b[key], [...path, key]);
      } else result.push({ ...base, before: a, after: b });
    };
    walk(patch.before ?? undefined, patch.after ?? undefined, []);
  }
  return result;
}
function identity(d: ReviewDelta): string | undefined {
  if (!d.path.length && d.collection !== 'canvases') return d.id;
  if (d.collection === 'canvases' && d.path[0] === 'directories' && d.path.length === 2) return d.path[1];
  return undefined;
}
export function overlap(a: ReviewDelta, b: ReviewDelta): boolean {
  if (a.collection !== b.collection || a.id !== b.id || a.layout || b.layout) return false;
  const length = Math.min(a.path.length, b.path.length);
  if (a.path.slice(0, length).some((part, i) => part !== b.path[i])) return false;
  return a.path.length !== b.path.length || a.member === undefined || b.member === undefined || a.member === b.member;
}
function references(command: Record<string, unknown>): string[] {
  const found: string[] = [];
  const visit = (x: unknown, key = '') => {
    if (typeof x === 'string' && /^(id|parentId|nodeId|sourceNodeId|targetNodeId)$/.test(key)) found.push(x);
    else if (Array.isArray(x) && /Ids$|^ids$/.test(key)) found.push(...x.filter((v): v is string => typeof v === 'string'));
    else if (object(x)) Object.entries(x).forEach(([k, v]) => visit(v, k));
  }; visit(command); return [...new Set(found)];
}
export function captureReviewUnits(before: GraphState, after: GraphState, canvasId: string,
  command: Record<string, unknown>, createdId?: string): ReviewUnit[] {
  const deltas = reviewDeltas(before, after);
  if (!deltas.some(d => !d.layout) && command.type !== 'moveBlock') return [];
  const kind = String(command.type), canvas = before.canvases.find(c => c.canvasId === canvasId)!;
  const paths = getCanvasPaths(before, canvas);
  const refs = [...new Set([...(createdId ? [createdId] : []), ...(typeof command.id === 'string' ? [command.id] : []),
    ...(Array.isArray(command.ids) ? command.ids as string[] : [])])];
  const row = paths.find(p => p.id === refs[0]);
  const name = String(command.name ?? before.nodes[refs[0]]?.name ?? before.documents[refs[0]]?.name ?? canvas.directories[refs[0]]?.name
    ?? before.edges.find(e => e.edgeId === refs[0])?.edgeContent ?? after.edges.find(e => e.edgeId === refs[0])?.edgeContent ?? '关系');
  const action = kind.startsWith('create') ? 'create' : kind.startsWith('delete') ? 'delete' : ['move', 'moveCanvasItems', 'reparentContent', 'moveBlock'].includes(kind) ? 'move' : 'update';
  const provides = deltas.filter(d => d.before === undefined && d.after !== undefined).flatMap(d => identity(d) ?? []);
  const removes = deltas.filter(d => d.after === undefined && d.before !== undefined).flatMap(d => identity(d) ?? []);
  const ghosts: ReviewGhost[] = [];
  if (removes.length) {
    for (const surface of before.canvases) {
      const members = memberIds(before, surface.canvasId);
      if (surface.canvasId !== canvasId && !removes.some(ref => members.has(ref))
        && !before.edges.some(e => removes.includes(e.edgeId) && (members.has(e.sourceNodeId) || members.has(e.targetNodeId)))) continue;
      const model = buildRenderModel(before, surface, { zoom: 1, ignoreCollapse: true });
      for (const block of model.blocks.filter(b => removes.includes(b.id))) ghosts.push({ id: block.id, canvasId: surface.canvasId, kind: block.kind === 'node' ? 'node' : 'region', name: block.name, ...block.rect });
      for (const edge of model.edges.filter(e => removes.includes(e.edge.edgeId))) ghosts.push({ id: edge.edge.edgeId, canvasId: surface.canvasId, kind: 'edge', name: edge.edge.edgeContent,
        x: edge.source.x, y: edge.source.y, width: 0, height: 0, targetX: edge.target.x, targetY: edge.target.y });
    }
  }
  const base: ReviewUnit = { id: id('review:'), kind: action, label: `${({ create: '新增', delete: '删除', move: '移动', update: '修改' })[action]} ${name}`,
    refs, parentId: typeof command.parentId === 'string' ? command.parentId : row?.parentId,
    requires: [...new Set([...references(command), ...(row?.parentId ? [row.parentId] : []), ...deltas.flatMap(d => {
      const edge = d.collection === 'edges' ? (d.after ?? d.before) : undefined;
      return object(edge) ? [edge.sourceNodeId, edge.targetNodeId].filter((v): v is string => typeof v === 'string') : [];
    })])], provides, removes, deltas, ghosts, dependencies: [], state: 'pending' };
  const fields: Record<string, string> = { name: '名称', content: '正文', edgeContent: '关系说明', directed: '关系方向', sourceNodeId: '起点', targetNodeId: '终点' };
  if (kind === 'updateNodeText' || kind === 'updateSubgraphText') base.label += ` · ${fields[String(command.field)] ?? '内容'}`;
  if (kind === 'patchNodeContent') base.label += ' · 正文';
  if (['move', 'moveCanvasItems', 'reparentContent'].includes(kind) && refs.length > 1) {
    const selected = normalizeStructureSelection(before, canvas, refs);
    const owners = new Map<string, string>();
    for (const ref of selected) {
      owners.set(ref, ref);
      for (const path of paths) if (path.segments.some(s => s.id === ref)) owners.set(path.id, ref);
    }
    const moved = selected.map(ref => {
      const related = deltas.filter(d => owners.get(d.member ?? (d.layout ? d.path.at(-1)! : identity(d) ?? d.id)) === ref);
      const row = paths.find(p => p.id === ref);
      return { ...base, id: id('review:'), refs: [ref], label: `移动 ${before.nodes[ref]?.name ?? before.documents[ref]?.name ?? canvas.directories[ref]?.name ?? ref}`,
        requires: [...new Set([ref, ...row?.parentId ? [row.parentId] : [], String(command.parentId)])], deltas: related };
    });
    // Derived sibling layout changes do not couple otherwise independent moves.
    const assigned = new Set(moved.flatMap(u => u.deltas));
    const remaining = deltas.filter(d => !assigned.has(d));
    if (remaining.every(d => d.layout)) { moved[0]?.deltas.push(...remaining); return moved.filter(u => u.deltas.length); }
  }
  // Independent edge text/direction fields can be selected separately. Design changes stay atomic with generated relations.
  if (kind === 'updateEdge' && deltas.filter(d => !d.layout).length > 1) return deltas.filter(d => !d.layout).map(d => ({ ...base,
    id: id('review:'), label: `${base.label} · ${fields[d.path.at(-1)!] ?? '关系'}`, deltas: [d] }));
  return [base];
}

function registerGroup(state: AppSnapshot, change: ChangeSet): void {
  if (change.review?.policy !== 'group') return;
  const review = change.review, window = state.canvasReviewStates![review.canvasId];
  const groups = window.groups ??= [], members = new Set([change.id]);
  let added = true;
  while (added) {
    added = false;
    const units = allReviewChanges(state).filter(c => members.has(c.id)).flatMap(c => c.review!.units);
    const refs = new Set(units.flatMap(reviewUnitRefs)), ids = new Set(units.map(u => u.id));
    for (const group of groups) {
      if (group.taskId !== change.taskId || group.state !== 'pending' || review.units.some(u => u.state !== 'pending')
        || group.changeSetIds.some(c => members.has(c))) continue;
      const prior = allReviewChanges(state).filter(c => group.changeSetIds.includes(c.id)).flatMap(c => c.review!.units);
      if (prior.some(u => reviewUnitRefs(u).some(ref => refs.has(ref)) || u.dependencies.some(dep => ids.has(dep)))
        || units.some(u => u.dependencies.some(dep => prior.some(p => p.id === dep)))) {
        group.changeSetIds.forEach(c => members.add(c)); added = true;
      }
    }
  }
  const merged = groups.filter(g => g.changeSetIds.some(c => members.has(c))).sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
  const group = merged[0] ?? { id: id('review-group:'), canvasId: review.canvasId, taskId: change.taskId,
    sequence: review.sequence!, revision: 0, state: review.units[0].state, changeSetIds: [] };
  group.changeSetIds = allReviewChanges(state).filter(c => members.has(c.id)).sort((a,b) => a.review!.sequence! - b.review!.sequence!).map(c => c.id);
  group.revision++;
  window.groups = [...groups.filter(g => !merged.includes(g)), group];
  for (const c of allReviewChanges(state)) if (members.has(c.id)) c.review!.groupId = group.id;
}
function synchronizeGroups(state: AppSnapshot): void {
  for (const group of reviewGroups(state)) {
    const units = allReviewChanges(state).filter(c => group.changeSetIds.includes(c.id)).flatMap(c => c.review!.units);
    requireValue(units.length && units.every(u => u.state === units[0].state), '审阅组不能部分决定', 'GROUP_REVIEW_REQUIRED');
    if (group.state !== units[0].state) { group.state = units[0].state; group.revision++; }
    group.source = units.find(u => u.source === 'user')?.source ?? units[0].source;
    group.decidedAt = units[0].decidedAt;
  }
}
function recordDecision(state: AppSnapshot, canvasId: string, action: ReviewAction, units: ReviewUnit[], affectedCanvasIds: string[] = []): void {
  if (!units.length) return;
  const window = state.canvasReviewStates![canvasId], ids = new Set(units.map(u => u.id));
  const entries = reviewEntries(state).filter(e => ids.has(e.unit.id));
  const changes = [...new Set(entries.map(e => e.change))];
  const decision = { id: id('review-decision:'), canvasId, revision: window.revision, action, createdAt: now(),
    groupIds: [...new Set(changes.flatMap(c => c.review?.groupId ? [c.review.groupId] : []))],
    refs: [...new Set(units.flatMap(reviewUnitRefs))],
    affectedCanvasIds: [...new Set([canvasId, ...affectedCanvasIds, ...changes.flatMap(c => c.affectedCanvasIds)])],
    changes: changes.map(c => { const selected = c.review!.units.filter(u => ids.has(u.id)); return {
      changeSetId: c.id, taskId: c.taskId, unitIds: selected.map(u => u.id),
      source: selected.find(u => u.source === 'user')?.source ?? selected[0].source ?? 'user' as const }; }) };
  (window.decisions ??= []).push(decision);
  for (const c of changes) (c.review!.decisionIds ??= []).push(decision.id);
}

/** Other canvases refresh only when their context actually used the shared data. */
export function reviewAffectedWorkspaces(state: AppSnapshot, changes: ChangeSet[], units = changes.flatMap(c => c.review?.units ?? []), onlyWorkspaceId?: string): Set<string> {
  const changeIds = new Set(changes.map(c => c.id)), origins = new Set(changes.map(c => c.review?.canvasId));
  const refs = new Set(units.flatMap(reviewUnitRefs));
  const affected = new Set<string>();
  for (const workspace of state.workspaces) {
    if (onlyWorkspaceId && workspace.id !== onlyWorkspaceId) continue;
    const session = state.sessions.find(s => s.id === workspace.sessionId);
    if (session && origins.has(session.canvasId)) { affected.add(workspace.id); continue; }
    const tasks = state.tasks.filter(t => t.workspaceId === workspace.id);
    const snapshots = state.snapshots.filter(s => workspace.snapshotIds.includes(s.id) && !s.revoked);
    const observations = [...workspace.observations ?? [], ...tasks.flatMap(t => t.responseReadHashes?.observations ?? [])];
    const read = observations.some(o => [...o.refs, ...Object.keys(o.objects ?? {}), ...o.completeDirectories].some(ref => refs.has(ref)))
      || workspace.canvasView?.knownRefs.some(ref => refs.has(ref))
      || tasks.some(t => Object.keys(t.nodeReadEvidence ?? {}).some(ref => refs.has(ref))
        || Object.keys({ ...t.readHashes, ...t.responseReadHashes?.hashes }).some(key => [...refs].some(ref => key.includes(`:${ref}`))));
    const inherited = snapshots.some(s => s.operations.some(c => changeIds.has(c.id)) || s.toolCalls?.some(c => {
      if (c.name !== 'graph_apply_changes') return false;
      try { return changeIds.has(JSON.parse(c.result ?? '{}').changeSetId); } catch { return false; }
    }));
    if (read || inherited) affected.add(workspace.id);
  }
  return affected;
}

/** The final layout pass may relocate an insertion after its semantic command. */
export function settleReviewLayout(units: ReviewUnit[], graph: GraphState): void {
  const seen = new Set<string>();
  for (const unit of [...units].reverse()) for (const d of [...unit.deltas].reverse()) if (d.layout) {
    const key = JSON.stringify([d.collection, d.id, d.path]);
    if (!seen.has(key)) { seen.add(key); d.after = structuredClone(at(record(graph, d), d.path)); }
  }
}

/** Called inside the same transaction as the successful graph write. */
export function registerReview(state: AppSnapshot, task: Task, change: ChangeSet, call: ToolCallRecord): void {
  if (!change.review?.units.length || change.review.callId) return;
  const review = change.review;
  const before = new Map([...reviewEntries(state).map(e => [e.unit.id, e.unit.state] as const), ...review.units.map(u => [u.id, u.state] as const)]);
  const windows = state.canvasReviewStates ??= {};
  const window = windows[task.canvasId] ??= { taskIds: [], revision: 0 };
  const sequence = state.graphRevision;
  const automatic: ReviewUnit[] = [];
  if (task.reviewFirstCommitSeq === undefined) {
    task.reviewFirstCommitSeq = sequence;
    window.taskIds.push(task.id);
    while (window.taskIds.length > 2) {
      const expired = window.taskIds.shift()!;
      const oldTask = state.tasks.find(t => t.id === expired); if (oldTask) oldTask.reviewWindowClosed = true;
      for (const old of allReviewChanges(state).filter(c => c.taskId === expired && c.review?.callId)) {
        let changed = false;
        for (const unit of old.review!.units) if (unit.state === 'pending') { Object.assign(unit, { state: 'approved', source: 'window', decidedAt: now() }); automatic.push(unit); changed = true; }
        if (changed) old.review!.revision++;
      }
    }
  }
  const previous = reviewEntries(state).filter(e => e.change.id !== change.id && e.unit.state !== 'reverted').map(e => e.unit);
  for (const unit of review.units) {
    unit.dependencies = previous.filter(p => p.provides.some(ref => unit.requires.includes(ref))
      || p.deltas.some(a => unit.deltas.some(b => overlap(a, b)))).map(p => p.id);
    if (task.reviewWindowClosed) { Object.assign(unit, { state: 'approved', source: 'window', decidedAt: now() }); automatic.push(unit); }
    previous.push(unit);
  }
  // An expired task's late write is final too. Its necessary local predecessors
  // must not remain deceptively selectable for rollback.
  review.callId = call.id; review.sequence = sequence; review.revision = 1;
  registerGroup(state, change);
  const byId = new Map(previous.map(u => [u.id, u]));
  const approvePrerequisites = (unit: ReviewUnit, visited = new Set<string>()) => {
    if (visited.has(unit.id)) return; visited.add(unit.id);
    for (const dependency of unit.dependencies) {
      const predecessor = byId.get(dependency);
      const owner = allReviewChanges(state).find(c => c.review?.units.some(u => u.id === dependency));
      if (!predecessor || predecessor.state !== 'pending' || owner?.review?.canvasId !== task.canvasId) continue;
      const members = owner.review.policy === 'group' ? reviewEntries(state).filter(e => e.change.review?.groupId === owner.review!.groupId).map(e => e.unit) : [predecessor];
      for (const member of members) if (member.state === 'pending') {
        Object.assign(member, { state: 'approved', source: 'dependency', decidedAt: now() });
        allReviewChanges(state).find(c => c.review?.units.includes(member))!.review!.revision++;
        approvePrerequisites(member, visited);
      }
    }
  };
  automatic.forEach(unit => approvePrerequisites(unit));
  window.revision++;
  synchronizeGroups(state);
  recordDecision(state, task.canvasId, 'approve', reviewEntries(state).filter(e => before.get(e.unit.id) === 'pending' && e.unit.state === 'approved').map(e => e.unit));
}

/** Protect human writes, including a change edited away and back (ABA). */
export function protectReviewWrites(state: AppSnapshot, before: GraphState, after: GraphState): void {
  const writes = reviewDeltas(before, after);
  const linked = after.edges.filter(e => !before.edges.some(old => old.edgeId === e.edgeId && same(old, e)))
    .flatMap(e => [e.sourceNodeId, e.targetNodeId]);
  for (const { unit } of reviewEntries(state)) if (unit.state === 'pending' && (
    unit.deltas.some(a => writes.some(b => overlap(a, b))) || unit.provides.some(ref => linked.includes(ref))
      || writes.some(d => !!identity(d) && unit.requires.includes(identity(d)!) && (d.before === undefined || d.after === undefined))
      || writes.some(d => d.layout && [...unit.provides, ...(unit.kind === 'move' ? unit.refs : [])].includes(d.path.at(-1) ?? '')
        && object(d.after) && d.after.source === 'manual' && (!object(d.before) || !same([d.before.lastManualAt, d.before.manualAnchor], [d.after.lastManualAt, d.after.manualAnchor]))))) {
    unit.blockers = [...new Set([...(unit.blockers ?? []), '相关内容已有用户后续编辑，回退会覆盖用户修改'])];
  }
}

function record(graph: GraphState, d: ReviewDelta): unknown {
  return d.collection === 'canvases' ? graph.canvases.find(c => c.canvasId === d.id)
    : d.collection === 'edges' ? graph.edges.find(e => e.edgeId === d.id) : graph[d.collection][d.id];
}
function at(value: unknown, path: string[]): unknown { for (const key of path) value = object(value) ? value[key] : undefined; return value; }
function write(graph: GraphState, d: ReviewDelta, value: unknown): void {
  if (!d.path.length) {
    if (d.collection === 'nodes' || d.collection === 'documents') {
      const entries = graph[d.collection] as Record<string, unknown>;
      if (value === undefined) delete entries[d.id]; else entries[d.id] = structuredClone(value);
    } else if (d.collection === 'edges') graph.edges = [...graph.edges.filter(e => e.edgeId !== d.id), ...(value === undefined ? [] : [structuredClone(value) as GraphState['edges'][number]])];
    else graph.canvases = [...graph.canvases.filter(c => c.canvasId !== d.id), ...(value === undefined ? [] : [structuredClone(value) as GraphState['canvases'][number]])];
    return;
  }
  const existing = record(graph, d);
  requireValue(object(existing), '恢复位置已不存在', 'REVIEW_CONFLICT');
  let target: Record<string, unknown> = existing;
  for (const key of d.path.slice(0, -1)) { if (!object(target[key])) target[key] = {}; target = target[key] as Record<string, unknown>; }
  if (value === undefined) delete target[d.path.at(-1)!]; else target[d.path.at(-1)!] = structuredClone(value);
}
function inverse(graph: GraphState, unit: ReviewUnit): void {
  for (const delta of [...unit.deltas].reverse()) {
    const current = at(record(graph, delta), delta.path);
    if (delta.member !== undefined) {
      const list = Array.isArray(current) ? current as string[] : [];
      requireValue(list.includes(delta.member) === delta.after, '目录或成员关系已有后续修改', 'REVIEW_CONFLICT');
      const next = list.filter(x => x !== delta.member);
      if (delta.before) next.splice(Math.max(0, Math.min(delta.beforeIndex ?? next.length, next.length)), 0, delta.member);
      write(graph, delta, next);
    } else {
      if (delta.layout && !comparable(delta, current, delta.after)) continue;
      requireValue(comparable(delta, current, delta.after), `${unit.label}已有后续修改`, 'REVIEW_CONFLICT');
      write(graph, delta, delta.before);
    }
  }
}

export function planReview(state: AppSnapshot, canvasId: string, selectedIds: string[], action: ReviewAction, groupIds: string[] = []): { preview: ReviewPreview; graph?: GraphState; signature: string } {
  requireValue(state.graph?.canvases.some(c => c.canvasId === canvasId), '画布不存在', 'NOT_FOUND');
  requireValue(action === 'approve' || action === 'revert', '决策动作无效');
  requireValue(selectedIds.length + groupIds.length > 0 && selectedIds.length + groupIds.length <= 10000, '请选择待决策修改');
  const entries = reviewEntries(state), byId = new Map(entries.map(e => [e.unit.id, e]));
  requireValue(selectedIds.every(uid => byId.get(uid)?.change.review?.policy !== 'group'), '新批次必须选择完整审阅组，请刷新界面', 'GROUP_REVIEW_REQUIRED');
  const groups = reviewGroups(state);
  requireValue(groupIds.every(gid => groups.some(g => g.id === gid && g.canvasId === canvasId && g.state === 'pending')), '审阅组已变化，请刷新选择', 'STALE_REVIEW');
  const selected = [...new Set([...selectedIds, ...entries.filter(e => !!e.change.review?.groupId && groupIds.includes(e.change.review.groupId)).map(e => e.unit.id)])], chosen = new Set(selected), conflicts: ReviewPreview['conflicts'] = [], reasons = new Map<string, string>();
  const conflict = (unitId: string, message: string) => { if (!conflicts.some(c => c.unitId === unitId && c.message === message)) conflicts.push({ unitId, message }); };
  const eligible = (unitId: string) => { const e = byId.get(unitId); return !!e && e.change.review!.canvasId === canvasId
    && state.canvasReviewStates?.[canvasId]?.taskIds.includes(e.change.taskId) && e.unit.state === 'pending'; };
  for (const unitId of selected) if (!eligible(unitId)) conflict(unitId, `“${byId.get(unitId)?.unit.label ?? '所选修改'}”已定案或不属于当前画布的两轮窗口`);
  const add = (unitId: string, reason: string) => {
    if (chosen.has(unitId)) return false;
    if (!eligible(unitId)) {
      const entry = byId.get(unitId), from = state.graph!.canvases.find(c => c.canvasId === entry?.change.review?.canvasId)?.canvasName;
      conflict(unitId, entry?.change.review?.canvasId !== canvasId
        ? `依赖“${entry?.unit.label ?? '未知修改'}”来自其他画布${from ? `“${from}”` : ''}，不能在此联动`
        : `依赖“${entry.unit.label}”已批准或已移出决策窗口`); return false;
    }
    chosen.add(unitId); reasons.set(unitId, reason); return true;
  };
  let graph: GraphState | undefined;
  for (let iteration = 0; iteration <= entries.length; iteration++) {
    let changed = false;
    for (const { change, unit } of entries) if (chosen.has(unit.id) && change.review?.policy === 'group') {
      for (const member of entries.filter(e => e.change.review?.groupId === change.review!.groupId))
        changed = add(member.unit.id, '同一审阅组的完整提交必须一起决定') || changed;
    }
    for (const { unit } of entries) {
      if (action === 'approve' && chosen.has(unit.id)) for (const dependency of unit.dependencies) {
        if (byId.get(dependency)?.unit.state === 'pending') changed = add(dependency, `保留“${unit.label}”需要先保留此项`) || changed;
      }
      if (action === 'revert' && unit.state !== 'reverted' && !chosen.has(unit.id) && unit.dependencies.some(d => chosen.has(d))) {
        const created = unit.dependencies.some(d => chosen.has(d) && byId.get(d)?.unit.provides.some(ref => unit.requires.includes(ref)));
        changed = add(unit.id, created ? '使用了所选修改创建的对象' : '后续修改了相同内容或成员关系') || changed;
      }
    }
    if (changed) continue;
    if (action === 'revert' && !conflicts.length) {
      graph = structuredClone(state.graph!);
      let restoring = selected[0];
      try {
        for (const { unit } of [...entries].reverse().filter(e => chosen.has(e.unit.id))) {
          restoring = unit.id;
          for (const reason of unit.blockers ?? []) conflict(unit.id, `“${unit.label}”：${reason}`);
          inverse(graph, unit);
        }
        const missing = graph.edges.flatMap(e => !e.removed ? [e.sourceNodeId, e.targetNodeId].filter(ref => !graph!.nodes[ref]) : []);
        for (const ref of new Set(missing)) {
          const removal = [...entries].reverse().find(e => e.unit.state !== 'reverted' && e.unit.removes.includes(ref));
          if (removal) changed = add(removal.unit.id, '恢复关系需要先恢复已删除的端点') || changed;
          else conflict(ref, '恢复关系所需的节点不存在');
        }
        if (changed) continue;
        if (!conflicts.length) {
          for (const patch of graphDiff(state.graph!, graph).filter(p => p.collection === 'documents')) {
            const document = graph.documents[patch.id];
            if (document) { document.rev = Math.max(document.rev, state.graph!.documents[patch.id]?.rev ?? 0) + 1; document.metadata.updatedAt = now(); }
          }
          graph = normalizedGraph(graph, state.graph!);
        }
      } catch (error) { conflict(restoring, error instanceof Error ? error.message : '图结构无法安全恢复'); }
    }
    break;
  }
  const affected = entries.filter(e => chosen.has(e.unit.id));
  const affectedCanvasIds = [...new Set([canvasId, ...affected.flatMap(e => e.change.affectedCanvasIds),
    ...state.graph!.canvases.filter(c => affected.some(e => reviewUnitRefs(e.unit).some(ref => memberIds(state.graph!, c.canvasId).has(ref)))).map(c => c.canvasId)])];
  const preview: ReviewPreview = { planToken: '', canvasId, action, selectedIds: selected, unitIds: [...chosen], conflicts,
    selectedGroupIds: [...new Set(groupIds)], groupIds: [...new Set(affected.flatMap(e => e.change.review?.groupId ? [e.change.review.groupId] : []))],
    changeSetIds: [...new Set(affected.map(e => e.change.id))], affectedRefs: [...new Set(affected.flatMap(e => reviewUnitRefs(e.unit)))],
    linked: affected.filter(e => !selected.includes(e.unit.id)).map(e => ({ id: e.unit.id, label: e.unit.label,
      reason: reasons.get(e.unit.id) ?? '恢复合法图结构所需的修改' })), affectedCanvasIds, graphRevision: state.graphRevision };
  const signature = hash([preview, allReviewChanges(state).map(c => [c.id, c.review?.revision, c.review?.units.map(u => u.blockers)]), state.canvasReviewStates]);
  return { preview, graph: conflicts.length ? undefined : graph, signature };
}

export function decideReview(state: AppSnapshot, preview: ReviewPreview, graph?: GraphState): void {
  requireValue(!preview.conflicts.length, '存在冲突，请调整选择后重试', 'REVIEW_CONFLICT', { conflicts: preview.conflicts });
  const selected = new Set(preview.selectedIds), ids = new Set(preview.unitIds), changed = new Set<ChangeSet>();
  for (const { change, unit } of reviewEntries(state)) if (ids.has(unit.id) && change.review?.policy === 'group')
    requireValue(reviewEntries(state).filter(e => e.change.review?.groupId === change.review!.groupId).every(e => ids.has(e.unit.id)), '审阅组不能部分决定', 'GROUP_REVIEW_REQUIRED');
  for (const { change, unit } of reviewEntries(state)) if (ids.has(unit.id)) {
    requireValue(unit.state === 'pending', '决定已变化，请重新预览', 'STALE_REVIEW');
    Object.assign(unit, { state: preview.action === 'approve' ? 'approved' : 'reverted', source: selected.has(unit.id) ? 'user' : 'dependency', decidedAt: now() });
    changed.add(change);
  }
  if (preview.action === 'revert') { requireValue(graph, '缺少可执行回退结果'); state.graph = graph; state.graphRevision++; }
  changed.forEach(c => c.review!.revision++);
  state.canvasReviewStates![preview.canvasId].revision++;
  synchronizeGroups(state);
  recordDecision(state, preview.canvasId, preview.action, reviewEntries(state).filter(e => ids.has(e.unit.id)).map(e => e.unit), preview.affectedCanvasIds);
}
