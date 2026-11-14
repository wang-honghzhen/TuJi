import assert from 'node:assert/strict';
import { Repository, hash, storableManifest } from '../src/ai/server/repository';
import { Runtime } from '../src/ai/server/runtime';
import { SessionService } from '../src/ai/server/sessions';
import { emptyGraph } from '../src/v3/storage';
import type { ModelResponse } from '../src/ai/server/providers';
import { toolDefinitions } from '../src/ai/server/tools';
import { emptyState } from '../src/ai/server/repository';
import { withNoteProvenance } from '../src/ai/memory';
import { captureSourceClosure, sourceChanges } from '../src/ai/server/sourceFreshness';
import { notebookUsage } from '../src/ai/notebook';
import { captureNotebookCheck, notebookCheckChanges } from '../src/ai/server/notebookChecks';
import { captureProposalSourceBasis, assertProposalSourceBasis } from '../src/ai/server/requestSourceEvidence';
import { editNotebookContent } from '../src/ai/server/notebooks';
import type { Task, Note, SourceRef, ContextManifest } from '../src/ai/domain';

const response = (name: string, args: object): ModelResponse => ({ text: '', finishReason: 'tool_calls',
  toolCalls: [{ id: crypto.randomUUID(), name, arguments: JSON.stringify(name === 'task_finish' ? { outcome: 'success', ...args } : args) }] });
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Offline note review did not settle');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/** Regression checks use isolated state, deterministic responses and no network. */
export async function runNotesReview() {
  assert.ok(!toolDefinitions({ write: true, graph: true }).some(tool => tool.name === 'workspace_delete_work_notes'));
  console.log('CONTROL: legacy AI delete handler is unreachable because no tool definition exposes it');
  for (const [rewriteNote, temporary] of [[false, false], [true, false], [true, true]]) {
    const repo = new Repository(':memory:');
    const sessions = new SessionService(repo);
    let runtime: Runtime, requests = 0, nodeId = '', noteId = '', sessionId = '', ownerSessionId = '';
    runtime = new Runtime(repo, async () => {
      requests++;
      if (requests === 1) {
        const input = repo.state.contextManifests.at(-1)!;
        assert.ok(input.currentSources?.some(source => source.kind === 'note' && source.id === noteId));
        assert.ok(!input.canvasSources?.some(source => source.id === nodeId));
        await runtime.mutateGraph({ canvasId: repo.state.sessions.find(s => s.id === sessionId)!.canvasId,
          command: { type: 'updateNodeText', id: nodeId, field: 'content', value: 'new source invalidates old conclusion' } });
        const finish = response('task_finish', { text: 'STALE CONCLUSION', basis: 'current' });
        if (!rewriteNote) return finish;
        const write = response('workspace_update_work_notes', { noteId, text: 'old conclusion, reformatted', type: 'finding', sourceRefs: [] });
        return { ...write, toolCalls: [...write.toolCalls, ...finish.toolCalls] };
      }
      assert.ok(requests <= 5, JSON.stringify(repo.state.toolCalls.map(call => call.result)));
      if (requests === 2) return response('task_finish', { text: 'STILL STALE WITHOUT REREAD', basis: 'current' });
      if (requests === 3) return response('graph_read', { refs: [nodeId] });
      return response('task_finish', { text: 'Refreshed conclusion', basis: 'current' });
    });
    try {
      repo.transaction(state => { state.graph = emptyGraph(); state.provider.model = 'offline-review'; state.provider.supportsTools = true; });
      repo.credential = 'offline-placeholder';
      const canvasId = repo.state.graph!.canvases[0].canvasId;
      nodeId = (await runtime.mutateGraph({ canvasId, command: { type: 'createNode', parentId: canvasId, name: 'source', content: 'old source' } })).id!;
      ownerSessionId = sessionId = sessions.create({ canvasId }).id;
      noteId = sessions.noteSave({ sessionId, kind: 'work', text: 'old conclusion', sourceRefs: [
        { kind: 'node', id: nodeId, version: hash(repo.state.graph!.nodes[nodeId]), tracking: 'current' },
      ] }).id;
      if (temporary) sessionId = sessions.create({ canvasId, mode: 'temporary', temporaryMode: 'custom', sourceSessionId: ownerSessionId }).id;
      const task = runtime.send({ sessionId, clientMessageId: `review-note-${rewriteNote}`, text: 'Reformat the existing note and give the current conclusion.',
        intent: 'new', targetIds: [], artifactIds: [] });
      await until(() => repo.state.tasks.find(candidate => candidate.id === task.id)!.status === 'completed');
      const stale = repo.state.messages.some(message => message.phase === 'final' && message.text === 'STALE CONCLUSION');
      assert.equal(stale, false);
      assert.ok(requests >= 4, 'A rejected stale response must reread before finishing');
      assert.ok(!repo.state.messages.some(message => message.phase === 'final' && message.text === 'STILL STALE WITHOUT REREAD'));
      assert.ok(repo.state.messages.some(message => message.phase === 'final' && message.text === 'Refreshed conclusion'));
      assert.match(repo.state.toolCalls.find(call => call.name === 'task_finish' && call.status === 'rejected')!.result!, /SOURCE_CHANGED/);
      assert.equal(repo.state.toolCalls.filter(call => call.name === 'task_finish' && call.status === 'rejected').length, 2);
      if (rewriteNote) {
        const notebook = repo.state.workspaces.find(workspace => workspace.sessionId === ownerSessionId)!;
        const rejected = repo.state.toolCalls.find(call => call.name === 'workspace_update_work_notes' && call.status === 'rejected');
        assert.match(rejected!.result!, /SOURCE_CHANGED/);
        assert.equal(notebook.workNotes.find(note => note.id === noteId)!.version, 1);
        assert.equal(notebook.workNotes.find(note => note.id === noteId)!.sourceRefs[0].id, nodeId);
        console.log(`SAFE (${temporary ? 'temporary shared notebook' : 'ordinary session'}): stale note writes are rejected, repeated finish stays blocked, rereading permits recovery`);
      } else {
        console.log('CONTROL: without the note rewrite, the same in-flight source edit rejects current finish until reread');
      }
    } finally { await runtime.dispose(); repo.close(); }
  }
  // Each generation cites its immediate predecessor; production provenance
  // expansion makes a shared-ancestor DAG, not intentionally cyclic input.
  const work = (length: number) => {
    const state = emptyState();
    state.sessions.push({ id: 'session', workspaceId: 'workspace', canvasId: 'canvas', mode: 'explore', lifecycle: 'active', title: 'review', createdAt: 'now' });
    const notebook = { id: 'workspace', sessionId: 'session', workNotes: [] as Note[], pinnedNotes: [], artifactIds: [], snapshotIds: [] };
    state.workspaces.push(notebook);
    const task = { id: 'task', sessionId: 'session', workspaceId: 'workspace', canvasId: 'canvas', inputBindings: { targetIds: [], artifactIds: [], artifactVersions: {} } } as Task;
    for (let i = 0; i < length; i++) notebook.workNotes.push({ id: `note:${i}`, version: 1, text: `fact ${i}`, type: 'finding', updatedAt: 'now',
      sourceRefs: i ? withNoteProvenance(state, [{ kind: 'note', id: `note:${i - 1}`, version: 1 }], 'session') : [] });
    const used = notebookUsage(state, notebook);
    assert.ok(used.used <= used.limit, 'The test notes must fit the ordinary notebook budget');
    let reads = 0;
    Object.defineProperty(notebook.workNotes[0], 'sourceRefs', { get: () => { reads++; return []; }, enumerable: true });
    const start = performance.now();
    const refs: SourceRef[] = [{ kind: 'note', id: `note:${length - 1}`, version: 1 }];
    assert.deepEqual(sourceChanges(state, task, refs), []);
    assert.equal(captureSourceClosure(state, task, refs).length, length);
    return { length, sharedAncestorReads: reads, milliseconds: Math.round(performance.now() - start), tokens: used.used, limit: used.limit };
  };
  const small = work(10), large = work(14);
  assert.ok(large.sharedAncestorReads <= small.sharedAncestorReads * 2);
  assert.ok(large.sharedAncestorReads <= 20, 'A shared ancestor must be resolved only a bounded number of times');
  console.log('SAFE: shared ancestors are checked once per tracking mode, including closure capture:', JSON.stringify({ small, large }));
  testSourceClosure();
}

