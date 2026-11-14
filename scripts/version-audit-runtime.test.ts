import assert from 'node:assert/strict';
import { Repository, hash } from '../src/ai/server/repository';
import { Runtime } from '../src/ai/server/runtime';
import { SessionService } from '../src/ai/server/sessions';
import { emptyGraph } from '../src/v3/storage';
import type { ModelResponse } from '../src/ai/server/providers';

const response = (name: string, args: object): ModelResponse => ({ text: '', finishReason: 'tool_calls',
  toolCalls: [{ id: crypto.randomUUID(), name, arguments: JSON.stringify(name === 'task_finish' ? { outcome: 'success', ...args } : args) }] });
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Mock runtime did not settle');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

// Exercise the real submission / result / tool / next-request loop. The caller
// is deterministic and cannot contact a provider; every database is in memory.
export async function runRuntimeAudit() {
  for (const mutation of ['canvas', 'note', 'requirements', 'new_note', 'note_deleted', 'note_source', 'self_write'] as const) {
    const repo = new Repository(':memory:');
    let runtime: Runtime;
    const sessions = new SessionService(repo);
    let requests = 0, sessionId = '', nodeId = '', noteId = '';
    runtime = new Runtime(repo, async () => {
      requests++;
      if(mutation==='self_write'){
        if(requests===1)return response('graph_read',{refs:[nodeId]});
        if(requests===2)return response('graph_propose_changes',{commands:[{type:'updateNodeText',id:nodeId,field:'content',value:'own verified update'}],reason:'test exact own-write advancement',dependencyRefs:[]});
        assert.equal(requests,3);
        const apply=response('graph_apply_changes',{changeSetId:repo.state.changes.at(-1)!.id});
        return {...apply,toolCalls:[...apply.toolCalls,...response('task_finish',{text:'Verified current result',basis:'current'}).toolCalls]};
      }
      if (mutation === 'canvas' && requests === 1) return response('graph_read', { refs: [nodeId] });
      const changeAt = mutation === 'canvas' ? 2 : 1;
      if (requests === changeAt) {
        if (mutation === 'canvas' || mutation === 'note_source') await runtime.mutateGraph({ canvasId: repo.state.sessions.find(s => s.id === sessionId)!.canvasId,
          command: { type: 'updateNodeText', id: nodeId, field: 'content', value: 'user changed during response' } });
        if (mutation === 'note') sessions.noteEdit({ sessionId, id: noteId, text: 'new note during response', expectedVersion: 1 });
        if (mutation === 'requirements') sessions.replaceRequirements({ sessionId, text: 'new live instruction', expectedVersion: '[]' });
        if (mutation === 'new_note') sessions.noteSave({ sessionId, kind: 'work', text: 'new finding during response' });
        if (mutation === 'note_deleted') sessions.noteDelete({ sessionId, kind: 'work', noteId, expectedVersion: 1 });
        return response('task_finish', { text: 'STALE RESPONSE', basis: 'current' });
      }
      assert.ok(requests <= 6, JSON.stringify(repo.state.toolCalls.map(c => c.result)));
      if ((mutation === 'canvas' || mutation === 'note_source') && requests === changeAt + 1)
        return response('graph_read', { refs: [nodeId] });
      return response('task_finish', { text: 'Verified current result', basis: 'current' });
    });
    try {
      repo.transaction(s => { s.graph = emptyGraph(); s.provider.model = 'offline-audit'; s.provider.supportsTools = true; });
      repo.credential = 'offline-test-placeholder';
      const canvasId = repo.state.graph!.canvases[0].canvasId;
      nodeId = (await runtime.mutateGraph({ canvasId, command: { type: 'createNode', parentId: canvasId, name: 'audit node', content: 'original' } })).id!;
      const session = sessions.create({ canvasId }); sessionId = session.id;
      if (mutation === 'note' || mutation === 'note_deleted') noteId = sessions.noteSave({ sessionId, kind: 'work', text: 'original note', type: 'finding' }).id;
      if (mutation === 'note_source' || mutation === 'self_write') noteId = sessions.noteSave({ sessionId, kind: 'work', text: 'conclusion derived from original node',
        sourceRefs: [{ kind: 'node', id: nodeId, version: hash(repo.state.graph!.nodes[nodeId]), tracking: 'current' }] }).id;
      const task = runtime.send({ sessionId, clientMessageId: `audit-${mutation}`, text: 'Read current material and finish.', intent: 'new', targetIds: [], artifactIds: [] });
      await until(() => repo.state.tasks.find(t => t.id === task.id)!.status === 'completed');
      assert.ok(!repo.state.messages.some(m => m.phase === 'final' && m.text === 'STALE RESPONSE'));
      assert.ok(repo.state.messages.some(m => m.phase === 'final' && m.text === 'Verified current result'));
      if(mutation==='self_write'){
        assert.ok(!repo.state.toolCalls.some(c=>c.status==='rejected'));
        assert.equal(repo.state.graph!.nodes[nodeId].content,'own verified update');
        console.log('PASS runtime: exact own-write receipt resolves an older note dependency without discarding other checks');
        continue;
      }
      if (mutation === 'requirements') {
        assert.ok(repo.state.steps.some(s => s.taskId === task.id && s.status === 'aborted'));
        assert.equal(repo.state.tasks.find(t => t.id === task.id)!.appliedInstructionRevision, 2);
        assert.ok(!repo.state.toolCalls.some(c => c.arguments.includes('STALE RESPONSE')));
      } else {
        const rejected = repo.state.toolCalls.find(c => c.name === 'task_finish' && c.status === 'rejected');
        assert.ok(rejected, 'Current finish must reject material changed after request submission');
        assert.match(rejected.result!, mutation === 'canvas' ? /VERSION_CONFLICT/ : /SOURCE_CHANGED/);
      }
      console.log(`PASS runtime: ${mutation} changed in-flight cannot finish as current`);
    } finally { await runtime.dispose(); repo.close(); }
  }

  const repo = new Repository(':memory:');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let requests = 0;
  const runtime = new Runtime(repo, async () => {
    if (++requests === 1) await held;
    return response('task_finish', { text: 'done', basis: 'current' });
  });
  try {
    repo.transaction(s => { s.graph = emptyGraph(); s.provider.model = 'offline-audit'; s.provider.supportsTools = true; });
    repo.credential = 'offline-test-placeholder';
    const sessions = new SessionService(repo), canvasId = repo.state.graph!.canvases[0].canvasId;
    const a = sessions.create({ canvasId }), b = sessions.create({ canvasId });
    const send = (sessionId: string) => runtime.send({ sessionId, clientMessageId: sessionId, text: 'finish', intent: 'new', targetIds: [], artifactIds: [] });
    const first = send(a.id), second = send(b.id);
    await until(() => requests === 1 && repo.state.tasks.find(t => t.id === second.id)!.status === 'waiting_resource');
    assert.equal(repo.state.tasks.find(t => t.id === first.id)!.status, 'running');
    release();
    await until(() => [first, second].every(t => repo.state.tasks.find(v => v.id === t.id)!.status === 'completed'));
    assert.equal(requests, 2);
    console.log('PASS runtime: two writing sessions on one canvas are serialized');
  } finally { release(); await runtime.dispose(); repo.close(); }
}
