import type { SummarySnapshot } from '../contextState';
import { digest } from './directGraph';

export type Row=Record<string,unknown>;
export type Region='history'|'progress'|'references';
export interface SummaryRelation { parentId:string; childId:string; navigationOnly?:true }
export interface SummaryPart {
  rootId:string; rootIds?:string[]; category:Region; data:Row; continuation?:Row;
  parentId?:string;
  page?:{number:number;total:number;status:string;hasMorePages:boolean;isLastPage:boolean;coverage?:unknown};
}
export const row=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function stableValue(v:unknown):unknown {
  if(Array.isArray(v))return v.map(stableValue);
  return row(v)?Object.fromEntries(Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>[k,stableValue(v[k])])):v;
}
export const contentKey=(v:unknown)=>digest(stableValue(v));

/** Only summary continuation slots are rewritten. A bound historical read is not a continuation. */
export function mapSummaryNavigation(value:unknown,replace:(id:string)=>string):unknown {
  if(Array.isArray(value))return value.map(v=>mapSummaryNavigation(v,replace));
  if(!row(value))return value;
  const out=Object.fromEntries(Object.entries(value).map(([k,v])=>[k,mapSummaryNavigation(v,replace)]));
  if(value.tool==='context_read_pages'&&row(value.arguments)&&typeof value.arguments.pointerId==='string')
    out.arguments={...out.arguments as Row,pointerId:replace(value.arguments.pointerId)};
  return out;
}
export function partIdentity(part:SummaryPart,pageKey:(id:string)=>string):string {
  return contentKey(mapSummaryNavigation({rootId:part.rootId,rootIds:part.rootIds??[part.rootId],parentId:part.parentId,
    data:part.data,page:part.page,continuation:part.continuation},pageKey));
}
/** The source footprint is independent of the region renderer and of temporary page IDs. */
export function partContents(part:SummaryPart){
  const cards:Row[]=[],fragments:Row[]=[],relations:SummaryRelation[]=[];
  const visit=(v:unknown,parent?:string)=>{
    if(Array.isArray(v)){v.forEach(x=>visit(x,parent));return;}if(!row(v))return;
    if(typeof v.serializedResult==='string'){fragments.push(v);return;}
    if(typeof v.summaryId==='string'&&typeof v.content==='string'){
      cards.push(v);if(parent&&parent!==v.summaryId)relations.push({parentId:parent,childId:v.summaryId});
      if(Array.isArray(v.children))visit(v.children,v.summaryId);return;
    }
    for(const [key,item] of Object.entries(v))visit(item,key==='items'?part.parentId:parent);
  };
  visit(part.data);
  return {cards,fragments,relations};
}
export function partScope(part:SummaryPart){return {rootIds:part.rootIds??[part.rootId],...(part.parentId?{parentId:part.parentId}:{}),
  ...(part.page?{page:part.page}:{}),shownIds:partContents(part).cards.map(c=>c.summaryId)};}

/** Ancestry supplies navigation identities only, never unrequested ancestor bodies. */
export function summaryPath(root:string,target:string,archive:SummarySnapshot[]):string[]{
  const queue=[[root]],seen=new Set<string>();
  for(let i=0;i<queue.length;i++){
    const path=queue[i],id=path.at(-1)!;if(id===target)return path;if(seen.has(id))continue;seen.add(id);
    for(const child of archive.find(s=>s.id===id)?.children??[])queue.push([...path,child]);
  }
  return [];
}
