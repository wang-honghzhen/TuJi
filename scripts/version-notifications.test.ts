import assert from 'node:assert/strict';
import { emptyState, hash } from '../src/ai/server/repository';
import { emptyGraph } from '../src/v3/storage';
import { renderNoticeFacts } from '../src/ai/server/contextUpdates';
import { canvasNoticeLabels, pendingCanvasChanges } from '../src/ai/server/contextFreshness';
import { directGraphRead } from '../src/ai/server/directGraph';
import { makeSummary, summaryEntry } from '../src/ai/server/historyRepresentations';
import { summarySourceEvidence } from '../src/ai/server/summaryFreshness';
import { assertMutationReadEvidence } from '../src/ai/server/graphMutationEvidence';
import type { Task, ToolCallRecord, Session, Workspace } from '../src/ai/domain';
import type { ContextStage, Observation } from '../src/ai/contextState';

export function testVersionNotifications() {
  const state=emptyState();state.graph=emptyGraph();
  const canvasId=state.graph.canvases[0].canvasId;
  state.graph.nodes.n1={nodeId:'n1',name:'Node one',content:'Original text'};state.graph.canvases[0].childIds.push('n1');
  const session={id:'session:notify',canvasId,workspaceId:'workspace:notify',mode:'explore',title:'Test',lifecycle:'active'} as Session;
  const workspace:Workspace={id:session.workspaceId,sessionId:session.id,workNotes:[],pinnedNotes:[],snapshotIds:[],artifactIds:[]};
  const task={id:'task:notify',sessionId:session.id,canvasId,workspaceId:workspace.id,inputBindings:{targetIds:[],artifactIds:[],artifactVersions:{}}} as Task;
  state.sessions.push(session);state.workspaces.push(workspace);state.tasks.push(task);
  const stage={entries:[],taskId:task.id,eventIds:[],baselineObservations:[]} as unknown as ContextStage;
  let count=0;
  const read=()=>{
    const call={id:`call:${++count}`,taskId:task.id,name:'graph_read',arguments:JSON.stringify({refs:['n1']}),status:'completed'} as ToolCallRecord;
    state.toolCalls.push(call);call.result=JSON.stringify(directGraphRead(state,task,call,{refs:['n1']}));
    stage.entries.push({id:`material:${call.id}`,category:'current_protocol',coverage:[],messages:[],readCallIds:[call.id]});
    return call;
  };
  const old=read(),observation=old.canvasOrigins![0].observation;
  const first=canvasNoticeLabels(state,task,{kind:'direct_data',refId:'n1',part:'field:content'},observation,x=>x);
  const second=canvasNoticeLabels(state,task,{kind:'direct_data',refId:'n2',part:'field:content'},observation,x=>x);
  const lines=renderNoticeFacts([first,{...first,labels:['n2·正文']},first]);
  assert.equal(lines.length,1);assert.match(lines[0],/n1·正文、n2·正文/);
  assert.equal((lines[0].match(/graph_read刷新/g)??[]).length,1,'Repeat actions only once per group');
  assert.ok(lines[0].length<65,'Common two-node change notice should be short');
  assert.ok(second.labels[0].includes('正文'));
  const unknown=canvasNoticeLabels(state,task,{kind:'unknown'},observation,x=>x);
  assert.equal(unknown.kind,'版本无法确认');assert.match(unknown.detail,/非确认变化/);
  const removed=canvasNoticeLabels(state,task,{kind:'content',refId:'n1',deleted:true},observation,x=>x);
  assert.match(removed.labels[0],/n1·不可用/);
  const query=canvasNoticeLabels(state,task,{kind:'query'}, {...observation,callId:'t1',graphQuery:{tool:'graph_search',arguments:{query:'Node'}}} as Observation,x=>x);
  assert.match(query.labels[0],/t1@画布根/);assert.match(query.detail,/重跑原查询/);
  const many=renderNoticeFacts(Array.from({length:300},(_,i)=>({...first,labels:[`n${i}·正文`]}))).join('\n');
  for(let i=0;i<300;i++)assert.ok(many.includes(`n${i}·正文`),'No notification facts may disappear under volume');

  const summary=makeSummary('task','Remember the original node.',[{recordId:'old-record',taskId:task.id,version:'v1',start:0,end:10}],[],
    [{kind:'node',id:'n1',version:hash(state.graph.nodes.n1),tracking:'current'}]);
  workspace.summaries=[summary];stage.entries.push(summaryEntry(summary,state,task));
  assert.equal(summarySourceEvidence(state,task,stage).sources.length,1);
  assert.equal(summarySourceEvidence(state,task,stage).facts.length,0);
  state.graph=structuredClone(state.graph);state.graph.nodes.n1.content='Edited body';state.graphRevision++;
  assert.equal(summarySourceEvidence(state,task,stage).facts.length,1,'A summary keeps its source change check');
  assert.ok(pendingCanvasChanges(state,task,stage).size>0,'Old full body stays unresolved');
  const fresh=read();
  const freshObservations=fresh.canvasOrigins!.map(o=>o.observation);
  const identityOnly=freshObservations.map(o=>({...o,canvasFacts:o.canvasFacts?.filter(f=>f.field!=='content')}));
  assert.equal(summarySourceEvidence(state,task,stage,identityOnly).facts.length,1,'Name-only evidence cannot refresh summary body');
  assert.equal(summarySourceEvidence(state,task,stage,freshObservations).facts.length,0);
  assert.equal(pendingCanvasChanges(state,task,stage).size,0,'Full fresh delivery clears corresponding old-body conflicts');

  // Corruption creates unknown evidence; independent complete delivery restores its recorded footprint.
  const payload=JSON.parse(old.result!);payload.data.invalidExtra='corrupt';old.result=JSON.stringify(payload);
  stage.entries=stage.entries.filter(e=>!e.readCallIds?.includes(fresh.id));
  assert.ok([...pendingCanvasChanges(state,task,stage).values()].some(v=>v.change.kind==='unknown'));
  stage.entries.push({id:`material:${fresh.id}`,category:'current_protocol',coverage:[],messages:[],readCallIds:[fresh.id]});
  assert.equal(pendingCanvasChanges(state,task,stage).size,0,'Unknown delivery with a recorded footprint can recover by complete reread');

  workspace.workNotes.push({id:'note:summary',text:'Old conclusion',type:'finding',version:1,sourceRefs:[],updatedAt:'2026-11-14'});
  const noteSummary=makeSummary('task','Note conclusion.',[{recordId:'old-note',taskId:task.id,version:'v1',start:0,end:10}],[],
    [{kind:'note',id:'note:summary',version:1,tracking:'current'}]);
  workspace.summaries.push(noteSummary);stage.entries.push(summaryEntry(noteSummary,state,task));
  workspace.noteVersions=[structuredClone(workspace.workNotes[0])];workspace.workNotes[0].text='New conclusion';workspace.workNotes[0].version=2;
  assert.ok(summarySourceEvidence(state,task,stage,freshObservations).facts.some(f=>f.labels.some(l=>l.includes('note:summary'))),
    'Compacted note sources keep version checks as well as graph sources');
  const queryCall={id:'call:empty-query',taskId:task.id,name:'graph_search',arguments:JSON.stringify({query:'new-match'}),status:'completed'} as ToolCallRecord;
  state.toolCalls.push(queryCall);queryCall.result=JSON.stringify(directGraphRead(state,task,queryCall,{query:'new-match'}));
  assert.ok(queryCall.canvasOrigins?.length,'Use real empty-query read evidence');
  const querySummary=makeSummary('task','The query had no matches.',[{recordId:queryCall.id,taskId:task.id,version:'v1',start:0,end:10}],[],[]);
  workspace.summaries.push(querySummary);stage.entries.push(summaryEntry(querySummary,state,task));
  state.graph=structuredClone(state.graph);state.graph.nodes.n1.name='new-match';state.graphRevision++;
  const queryEvidence=summarySourceEvidence(state,task,stage);
  assert.ok([...queryEvidence.pending.values()].some(v=>v.change.kind==='query'),
    'Summary of an empty query must retain its membership check even without object source refs');
  state.graph=structuredClone(state.graph);
  state.graph.nodes.n2={nodeId:'n2',name:'Second node',content:'Text'};
  state.graph.canvases[0].childIds.push('n2','d1');
  state.graph.canvases[0].directories.d1={name:'Directory',description:'Directory body',childIds:[]};
  state.graph.edges.push({edgeId:'e1',sourceNodeId:'n1',targetNodeId:'n2',directed:true,edgeContent:'Edge body'});
  const structuredCall={id:'call:structured',taskId:task.id,name:'graph_read',arguments:JSON.stringify({refs:['d1']}),status:'completed'} as ToolCallRecord;
  state.toolCalls.push(structuredCall);structuredCall.result=JSON.stringify(directGraphRead(state,task,structuredCall,{refs:['d1']}));
  const edgeCall={id:'call:edge',taskId:task.id,name:'graph_read',arguments:JSON.stringify({refs:['e1']}),status:'completed'} as ToolCallRecord;
  state.toolCalls.push(edgeCall);edgeCall.result=JSON.stringify(directGraphRead(state,task,edgeCall,{refs:['e1']}));
  const structuredSummary=makeSummary('task','Directory and edge summary.',[structuredCall,edgeCall].map(c=>({recordId:c.id,taskId:task.id,version:'v1',start:0,end:10})),[],[]);
  workspace.summaries.push(structuredSummary);stage.entries.push(summaryEntry(structuredSummary,state,task));
  const summarizedChecks=summarySourceEvidence(state,task,stage).observations;
  assert.ok(summarizedChecks.some(o=>o.canvasFacts?.some(f=>f.refId==='e1'&&f.field==='edge')),structuredCall.result);
  task.responseReadHashes={stepId:'summary-only',hashes:{},observations:[],summaryObservations:summarizedChecks};
  const writes=[{type:'updateSubgraphText',id:'d1',field:'content',value:'replacement'},
    {type:'updateEdge',id:'e1',patch:{edgeContent:'replacement'}}];
  for(const command of writes)assert.throws(()=>assertMutationReadEvidence(task,state.graph!,command),(e:any)=>e.code==='READ_REQUIRED',
    'Summary checks must never authorize subgraph or edge writes');
  task.responseReadHashes.observations=[...structuredCall.canvasOrigins!,...edgeCall.canvasOrigins!].map(o=>o.observation);
  for(const command of writes)assert.doesNotThrow(()=>assertMutationReadEvidence(task,state.graph!,command),'An actual full read authorizes its field');
  console.log('PASS: concise grouped notices preserve all identities, fields, query scopes and unknown states; fresh reads resolve only covered evidence; summaries retain graph and note dependencies.');
}
