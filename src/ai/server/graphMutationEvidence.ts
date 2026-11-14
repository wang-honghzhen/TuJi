import type { Task } from '../domain';
import type { GraphState } from '@/v3/types';
import { canvasIndex } from './canvasView';
import { canvasMemberIds } from '../canvasScope';
import { canvasFactCovered, canvasField, canvasKey, deliveredCanvasFacts } from './canvasReadEvidence';
import { assertCompleteNodeRead } from './nodeReadEvidence';
import { relationDependencyKey } from './graphRelationDependencies';
import { requireValue } from './errors';

/** Version hashes are fences, not proof that the old value was actually read.
 * Destructive writes require the delivered target fields as well. Directory
 * cards and partial pages cannot silently authorize replacing hidden content.
 */
export function assertMutationReadEvidence(task:Task,before:GraphState,command:Record<string,unknown>):void {
  const index=canvasIndex(before,task.canvasId,canvasMemberIds(before,task.canvasId));
  const observations=task.responseReadHashes?.observations??[];
  const facts=deliveredCanvasFacts(index,observations);
  const required=(refId:string,field:string,tool='graph_read')=>{
    const version=canvasKey(canvasField(index,refId,field));
    requireValue(canvasFactCovered({refId,field,version},facts.filter(f=>f.refId===refId&&f.field===field&&f.version===version)),
      `修改前须完整读取目标${field==='content'?'正文':field==='members'?'直接成员集合':field==='edge'?'边数据':field==='path'?'路径':'字段'}`,'READ_REQUIRED',
      {executed:false,failedRefs:[refId],field,readWith:field==='path'
        ?{tool:'graph_read_object_field',arguments:{refId,field:'path'}}:{tool,arguments:tool==='graph_read'?{refs:[refId]}:{refId}},
        ...(field==='members'?{instruction:'graph_read_subgraph读取直属节点，graph_read_directory读取直属子图；分别续完分页。'}:{})});
  };
  const relations=(refId:string)=>requireValue(!!task.readHashes?.[relationDependencyKey(task.canvasId,refId)],
    '删除节点前须读取其关系集合，包括空集合','READ_REQUIRED',
    {executed:false,failedRefs:[refId],readWith:{tool:'graph_read',arguments:{refs:[refId]}}});
  const id=String(command.id),kind=String(command.type);
  // Grouping existing objects is a move as well. Knowing an ID, a directory
  // card for another object, or the current live parent is not a delivered
  // version of the selected object's old location. A fresh path is sufficient
  // for a node; moving a container also needs its complete immediate members.
  if(['move','moveCanvasItems','reparentContent','createSubgraph'].includes(kind)&&Array.isArray(command.ids)){
    for(const ref of command.ids.map(String))if(index.rows.has(ref)){
      required(ref,'path',before.nodes[ref]?'graph_read':'graph_read_directory');
      if(!before.nodes[ref])required(ref,'members','graph_read_subgraph');
    }
    const parent=typeof command.parentId==='string'?command.parentId:task.canvasId;
    if(parent!==task.canvasId&&index.rows.has(parent))required(parent,'path','graph_read_directory');
  }
  // Objects created inside this same proposal have no previous user-owned body.
  if(kind==='updateSubgraphText'&&index.rows.has(id))required(id,String(command.field),String(command.field)==='content'?'graph_read_subgraph':'graph_read');
  if(['updateEdge','reconnectEdge','deleteEdge'].includes(kind)&&before.edges.some(e=>e.edgeId===id))required(id,'edge');
  if(kind==='deleteNode'&&before.nodes[id]){assertCompleteNodeRead(task,before,id);relations(id);}
  if(kind==='deleteSubgraph'&&index.rows.has(id)){
    const visited=new Set<string>(),visit=(refId:string)=>{
      if(visited.has(refId))return;visited.add(refId);
      if(before.nodes[refId]){assertCompleteNodeRead(task,before,refId);relations(refId);return;}
      required(refId,'name');required(refId,'content','graph_read_subgraph');required(refId,'members','graph_read_subgraph');
      if(command.mode==='cascade')for(const child of index.rows.get(refId)?.children??[])visit(child);
    };
    visit(id);
  }
}
