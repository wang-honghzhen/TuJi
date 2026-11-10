import type { GraphState } from '@/v3/types';
import type { AppSnapshot, ChangeSet, Task, ToolCallRecord } from '../domain';
import type { ContextStage, GraphWriteAcknowledgement, Observation } from '../contextState';
import { digest, graphIndex, observe } from './directGraph';
import { graphTables } from './graphReadTables';
import { entity, semanticHashes } from './graph';
import { currentRelationHashes } from './graphRelationDependencies';
import { canvasField, canvasKey, stampCanvasObservation } from './canvasReadEvidence';
import { subgraphKey, subgraphVersion } from './subgraphVersions';

/** A receipt acknowledges a write only while its native call/result pair is in this prompt. */
export function visibleNativeCalls(stage: ContextStage, calls: ToolCallRecord[]): ToolCallRecord[] {
  const byId = new Map(calls.map(c => [c.id, c]));
  const delivered = new Set(stage.entries.flatMap(e => {
    const requested = new Set(e.messages.flatMap(m => m.toolCalls?.map(c => c.id) ?? []));
    const results = new Set(e.messages.filter(m => m.role === 'tool').map(m => m.toolCallId));
    return e.coverage.flatMap(coverage => {
      const call = byId.get(coverage.recordId);
      return call && requested.has(call.providerCallId) && results.has(call.providerCallId) ? [call.id] : [];
    });
  }));
  return calls.filter(c => c.status === 'completed' && delivered.has(c.id)).sort((a,b) => (a.sequence ?? 0) - (b.sequence ?? 0));
}

export function visibleWriteCalls(stage: ContextStage, calls: ToolCallRecord[]): ToolCallRecord[] {
  const visible=visibleNativeCalls(stage,calls),ids=new Set(visible.map(c=>c.id));
  return visible.filter(c=>c.noteWriteAcknowledgement || c.graphWriteAcknowledgement
    && c.graphWriteAcknowledgement.commandCallIds?.length
    && c.graphWriteAcknowledgement.commandCallIds.every(id=>ids.has(id)));
}

/** Replay exact transitions, so missing receipts or an external version gap cannot be skipped. */
export function acknowledgedObservations(observations: Observation[], calls: ToolCallRecord[]): Observation[] {
  const known = new Map(observations.map(o => [o.id, o]));
  for (const call of calls) {
    if (call.status !== 'completed') continue;
    for (const advance of call.graphWriteAcknowledgement?.advances ?? []) {
      const previous = known.get(advance.observationId);
      // A new request rebinds baseline evidence to its task. That delivery owner
      // is not a source version: compare the exact payload with the original
      // owner, then retain the current owner for prompt visibility checks.
      if (previous && digest({ ...previous, taskId: advance.observation.taskId }) === advance.expected)
        known.set(previous.id, { ...advance.observation, taskId: previous.taskId });
    }
    for (const observation of call.graphWriteAcknowledgement?.observations ?? []) known.set(observation.id, observation);
  }
  return [...known.values()];
}

