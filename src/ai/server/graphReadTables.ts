import { createHash } from 'node:crypto';
import type { SourceRef } from '../domain';
import type { CanvasIndex } from './canvasView';
import { readCoverage } from './readCoverage';
import { relationMembershipVersion } from './relationMembershipVersion';

type Row=Record<string,unknown>;
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const caches=new WeakMap<CanvasIndex,ReturnType<typeof createTables>>();
export function graphTables(index:CanvasIndex) {
  let tables=caches.get(index);if(!tables){tables=createTables(index);caches.set(index,tables);}return tables;
}
function createTables(index:CanvasIndex) {
  const edges=new Map(index.edges.map(e=>[e.edgeId,e]));
  const incident=new Map<string,typeof index.edges>(),versions=new Map<string,string>(),sources=new Map<string,SourceRef>();
  for(const e of index.edges)for(const id of new Set([e.sourceNodeId,e.targetNodeId])){
    let list=incident.get(id);if(!list){list=[];incident.set(id,list);}list.push(e);
  }
  for(const list of incident.values())list.sort((a,b)=>a.edgeId.localeCompare(b.edgeId));
  const path=(id:string)=>index.rows.get(id)?.segments.map(s=>({refId:s.id,name:s.name}))??[];
  const source=(id:string):SourceRef|undefined=>{
    if(sources.has(id))return sources.get(id);
    const row=index.rows.get(id),edge=edges.get(id);
    const value=row&&row.kind!=='root'?{kind:row.kind==='node'?'node' as const:'document' as const,id,
      version:hash(index.graph.nodes[id]??index.graph.documents[id]??index.graph.canvases.find(c=>c.directories[id])?.directories[id])}
      :edge?{kind:'edge' as const,id,version:hash(edge)}:undefined;
    if(value)sources.set(id,value);return value;
  };
  const related=(id:string)=>incident.get(id)??[];
  const fieldVersion=(id:string,field:string,value:unknown)=>hash([source(id)?.version,field,value]);
  const relationVersion=(id:string)=>{
    if(!versions.has(id))versions.set(id,relationMembershipVersion(related(id)));
    return versions.get(id)!;
  };
  const relations=(id:string,pageEdges:Row[]=[])=>{
    const totalEdges=related(id).length;
    const present=pageEdges.filter(e=>(e.source as Row)?.refId===id||(e.target as Row)?.refId===id);
    const inlineEdges=new Set(present.map(e=>e.edgeId)).size;
    return {totalEdges,inlineEdges,coverage:readCoverage('node_edges',totalEdges>inlineEdges?['relations_deferred']:[]),
      version:relationVersion(id),...(totalEdges>inlineEdges?{readWith:{tool:'graph_read_node_edges',arguments:{refId:id,expectedRelationVersion:relationVersion(id)}}}:{})};
  };
  const node=(id:string,includePath=true):Row=>{
    const row=index.rows.get(id)!;
    return {refId:id,kind:row.kind,name:row.segments.at(-1)?.name,content:row.content,...(includePath?{path:path(id)}:{}),
      ...(index.graph.nodes[id]?.design ? {design:index.graph.nodes[id].design} : {}),
      ...(row.kind==='node'?{relations:relations(id)}:{})};
  };
  const edge=(id:string):Row=>{const e=edges.get(id)!;return {edgeId:id,source:{refId:e.sourceNodeId},target:{refId:e.targetNodeId},directed:e.directed,content:e.edgeContent,...(e.membershipFor?{membershipFor:e.membershipFor}: {})};};
  const table=(items:Row[],pageEdges:Row[],scope:string):Row=>{
    const loaded=new Set(items.filter(i=>i.kind==='node'&&i.status!=='blocked').map(i=>i.refId));
    const endpoints=[...new Set(pageEdges.flatMap(e=>[(e.source as Row)?.refId,(e.target as Row)?.refId]).filter((id):id is string=>typeof id==='string'))]
      .filter(id=>!loaded.has(id)).map(id=>{
        if(!index.rows.has(id))return {refId:id,outside:true};
        const name=index.rows.get(id)!.segments.at(-1)?.name??'';
        return {refId:id,...(name.length<=256?{name}:{nameState:'deferred',nameReadWith:{tool:'graph_read_object_field',
          arguments:{refId:id,field:'name',expectedVersion:fieldVersion(id,'name',name)}}})};
      });
    return {scope,items:items.map(i=>i.kind==='node'?{...i,relations:relations(String(i.refId),pageEdges)}:i),edges:pageEdges,
      ...(endpoints.length?{endpoints}:{})};
  };
  return {edges,related,relationVersion,relations,node,edge,table,source,path,fieldVersion};
}
