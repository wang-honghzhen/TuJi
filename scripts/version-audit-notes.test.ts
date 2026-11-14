import assert from 'node:assert/strict';
import { Repository, emptyState, hash } from '../src/ai/server/repository';
import { Runtime } from '../src/ai/server/runtime';
import { SessionService } from '../src/ai/server/sessions';
import { emptyGraph } from '../src/v3/storage';
import { notePayload } from '../src/ai/notebook';
import { withNoteProvenance } from '../src/ai/memory';
import { writeAiNote, editNotebookContent } from '../src/ai/server/notebooks';
import { noteVersionNotices, visibleNoteEvidence } from '../src/ai/server/noteFreshness';
import { sourceChanges } from '../src/ai/server/sourceFreshness';
import { captureNotebookCheck, notebookCheckChanges, type NotebookCheck } from '../src/ai/server/notebookChecks';
import { bindToolVersions } from '../src/ai/server/toolVersions';
import { queueNotebookNotices, prepareTaskNoticeBatch, taskNoticeBatchCurrent } from '../src/ai/server/taskNotices';
import type { AppSnapshot, ContextManifest, Note, Session, Task, ToolCallRecord, Workspace } from '../src/ai/domain';
import type { ContextStage } from '../src/ai/contextState';

const at = '2026-11-14T00:00:00.000Z';
const note = (id: string, text: string, version = 1, sourceRefs: Note['sourceRefs'] = []): Note =>
  ({ id, text, version, sourceRefs, type: 'finding', lifecycle: 'multi_task', updatedAt: at });
function fixture() {
  const state = emptyState(); state.graph = emptyGraph();
  const session: Session = { id: 'session:a', workspaceId: 'workspace:a', canvasId: state.graph.canvases[0].canvasId,
    mode: 'explore', title: 'audit', lifecycle: 'active', createdAt: at };
  const workspace: Workspace = { id: session.workspaceId, sessionId: session.id, workNotes: [], pinnedNotes: [], snapshotIds: [], artifactIds: [] };
  const task = { id: 'task:a', sessionId: session.id, workspaceId: workspace.id, canvasId: session.canvasId,
    rootUserMessageId: 'message:root', status: 'running', instructionRevision: 1, inputBindings: { targetIds: [], artifactIds: [], artifactVersions: {} } } as Task;
  const stage = { version: 1, generation: 1, taskId: task.id, entries: [], noteVersions: {}, eventIds: [] } as unknown as ContextStage;
  state.sessions.push(session); state.workspaces.push(workspace); state.tasks.push(task);
  return { state, session, workspace, task, stage };
}
function display(stage: ContextStage, value: Note) {
  stage.entries.push({ id: `note:${value.id}:${value.version}`, category: 'work_notes', lifecycle: 'region', coverage: [],
    messages: [{ role: 'user', content: JSON.stringify({ work_note: notePayload(value) }) }] });
}
function finish(state: AppSnapshot, task: Task, sources: NonNullable<ContextManifest['currentSources']>, notebookCheck: NotebookCheck = captureNotebookCheck(state,task), basis='current') {
  const repo = new Repository(':memory:');
  try {
    const runtime = new Runtime(repo, async () => { throw new Error('Paid model calls are forbidden in this audit'); });
    repo.state = state;
    const call = { id: 'call:finish', taskId: task.id, stepId: 'step:a', name: 'task_finish', status: 'prepared', providerCallId: 'provider:finish', operationId: 'operation:finish', arguments: '{}' } as ToolCallRecord;
    state.toolCalls.push(call);
    state.steps.push({ id: call.stepId, taskId: task.id, inputInstructionRevision: task.instructionRevision } as any);
    state.contextManifests.push({ id: 'manifest:a', taskId: task.id, stepId: call.stepId, currentSources: sources, notebookCheck, canvasReadHashes: {}, canvasChecks: [] } as any);
    // Exercise the production task_finish handler without scheduling a model request.
    return repo.transaction(() => (runtime as any).tool(task, call, { text: 'audit completion', outcome: 'success', basis }));
  } finally { repo.close(); }
}

