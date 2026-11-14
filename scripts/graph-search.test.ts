import assert from 'node:assert/strict';
import { searchCanvas, searchContains, searchFocusView, searchPendingReviews } from '../src/new/graphSearch';
import type { AppSnapshot, ChangeSet } from '../src/ai/domain';
import type { CanvasRecord, GraphState } from '../src/v3/types';
import type { ReviewUnit } from '../src/ai/reviewTypes';

export function runGraphSearchTests() {
  const canvas: CanvasRecord = { canvasId:'canvas-a', canvasName:'当前画布', updatedAt:'', childIds:['folder','b'], directories:{folder:{name:'折叠目录', childIds:['a']}}, placements:{}, collapsed:{folder:true} };
  const state: GraphState = { canvases:[canvas], documents:{}, nodes:{
    a:{nodeId:'a',name:'起点',content:'隐藏正文 Needle'}, b:{nodeId:'b',name:'终点',content:'匹配正文'}, outside:{nodeId:'outside',name:'外部 Needle',content:''},
  }, edges:[
    {edgeId:'internal',sourceNodeId:'a',targetNodeId:'b',directed:true,edgeContent:'关系 Needle'},
    {edgeId:'undirected',sourceNodeId:'b',targetNodeId:'a',directed:false,edgeContent:'无向关系'},
    {edgeId:'outside-link',sourceNodeId:'a',targetNodeId:'outside',directed:true,edgeContent:'Needle'},
    {edgeId:'deleted-link',sourceNodeId:'a',targetNodeId:'b',directed:true,edgeContent:'Needle',removed:true},
  ] };
  const matches = searchCanvas(state,canvas,'needle');
  assert.deepEqual(matches.map(r=>r.id),['a','internal']);
  assert.equal(matches[0].path,'当前画布 / 折叠目录 / 起点');
  assert.equal(matches[1].name,'起点 → 终点');
  assert.equal(matches[1].sourcePath,'当前画布 / 折叠目录 / 起点');
  assert.equal(matches[1].targetPath,'当前画布 / 终点');
  assert.deepEqual(searchCanvas(state,canvas,'needle',false).map(r=>r.id),['a']);
  assert.equal(searchCanvas(state,canvas,'无向')[0].name,'终点 — 起点');
  assert.ok(searchCanvas(state,canvas,'折叠目录').some(r=>r.id==='a'),'path searches include nested nodes');
  assert.equal(searchCanvas(state,canvas,'外部').length,0);
  assert.ok(searchContains('NEEDLE 隐藏','隐藏正文 Needle'));
  assert.equal(searchCanvas(state,canvas,'  ').length,0);
  const excluded = structuredClone(state);
  excluded.documents.doc = { documentId:'doc',kind:'document',name:'排除文档',childNodeIds:['outside'],childDocumentIds:[],placements:{},rev:1,metadata:{createdAt:'',updatedAt:'',version:'1'} };
  excluded.canvases[0].childIds.push('doc'); excluded.canvases[0].excludedDocumentIds=['doc'];
  assert.equal(searchCanvas(excluded,excluded.canvases[0],'外部').length,0,'excluded documents do not leak into search');

  const unit = (id:string,state:ReviewUnit['state']='pending'):ReviewUnit => ({id,kind:'update',label:'修改起点',refs:['a'],parentId:'folder',requires:[],provides:[],removes:[],deltas:[],dependencies:[],ghosts:[],state});
  const change = (id:string,units:ReviewUnit[],canvasId='canvas-a'):ChangeSet => ({id,operationId:id,workspaceId:'w',taskId:'task-'+id,stepId:'s',status:'committed',commands:[],patches:[],expectedHashes:{},affectedRefs:['a'],affectedCanvasIds:[canvasId],createdAt:'2026-11-14T00:00:00Z',instructionRevision:1,digest:'更新内容',review:{canvasId,revision:1,callId:'call-'+id,units}});
  const snapshot = { graph:state, changes:[change('pending',[unit('u1'),unit('u2','approved')]), change('approved',[unit('u3','approved')]),change('foreign',[unit('u4')],'canvas-b')],reviewChanges:[change('archived-pending',[unit('u5')])] } as unknown as AppSnapshot;
  const reviews = searchPendingReviews(snapshot,'canvas-a','折叠目录');
  assert.deepEqual(new Set(reviews.map(r=>r.id)),new Set(['pending','archived-pending']));
  assert.deepEqual(reviews.find(r=>r.id==='pending')!.unitIds,['u1']);
  assert.equal(searchPendingReviews(snapshot,'canvas-a','不存在').length,0);

  const area = {x:240,y:100,width:760,height:400};
  const rects = [{x:-1200,y:-500,width:180,height:64},{x:1000,y:400,width:180,height:64}];
  const {view} = searchFocusView(rects,area,1.7);
  for(const rect of rects) {
    const left=rect.x*view.zoom+view.x,top=rect.y*view.zoom+view.y;
    assert.ok(left>=area.x-.001 && top>=area.y-.001);
    assert.ok(left+rect.width*view.zoom<=area.x+area.width+.001);
    assert.ok(top+rect.height*view.zoom<=area.y+area.height+.001);
  }
  console.log('Graph search: canonical current-canvas scope, folded paths, edge directions, pending-only reviews, and camera fit passed.');
}
