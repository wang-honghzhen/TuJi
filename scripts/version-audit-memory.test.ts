import assert from 'node:assert/strict';
import { Repository, now } from '../src/ai/server/repository';
import { SessionService } from '../src/ai/server/sessions';
import { Runtime } from '../src/ai/server/runtime';
import { emptyGraph } from '../src/v3/storage';
import { directGraphRead } from '../src/ai/server/directGraph';
import { registerSessionTask } from '../src/ai/sessionContext';
import { inheritedReadScope } from '../src/ai/server/inheritedReadScope';
import { allRetainedCalls } from '../src/ai/server/readVisibility';
import { visibleObservations, canvasObservationChanges, pendingCanvasChanges } from '../src/ai/server/contextFreshness';
import { assertGraphReadHashes } from '../src/ai/server/graphReadDependencies';
import { synchronizeRetentionStage } from '../src/ai/server/retentionCommit';
import { allEvidence, fullCoverage, makeSummary } from '../src/ai/server/historyRepresentations';
import type { Session, Task, ToolCallRecord } from '../src/ai/domain';

// Offline regression tests: no model client, credentials, disk database, or API requests.
export async function testMemoryAudit() {
  const repo = new Repository(':memory:');
  const runtime = new Runtime(repo, async () => { throw new Error('Network/model calls forbidden in this audit'); });
  const sessions = new SessionService(repo, (state, session) => runtime.assembleCreatedSession(state, session));
  let counter = 0;
  function addTask(session: Session, status: Task['status']): Task {
    const id = `audit-task-${++counter}`, timestamp = now();
    const task: Task = { id, sessionId: session.id, workspaceId: session.workspaceId, canvasId: session.canvasId,
      rootUserMessageId: `${id}-user`, clientRequestId: id, instructionRevision: 1, appliedInstructionRevision: 1,
      status, createdAt: timestamp, updatedAt: timestamp, inputBindings: {targetIds: [], artifactIds: [], artifactVersions: {}},
      maxSteps: 50, maxTokens: 500000, usedTokens: 0, stepCount: 1, fencingToken: 0 };
    repo.state.tasks.push(task);
    repo.state.messages.push({id:task.rootUserMessageId, taskId:id, workspaceId:session.workspaceId, role:'user', text:'Read the node and remember its contents.',
      version:1,status:'complete',phase:'request',createdAt:timestamp,sequence:counter*10,targetRefs:[],sourceRefs:[],relatedOperationIds:[]});
    registerSessionTask(repo.state,session.id,id);
    return task;
  }
  try {
    repo.transaction(state => {
      state.graph = emptyGraph();
      state.graph.nodes['audit-node']={nodeId:'audit-node',name:'Audit node',content:'OLD BODY'};
      state.graph.canvases[0].childIds.push('audit-node');
    });
    const canvasId = repo.state.graph!.canvases[0].canvasId;
    const source = sessions.create({canvasId,title:'Audit source'});
    const old = addTask(source,'completed');
    const read: ToolCallRecord = {id:'audit-read',providerCallId:'audit-read',operationId:'audit-operation',taskId:old.id,stepId:'audit-step',
      name:'graph_read',arguments:JSON.stringify({refs:['audit-node']}),status:'prepared',createdAt:now(),sequence:11};
    repo.state.toolCalls.push(read);
    repo.state.steps.push({id:read.stepId,taskId:old.id,runId:'audit-run',ordinal:1,purpose:'agent',status:'completed',inputInstructionRevision:1,
      contextManifestId:'audit-parent-manifest',provider:repo.state.provider.protocol,model:repo.state.provider.model,createdAt:now(),completedSequence:12});
    read.result=JSON.stringify(directGraphRead(repo.state,old,read,{refs:['audit-node']})); read.status='completed';
    assert.ok(read.result.includes('OLD BODY'));
    assert.ok(read.canvasOrigins?.length, 'Use real bound read evidence, not fabricated observations');
    const sourceManifest=runtime.previewState(repo.state,old,undefined,{phase:'task_end'});
    assert.ok(sourceManifest.canvasReadHashes?.['nodes:audit-node'], 'Control: locally read node retains its guard');
    // A source whose completed turn has not been sealed is a supported reassembly path.
    const child = sessions.create({canvasId,title:'Selected memory child',orderedTasks:[{sessionId:source.id,taskId:old.id}]});
    const workspace=repo.state.workspaces.find(w=>w.id===child.workspaceId)!;
    assert.equal(workspace.inheritanceStatus?.reused,false);
    const current = addTask(child,'running');
    const manifest=runtime.previewState(repo.state,current);
    assert.equal(manifest.error,undefined);
    assert.ok(manifest.messages.some(m=>m.content.includes('OLD BODY')), 'Inherited node body is actually in model input');
    const scoped=inheritedReadScope(repo.state,current);
    assert.equal(scoped.toolCalls.some(c=>c.id===read.id),false);
    assert.ok(allRetainedCalls(scoped).some(c=>c.id===read.id));
    const intended=visibleObservations(manifest.stageDraft!,workspace.observations??[],current,allRetainedCalls(scoped),scoped);
    assert.ok(intended.some(o=>o.sources.some(s=>s.id==='audit-node')), 'The existing evidence resolver can recover inherited sources');
    assert.equal(manifest.canvasSources?.some(s=>s.id==='audit-node'),true,
      'Inherited source bindings must be present in the submitted manifest');
    assert.ok(manifest.canvasReadHashes?.['nodes:audit-node']);
    assert.equal(manifest.canvasChecks?.some(o=>o.sources.some(s=>s.id==='audit-node')),true);
    for (const mode of ['refactor','compact'] as const) {
      const rebuilt=runtime.previewState(repo.state,current,undefined,{mode});
      assert.equal(rebuilt.error,undefined);
      assert.ok(rebuilt.messages.some(m=>m.content.includes('OLD BODY')));
      assert.ok(rebuilt.canvasReadHashes?.['nodes:audit-node'], `${mode} must retain inherited node version guards`);
    }

    // Control: exact prompt reuse copies the parent's observation store and remains protected.
    repo.state.workspaces.find(w=>w.id===source.workspaceId)!.contextStage=sourceManifest.stageDraft;
    const exact=sessions.create({canvasId,title:'Exact-memory control',orderedTasks:[{sessionId:source.id,taskId:old.id}]});
    const exactTask=addTask(exact,'running');
    const exactManifest=runtime.previewState(repo.state,exactTask);
    assert.equal(repo.state.workspaces.find(w=>w.id===exact.workspaceId)!.inheritanceStatus?.reused,true);
    assert.ok(exactManifest.canvasReadHashes?.['nodes:audit-node']);

    // The node is changed after the request is built, as in a user edit during model generation.
    repo.transaction(state=>{ state.graph=structuredClone(state.graph!);state.graph.nodes['audit-node'].content='NEW BODY';state.graphRevision++; });
    assert.equal(synchronizeRetentionStage(repo.state,current,manifest.stageDraft!),false,
      'PASS: a prepared request is invalidated if the edit happens before request submission');
    assert.ok(intended.some(o=>canvasObservationChanges(repo.state,o).length), 'Inherited evidence correctly identifies the change when supplied');
    assert.throws(()=>assertGraphReadHashes(repo.state.graph!,exactManifest.canvasReadHashes??{},'audit',canvasId),
      'Control: exact reused prompt does detect the concurrent body edit');
    assert.throws(()=>assertGraphReadHashes(repo.state.graph!,manifest.canvasReadHashes??{},'audit',canvasId));
    assert.ok(manifest.canvasChecks?.flatMap(o=>canvasObservationChanges(repo.state,o)).length,
      'The exact checks used by task_finish must detect inherited source edits');
    const later=runtime.previewState(repo.state,current);
    assert.ok(pendingCanvasChanges(inheritedReadScope(repo.state,current),current,later.stageDraft!).size>0,
      'PASS: a subsequent prompt DOES report the inherited source change');
    assert.ok(later.canvasPendingChanges?.length,'An already stale visible body must remain an explicit completion blocker');

    const record=allEvidence(repo.state,current).find(r=>r.id===read.id)!;
    const compacted=makeSummary('task','The remembered node said OLD BODY.',[fullCoverage(record)],[],record.sources);
    workspace.summaries=[compacted];
    const summaryManifest=runtime.previewState(repo.state,current,undefined,{mode:'compact'});
    assert.ok(summaryManifest.stageDraft?.entries.some(e=>e.id===`summary:${compacted.id}:${compacted.version}`),
      'The actual compaction builder must deliver the summary body');
    assert.ok(summaryManifest.currentSources?.some(s=>s.id==='audit-node'),
      'Summary-only material must retain the original node dependency without granting a full read');
    assert.equal(summaryManifest.canvasReadHashes?.['nodes:audit-node'],undefined,'A summary must not grant full-node write evidence');
    assert.ok(summaryManifest.messages.some(m=>m.content.includes('摘要依据变动')));

    // Exercise the real task_finish branch with the same manifest, bypassing only the network loop.
    const finish: ToolCallRecord={id:'audit-finish',providerCallId:'audit-finish',operationId:'audit-finish-operation',taskId:current.id,stepId:'audit-finish-step',
      name:'task_finish',arguments:'{}',status:'prepared',createdAt:now()};
    manifest.stepId=finish.stepId;repo.state.contextManifests.push(manifest);repo.state.toolCalls.push(finish);
    repo.state.steps.push({id:finish.stepId,taskId:current.id,runId:'audit-run-2',ordinal:1,purpose:'agent',status:'streaming',inputInstructionRevision:1,
      contextManifestId:manifest.id,provider:repo.state.provider.protocol,model:repo.state.provider.model,createdAt:now()});
    assert.throws(()=>repo.transaction(()=>(runtime as any).tool(current,finish,{outcome:'success',basis:'current',text:'The current node body is OLD BODY.'})),
      (e:any)=>e.code==='VERSION_CONFLICT');
    assert.notEqual(repo.state.tasks.find(t=>t.id===current.id)?.status,'completed');
    console.log('PASS: selected-memory append/refactor/compact and exact fork retain inherited checks; stale current-basis finish is rejected.');
    console.log('PASS: pre-submission fence, later concise notice and unresolved-evidence blockers agree.');
  } finally { await runtime.dispose(); repo.close(); }
  await inheritedWriteControl();
}