/** Regression checks use memory-only databases and never invoke a provider. */
export function testNotesAudit() {
  const results: string[] = [];
  {
    const read=fixture();
    assert.equal(finish(read.state,read.task,[],captureNotebookCheck(read.state,read.task),'historical').status,'ok');
    const write=fixture();
    write.state.toolCalls.push({id:'written-note',taskId:write.task.id,stepId:'prior-step',name:'workspace_update_work_notes',status:'completed'} as ToolCallRecord);
    assert.throws(()=>finish(write.state,write.task,[],captureNotebookCheck(write.state,write.task),'historical'),(e:any)=>e.code==='HISTORICAL_BASIS_NOT_ALLOWED');
    results.push('SAFE: historical read-only finish remains available; a task with current writes cannot use it to bypass checks');
  }
  {
    const {state,workspace,task}=fixture();
    const check=captureNotebookCheck(state,task);
    const saved=writeAiNote(state,task,{text:'own write',type:'finding',lifecycle:'multi_task',sourceRefs:[],receiptId:'self-write'});
    const ack={taskId:task.id,status:'completed',name:'workspace_update_work_notes',noteWriteAcknowledgement:{notebookId:workspace.id,noteId:saved.noteId,version:saved.version}} as ToolCallRecord;
    assert.deepEqual(notebookCheckChanges(state,task,check,[ack]),[]);
    editNotebookContent(state,workspace,{id:saved.noteId,text:'external after own write',expectedVersion:1});
    assert.equal(notebookCheckChanges(state,task,check,[ack])[0]?.kind,'changed');
    editNotebookContent(state,workspace,{id:saved.noteId,text:'own write',expectedVersion:2});
    assert.deepEqual(notebookCheckChanges(state,task,check,[ack]),[]);
    assert.equal(notebookCheckChanges(state,task,undefined)[0]?.kind,'unknown');
    results.push('SAFE: own receipt advances only its exact content; later external edits reject, identical restoration is equivalent, missing evidence fails closed');
  }
  {
    const {state,workspace,task}=fixture();
    state.graph!.nodes['source-node']={nodeId:'source-node',name:'source',content:'original'};
    state.graph!.canvases[0].childIds.push('source-node');
    const check=captureNotebookCheck(state,task);
    const saved=writeAiNote(state,task,{text:'derived from source',type:'finding',lifecycle:'multi_task',
      sourceRefs:[{kind:'node',id:'source-node',version:hash(state.graph!.nodes['source-node']),tracking:'current'}],receiptId:'own-derived'});
    state.toolCalls.push({id:'own-derived-call',taskId:task.id,stepId:'step:a',name:'workspace_update_work_notes',status:'completed',
      noteWriteAcknowledgement:{notebookId:workspace.id,noteId:saved.noteId,version:saved.version}} as ToolCallRecord);
    state.graph=structuredClone(state.graph!);state.graph.nodes['source-node'].content='changed after own note write';
    assert.deepEqual(notebookCheckChanges(state,task,check,state.toolCalls),[]);
    assert.throws(()=>finish(state,task,[],check),(e:any)=>e.code==='SOURCE_CHANGED');
    results.push('SAFE: newly written notes join finish dependencies; a later change to their graph source is rejected');
  }
  {
    const { state, workspace, task, stage } = fixture();
    const original = note('note:n', 'original'); workspace.workNotes.push(original); display(stage, original);
    const sources = noteVersionNotices(state, task, stage, id => id).sources;
    editNotebookContent(state, workspace, { id: original.id, expectedVersion: 1, text: 'user update' });
    assert.throws(() => writeAiNote(state, task, { noteId: original.id, expectedVersion: 1, text: 'stale AI write', type: 'finding', lifecycle: 'multi_task', sourceRefs: [], receiptId: 'write:1' }), (e: any) => e.code === 'VERSION_CONFLICT');
    assert.equal(workspace.workNotes[0].text, 'user update');
    assert.throws(() => finish(state, task, sources), (e: any) => e.code === 'SOURCE_CHANGED');
    results.push('SAFE: user edit rejects an old AI note write and current-basis task_finish');
  }
  {
    const { state, session, workspace, task, stage } = fixture();
    const original = note('note:n', 'original'); workspace.workNotes.push(original); display(stage, original);
    const temporary: Session = { ...session, id: 'session:temporary', workspaceId: 'workspace:temporary', mode: 'temporary', temporaryContext: { revision: 1, mode: 'custom', sourceSessionId: session.id } };
    state.sessions.push(temporary); state.workspaces.push({ id: temporary.workspaceId, sessionId: temporary.id, workNotes: [], pinnedNotes: [], snapshotIds: [], artifactIds: [] });
    const peer = { ...task, id: 'task:temporary', sessionId: temporary.id, workspaceId: temporary.workspaceId, notebookBinding: { id: workspace.id, revision: 1 } };
    const saved = writeAiNote(state, peer, { noteId: original.id, expectedVersion: 1, text: 'temporary update', type: 'finding', lifecycle: 'multi_task', sourceRefs: [], receiptId: 'write:temporary' });
    assert.equal(saved.version, 2); assert.equal(workspace.pendingTaskNotices?.changes.length, 1);
    assert.throws(() => writeAiNote(state, task, { noteId: original.id, expectedVersion: 1, text: 'original-session stale write', type: 'finding', lifecycle: 'multi_task', sourceRefs: [], receiptId: 'write:original' }), (e: any) => e.code === 'VERSION_CONFLICT');
    results.push('SAFE: temporary session shares notebook; peers are notified and stale writes rejected');
  }
  {
    const { state, workspace, task, stage } = fixture();
    const initial = note('note:n', 'A'); workspace.workNotes.push(initial); display(stage, initial);
    let before = structuredClone(workspace.workNotes);
    editNotebookContent(state, workspace, { id: initial.id, expectedVersion: 1, text: 'B' }); queueNotebookNotices(state, workspace, 'work', before);
    const batch = prepareTaskNoticeBatch(state, task); stage.taskNoticeBatch = batch;
    before = structuredClone(workspace.workNotes);
    editNotebookContent(state, workspace, { id: initial.id, expectedVersion: 2, text: 'A' }); queueNotebookNotices(state, workspace, 'work', before);
    assert.equal(workspace.pendingTaskNotices?.changes.length, 0);
    assert.equal(taskNoticeBatchCurrent(state, task, stage), false);
    assert.equal(visibleNoteEvidence(state, task, stage).get(initial.id)?.complete.has(3), true);
    results.push('SAFE: A-to-B-to-A coalesces notification while invalidating a prepared batch and recognizing identical content');
  }
  {
    const { state, workspace, task } = fixture();
    workspace.workNotes.push(note('note:n', 'new live version', 2));
    const call = { name: 'workspace_update_work_notes', taskId: task.id, stepId: 'step:frozen' } as ToolCallRecord;
    state.contextManifests.push({ taskId: task.id, stepId: call.stepId, toolVersions: { protocol: 1, handoff: 0, notes: { 'note:n': 1 }, reads: {}, sources: [] } } as any);
    const bound = bindToolVersions(state, task, call, { noteId: 'note:n', expectedVersion: 999 });
    assert.equal(bound.expectedVersion, 1);
    results.push('SAFE: a submitted manifest binds the displayed note revision, not live state or model-provided version');
  }
  {
    const { state, workspace, task, stage } = fixture();
    const sources = noteVersionNotices(state, task, stage, id => id).sources;
    const check = captureNotebookCheck(state,task);
    workspace.workNotes.push(note('note:new', 'new user constraint during generation'));
    queueNotebookNotices(state, workspace, 'work', []);
    assert.equal(workspace.pendingTaskNotices?.changes.length, 1);
    assert.throws(()=>finish(state, task, sources, check), (e:any)=>e.code==='SOURCE_CHANGED');
    assert.equal(workspace.pendingTaskNotices?.changes.length, 1);
    results.push('SAFE: newly added notebook entries block finish until the next submitted input');
  }
  {
    const { state, workspace, task, stage } = fixture();
    const dependency = note('note:dependency', 'old source');
    const derived = note('note:derived', 'derived conclusion', 1, [{ kind: 'note', id: dependency.id, version: 1, tracking: 'current' }]);
    workspace.workNotes.push(dependency, derived); display(stage, derived);
    const sources = noteVersionNotices(state, task, stage, id => id).sources;
    editNotebookContent(state, workspace, { id: dependency.id, expectedVersion: 1, text: 'contradicting source' });
    assert.equal(sourceChanges(state, task, sources).length, 1);
    assert.equal(sourceChanges(state, task, sources, false).length, 0);
    assert.throws(()=>finish(state, task, sources), (e:any)=>e.code==='SOURCE_CHANGED');
    results.push('SAFE: task_finish checks changed transitive dependencies of a displayed note');
  }
  {
    const { state, workspace, task, stage } = fixture();
    const old = note('note:n', 'old body'); display(stage, old);
    workspace.workNotes.push(note(old.id, 'changed body', 2)); workspace.noteVersions = [old];
    const notices = noteVersionNotices(state, task, stage, id => id);
    assert.ok(notices.lines.some(line => line.includes('笔记'))); assert.equal(notices.sources[0]?.version,1);
    assert.throws(()=>finish(state, task, notices.sources), (e:any)=>e.code==='SOURCE_CHANGED');
    results.push('SAFE: a warning never removes stale displayed notes from finish preconditions');
  }
  {
    const {state,workspace,task,stage}=fixture();workspace.workNotes.push(note('note:unread','not delivered'));
    const notices=noteVersionNotices(state,task,stage,id=>id);
    assert.deepEqual(notices.check.unreadNoteIds,['note:unread']);
    assert.throws(()=>finish(state,task,notices.sources,notices.check),(e:any)=>e.code==='SOURCE_CHANGED');
    results.push('SAFE: unread notebook entries remain blockers even when only a notification was displayed');
  }
  {
    const repo = new Repository(':memory:');
    try {
      const runtime = new Runtime(repo, async () => { throw new Error('Paid model calls are forbidden in this audit'); });
      repo.state.graph = emptyGraph(); const state = repo.state;
      const service = new SessionService(repo), canvasId = state.graph!.canvases[0].canvasId;
      const parent = service.ensure(canvasId);
      const initial = service.noteSave({ sessionId: parent.id, kind: 'work', text: 'fork seed' });
      const parentTask = { ...fixture().task, id: 'task:parent', sessionId: parent.id, workspaceId: parent.workspaceId,
        canvasId, status: 'completed', rootUserMessageId: 'message:parent', createdAt: at } as Task;
      state.tasks.push(parentTask);
      const addMessage = (task: Task) => state.messages.push({ id: task.rootUserMessageId, workspaceId: task.workspaceId, taskId: task.id,
        role: 'user', text: task.id, version: 1, status: 'complete', phase: 'request', createdAt: at, sourceRefs: [], relatedOperationIds: [], targetRefs: [] });
      addMessage(parentTask);
      // Real selection-based creation must be the operation that duplicates identity.
      const childSession = service.create({ canvasId, orderedTasks: [{ sessionId: parent.id, taskId: parentTask.id }] });
      const child = state.workspaces.find(w => w.id === childSession.workspaceId)!;
      assert.equal(child.workNotes[0].id, initial.id); assert.equal(child.workNotes[0].version, 1);
      const parentWriteTask = { ...parentTask, id: 'task:parent-after-fork', status: 'running', rootUserMessageId: 'message:parent-after-fork' } as Task;
      const childTask = { ...parentTask, id: 'task:child', sessionId: childSession.id, workspaceId: child.id, status: 'running', rootUserMessageId: 'message:child' } as Task;
      state.tasks.push(parentWriteTask, childTask); addMessage(parentWriteTask); addMessage(childTask);
      for (const [task, body] of [[parentWriteTask, 'parent branch'], [childTask, 'child branch']] as const)
        writeAiNote(state, task, { noteId: initial.id, expectedVersion: 1, text: body, type: 'finding', lifecycle: 'multi_task',
          sourceRefs: [{ kind: 'message', id: task.rootUserMessageId, version: 1 }], receiptId: `write:${task.id}` });
      const expanded = withNoteProvenance(state, [{ kind: 'note', id: initial.id, version: 2 }], childSession.id);
      assert.ok(!expanded.some(ref => ref.id === 'message:parent-after-fork')); assert.ok(expanded.some(ref => ref.id === 'message:child'));
      const call = { id: 'call:derive', taskId: childTask.id, stepId: 'step:child', name: 'workspace_update_work_notes', operationId: 'operation:derive' } as ToolCallRecord;
      state.contextManifests.push({id:'manifest:derive',taskId:childTask.id,stepId:call.stepId,
        currentSources:[{kind:'note',id:initial.id,version:2,tracking:'current'}],notebookCheck:captureNotebookCheck(state,childTask)} as ContextManifest);
      const result = repo.transaction(() => (runtime as any).tool(childTask, call, { text: 'derived from child branch', type: 'finding',
        sourceRefs: [{ kind: 'note', id: initial.id, version: 2 }] }));
      const derived = child.workNotes.find(n => n.id === result.noteId)!;
      assert.ok(!derived.sourceRefs.some(ref => ref.id === 'message:parent-after-fork'));
      assert.ok(derived.sourceRefs.some(ref => ref.id === 'message:child'));
      assert.deepEqual(sourceChanges(state, childTask, [{ kind: 'note', id: derived.id, version: 1 }]), []);
      results.push('SAFE (real SessionService creation + runtime note write): forked note provenance stays in the selected notebook branch');
    } finally { repo.close(); }
  }
  results.forEach(line => console.log(line));
  return results;
}
