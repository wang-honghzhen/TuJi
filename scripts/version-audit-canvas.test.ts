/** Offline regression tests for write fences, scoped layout and user-edit races.
 * No model/API calls; SQLite is in-memory. Run through scripts/test-version-audit.mjs.
 */
import assert from 'node:assert/strict';
import { Repository, hash, now } from '../src/ai/server/repository';
import { Runtime } from '../src/ai/server/runtime';
import { SessionService } from '../src/ai/server/sessions';
import { emptyGraph } from '../src/v3/storage';
import { planMutation } from '../src/ai/server/graph';
import { completeNodeEvidence } from '../src/ai/server/nodeReadEvidence';
import { fullyObservedNodeIds } from '../src/ai/server/canvasReadEvidence';
import { graphIndex } from '../src/ai/server/directGraph';
import type { ToolCallRecord } from '../src/ai/domain';
import { captureNotebookCheck } from '../src/ai/server/notebookChecks';

function fixture() {
  const repo = new Repository(':memory:');
  repo.transaction(s => { s.graph = emptyGraph(); });
  const canvasId = repo.state.graph!.canvases[0].canvasId;
  const nodes: string[] = [];
  for (const name of ['A', 'B']) repo.transaction(s => {
    const next = planMutation(s.graph!, canvasId, { type: 'createNode', parentId: canvasId, name, content: `${name}-original` });
    s.graph = next.state; s.graphRevision++; nodes.push(next.id!);
  });
  const sessions = new SessionService(repo), session = sessions.create({ canvasId });
  const runtime = new Runtime(repo, async () => { throw new Error('Audit must not call a model'); });
  const internal = runtime as any;
  internal.kick = () => {};
  const task = runtime.send({ sessionId: session.id, clientMessageId: 'audit', text: 'Edit A and B', intent: 'new' });
  task.status = 'running'; task.fencingToken = 1;
  task.checkpoint = { stepId: 'audit-step', operationIds: [], protocol: [], instructionRevision: 1, lastSeq: repo.state.lastSeq };
  task.readHashes = Object.fromEntries(nodes.map(id => [`nodes:${id}`, hash(repo.state.graph!.nodes[id])]));
  task.nodeReadEvidence = Object.fromEntries(nodes.map(id => [id, completeNodeEvidence(repo.state.graph!.nodes[id])]));
  task.responseReadHashes = { stepId: 'audit-step', hashes: { ...task.readHashes } };
  repo.state.contextManifests.push({id:'audit-manifest',taskId:task.id,stepId:'audit-step',currentSources:[],sourceClosure:[],
    notebookCheck:captureNotebookCheck(repo.state,task),canvasReadHashes:{...task.readHashes},canvasChecks:[]} as any);
  repo.state.steps.push({ id: 'audit-step', taskId: task.id, runId: 'audit-run', ordinal: 1, purpose: 'agent', status: 'completed',
    inputInstructionRevision: 1, contextManifestId: 'audit-manifest', provider: 'offline', model: 'offline', createdAt: now() });
  const resources = internal.taskResources(task);
  internal.active.set(task.id, { resources, controller: new AbortController(), fence: 1 });
  for (const resource of resources) internal.claims.set(resource, task.id);
  let sequence = 0;
  const tool = async (name: string, args: Record<string, unknown>) => {
    const id = `audit-call-${++sequence}`;
    const call: ToolCallRecord = { id, providerCallId: id, taskId: task.id, stepId: 'audit-step', operationId: `audit-op-${sequence}`,
      name, arguments: JSON.stringify(args), argumentVersion: 2, status: 'prepared', createdAt: now() };
    repo.state.toolCalls.push(call);
    return internal.executeTool(task, call);
  };
  const propose = (ref: string, value: string) => tool('graph_propose_changes', {
    commands: [{ type: 'updateNodeText', id: ref, field: 'content', value }], reason: 'offline version audit', dependencyRefs: [] });
  const userEdit = (ref: string, value: string) => runtime.mutateGraph({ canvasId,
    command: { type: 'updateNodeText', id: ref, field: 'content', value } });
  return { repo, runtime, internal, task, nodes, canvasId, sessions, tool, propose, userEdit };
}

