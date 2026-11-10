import { randomUUID } from 'node:crypto';
import type { CanvasIndex } from './canvasView';
import { graphTables } from './graphReadTables';
import { estimateTokens } from '../tokens';
import { fittingTextEnd } from './textSlicePacking';
import { fieldReadWith } from './graphReadFields';
import { GRAPH_READ_LIMITS, resourceLimit } from './graphReadLimits';

type Row=Record<string,unknown>;
export interface EdgeBranch {id:string;pages:Row[];relationRefs:string[]}

/** Object pages and their overflow edge streams are independent frozen results. */
export function graphPaginator(index:CanvasIndex,pages:Row[],pointerId:string,budget:number,
  fits:(data:Row)=>boolean,size:(data:Row)=>number) {
  const tables=graphTables(index),branches:EdgeBranch[]=[],values=new Map<string,Row>();
  let failed=false;
  const edge=(id:string)=>{let value=values.get(id);if(!value){value=tables.edge(id);values.set(id,value);}return value;};
  const edgePages=(ids:string[],scope:string,query:Row,cards:Row[]=[]):Row[]=>{
    const result:Row[]=[];let edges:Row[]=[],items=cards;
    const data=(es=edges)=>({kind:'node_edges',...tables.table([],es,scope),items,query});
    const check=()=>resourceLimit(result.length+pages.length+branches.reduce((n,b)=>n+b.pages.length,0)<=GRAPH_READ_LIMITS.pages,'pages');
    const flush=()=>{if(edges.length||items.length){result.push(data());check();edges=[];items=[];}};
    if(!fits(data())){failed=true;return result;}
    for(const id of ids){
      const value=edge(id);
      if(fits(data([...edges,value]))){edges.push(value);continue;}
      flush();
      if(fits(data([value]))){edges.push(value);continue;}
      const content=String(value.content),metadata={...value};delete metadata.content;
      let start=0;
      while(start<content.length){
        const fragment=(end:number)=>({...metadata,content:content.slice(start,end),start,end,contentLength:content.length});
        const end=fittingTextEnd(content,start,budget,end=>fits(data([fragment(end)])));
        if(end<=start){failed=true;return result;}
        result.push(data([fragment(end)]));check();start=end;
      }
      if(!content.length){failed=true;return result;}
    }
    flush();if(!result.length)result.push(data());return result;
  };
  const put=(items:Row[],kind:string,scope:string,related:string[]=[],extra:Row={})=>{
    const initialPage=pages.length;
    const allowed=new Set(related),represented=new Set<string>();
    let objects:Row[]=[];
    const idsFor=(os:Row[])=>[...new Set(os.filter(i=>i.kind==='node').flatMap(i=>tables.related(String(i.refId)).map(e=>e.edgeId).filter(id=>allowed.has(id))))].sort();
    const overflowId=`read:${randomUUID()}`;
    const prepare=(os:Row[],es:Row[],ids:string[],id=overflowId,totalPages=99999999,blocked?:Row):Row=>{
      const data:Row=blocked?{...extra,...blocked}: {kind,...extra,...tables.table(os,es,scope)};
      const remaining=ids.length-es.length;
      if(remaining)data.edgeOverflow={edgeCount:remaining,totalPages,readWith:{tool:'context_read_pages',arguments:{pointerId:id,page:1}}};
      const rows=blocked?[data]:data.items as Row[];
      const included=new Set(ids);
      for(const row of rows){
        if(!row.relations)continue;
        const r={...row.relations as Row};row.relations=r;
        const outside=tables.related(String(row.refId)).filter(e=>!included.has(e.edgeId)).length;
        if(outside)r.outsideQueryEdges=outside;
        else delete r.readWith; // One page-level entry serves every deferred node on this page.
      }
      return data;
    };
    const emit=(os:Row[],es:Row[],ids:string[],blocked?:Row)=>{
      const present=new Set(es.map(e=>String(e.edgeId))),remaining=ids.filter(id=>!present.has(id));
      const id=`read:${randomUUID()}`;
      if(remaining.length){
        const query={kind:'page_remaining_edges',origin:{pointerId,page:pages.length+1},totalEdges:remaining.length};
        const branch=edgePages(remaining,scope,query);
        branches.push({id,pages:branch,relationRefs:os.filter(o=>o.kind==='node'||o.relations).map(o=>String(o.refId))});
        pages.push(prepare(os,es,ids,id,branch.length,blocked));
      }else pages.push(prepare(os,es,ids,id,0,blocked));
      ids.forEach(id=>represented.add(id));
      resourceLimit(pages.length+branches.reduce((n,b)=>n+b.pages.length,0)<=GRAPH_READ_LIMITS.pages,'pages');
    };
    const flush=()=>{
      if(!objects.length)return;
      const ids=idsFor(objects),inline:Row[]=[],present=new Set<string>();
      const queues=objects.filter(i=>i.kind==='node').map(i=>tables.related(String(i.refId)).map(e=>e.edgeId).filter(id=>allowed.has(id)))
        .sort((a,b)=>a.length-b.length);
      // Complete small relation sets first. This preserves shared A--C even when A is a hub.
      for(const queue of queues){
        const missing=queue.filter(id=>!present.has(id));
        if(missing.reduce((n,id)=>n+estimateTokens(JSON.stringify(edge(id))),0)>budget)continue;
        const candidate=[...inline,...missing.map(edge)];
        if(fits(prepare(objects,candidate,ids))){inline.push(...missing.map(edge));missing.forEach(id=>present.add(id));}
      }
      const cursors=queues.map(ids=>({ids,at:0,done:false}));let added=true;
      while(added){added=false;for(const q of cursors){
        if(q.done)continue;
        while(q.at<q.ids.length&&present.has(q.ids[q.at]))q.at++;
        if(q.at===q.ids.length){q.done=true;continue;}
        const id=q.ids[q.at++];
        if(!fits(prepare(objects,[...inline,edge(id)],ids))){q.done=true;continue;}
        inline.push(edge(id));present.add(id);added=true;
      }}
      emit(objects,inline,ids);objects=[];
    };
    const overhead=size({kind,...extra,...tables.table([],[],scope)});
    const objectTarget=overhead+Math.max(0,budget-overhead)*.6;
    for(const item of items){
      let candidate=[...objects,item],ids=idsFor(candidate),data=prepare(candidate,[],ids);
      if(objects.length&&(!fits(data)||ids.length>0&&size(data)>objectTarget)){
        flush();candidate=[item];ids=idsFor(candidate);data=prepare(candidate,[],ids);
      }
      if(!fits(data)){
        flush();
        const refId=String(item.refId),node=index.rows.get(refId)?.kind==='node';
        const blocked:Row={kind,scope,status:'blocked',code:'OBJECT_TOO_LARGE',refId,
          ...(node?{relations:tables.relations(refId)}:{}),
          readWith:{tool:node?'graph_read_node_content':'graph_read_directory_content',arguments:{refId,expectedVersion:tables.source(refId)?.version}},
          ...(typeof item.name==='string'&&item.name.length>256?{nameReadWith:fieldReadWith(index,refId,'name')}:{}),
          ...(item.path&&JSON.stringify(item.path).length>512?{pathReadWith:fieldReadWith(index,refId,'path')}:{}),
          ...(index.graph.nodes[refId]?.design?{designReadWith:fieldReadWith(index,refId,'design')}:{} )};
        if(typeof item.name==='string'&&fits(prepare([item],[],ids,overflowId,99999999,{...blocked,name:item.name})))blocked.name=item.name;
        emit([item],[],ids,blocked);continue;
      }
      objects.push(item);
    }
    flush();
    // Explicit edge references without a returned node remain ordinary requested data.
    const standalone=related.filter(id=>!represented.has(id));
    if(standalone.length)pages.push(...edgePages(standalone,scope,{kind:'selected_edges',totalEdges:standalone.length}));
    if(pages.length===initialPage)pages.push({kind,...extra,...tables.table([],[],scope)});
  };
  return {put,edgePages,branches,get failed(){return failed;}};
}
