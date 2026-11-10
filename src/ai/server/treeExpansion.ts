import { randomUUID } from 'node:crypto';
import { estimateTokens } from '../tokens';
import { resultPages } from './resultPaging';
import { GRAPH_READ_LIMITS, resourceLimit } from './graphReadLimits';

export type TreeRow = Record<string,unknown>;
export interface TreeListBranch { id:string; parentId:string; childIds:string[]; pages:TreeRow[] }

/** Breadth-first traversal. fits must also measure a branch as a standalone root. */
export function expandTree(rootId:string,childrenOf:(id:string)=>string[],card:(id:string)=>TreeRow,
  fits:(tree:TreeRow)=>boolean,terminalKey:string,paginate?:(id:string,ids:string[],rows:TreeRow[])=>TreeListBranch|undefined) {
  const tree=card(rootId),refs=[rootId],expanded:string[]=[],branches:TreeListBranch[]=[];
  const queue=[{id:rootId,row:tree}],omitted:string[]=[];
  let captured=1;
  for(let at=0;at<queue.length;at++){
    const {id,row}=queue[at],ids=childrenOf(id);
    if(!ids.length){expanded.push(id);continue;}
    if(captured+ids.length>GRAPH_READ_LIMITS.objects){omitted.push(id);continue;}
    const children=ids.map(card),terminal=row[terminalKey];
    delete row[terminalKey];row.children=children;
    if(fits(tree)){
      captured+=ids.length;expanded.push(id);refs.push(...ids);children.forEach((child,i)=>queue.push({id:ids[i],row:child}));continue;
    }
    // A short branch can be retried alone. Otherwise freeze its whole child list,
    // even if that list needs just one page without the parent card's overhead.
    const needsPaging=!fits(row);
    delete row.children;row[terminalKey]=terminal;omitted.push(id);
    if(!needsPaging)continue;
    const branch=paginate?.(id,ids,children);if(!branch)continue;
    row.childrenPage={totalChildren:ids.length,totalPages:branch.pages.length,
      readWith:{tool:'context_read_pages',arguments:{pointerId:branch.id,page:1}}};
    if(fits(tree)){
      resourceLimit(branches.reduce((n,b)=>n+b.pages.length,1)+branch.pages.length<=GRAPH_READ_LIMITS.pages,'pages');
      captured+=ids.length;branches.push(branch);
    }else delete row.childrenPage;
  }
  return {tree,refs,expanded,omitted,branches};
}

/** Freeze the complete immediate list after its standalone tree fails to fit. */
export function treeListBranch(parentId:string,childIds:string[],rows:TreeRow[],budget:number,
  wrap:(items:TreeRow[])=>TreeRow,fits:(data:TreeRow)=>boolean):TreeListBranch|undefined {
  resourceLimit(childIds.length<=GRAPH_READ_LIMITS.objects,'objects');
  resourceLimit(Buffer.byteLength(JSON.stringify(rows))<=GRAPH_READ_LIMITS.sourceBytes,'sourceBytes');
  const pages:TreeRow[]=[];let items:TreeRow[]=[];
  for(const row of rows){
    if(fits(wrap([...items,row]))){items.push(row);continue;}
    if(items.length){pages.push(wrap(items));items=[];resourceLimit(pages.length<=GRAPH_READ_LIMITS.pages,'pages');}
    if(fits(wrap([row]))){items=[row];continue;}
    // Summary text/bindings can themselves exceed a page; retain every fragment.
    let limit=Math.floor(budget-estimateTokens(JSON.stringify(wrap([])))-256),parts:TreeRow[]=[];
    while(limit>=128){parts=resultPages({items:[row]},limit).map(part=>({...wrap([]),...part}));if(parts.every(fits))break;limit=Math.floor(limit*.75);}
    if(limit<128)return;
    pages.push(...parts);resourceLimit(pages.length<=GRAPH_READ_LIMITS.pages,'pages');
  }
  if(items.length)pages.push(wrap(items));
  resourceLimit(pages.length<=GRAPH_READ_LIMITS.pages,'pages');
  return {id:`read:${randomUUID()}`,parentId,childIds,pages};
}