export async function testCanvasVersions() {
  const findings: string[] = [];
  {
    const f=fixture();try{
      const result=await f.tool('graph_propose_changes',{commands:[{type:'moveBlock',id:f.nodes[0],point:{x:800,y:500}}],reason:'audit',dependencyRefs:[]});
      assert.equal(result.code,'VERSION_BINDING_REQUIRED');
      findings.push('PASS: legacy coordinate writes without a request-bound geometry version fail closed');
    }finally{f.repo.close();}
  }
  for(const userMoves of [false,true]){
    const f=fixture();try{
      f.repo.state.steps=[];f.task.readHashes={};delete f.task.nodeReadEvidence;delete f.task.responseReadHashes;
      f.task.startedAt=now();let request=0,manualPlacement='';
      const call=(name:string,args:Record<string,unknown>)=>({id:`geometry-${request}`,name,arguments:JSON.stringify(args)});
      f.internal.modelCaller=async()=>{
        const phase=request++;assert.ok(phase<4,'geometry mock must settle');
        if(phase===0){
          assert.ok(f.repo.state.contextManifests.at(-1)?.mutationLayoutVersion);
          if(userMoves){
            await f.runtime.mutateGraph({canvasId:f.canvasId,command:{type:'moveBlock',id:f.nodes[0],parentId:f.canvasId,point:{x:420,y:260}}});
            manualPlacement=hash(f.repo.state.graph!.canvases.find(c=>c.canvasId===f.canvasId)!.placements[f.nodes[0]]);
          }
          return {text:'',toolCalls:[call('graph_propose_changes',{commands:[{type:'moveBlock',id:f.nodes[0],point:{x:800,y:500}}],reason:'audit geometry',dependencyRefs:[]})]};
        }
        if(phase===1){
          if(userMoves){
            const rejected=f.repo.state.toolCalls.find(c=>c.name==='graph_propose_changes')!;
            assert.equal(rejected.status,'rejected');assert.match(rejected.result!,/VERSION_CONFLICT/);
            assert.equal(hash(f.repo.state.graph!.canvases.find(c=>c.canvasId===f.canvasId)!.placements[f.nodes[0]]),manualPlacement);
          }else{
            const proposal=f.repo.state.changes.find(c=>c.taskId===f.task.id)!;assert.equal(proposal?.status,'proposed');
            return {text:'',toolCalls:[call('graph_apply_changes',{changeSetId:proposal.id})]};
          }
        }
        return {text:'',toolCalls:[call('task_finish',{text:userMoves?'The user move was preserved.':'Coordinate update committed.',outcome:'success',basis:'current'})]};
      };
      await f.internal.run(f.task.id);
      assert.equal(f.task.status,'completed',f.task.error);
      if(userMoves){assert.equal(f.repo.state.changes.length,0);assert.equal(request,2);}
      else {assert.equal(f.repo.state.changes[0].status,'committed');assert.equal(request,3);}
      findings.push(userMoves?'PASS real run: in-flight user positioning invalidates stale coordinate writes and is preserved':'PASS real run: unchanged request geometry permits a coordinate write');
    }finally{f.repo.close();}
  }
  {
    const f=fixture();try{
      const sub=await f.runtime.mutateGraph({canvasId:f.canvasId,command:{type:'createSubgraph',parentId:f.canvasId,name:'protected subgraph',content:'must read me'}});
      const child=await f.runtime.mutateGraph({canvasId:f.canvasId,command:{type:'createNode',parentId:sub.id,name:'child',content:'hidden child'}});
      const deliver=async(name:string,args:Record<string,unknown>)=>{
        const result=await f.tool(name,args);assert.equal(result.status,'ok',JSON.stringify(result));
        const observations=f.repo.state.workspaces.find(w=>w.id===f.task.workspaceId)!.observations??[];
        f.task.responseReadHashes!.observations=structuredClone(observations);
        for(const observation of observations)Object.assign(f.task.readHashes!,observation.readHashes);
        for(const ref of fullyObservedNodeIds(graphIndex(f.repo.state,f.canvasId),observations))
          (f.task.nodeReadEvidence??={})[ref]=completeNodeEvidence(f.repo.state.graph!.nodes[ref]);
      };
      await deliver('graph_read_directory',{refId:sub.id});
      const remove=()=>f.tool('graph_propose_changes',{commands:[{type:'deleteSubgraph',id:sub.id,mode:'cascade'}],reason:'audit',dependencyRefs:[]});
      assert.equal((await remove()).code,'READ_REQUIRED');
      await deliver('graph_read_subgraph',{refId:sub.id});
      await deliver('graph_read',{refs:[child.id]});
      const proposal=await remove();assert.equal(proposal.status,'proposed',JSON.stringify(proposal));
      assert.equal((await f.tool('graph_apply_changes',{changeSetId:proposal.changeSetId})).status,'committed');
      assert.equal(f.repo.state.graph!.nodes[child.id!],undefined);
      findings.push('PASS: directory identity cannot authorize subtree deletion; complete contents/members permit it');
    }finally{f.repo.close();}
  }
  {
    const f=fixture();try{
      const edge=await f.runtime.mutateGraph({canvasId:f.canvasId,command:{type:'createEdge',input:{sourceNodeId:f.nodes[0],targetNodeId:f.nodes[1],directed:true,edgeContent:'old relation'}}});
      const update=()=>f.tool('graph_propose_changes',{commands:[{type:'updateEdge',id:edge.id,patch:{edgeContent:'new relation'}}],reason:'audit',dependencyRefs:[]});
      assert.equal((await update()).code,'READ_REQUIRED');
      const read=await f.tool('graph_read',{refs:[edge.id]});assert.equal(read.status,'ok',JSON.stringify(read));
      const observations=f.repo.state.workspaces.find(w=>w.id===f.task.workspaceId)!.observations??[];
      f.task.responseReadHashes!.observations=structuredClone(observations);
      for(const observation of observations)Object.assign(f.task.readHashes!,observation.readHashes);
      for(let i=0;i<2;i++){
        const proposal=await update();assert.equal(proposal.status,'proposed',JSON.stringify(proposal));
        assert.equal((await f.tool('graph_apply_changes',{changeSetId:proposal.changeSetId})).status,'committed');
      }
      findings.push('PASS: edge replacement requires actual current edge data and preserves own-write evidence');
    }finally{f.repo.close();}
  }
  {
    const f=fixture();try{
      f.task.nodeReadEvidence![f.nodes[0]].fields.content!.ranges=[[0,2]];
      const result=await f.propose(f.nodes[0],'unread replacement');
      assert.equal(result.code,'READ_REQUIRED');
      assert.equal(f.repo.state.graph!.nodes[f.nodes[0]].content,'A-original');
      findings.push('PASS: whole-node replacement rejects partial delivery even with a current version hash and dependencyRefs empty');
    }finally{f.repo.close();}
  }
  {
    const f=fixture();try{
      for(const [ref,content] of [[f.nodes[0],'A-first'],[f.nodes[0],'A-second'],[f.nodes[1],'B-first']]){
        const proposal=await f.propose(ref,content);assert.equal(proposal.status,'proposed',proposal.message);
        assert.equal((await f.tool('graph_apply_changes',{changeSetId:proposal.changeSetId})).status,'committed');
      }
      assert.equal(f.repo.state.graph!.nodes[f.nodes[0]].content,'A-second');
      assert.equal(f.repo.state.graph!.nodes[f.nodes[1]].content,'B-first');
      findings.push('PASS: same-response consecutive own writes advance exact evidence without false conflicts');
    }finally{f.repo.close();}
  }
  {
    const f=fixture();try{
      const proposal=await f.tool('graph_propose_changes',{commands:[{type:'createNode',name:'owned',content:'created'}],reason:'audit',dependencyRefs:[]});
      assert.equal(proposal.status,'proposed',proposal.message);
      assert.equal((await f.tool('graph_apply_changes',{changeSetId:proposal.changeSetId})).status,'committed');
      const created=Object.keys(f.repo.state.graph!.nodes).find(id=>!f.nodes.includes(id))!;
      const update=await f.propose(created,'updated own new node');assert.equal(update.status,'proposed',update.message);
      assert.equal((await f.tool('graph_apply_changes',{changeSetId:update.changeSetId})).status,'committed');
      findings.push('PASS: successful creation supplies evidence for a subsequent own-node replacement');
    }finally{f.repo.close();}
  }
  {
    const f=fixture();try{
      const proposal=await f.tool('graph_propose_changes',{commands:[{type:'createNode',name:'layout candidate',content:'created'}],reason:'audit',dependencyRefs:[]});
      assert.equal(proposal.status,'proposed');
      await f.userEdit(f.nodes[1],'changed layout dependency');
      assert.equal((await f.tool('graph_apply_changes',{changeSetId:proposal.changeSetId})).code,'VERSION_CONFLICT');
      findings.push('PASS: relevant canvas changes still reject layout commits');
    }finally{f.repo.close();}
  }
  {
    const f=fixture();try{
      const doc=await f.runtime.mutateGraph({canvasId:f.canvasId,command:{type:'createDocument',name:'shared'}});
      await f.runtime.mutateGraph({canvasId:f.canvasId,command:{type:'importDocument',id:doc.id,mode:'reference'}});
      const node=await f.runtime.mutateGraph({canvasId:f.canvasId,command:{type:'createNode',parentId:doc.id,name:'shared child',content:'original'}});
      const other=await f.runtime.mutateGraph({canvasId:f.canvasId,command:{type:'createCanvas',name:'shared view'}});
      await f.runtime.mutateGraph({canvasId:other.id!,command:{type:'importDocument',id:doc.id,mode:'reference'}});
      const resources=f.internal.taskResources(f.task);
      f.internal.active.get(f.task.id).resources=resources;
      for(const resource of resources)f.internal.claims.set(resource,f.task.id);
      const proposal=await f.tool('graph_propose_changes',{commands:[{type:'createNode',name:'layout candidate',content:'created'}],reason:'audit',dependencyRefs:[]});
      assert.equal(proposal.status,'proposed',proposal.message);
      await f.runtime.mutateGraph({canvasId:other.id!,command:{type:'updateNodeText',id:node.id,field:'content',value:'shared edited'}});
      assert.equal((await f.tool('graph_apply_changes',{changeSetId:proposal.changeSetId})).code,'VERSION_CONFLICT');
      findings.push('PASS: shared-document edits through a second canvas remain layout dependencies');
    }finally{f.repo.close();}
  }
  {
    const f = fixture(); try {
      await f.userEdit(f.nodes[1], 'B-user');
      const result = await f.propose(f.nodes[1], 'B-stale-AI');
      assert.equal(result.code, 'VERSION_CONFLICT');
      assert.equal(f.repo.state.graph!.nodes[f.nodes[1]].content, 'B-user');
      findings.push('PASS: stale node read blocks proposal before any earlier AI commit');
    } finally { f.repo.close(); }
  }
  {
    const f = fixture(); try {
      const proposed = await f.propose(f.nodes[0], 'A-AI');
      assert.equal(proposed.status, 'proposed');
      await f.userEdit(f.nodes[0], 'A-user');
      const result = await f.tool('graph_apply_changes', { changeSetId: proposed.changeSetId });
      assert.equal(result.code, 'VERSION_CONFLICT');
      assert.equal(f.repo.state.graph!.nodes[f.nodes[0]].content, 'A-user');
      findings.push('PASS: user editing after proposal blocks stale commit');
    } finally { f.repo.close(); }
  }
  {
    const f = fixture(); try {
      const proposed = await f.propose(f.nodes[0], 'A-AI');
      assert.equal(proposed.status, 'proposed');
      // The next model request knows A's proposal and B's old content. User edits B during it.
      await f.userEdit(f.nodes[1], 'B-user-important');
      const committed = await f.tool('graph_apply_changes', { changeSetId: proposed.changeSetId });
      assert.equal(committed.status, 'committed');
      assert.equal(f.task.readHashes?.[`nodes:${f.nodes[1]}`],hash({ ...f.repo.state.graph!.nodes[f.nodes[1]], content: 'B-original' }));
      // Both calls can occur in one model response; no fresh input/read is delivered between them.
      const second = await f.propose(f.nodes[1], 'B-from-stale-model-input');
      assert.equal(second.code, 'VERSION_CONFLICT');
      assert.equal(f.repo.state.graph!.nodes[f.nodes[1]].content, 'B-user-important');
      findings.push('PASS: committing A preserves B read fence and rejects a stale whole-body replacement');
    } finally { f.repo.close(); }
  }
  {
    const f = fixture(); try {
      const proposed = await f.propose(f.nodes[0], 'A-AI');
      await f.userEdit(f.nodes[1], 'B-user-important');
      assert.equal((await f.tool('graph_apply_changes', { changeSetId: proposed.changeSetId })).status, 'committed');
      const second = await f.tool('graph_propose_changes', { commands: [{ type: 'patchNodeContent', id: f.nodes[1],
        oldText: 'B-original', newText: 'B-AI' }], reason: 'offline audit', dependencyRefs: [] });
      assert.equal(second.code, 'VERSION_CONFLICT');
      findings.push('PASS: patchNodeContent retains a separate full-read fence after commit A');
    } finally { f.repo.close(); }
  }
  {
    const f = fixture(); try {
      const proposed = await f.propose(f.nodes[0], 'A-AI');
      f.runtime.editing(f.nodes[0], 'content', true, 'A-original');
      const result = await f.tool('graph_apply_changes', { changeSetId: proposed.changeSetId });
      assert.equal(result.code, 'USER_EDITING');
      findings.push('PASS: active user editor blocks AI commit');
    } finally { f.repo.close(); }
  }
  {
    const f = fixture(); try {
      const secondSession = f.sessions.create({ canvasId: f.canvasId });
      const second = f.runtime.send({ sessionId: secondSession.id, clientMessageId: 'second', text: 'Edit B', intent: 'new' });
      assert.equal(f.internal.canClaim(second, f.internal.taskResources(second)), false);
      findings.push('PASS: two writable sessions on the same canvas share a resource lock and queue');
    } finally { f.repo.close(); }
  }
  {
    const f = fixture(); try {
      const other = await f.runtime.mutateGraph({ canvasId: f.canvasId, command: { type: 'createCanvas', name: 'unrelated' } });
      const node = await f.runtime.mutateGraph({ canvasId: other.id!, command: { type: 'createNode', parentId: other.id,
        name: 'unrelated node', content: 'other-original' } });
      const proposed = await f.tool('graph_propose_changes', { commands: [{ type: 'createNode', name: 'AI new node', content: 'new' }],
        reason: 'offline independent canvas audit', dependencyRefs: [] });
      assert.equal(proposed.status, 'proposed');
      assert.ok(f.repo.state.changes.find(c => c.id === proposed.changeSetId)?.expectedHashes[`layout-scope:${f.canvasId}`]);
      await f.runtime.mutateGraph({ canvasId: other.id!, command: { type: 'updateNodeText', id: node.id,
        field: 'content', value: 'independent edit' } });
      const result = await f.tool('graph_apply_changes', { changeSetId: proposed.changeSetId });
      assert.equal(result.status, 'committed',result.message);
      assert.equal(f.repo.state.graph!.nodes[node.id!].content,'independent edit');
      findings.push('PASS: unrelated canvas edit neither invalidates the layout proposal nor loses its own content');
    } finally { f.repo.close(); }
  }
  {
    const f = fixture(); try {
      // Exercise the real run loop, graph_read, prompt assembly, read-delivery acknowledgement,
      // and all tool execution paths. Only the remote model is replaced with scripted replies.
      f.repo.state.steps = [];
      f.task.readHashes = {};
      delete f.task.nodeReadEvidence; delete f.task.responseReadHashes;
      f.task.startedAt = now();
      let request = 0, boundB = false;
      const call = (name: string, args: Record<string, unknown>, ordinal = 0) => ({
        id: `mock-${request}-${ordinal}`, name, arguments: JSON.stringify(args) });
      f.internal.modelCaller = async (_provider: unknown, _credential: unknown, input: any) => {
        const phase = request++;
        assert.ok(phase < 6, 'mock run must terminate within six requests');
        if (phase === 0) return { text: '', toolCalls: [call('graph_read', { refs: f.nodes })] };
        if (phase === 1) {
          assert.ok(JSON.stringify(input.messages).includes('B-original'));
          boundB = f.task.readHashes?.[`nodes:${f.nodes[1]}`] === hash(f.repo.state.graph!.nodes[f.nodes[1]]);
          assert.ok(boundB, 'real graph_read and submitted prompt must bind B original version');
          return { text: '', toolCalls: [call('graph_propose_changes', { commands: [{ type: 'updateNodeText', id: f.nodes[0],
            field: 'content', value: 'A-AI' }], reason: 'offline real pipeline audit', dependencyRefs: [] })] };
        }
        if (phase === 2) {
          const first = f.repo.state.changes.find(c => c.taskId === f.task.id)!;
          assert.equal(first?.status, 'proposed');
          assert.ok(JSON.stringify(input.messages).includes('B-original'));
          assert.equal(f.task.readHashes?.[`nodes:${f.nodes[1]}`], hash(f.repo.state.graph!.nodes[f.nodes[1]]));
          await f.userEdit(f.nodes[1], 'B-user-during-real-request');
          return { text: '', toolCalls: [call('graph_apply_changes', { changeSetId: first.id }),
            call('graph_propose_changes', { commands: [{ type: 'updateNodeText', id: f.nodes[1], field: 'content',
              value: 'B-stale-replacement-real-pipeline' }], reason: 'offline real pipeline audit', dependencyRefs: [] }, 1)] };
        }
        if (phase === 3) {
          assert.equal(f.repo.state.changes.filter(c => c.taskId === f.task.id).length,1);
          assert.ok(f.repo.state.toolCalls.some(c=>c.name==='graph_propose_changes'&&c.status==='rejected'&&c.result?.includes('VERSION_CONFLICT')));
          assert.equal(f.repo.state.graph!.nodes[f.nodes[1]].content, 'B-user-during-real-request');
          return { text: '', toolCalls: [call('graph_read', { refs: [f.nodes[1]] })] };
        }
        assert.equal(f.repo.state.graph!.nodes[f.nodes[1]].content, 'B-user-during-real-request');
        return { text: '', toolCalls: [call('task_finish', { text: 'Offline audit complete', outcome: 'success' })] };
      };
      await f.internal.run(f.task.id);
      assert.ok(boundB);
      assert.equal(f.repo.state.graph!.nodes[f.nodes[1]].content, 'B-user-during-real-request');
      assert.equal(f.task.status, 'completed', f.task.error);
      assert.equal(request, 5);
      findings.push('PASS real run loop: stale B write is rejected after A commit; reread permits current completion and preserves user B');
    } finally { f.repo.close(); }
  }
  return findings;
}
