import assert from 'node:assert/strict';
import { Repository, hash } from '../src/ai/server/repository';
import { Runtime } from '../src/ai/server/runtime';
import { SessionService } from '../src/ai/server/sessions';
import { emptyGraph } from '../src/v3/storage';
import type { ModelResponse } from '../src/ai/server/providers';

const response = (name: string, args: object): ModelResponse => ({ text: '', toolCalls: [
  { id: crypto.randomUUID(), name, arguments: JSON.stringify(args) },
] });

/** Real Runtime safety regressions; deterministic local model and in-memory SQLite. */
export async function runReviewRuntime() {
  for (const mutation of ['note', 'note_source', 'new_note', 'note_deleted', 'none'] as const)
    for (const mutationRequest of [2, 3])
    for (const explicitDependencies of [false, true]) {
    const repo = new Repository(':memory:');
    const sessions = new SessionService(repo);
    const invalidatesProposal = ['note', 'note_source', 'note_deleted'].includes(mutation);
    let request = 0, sessionId = '', nodeId = '', sourceId = '', noteId = '', oldProposalId = '';
    const lastCall = (name: string) => repo.state.toolCalls.filter(c => c.name === name).at(-1)!;
    const assertRejected = (name: string) => {
      const call = lastCall(name);
      assert.equal(call.status, 'rejected', call.result); assert.match(call.result!, /SOURCE_CHANGED/);
      assert.equal(repo.state.graph!.nodes[nodeId].content, 'original B', 'A stale proposal must never change B');
      assert.ok(!repo.state.changes.some(c => c.status === 'committed'));
    };
    const propose = (fresh: boolean) => response('graph_propose_changes', {
      commands: [{ type: 'updateNodeText', id: nodeId, field: 'content', value: fresh ? 'verified current result' : 'initial proposed result' }],
      reason: fresh ? 'Replanned after reading corrected evidence' : 'Apply the conclusion from the work note',
      ...(explicitDependencies ? { dependencyRefs: [] } : {}),
    });
    const finish = (text = 'Completed after receiving latest context') => response('task_finish', { text, outcome: 'success', basis: 'current' });
    const apply = (changeSetId: string, alsoFinish = false): ModelResponse => ({ text: '', toolCalls: [
      ...response('graph_apply_changes', { changeSetId }).toolCalls, ...(alsoFinish ? finish('Verified completion').toolCalls : []),
    ] });
    const reread = () => mutation === 'note'
      ? response('context_read_children', { summaryId: noteId })
      : response('graph_read', { refs: [mutation === 'note_source' ? sourceId : nodeId] });

    const runtime = new Runtime(repo, async () => {
      request++; assert.ok(request <= 10, 'Offline review must settle within ten requests');
      if (request === 1) return response('graph_read', { refs: [nodeId] });
      if (request === mutationRequest) {
        if (mutation === 'note') sessions.noteEdit({ sessionId, id: noteId, text: 'Corrected conclusion: use verified current evidence', expectedVersion: 1 });
        if (mutation === 'note_deleted') sessions.noteDelete({ sessionId, kind: 'work', noteId, expectedVersion: 1 });
        if (mutation === 'new_note') sessions.noteSave({ sessionId, kind: 'work', text: 'Additional evidence to consider before finishing' });
        if (mutation === 'note_source') await runtime.mutateGraph({ canvasId: repo.state.sessions.find(s => s.id === sessionId)!.canvasId,
          command: { type: 'updateNodeText', id: sourceId, field: 'content', value: 'corrected external premise' } });
      }
      if (request === 2) return propose(false);
      if (!invalidatesProposal) {
        if (request === 3) {
          assert.equal(repo.state.changes.at(-1)?.status, 'proposed');
          return apply(repo.state.changes.at(-1)!.id, true);
        }
        assert.equal(mutation, 'new_note'); assert.equal(mutationRequest, 3); assert.equal(request, 4);
        assert.equal(repo.state.changes.at(-1)?.status, 'committed');
        assert.equal(lastCall('task_finish').status, 'rejected'); assert.match(lastCall('task_finish').result!, /SOURCE_CHANGED/);
        return finish();
      }
      if (mutationRequest === 2) {
        if (request === 3) { assertRejected('graph_propose_changes'); return reread(); }
        if (request === 4) return propose(true);
        assert.equal(request, 5); assert.equal(repo.state.changes.at(-1)?.status, 'proposed');
        return apply(repo.state.changes.at(-1)!.id, true);
      }
      if (request === 3) {
        assert.equal(repo.state.changes.at(-1)?.status, 'proposed'); oldProposalId = repo.state.changes.at(-1)!.id;
        return apply(oldProposalId);
      }
      if (request === 4) { assertRejected('graph_apply_changes'); return reread(); }
      // Rereading corrects the current request, never the basis of an old proposal.
      if (request === 5) return apply(oldProposalId);
      if (request === 6) { assertRejected('graph_apply_changes'); return propose(true); }
      assert.equal(request, 7); assert.equal(repo.state.changes.at(-1)?.status, 'proposed');
      assert.notEqual(repo.state.changes.at(-1)!.id, oldProposalId);
      return apply(repo.state.changes.at(-1)!.id, true);
    });
    try {
      repo.transaction(s => { s.graph = emptyGraph(); s.provider.model = 'offline-review'; s.provider.supportsTools = true; });
      repo.credential = 'offline-test-placeholder';
      const canvasId = repo.state.graph!.canvases[0].canvasId;
      nodeId = (await runtime.mutateGraph({ canvasId, command: { type: 'createNode', parentId: canvasId, name: 'B', content: 'original B' } })).id!;
      sourceId = (await runtime.mutateGraph({ canvasId, command: { type: 'createNode', parentId: canvasId, name: 'A', content: 'old premise' } })).id!;
      sessionId = sessions.create({ canvasId }).id;
      noteId = sessions.noteSave({ sessionId, kind: 'work', text: 'Conclusion from old premise: replace B',
        sourceRefs: mutation === 'note_source' ? [{ kind: 'node', id: sourceId, version: hash(repo.state.graph!.nodes[sourceId]), tracking: 'current' }] : [],
      }).id;
      const task = runtime.send({ sessionId, clientMessageId: `${mutation}-${mutationRequest}-${explicitDependencies}`, text: 'Use the work note to update B.', intent: 'new', targetIds: [], artifactIds: [] });
      const deadline = Date.now() + 15000;
      while (!['completed', 'paused', 'failed'].includes(task.status)) {
        assert.ok(Date.now() < deadline, 'Offline task timed out');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.equal(task.status, 'completed', `${mutation}/${mutationRequest}/${explicitDependencies}: ${task.error}\n${repo.state.toolCalls.map(c => c.result).join('\n')}`);
      assert.equal(repo.state.changes.filter(c => c.status === 'committed').length, 1);
      assert.equal(repo.state.graph!.nodes[nodeId].content, invalidatesProposal ? 'verified current result' : 'initial proposed result');
      const rejectedWrites = repo.state.toolCalls.filter(c => ['graph_propose_changes','graph_apply_changes'].includes(c.name) && c.status === 'rejected');
      assert.equal(rejectedWrites.length, invalidatesProposal ? mutationRequest === 2 ? 1 : 2 : 0);
      const rejectedFinishes = repo.state.toolCalls.filter(c => c.name === 'task_finish' && c.status === 'rejected');
      assert.equal(rejectedFinishes.length, mutation === 'new_note' && mutationRequest === 3 ? 1 : 0);
      if (invalidatesProposal && mutationRequest === 3) assert.equal(repo.state.changes.find(c => c.id === oldProposalId)!.status, 'proposed');
      console.log(`SAFE: ${mutation} during ${mutationRequest === 2 ? 'proposal' : 'apply'}; dependencies ${explicitDependencies ? 'empty' : 'omitted'}; ${invalidatesProposal ? 'stale writes rejected, fresh replan succeeds' : mutation === 'new_note' ? 'write allowed, new note checked before finish' : 'unchanged evidence permits normal completion'}`);
    } finally { await runtime.dispose(); repo.close(); }
    }
}
