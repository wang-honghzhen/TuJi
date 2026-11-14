export function versionNoticeLine(title:string,refs:Iterable<string>):string {
  const values=[...new Set(refs)].sort((a,b)=>a.localeCompare(b));
  return values.length?`${title}：${values.join('、')}`:'';
}

/** Shared by request rendering and maintenance costing; no fact is truncated. */
export function renderNoticeFacts(facts:Array<{kind:string;labels:string[];detail?:string}>):string[]{
  const kinds=[...new Set(facts.map(f=>f.kind))].sort((a,b)=>a.localeCompare(b));
  return kinds.map(kind=>{
    const groups=new Map<string,Set<string>>();
    for(const fact of facts.filter(f=>f.kind===kind)){
      const detail=fact.detail??'',refs=groups.get(detail)??new Set<string>();fact.labels.forEach(r=>refs.add(r));groups.set(detail,refs);
    }
    return `${kind}：${[...groups].sort(([a],[b])=>a.localeCompare(b)).map(([detail,refs])=>
      [...refs].sort((a,b)=>a.localeCompare(b)).join('、')+(detail?`（${detail}）`:'')).join('；')}`;
  }).filter(Boolean);
}
