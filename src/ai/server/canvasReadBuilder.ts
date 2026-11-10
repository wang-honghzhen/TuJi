import type { AppSnapshot, Task, ToolCallRecord } from '../domain';
import type { FrozenRead, Observation } from '../contextState';
import { directGraphRead, graphIndex } from './directGraph';
import { graphQueryRead } from './graphQueryRead';
import { translateGraphPayload } from './graphReferences';
import { DomainError } from './errors';
import { canvasKey, canvasRefreshRequest, row, type CanvasReadRequest, type Row } from './canvasReadEvidence';

export interface CanvasReadDraft { result?:Row; observations:Observation[];pages:FrozenRead[];reason?:string;unavailable:string[];references?:Array<[string,string]> }
/** Reuse the real read constructors with an isolated recording sink. No runtime tool dispatch,
 *  model-call record, delivery, read dependency or page is committed by this function. */
export function buildCanvasRead(state:AppSnapshot,task:Task,source:ToolCallRecord,request:CanvasReadRequest,identity:string,encode:(id:string)=>string):CanvasReadDraft {
  const index=graphIndex(state,task.canvasId),semantic=canvasRefreshRequest(request),args=semantic.arguments,unavailable:string[]=[];
  const valid=(id:string)=>index.rows.get(id)?.readable||index.edges.some(e=>e.edgeId===id);
  if(Array.isArray(args.refs)){args.refs=args.refs.filter(id=>{if(typeof id==='string'&&!valid(id)){unavailable.push(id);return false;}return true;});
    if(!(args.refs as unknown[]).length)return {observations:[],pages:[],reason:'source_unavailable',unavailable};}
  if(Array.isArray(args.requests)){args.requests=args.requests.filter(v=>{if(!row(v)||typeof v.refId!=='string')return false;
    delete v.expectedRelationVersion;if(!valid(v.refId)){unavailable.push(v.refId);return false;}return true;});
    if(!(args.requests as unknown[]).length)return {observations:[],pages:[],reason:'source_unavailable',unavailable};}
  if(typeof args.refId==='string'&&!valid(args.refId))return {observations:[],pages:[],reason:'source_unavailable',unavailable:[args.refId]};
  for (const target of [args.sourceRefId, args.targetRefId]) if (typeof target === 'string' && !valid(target)) unavailable.push(target);
  if (unavailable.length) return { observations: [], pages: [], reason: 'source_unavailable', unavailable };
  const workspace=state.workspaces.find(w=>w.id===task.workspaceId)!;
  const privateTask=structuredClone(task),sink={...workspace,frozenReads:[] as FrozenRead[],observations:[] as Observation[],
    contextStage:workspace.contextStage?{...workspace.contextStage,lastRequest:undefined}:undefined};
  const privateState:AppSnapshot={...state,workspaces:state.workspaces.map(w=>w.id===workspace.id?sink:w),tasks:state.tasks.map(t=>t.id===task.id?privateTask:t)};
  const recording:ToolCallRecord={...structuredClone(source),id:`canvas-view:${identity}`,taskId:task.id,stepId:`canvas-refresh:${identity}`,
    name:request.tool,arguments:JSON.stringify(args),status:'prepared',result:undefined,canvasOrigins:undefined,readPageRefs:undefined,readPageOrigins:undefined,readOriginIds:undefined};
  let result:Row;
  const references=new Map<string,string>(),project=(id:string)=>{const alias=encode(id);references.set(id,alias);return alias;};
  try {
    result=request.tool==='graph_read_design_references'||request.tool==='graph_search_node_content'||request.tool==='graph_search'&&args.output==='cards'
      ?graphQueryRead(privateState,privateTask,recording,args):directGraphRead(privateState,privateTask,recording,args,v=>translateGraphPayload(v,project));
  }catch(cause){
    if(!(cause instanceof DomainError))throw cause;
    if(!['OUT_OF_SCOPE','NOT_FOUND','TOOL_NOT_ALLOWED','READ_RESOURCE_LIMIT'].includes(cause.code))throw cause;
    return {observations:[],pages:[],reason:cause.code==='READ_RESOURCE_LIMIT'?`resource:${String((cause.details as Row)?.resource)}`:'source_unavailable',unavailable};
  }
  if(!['ok','partial'].includes(String(result.status))||!row(result.data))return {observations:[],pages:[],reason:String(result.code??'not_delivered'),unavailable};
  const slots=new Map(sink.frozenReads.map((r,i)=>[r.id,`page:${i}`]));
  const normalize=(v:unknown):unknown=>Array.isArray(v)?v.map(normalize):row(v)?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,k==='pointerId'&&typeof x==='string'?slots.get(x)??x:normalize(x)])):v;
  const contentId=canvasKey([semantic,normalize(result),sink.frozenReads.map(r=>[r.kind,normalize(r.pages),r.pageReadHashes])]);
  const renames=new Map(sink.frozenReads.map((r,i)=>[r.id,`read:canvas-refresh-${canvasKey([contentId,i])}`]));
  const rewrite=(v:unknown):unknown=>Array.isArray(v)?v.map(rewrite):row(v)?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,k==='pointerId'&&typeof x==='string'?renames.get(x)??x:rewrite(x)])):v;
  const pages=sink.frozenReads.map(r=>rewrite({...r,id:renames.get(r.id)!,callId:`canvas-view:${contentId}`,originResultIds:undefined,canvasView:true}) as FrozenRead);
  return {result:rewrite(result) as Row,observations:rewrite(sink.observations) as Observation[],pages,unavailable,references:[...references]};
}