/** Advance each independently observed fact only when its pre-write version still matches. */
export function graphWriteAcknowledgement(state: AppSnapshot, task: Task, call: ToolCallRecord,
  change: ChangeSet, before: GraphState): GraphWriteAcknowledgement {
  const workspace = state.workspaces.find(w => w.id === task.workspaceId)!;
  const priorCalls = state.toolCalls.filter(c => c.taskId === task.id && c.status === 'completed')
    .sort((a,b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  const observations = acknowledgedObservations([...(workspace.observations ?? []), ...(workspace.contextStage?.baselineObservations ?? [])], priorCalls)
    .filter(o => o.taskId === task.id && !o.historical && o.canvasId === task.canvasId);
  const oldState = { ...state, graph: before }, oldIndex = graphIndex(oldState, task.canvasId), index = graphIndex(state, task.canvasId);
  const oldTables = graphTables(oldIndex), tables = graphTables(index);
  const keys = observations.flatMap(o => Object.keys(o.readHashes ?? {}));
  const oldHashes = { ...semanticHashes(before), ...currentRelationHashes(before, keys) };
  const hashes = { ...semanticHashes(state.graph!), ...currentRelationHashes(state.graph!, keys) };
  const changedRefs = change.affectedRefs.filter(ref => tables.source(ref) && digest(entity(before, ref)) !== digest(entity(state.graph!, ref)));
  // Full bodies are known only if created or explicitly supplied by this write.
  const bodies = new Set(changedRefs.filter(ref => !entity(before, ref) || change.commands.some(command =>
    command.id === ref && (command.type === 'updateNodeText' && command.field === 'content'
      || command.type === 'updateEdge' && typeof (command.patch as Record<string, unknown> | undefined)?.edgeContent === 'string'))));
  const advances: GraphWriteAcknowledgement['advances'] = [];
  for (const previous of observations) {
    if (!previous.objects) continue; // Legacy observations must be reread.
    const old = observe(oldState, task, oldIndex, previous.refs, Object.keys(previous.directoryMembers ?? {}), previous.structureOnly, previous.query, previous.queryScope, previous.graphQuery);
    const next = observe(state, task, index, previous.refs, Object.keys(previous.directoryMembers ?? {}), previous.structureOnly, previous.query, previous.queryScope, previous.graphQuery);
    const updated = structuredClone(previous);
    for(const facts of Object.values(updated.canvasVersionDependencies??{}))for(const fact of facts){
      if(fact.version===canvasKey(canvasField(oldIndex,fact.refId,fact.field)))fact.version=canvasKey(canvasField(index,fact.refId,fact.field));
    }
    updated.canvasFacts=previous.canvasFacts?.flatMap(fact=>{
      const oldValue=canvasField(oldIndex,fact.refId,fact.field),value=canvasField(index,fact.refId,fact.field);
      if(fact.version!==canvasKey(oldValue))return [fact];
      if(value===undefined)return [];
      const partial=fact.start!==undefined&&!(fact.start===0&&fact.end===fact.total);
      const completeBody=bodies.has(fact.refId)&&['content','edge'].includes(fact.field);
      if(partial&&!completeBody)return fact;
      const next={...fact,version:canvasKey(value)};
      if(completeBody){delete next.start;delete next.end;delete next.total;}
      return next;
    });
    for(const [ref,parents] of Object.entries(previous.objectParents??{}))
      if(digest(parents)===digest(old.objectParents?.[ref]))
        (updated.objectParents??={})[ref]=next.objectParents?.[ref]??[];
    for (const field of ['objects', 'directoryMembers', 'paths', 'directories', 'readHashes'] as const) {
      const expected = field === 'readHashes' ? oldHashes : old[field] ?? {};
      const current = field === 'readHashes' ? hashes : next[field] ?? {};
      for (const [key, version] of Object.entries(updated[field] ?? {})) if (version === expected[key] && version !== current[key]) {
        if (current[key] === undefined) delete updated[field]![key]; else updated[field]![key] = current[key];
      }
    }
    if (previous.querySignature === old.querySignature) updated.querySignature = next.querySignature;
    updated.sources = previous.sources.flatMap(source => {
      const oldSource = oldTables.source(source.id), current = tables.source(source.id);
      if (!oldSource || source.version !== oldSource.version || source.version === current?.version) return [source];
      if (!current) return [];
      if (bodies.has(source.id)) return [current];
      return [{ ...source, version: current.version }];
    });
    for (const ref of Object.keys(previous.contentLengths ?? {})) if (previous.objects[ref] === old.objects?.[ref]) {
      if (!tables.source(ref)) delete updated.contentLengths![ref];
      else updated.contentLengths![ref] = next.contentLengths![ref];
    }
    if(!Object.keys(updated.objects??{}).length&&!Object.keys(updated.directories).length&&!Object.keys(updated.readHashes??{}).length
      &&!updated.canvasFacts?.length&&!updated.query&&!updated.graphQuery
      &&(Object.keys(previous.objects??{}).length||previous.canvasFacts?.length))updated.provenEmpty=true;
    if (digest(previous) !== digest(updated)) advances.push({ observationId: previous.id, expected: digest(previous), observation: updated });
  }
  const written = observe(state, task, index, changedRefs);
  written.id = `write:${call.id}`; written.callId = call.id;
  written.sources = written.sources.filter(source => bodies.has(source.id));
  stampCanvasObservation(index,written,[...bodies].map(refId=>tables.edges.has(refId)?tables.edge(refId):{refId,content:canvasField(index,refId,'content')}));
  const commandCallIds=priorCalls.filter(c=>c.name==='graph_propose_changes'&&c.stepId===change.stepId
    && c.operationId===change.operationId).map(c=>c.id);
  const groups=new Set([...oldIndex.rows.values(),...index.rows.values()].filter(r=>r.kind!=='node').map(r=>r.id));
  const fileTransitions=[...groups].flatMap(id=>(['directory','direct'] as const).flatMap(part=>{
    const previous=subgraphVersion(oldIndex,id,part),next=subgraphVersion(index,id,part);
    return previous===next?[]:[{key:subgraphKey(index.canvasId,id,part),before:previous,after:next}];
  }));
  return { commandCallIds, advances, observations: changedRefs.length ? [written] : [],fileTransitions };
}