/** A safe inherited full body must allow writing without a redundant reread. */
async function inheritedWriteControl() {
  const repo=new Repository(':memory:');
  let requests=0,childTaskId='',nodeId='';
  const runtime=new Runtime(repo,async (_provider,_credential,input)=>{
    const request=++requests;
    const call=(name:string,args:Record<string,unknown>)=>({text:'',finishReason:'tool_calls',
      toolCalls:[{id:`inherited-write-response-${request}`,name,arguments:JSON.stringify(args)}]});
    if(request===1){
      assert.ok(input.messages.some(m=>m.content.includes('INHERITED ORIGINAL')),'Original inherited body is actually in the first request');
      assert.ok(repo.state.tasks.find(t=>t.id===childTaskId)?.readHashes?.[`nodes:${nodeId}`]);
      return call('graph_propose_changes',{commands:[{type:'updateNodeText',id:nodeId,field:'content',value:'OWN WRITE RESULT'}],
        reason:'Update the complete current body inherited from selected memory',dependencyRefs:[]});
    }
    if(request===2){
      const proposal=repo.state.changes.find(c=>c.taskId===childTaskId);
      assert.equal(proposal?.status,'proposed',JSON.stringify(repo.state.toolCalls.filter(c=>c.taskId===childTaskId).map(c=>c.result)));
      return call('graph_apply_changes',{changeSetId:proposal!.id});
    }
    assert.equal(request,3,'Own-write receipts should make current finish possible without rereading');
    assert.equal(repo.state.graph!.nodes[nodeId].content,'OWN WRITE RESULT');
    const submitted=repo.state.contextManifests.filter(m=>m.taskId===childTaskId).at(-1)!;
    assert.deepEqual(submitted.canvasPendingChanges,[],'Successful own write must not produce stale inherited-evidence blockers');
    assert.ok(!submitted.items.some(i=>i.category==='version_notices'&&/画布变动|版本无法确认/.test(i.text)),
      'Own writes must not generate a false stale-canvas notification');
    return call('task_finish',{text:'Inherited current body updated successfully.',outcome:'success',basis:'current'});
  });
  try{
    repo.transaction(state=>{
      state.graph=emptyGraph();state.provider.model='offline-memory-control';state.provider.supportsTools=true;
    });
    const canvasId=repo.state.graph!.canvases[0].canvasId;
    nodeId=(await runtime.mutateGraph({canvasId,command:{type:'createNode',parentId:canvasId,name:'Inherited write',content:'INHERITED ORIGINAL'}})).id!;
    const sessions=new SessionService(repo,(state,session)=>runtime.assembleCreatedSession(state,session));
    const source=sessions.create({canvasId,title:'Original read'}),stamp=now();
    const old:Task={id:'inherited-write-old-task',sessionId:source.id,workspaceId:source.workspaceId,canvasId,
      rootUserMessageId:'inherited-write-old-user',clientRequestId:'inherited-write-old',instructionRevision:1,appliedInstructionRevision:1,
      status:'completed',createdAt:stamp,updatedAt:stamp,inputBindings:{targetIds:[],artifactIds:[],artifactVersions:{}},
      maxSteps:50,maxTokens:500000,usedTokens:0,stepCount:1,fencingToken:0};
    repo.state.tasks.push(old);registerSessionTask(repo.state,source.id,old.id);
    repo.state.messages.push({id:old.rootUserMessageId,taskId:old.id,workspaceId:source.workspaceId,role:'user',text:'Read and remember this node.',
      version:1,status:'complete',phase:'request',createdAt:stamp,sequence:1,targetRefs:[],sourceRefs:[],relatedOperationIds:[]});
    const read:ToolCallRecord={id:'inherited-write-read',providerCallId:'inherited-write-read',operationId:'inherited-write-op',taskId:old.id,stepId:'inherited-write-step',
      name:'graph_read',arguments:JSON.stringify({refs:[nodeId]}),status:'prepared',createdAt:stamp,sequence:2};
    repo.state.toolCalls.push(read);
    repo.state.steps.push({id:read.stepId,taskId:old.id,runId:'inherited-write-run',ordinal:1,purpose:'agent',status:'completed',inputInstructionRevision:1,
      contextManifestId:'inherited-write-old-manifest',provider:repo.state.provider.protocol,model:repo.state.provider.model,createdAt:stamp,completedSequence:3});
    read.result=JSON.stringify(directGraphRead(repo.state,old,read,{refs:[nodeId]}));read.status='completed';
    const child=sessions.create({canvasId,title:'Inherited write control',orderedTasks:[{sessionId:source.id,taskId:old.id}]});
    assert.equal(repo.state.workspaces.find(w=>w.id===child.workspaceId)?.inheritanceStatus?.reused,false);
    repo.credential='offline-placeholder';
    const task=runtime.send({sessionId:child.id,clientMessageId:'inherited-write-new',text:'Update the inherited node and finish.',intent:'new'});childTaskId=task.id;
    const deadline=Date.now()+15000;
    while(repo.state.tasks.find(t=>t.id===task.id)?.status!=='completed'){
      assert.ok(Date.now()<deadline,JSON.stringify({task:repo.state.tasks.find(t=>t.id===task.id),calls:repo.state.toolCalls.filter(c=>c.taskId===task.id).map(c=>c.result)}));
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    assert.equal(requests,3);
    assert.ok(!repo.state.toolCalls.some(c=>c.taskId===task.id&&c.name.startsWith('graph_read')),'No redundant graph reread was needed');
    console.log('PASS: selected-memory full-body inheritance permits propose/apply/current-finish without rereading or false stale notifications.');
  }finally{await runtime.dispose();repo.close();}
}
