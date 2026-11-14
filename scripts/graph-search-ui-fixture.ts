import path from 'node:path';
import { Repository } from '../src/ai/server/repository';
import { emptyGraph } from '../src/v3/storage';
import { planMutation } from '../src/ai/server/graph';
export function seedGraphSearchReview(directory: string) {
  const repo = new Repository(path.join(directory,'qixue.sqlite'));
  try {
    const graph=emptyGraph(), canvasId=graph.canvases[0].canvasId;
    const created=planMutation(graph,canvasId,{type:'createNode',parentId:canvasId,name:'待审核示例节点',content:'更新后的正文'});
    const nodeId=created.id!;
    repo.transaction(s=>{
      s.graph=created.state;
      s.canvasReviewStates={[canvasId]:{taskIds:['search-review-task'],revision:1}};
      s.reviewChanges=[{id:'search-review-change',operationId:'test-op',workspaceId:'test-workspace',taskId:'search-review-task',stepId:'test-step',
        status:'committed',commands:[],patches:[],expectedHashes:{},affectedRefs:[nodeId],affectedCanvasIds:[canvasId],createdAt:'2026-11-14T08:00:00Z',instructionRevision:1,digest:'补充待审核示例节点的说明',
        reviewArchive:{title:'完善说明',request:'补充待审核示例节点的说明',createdAt:'2026-11-14T08:00:00Z'},
        review:{canvasId,revision:1,callId:'search-test-call',sequence:1,units:[{id:'search-review-unit',kind:'update',label:'更新待审核示例节点',refs:[nodeId],parentId:canvasId,
          requires:[],provides:[],removes:[],deltas:[{collection:'nodes',id:nodeId,path:['nodes',nodeId,'content'],before:'原来的正文',after:'更新后的正文'}],dependencies:[],ghosts:[],state:'pending'}]}}];
    });
  } finally {repo.close();}
}
