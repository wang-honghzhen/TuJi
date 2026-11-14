/** Offline safety regressions for structural moves and exact own-layout advancement. */
import assert from 'node:assert/strict';
import { Repository, hash, now } from '../src/ai/server/repository';
import { Runtime } from '../src/ai/server/runtime';
import { SessionService } from '../src/ai/server/sessions';
import { emptyGraph } from '../src/v3/storage';

export async function runCanvasReview() {
  for (const [readMode,userMoves] of [['none',true],['node',true],['directory',true],['node',false]] as const) {
    const repo = new Repository(':memory:');
    const runtime = new Runtime(repo, async () => { throw new Error('No provider allowed'); });
    const internal = runtime as any;
    internal.kick = () => {};
    try {
      repo.transaction(s => { s.graph = emptyGraph(); s.provider.model = 'offline-audit'; s.provider.supportsTools = true; });
      const canvasId = repo.state.graph!.canvases[0].canvasId;
      const create = (type: string, name: string) => runtime.mutateGraph({ canvasId, command: { type, parentId: canvasId, name, content: name } });
      const node = (await create('createNode', 'target')).id!;
      const intended = (await create('createSubgraph', 'AI destination')).id!;
      const manual = (await create('createSubgraph', 'User destination')).id!;
      const session = new SessionService(repo).create({ canvasId });
      const task = runtime.send({ sessionId: session.id, clientMessageId: `review-${readMode}`, text: `Move ${node} to ${intended}`, intent: 'new' });
      task.status = 'running'; task.fencingToken = 1; task.startedAt = now();
      const resources = internal.taskResources(task);
      internal.active.set(task.id, { resources, controller: new AbortController(), fence: 1 });
      resources.forEach((r: string) => internal.claims.set(r, task.id));
      let requests = 0;
      let proposal: any;
      let refreshed = false;
      const reply = (name: string, args: object) => ({ text: '', toolCalls: [{ id: `review-${requests}`, name, arguments: JSON.stringify(args) }] });
      internal.modelCaller = async () => {
        const phase = requests++;
        assert.ok(phase < 6, 'Audit must terminate');
        if (readMode !== 'none' && phase === 0) {
          const read=reply(readMode === 'node' ? 'graph_read' : 'graph_read_directory', readMode === 'node' ? { refs: [node] } : {});
          if(readMode==='node')read.toolCalls.push({id:`review-${requests}-path`,name:'graph_read_object_field',arguments:JSON.stringify({refId:intended,field:'path'})});
          return read;
        }
        const movePhase = readMode === 'none' ? 0 : 1;
        if (phase === movePhase) {
          if(userMoves){
            await runtime.mutateGraph({ canvasId, command: { type: 'moveCanvasItems', ids: [node], parentId: manual } });
            assert.ok(repo.state.graph!.canvases[0].directories[manual].childIds.includes(node));
          }
          return reply('graph_propose_changes', { commands: [{ type: 'move', ids: [node], parentId: intended }], reason: 'Move according to the earlier request', dependencyRefs: [] });
        }
        if (phase === movePhase + 1) {
          proposal = repo.state.toolCalls.find(c => c.name === 'graph_propose_changes');
          if (proposal.status === 'completed') return reply('graph_apply_changes', { changeSetId: repo.state.changes.at(-1)!.id });
          refreshed = true;
          return reply('graph_read', { refs: [node] });
        }
        return reply('task_finish', { text: 'Audit complete', outcome: 'success', basis: 'current' });
      };
      await internal.run(task.id);
      const inAiDestination = repo.state.graph!.canvases[0].directories[intended].childIds.includes(node);
      assert.equal(task.status, 'completed', task.error);
      if (userMoves) {
        assert.equal(proposal.status, 'rejected'); assert.match(proposal.result, readMode==='node'?/VERSION_CONFLICT/:/READ_REQUIRED/);
        assert.equal(inAiDestination, false); assert.equal(refreshed, true);
        assert.ok(repo.state.graph!.canvases[0].directories[manual].childIds.includes(node));
        console.log(`SAFE: ${readMode} read cannot replace an in-flight user classification; reread permits finish`);
      } else {
        assert.equal(proposal.status, 'completed', proposal.result); assert.equal(inAiDestination, true);
        assert.equal(repo.state.changes.at(-1)?.status, 'committed');
        console.log('SAFE: delivered current node and destination paths permit structural classification');
      }
    } finally { repo.close(); }
  }

  for(const userMoves of [false,true]) {
    const repo = new Repository(':memory:');
    const runtime = new Runtime(repo, async () => { throw new Error('No provider allowed'); });
    const internal = runtime as any; internal.kick = () => {};
    try {
      repo.transaction(s => { s.graph = emptyGraph(); s.provider.model = 'offline-audit'; s.provider.supportsTools = true; });
      const canvasId = repo.state.graph!.canvases[0].canvasId;
      const create = async (name: string) => (await runtime.mutateGraph({ canvasId, command: { type: 'createNode', parentId: canvasId, name, content: name } })).id!;
      const first = await create('A'), second = await create('B');
      const session = new SessionService(repo).create({ canvasId });
      const task = runtime.send({ sessionId: session.id, clientMessageId: 'review-own-layout', text: 'Move A and B', intent: 'new' });
      task.status = 'running'; task.fencingToken = 1; task.startedAt = now();
      const resources = internal.taskResources(task);
      internal.active.set(task.id, { resources, controller: new AbortController(), fence: 1 });
      resources.forEach((r: string) => internal.claims.set(r, task.id));
      let requests = 0, manualPlacement='';
      const call = (name: string, args: object, index = 0) => ({ id: `layout-${requests}-${index}`, name, arguments: JSON.stringify(args) });
      const propose = (id: string, index = 0) => call('graph_propose_changes', { commands: [{ type: 'moveBlock', id, point: { x: 800, y: 500 } }], reason: 'Offline consecutive own positioning', dependencyRefs: [] }, index);
      internal.modelCaller = async () => {
        const phase = requests++; assert.ok(phase < 6);
        if(userMoves&&phase===0)return {text:'',toolCalls:[call('graph_read',{refs:[first]})]};
        const proposalPhase=userMoves?1:0;
        if (phase === proposalPhase) return { text: '', toolCalls: [userMoves
          ?call('graph_propose_changes',{commands:[{type:'updateNodeText',id:first,field:'content',value:'Z'}],reason:'Own body write before geometry',dependencyRefs:[]})
          :propose(first)] };
        if (phase === proposalPhase+1) {
          if(userMoves){
            await runtime.mutateGraph({canvasId,command:{type:'moveBlock',id:second,parentId:canvasId,point:{x:420,y:260}}});
            manualPlacement=hash(repo.state.graph!.canvases[0].placements[second]);
          }
          return { text: '', toolCalls: [call('graph_apply_changes', { changeSetId: repo.state.changes.at(-1)!.id }), propose(second, 1)] };
        }
        if (!userMoves&&phase === proposalPhase+2) return { text: '', toolCalls: [call('graph_apply_changes', { changeSetId: repo.state.changes.at(-1)!.id })] };
        return { text: '', toolCalls: [call('task_finish', { text: 'Audit complete', basis: 'current', outcome: 'success' })] };
      };
      await internal.run(task.id);
      assert.equal(task.status, 'completed', task.error);
      assert.equal(repo.state.changes[0].status, 'committed');
      if(userMoves){
        assert.equal(repo.state.changes.length,1);assert.equal(repo.state.graph!.nodes[first].content,'Z');
        const rejected=repo.state.toolCalls.filter(c=>c.name==='graph_propose_changes')[1];
        assert.equal(rejected.status,'rejected');assert.match(rejected.result!,/VERSION_CONFLICT/);
        assert.equal(hash(repo.state.graph!.canvases[0].placements[second]),manualPlacement);
        console.log('SAFE: committing own body A never acknowledges the in-flight user positioning of B');
      }else{
        assert.equal(repo.state.changes.length, 2); assert.equal(repo.state.changes[1].status,'committed');
        assert.ok(!repo.state.toolCalls.some(c=>c.status==='rejected'));
        console.log('SAFE: apply move A + propose move B in one response advances only the exact own layout transition');
      }
    } finally { repo.close(); }
  }
}
