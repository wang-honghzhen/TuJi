import assert from 'node:assert/strict';
import { Repository, now, hash } from '../src/ai/server/repository';
import { Runtime } from '../src/ai/server/runtime';
import { SessionService } from '../src/ai/server/sessions';
import { prepareAutomaticContext } from '../src/ai/server/automaticCompaction';
import { taskSummaryUnits } from '../src/ai/server/taskSummaryEngine';
import { registerSessionTask } from '../src/ai/sessionContext';
import { emptyGraph } from '../src/v3/storage';
import type { Session, Task, ToolCallRecord } from '../src/ai/domain';
import type { callModel } from '../src/ai/server/providers';
import { sourceChanges } from '../src/ai/server/sourceFreshness';

/** Real automatic compaction, deterministic local model responses, isolated in-memory data. */
export async function testMemoryReview() {
  for (const mutation of ['none', 'unrelated_canvas', 'unrelated_notebook', 'runtime_unrelated_canvas',
    'runtime_unrelated_notebook', 'related_canvas', 'input_edit', 'repeated_input_edit', 'provider_failure_after_edit'] as const) {
    const repo = new Repository(':memory:');
    let caller:typeof callModel=async()=>{throw new Error('Caller not initialized');};
    const runtime = new Runtime(repo, (...args) => caller(...args));
    try {
      repo.transaction(state => {
        state.graph = emptyGraph();
        state.graph.canvases.push({ ...structuredClone(state.graph.canvases[0]), canvasId: 'unrelated-canvas', childIds: [] });
        state.provider = {...state.provider,contextWindow:50000,maxOutputTokens:4096,apiFamily:undefined,model:'offline-summary'};
      });
      const canvasId=repo.state.graph!.canvases[0].canvasId;
      const sourceId=(await runtime.mutateGraph({canvasId,command:{type:'createNode',parentId:canvasId,name:'Summary source',content:'ORIGINAL SOURCE'}})).id!;
      const unrelatedId=(await runtime.mutateGraph({canvasId:'unrelated-canvas',command:{type:'createNode',parentId:'unrelated-canvas',name:'Unrelated',content:'Unchanged'}})).id!;
      const sessions = new SessionService(repo, (state, session) => runtime.assembleCreatedSession(state, session));
      const session = sessions.create({canvasId:repo.state.graph!.canvases[0].canvasId,title:'Summary fence audit'});
      const unrelated = sessions.create({canvasId:'unrelated-canvas',title:'Independent notebook'});
      const addTask = (owner:Session,id:string,status:Task['status']):Task => {
        const stamp=now();
        const task:Task={id,sessionId:owner.id,workspaceId:owner.workspaceId,canvasId:owner.canvasId,
          rootUserMessageId:`${id}-user`,clientRequestId:id,instructionRevision:1,appliedInstructionRevision:1,
          status,createdAt:stamp,updatedAt:stamp,inputBindings:{targetIds:[],artifactIds:[],artifactVersions:{}},
          maxSteps:50,maxTokens:500000,usedTokens:0,stepCount:1,fencingToken:0};
        repo.state.tasks.push(task);registerSessionTask(repo.state,owner.id,id);
        repo.state.messages.push({id:task.rootUserMessageId,taskId:id,workspaceId:owner.workspaceId,role:'user',text:'Remember the completed discussion.',
          version:1,status:'complete',phase:'request',createdAt:stamp,sequence:id==='old'?1:20,targetRefs:[],sourceRefs:[],relatedOperationIds:[]});
        return task;
      };
      const old=addTask(session,'old','completed');
      if(mutation==='related_canvas')repo.state.workspaces.find(w=>w.id===session.workspaceId)!.progressEvents=[{
        id:'source-progress',taskId:old.id,version:1,text:'The source node says ORIGINAL SOURCE.',sequence:2,createdAt:now(),
        sourceRefs:[{kind:'node',id:sourceId,version:hash(repo.state.graph!.nodes[sourceId])}]}];
      for(let ordinal=1;ordinal<=2;ordinal++) {
        const stepId=`history-step-${ordinal}`,stamp=now();
        repo.state.steps.push({id:stepId,taskId:old.id,runId:'history-run',ordinal,purpose:'agent',status:'completed',inputInstructionRevision:1,
          contextManifestId:'old-manifest',provider:repo.state.provider.protocol,model:repo.state.provider.model,createdAt:stamp,completedSequence:ordinal*3+1});
        repo.state.messages.push({id:`history-answer-${ordinal}`,taskId:old.id,workspaceId:old.workspaceId,stepId,role:'assistant',
          text:`Completed discussion ${ordinal}: `+'Long but valid historical material. '.repeat(1400),version:1,status:'complete',phase:'final',
          createdAt:stamp,sequence:ordinal*3,targetRefs:[],sourceRefs:[],relatedOperationIds:[]});
      }
      let calls=0,executionCalls=0;
      caller=async (_provider,_credential,input)=> {
          if(input.tools?.length) {
            executionCalls++;
            return {text:'',finishReason:'tool_calls',toolCalls:[{id:'finish-after-summary',name:'task_finish',arguments:JSON.stringify({text:'Done.',outcome:'success',basis:'current'})}]};
          }
          calls++;
          const request=JSON.parse(input.messages[1].content);
          if(['unrelated_canvas','runtime_unrelated_canvas','provider_failure_after_edit'].includes(mutation))await runtime.mutateGraph({canvasId:'unrelated-canvas',command:{type:'updateNodeText',id:unrelatedId,field:'content',value:'Edited during summary'}});
          if(mutation==='unrelated_notebook'||mutation==='runtime_unrelated_notebook')sessions.noteSave({sessionId:unrelated.id,kind:'work',text:'Independent note during summary'});
          if(mutation==='related_canvas')await runtime.mutateGraph({canvasId:session.canvasId,command:{type:'updateNodeText',id:sourceId,field:'content',value:'NEW SOURCE'}});
          if(mutation==='input_edit'&&calls===1||mutation==='repeated_input_edit')repo.transaction(state=>{
            const record=state.messages.find(m=>m.id==='history-answer-1')!;record.text+=` Changed source revision ${calls}.`;record.version++;
          });
          if(mutation==='provider_failure_after_edit')throw new Error('Simulated provider failure after concurrent edit');
          return {text:JSON.stringify({summaries:request.tasks.map((t:any)=>({taskId:t.taskId,unitIds:t.units.map((u:any)=>u.id),summary:`Summary response ${calls}: two completed historical discussions.`}))}),
            toolCalls:[],finishReason:'stop',outputTokens:20};
        };
      if(mutation==='runtime_unrelated_canvas'||mutation==='runtime_unrelated_notebook') {
        repo.credential='offline-placeholder';
        const task=runtime.send({sessionId:session.id,clientMessageId:'runtime-summary-fence',text:'Continue the discussion.',intent:'new'});
        const deadline=Date.now()+15000;
        while(!['waiting_user','failed','completed','paused'].includes(repo.state.tasks.find(t=>t.id===task.id)!.status)) {
          assert.ok(Date.now()<deadline,JSON.stringify(repo.state.tasks.find(t=>t.id===task.id)));
          await new Promise(resolve=>setTimeout(resolve,5));
        }
        const stopped=repo.state.tasks.find(t=>t.id===task.id)!;
        assert.equal(calls,1);
        assert.equal(stopped.status,'completed',JSON.stringify(stopped));
        assert.equal(executionCalls,1);
        assert.equal(repo.state.workspaces.find(w=>w.id===session.workspaceId)!.summaries?.length,1);
        console.log(`PASS ${mutation}: task completed with one retained summary and no provider retry.`);
        continue;
      }
      const task=addTask(session,'current','running');
      assert.equal(taskSummaryUnits(repo.state,task,old.id).units.length,2);
      const before=runtime.previewState(repo.state,task);
      let result:ReturnType<Runtime['previewState']>|undefined,failure:any;
      try {
        result=await prepareAutomaticContext({repo,task,signal:new AbortController().signal,guard:()=>{},
          build:options=>runtime.previewState(repo.state,task,undefined,options),caller});
      } catch(error) { failure=error; }
      assert.ok(result, String(failure));
      const owner=repo.state.workspaces.find(w=>w.id===session.workspaceId)!;
      const events=repo.state.events.filter(e=>e.type==='context.compaction_finished');
      assert.equal(result.error,undefined);
      assert.ok(result.requestTokens<before.requestTokens);
      if(mutation==='repeated_input_edit'||mutation==='provider_failure_after_edit') {
        assert.equal(calls,mutation==='repeated_input_edit'?4:1,'Model work remains bounded');
        assert.equal(owner.summaries?.length??0,0,'Invalid or failed model responses never become accepted summaries');
      } else {
        assert.equal(calls,mutation==='input_edit'?2:1);
        assert.equal(owner.summaries?.length,1,JSON.stringify({mutation,events:repo.state.events.filter(e=>e.type.startsWith('context.'))}));
        assert.equal(events.at(-1)?.payload.status,'completed');
        if(mutation==='input_edit')assert.ok(owner.summaries![0].text.startsWith('Summary response 2:'),'Old input response is discarded');
      }
      if(mutation==='related_canvas') {
        assert.ok(owner.summaries![0].sourceRefs.some(s=>s.id===sourceId&&s.version!==hash(repo.state.graph!.nodes[sourceId])));
        assert.ok(sourceChanges(repo.state,task,result.currentSources??[]).some(c=>c.source.id===sourceId));
        assert.ok(result.messages.some(m=>m.content.includes('摘要依据变动')));
        assert.equal(result.canvasReadHashes?.[`nodes:${sourceId}`],undefined,'Historical summary grants no body-read authority');
        const finish:ToolCallRecord={id:'summary-finish',providerCallId:'summary-finish',operationId:'summary-finish',taskId:task.id,
          stepId:'summary-finish-step',name:'task_finish',arguments:'{}',status:'prepared',createdAt:now()};
        result.stepId=finish.stepId;repo.state.contextManifests.push(result);repo.state.toolCalls.push(finish);
        repo.state.steps.push({id:finish.stepId,taskId:task.id,runId:'summary-finish-run',ordinal:1,purpose:'agent',status:'streaming',inputInstructionRevision:1,
          contextManifestId:result.id,provider:repo.state.provider.protocol,model:repo.state.provider.model,createdAt:now()});
        assert.throws(()=>repo.transaction(()=>(runtime as any).tool(task,finish,{basis:'current',outcome:'success',text:'The source still says ORIGINAL SOURCE.'})),
          (error:any)=>error.code==='SOURCE_CHANGED');
      }
      console.log(`PASS ${mutation}: summaryCalls=${calls}, summaries=${owner.summaries?.length??0}, before=${before.requestTokens}, after=${result.requestTokens}, status=${events.at(-1)?.payload.status}`);
    } finally { await runtime.dispose();repo.close(); }
  }
}
