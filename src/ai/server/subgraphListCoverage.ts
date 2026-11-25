import type {Observation} from '../contextState';
import {subgraphKey} from './subgraphVersions';

/** Batched subgraphs are interleaved. Parts from different frozen pointers or
 * different membership versions cannot complete one another's enumeration. */
export function completedMemberLists(observations:Observation[]):Observation[] {
  const groups=new Map<string,{first?:Observation;parts:Set<number>}>();
  for(const o of observations){
    const list=o.memberListPage;
    if(!list||!o.canvasPage||o.evidenceUnknown||list.part<1||list.part>list.total)continue;
    const key=JSON.stringify([o.canvasId,o.canvasPage.pointerId,list.refId,list.total,list.version]);
    const group=groups.get(key)??{parts:new Set<number>()};
    if(list.part===1)group.first=o;
    group.parts.add(list.part);groups.set(key,group);
  }
  return [...groups.values()].flatMap(g=>g.first&&g.parts.size===g.first.memberListPage!.total?[g.first]:[]);
}

/** Only the assembled visible list subscribes to collection membership. Do
 * not alter archived per-page evidence when adding this derived observation. */
export function observeCompletedMemberLists(observations:Observation[]):Observation[]{
  const anchors=new Set(completedMemberLists(observations).filter(o=>o.memberListPage!.total>1));
  if(!anchors.size)return observations;
  return observations.map(o=>{
    if(!anchors.has(o))return o;
    const {refId,version}=o.memberListPage!;
    return {...o,readHashes:{...o.readHashes,[subgraphKey(o.canvasId,refId,'members')]:version},
      canvasFacts:[...o.canvasFacts??[],{refId,field:'node_members',version}]};
  });
}
