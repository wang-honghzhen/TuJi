import { emptyState } from '../src/ai/server/repository';
import { emptyGraph } from '../src/v3/storage';
import { registerSessionTask } from '../src/ai/sessionContext';
import { digest } from '../src/ai/server/directGraph';
import type { Task } from '../src/ai/domain';

/** Synthetic records only: no disk repository, credentials or network. */
export function compactionFixture({steps=2,records=1,body='检查完成。',correction=false,sources=0,current=false}={}) {
  const state=emptyState();state.graph=emptyGraph();state.provider.contextWindow=1000000;state.provider.maxOutputTokens=4096;
  const canvasId=state.graph.canvases[0].canvasId,stamp='2026-11-15T00:00:00.000Z';
  state.sessions.push({id:'session',canvasId,workspaceId:'workspace',mode:'explore',title:'Compaction fixture',lifecycle:'active',createdAt:stamp});
  state.workspaces.push({id:'workspace',sessionId:'session',workNotes:[],pinnedNotes:[],snapshotIds:[],artifactIds:[]});
  const addTask=(id:string,status:Task['status'])=>{
    const task:Task={id,sessionId:'session',workspaceId:'workspace',canvasId,rootUserMessageId:`user-${id}`,clientRequestId:id,
      instructionRevision:1,appliedInstructionRevision:1,status,createdAt:stamp,updatedAt:stamp,
      inputBindings:{targetIds:[],artifactIds:[],artifactVersions:{}},maxSteps:100,maxTokens:1000000,usedTokens:0,stepCount:0,fencingToken:0};
    state.tasks.push(task);registerSessionTask(state,'session',id);
    state.messages.push({id:task.rootUserMessageId,taskId:id,workspaceId:'workspace',role:'user',text:'核对清单，只记录经过核验的结果。',
      version:1,status:'complete',phase:'request',createdAt:stamp,sequence:id==='old'?1:10000,targetRefs:[],sourceRefs:[],relatedOperationIds:[]});return task;
  };
  const old=addTask('old',current?'running':'completed');
  for(let s=0;s<steps;s++){
    const stepId=`step-${s}`,seq=10+s*100;
    state.steps.push({id:stepId,taskId:'old',runId:'run',ordinal:s+1,purpose:'agent',status:'completed',inputInstructionRevision:1,
      contextManifestId:'manifest',provider:state.provider.protocol,model:state.provider.model,createdAt:stamp,completedSequence:seq+90});
    if(correction&&s===1)state.messages.push({id:'correction',taskId:'old',workspaceId:'workspace',role:'user',
      text:'更正：预算上限为150元，不是500元；未完成部分不能标为成功。',version:2,status:'complete',phase:'amendment',
      createdAt:stamp,sequence:seq-1,targetRefs:[],sourceRefs:[],relatedOperationIds:[]});
    for(let r=0;r<records;r++)state.messages.push({id:`msg-${s}-${r}`,taskId:'old',stepId,workspaceId:'workspace',role:'assistant',
      text:`记录${s}-${r}：${body}`,version:1,status:'complete',phase:'progress',createdAt:stamp,sequence:seq+r,targetRefs:[],sourceRefs:[],relatedOperationIds:[]});
    if(sources){
      const refs=[];
      for(let i=0;i<sources;i++){
        const id=`n-${s}-${i}`,node={nodeId:id,name:`item ${i}`,content:'原始数据'};
        state.graph.nodes[id]=node;state.graph.canvases[0].childIds.push(id);refs.push({kind:'node' as const,id,version:digest(node),tracking:'current' as const});
      }
      state.toolCalls.push({id:`call-${s}`,providerCallId:`provider-call-${s}`,operationId:`operation-${s}`,taskId:'old',stepId,
        name:'workspace_update_handoff',arguments:'{"text":"已记录"}',result:JSON.stringify({status:'ok',text:'记录已保存；不等同核验通过。'}),
        resultSources:refs,status:'completed',createdAt:stamp,presentedAt:Date.parse(stamp),sequence:seq+60});
    }
  }
  if(current)for(let i=0;i<5;i++)state.steps.push({...state.steps[0],id:`later-${i}`,ordinal:steps+i+1,completedSequence:9000+i});
  const task=current?old:addTask('current','running');
  return {state,task,old};
}
