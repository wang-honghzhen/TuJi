import type { Coverage, FrozenRead } from '../contextState';
import { estimateTokens } from '../tokens';

type Directory=NonNullable<FrozenRead['recordDirectory']>;
function mergedRanges(ranges:Array<[number,number]>):Array<[number,number]>{
  const result:Array<[number,number]>=[];
  for(const [start,end] of [...ranges].sort((a,b)=>a[0]-b[0]||a[1]-b[1])){
    const last=result.at(-1);
    if(last&&start<=last[1])last[1]=Math.max(last[1],end);else result.push([start,end]);
  }
  return result;
}

/** Index actual source rows, never user text or nested viewed-content references.
 * The index is outside page data, so its ranges cannot become delivered coverage. */
export function historyRecordDirectory(contents:unknown[],coverage:Coverage[],pages:Record<string,unknown>[],
  firstResult:Record<string,unknown>,budget:number):Directory|undefined {
  const sourceRows=contents as Array<{recordId?:unknown}>;
  const recordIds=[...new Set(sourceRows.flatMap(row=>typeof row.recordId==='string'?[row.recordId]:[]))];
  if(!recordIds.length)return;
  const pageNumbers=new Map(recordIds.map(id=>[id,[] as number[]]));
  // Root JSON fallback uses serialized offsets in {items:[...]}; row-level JSON
  // fallback carries its existing ['items', index] path. Both retain exact identity.
  let offset='{"items":['.length;
  const sourceSpans=contents.map((row,index)=>{
    if(index)offset++;
    const start=offset;offset+=JSON.stringify(row).length;return {start,end:offset,recordId:sourceRows[index].recordId};
  });
  for(const [index,page] of pages.entries()){
    const ids=new Set<string>();
    const rows=Array.isArray(page.items)?page.items as Record<string,unknown>[]:[page];
    for(const row of rows){
      if(typeof row.recordId==='string'&&typeof row.content==='string')ids.add(row.recordId);
      const fragment=row.resultFragment as {path?:unknown[];offset?:number}|undefined;
      if(typeof row.serializedResult!=='string'||typeof fragment?.offset!=='number')continue;
      if(fragment.path?.length===2&&fragment.path[0]==='items'&&Number.isSafeInteger(fragment.path[1])){
        const id=sourceRows[fragment.path[1] as number]?.recordId;if(typeof id==='string')ids.add(id);
      }else if(fragment.path?.length===0){
        for(const span of sourceSpans)if(typeof span.recordId==='string'&&span.start<fragment.offset+row.serializedResult.length&&span.end>fragment.offset)ids.add(span.recordId);
      }
    }
    for(const id of ids)pageNumbers.get(id)?.push(index+1);
  }
  const directory:Directory={totalRecords:recordIds.length,listedRecords:0,complete:false,
    instruction:'仅定位，不代表正文交付。一份分页可含多条记录；ranges为原文UTF-16左闭右开范围，pageRanges为本快照闭区间页码。',records:[]};
  const fits=(value:Directory)=>estimateTokens(JSON.stringify(value))<=512
    &&estimateTokens(JSON.stringify({...firstResult,recordDirectory:value}))<=budget;
  if(!fits(directory))return;
  for(const id of recordIds.slice(0,8)){
    const spans=coverage.filter(c=>c.recordId===id),first=spans[0],numbers=pageNumbers.get(id)!;
    if(!first||!numbers.length)break;
    const ranges=mergedRanges(spans.map(c=>[c.start,c.end]));
    const pageRanges=mergedRanges(numbers.map(n=>[n,n+1])).map(([start,end]):[number,number]=>[start,end-1]);
    const records=[...directory.records,{recordId:id,taskId:first.taskId,version:first.version,ranges,pageRanges,
      readWith:{tool:'context_read_children' as const,arguments:{summaryId:id}}}];
    const candidate={...directory,records,listedRecords:records.length,complete:records.length===recordIds.length};
    if(!fits(candidate))break;
    Object.assign(directory,candidate);
  }
  return directory;
}
