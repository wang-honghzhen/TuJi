/** Matching display paths get an ID suffix that remains stable across searches. */
export function duplicatePathIds(rows: Array<{id:string;label:string}>): Map<string,string> {
  const groups=new Map<string,string[]>();
  for(const {id,label} of rows){
    const ids=groups.get(label);
    if(ids)ids.push(id);else groups.set(label,[id]);
  }
  const suffixes=new Map<string,string>();
  for(const ids of groups.values()){
    if(ids.length<2)continue;
    const counts=new Map<string,number>();
    for(const id of ids){const suffix=id.slice(-6);counts.set(suffix,(counts.get(suffix)??0)+1);}
    for(const id of ids){
      const suffix=id.slice(-6);
      suffixes.set(id,`#${counts.get(suffix)===1?suffix:id}`);
    }
  }
  return suffixes;
}