/** Closure semantics stay independently testable without a running provider. */
export function testSourceClosure() {
  const state = emptyState(); state.graph = emptyGraph();
  const canvasId = state.graph.canvases[0].canvasId;
  state.sessions.push({ id: 'closure-session', workspaceId: 'closure-workspace', canvasId, mode: 'explore', lifecycle: 'active', title: 'closure', createdAt: 'now' });
  const workspace = { id: 'closure-workspace', sessionId: 'closure-session', workNotes: [] as Note[], noteVersions: [] as Note[], pinnedNotes: [], artifactIds: [], snapshotIds: [] as string[] };
  state.workspaces.push(workspace);
  const task = { id: 'closure-task', sessionId: 'closure-session', workspaceId: workspace.id, canvasId,
    inputBindings: { targetIds: [], artifactIds: [], artifactVersions: {} } } as Task;
  state.graph.nodes['source'] = { nodeId: 'source', name: 'source', content: 'old' };
  state.graph.canvases[0].childIds.push('source');
  const graphRef: SourceRef = { kind: 'node', id: 'source', version: hash(state.graph.nodes.source), tracking: 'current' };
  const note: Note = { id: 'derived', version: 1, text: 'old derived conclusion', type: 'finding', updatedAt: 'now', sourceRefs: [graphRef] };
  workspace.workNotes.push(note);
  const root: SourceRef = { kind: 'note', id: note.id, version: 1, tracking: 'current' };
  const closure = captureSourceClosure(state, task, [root]);
  assert.equal(closure.length, 2);
  const historical = captureSourceClosure(state, task, [{ ...root, tracking: 'historical' }]);
  assert.ok(historical.every(source => source.tracking === 'historical'));
  state.graph = structuredClone(state.graph);
  state.graph.nodes.source.content = 'new';
  workspace.noteVersions.push(structuredClone(note));
  note.version = 2; note.sourceRefs = [];
  // A host receipt may advance its exact root while retaining the source row.
  const advanced = closure.map(source => source.id === note.id ? { ...source, version: 2 } : source);
  assert.deepEqual(sourceChanges(state, task, advanced, false).map(change => change.source.id), ['source']);
  assert.deepEqual(sourceChanges(state, task, historical, false), []);
  assert.equal(closure.find(source => source.id === note.id)!.version, 1, 'The frozen list must not alias live notes');
  // Historical-first traversal must not mask the current path to the same DAG.
  assert.ok(sourceChanges(state, task, [{ ...root, tracking: 'historical' }, root]).some(change => change.source.id === 'source'));
  const cyclic: Note = { ...note, id: 'cycle', version: 1, sourceRefs: [{ kind: 'note', id: 'cycle', version: 1 }] };
  workspace.workNotes.push(cyclic);
  const cycle = captureSourceClosure(state, task, [{ kind: 'note', id: 'cycle', version: 1 }]);
  assert.equal(cycle[0].unavailableReason, 'source_cycle');
  assert.equal(sourceChanges(state, task, cycle, false)[0].state, 'unavailable');
  assert.equal(sourceChanges(state, task, [{ kind: 'note', id: 'cycle', version: 1 }])[0].state, 'unavailable');
  const missing = captureSourceClosure(state, task, [{ kind: 'note', id: 'not-authorized', version: 1 }]);
  assert.equal(missing[0].unavailableReason, 'source_unavailable');
  assert.equal(sourceChanges(state, task, missing, false)[0].state, 'unavailable');
  console.log('SAFE: frozen closure preserves original dependencies, historical tracking, missing scope and cycle blockers');

  const stored = JSON.parse(JSON.stringify(storableManifest({ id: 'saved-manifest', taskId: task.id, stepId: 'step',
    items: [], messages: [], currentSources: [root], sourceClosure: closure } as unknown as ContextManifest))) as ContextManifest;
  assert.deepEqual(stored.sourceClosure, closure);
  assert.ok(sourceChanges(state, task, stored.sourceClosure!, false).some(change => change.source.id === 'source'),
    'Persistence must keep the old transitive source even after the live note loses its sources');

  const unread: Note = { ...note, id: 'unread', version: 1, text: 'unread original', sourceRefs: [] };
  workspace.workNotes.push(unread);
  const displayed: SourceRef[] = [{ kind: 'note', id: note.id, version: note.version, tracking: 'current' }];
  const input = { id: 'read-scope-manifest', taskId: task.id, stepId: 'step', items: [], messages: [],
    currentSources: displayed, sourceClosure: captureSourceClosure(state, task, displayed),
    notebookCheck: captureNotebookCheck(state, task) } as unknown as ContextManifest;
  const basis = captureProposalSourceBasis(state, task, input, []);
  editNotebookContent(state, workspace, { id: unread.id, expectedVersion: 1, text: 'unread changed while planning' });
  assert.doesNotThrow(() => assertProposalSourceBasis(state, task, basis));
  assert.equal(notebookCheckChanges(state, task, input.notebookCheck).find(change => 'noteId' in change && change.noteId === unread.id)?.kind, 'changed');
  console.log('SAFE: stored manifests retain dependencies; unread note changes allow proposals but still require review before finish');
}
