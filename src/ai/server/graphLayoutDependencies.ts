import type { GraphState } from '@/v3/types';
import { canvasMemberIds } from '../canvasScope';
import { hash } from './repository';

export const layoutDependencyKey = (canvasId:string) => `layout-scope:${canvasId}`;
export const layoutDependencyCanvas = (key:string) => key.startsWith('layout-scope:') ? key.slice(13) : undefined;

/** Layout can resize shared document ancestors and their canvas placements.
 * Include that connected ownership scope, never unrelated canvases. Membership,
 * empty sets and incident edges are hashed too, so insertion/deletion is fenced.
 */
export function graphLayoutVersion(graph:GraphState,canvasId:string):string|undefined {
  if(!graph.canvases.some(c=>c.canvasId===canvasId))return;
  const canvases=new Set([canvasId]),refs=new Set(canvasMemberIds(graph,canvasId));
  let changed=true;
  while(changed){
    changed=false;
    const add=(id:string)=>{if(!refs.has(id)){refs.add(id);changed=true;}};
    for(const doc of Object.values(graph.documents))if(refs.has(doc.documentId)
      ||doc.childNodeIds.some(id=>refs.has(id))||doc.childDocumentIds.some(id=>refs.has(id))){
      add(doc.documentId);doc.childNodeIds.forEach(add);doc.childDocumentIds.forEach(add);
    }
    for(const canvas of graph.canvases){
      const members=canvasMemberIds(graph,canvas.canvasId);
      // Edges can be incident to two otherwise independent canvases; they do not
      // establish shared ownership. Their actual records remain in the hash below.
      if(canvases.has(canvas.canvasId)||[...members].some(id=>(graph.nodes[id]||graph.documents[id])&&refs.has(id))){
        canvases.add(canvas.canvasId);members.forEach(add);
      }
    }
  }
  return hash([graph.layoutVersion,
    graph.canvases.filter(c=>canvases.has(c.canvasId)).sort((a,b)=>a.canvasId.localeCompare(b.canvasId)),
    [...refs].sort().filter(id=>graph.nodes[id]||graph.documents[id]).map(id=>[id,graph.nodes[id]??graph.documents[id]]),
    graph.edges.filter(e=>refs.has(e.sourceNodeId)||refs.has(e.targetNodeId)).slice().sort((a,b)=>a.edgeId.localeCompare(b.edgeId))]);
}
export function currentLayoutHashes(graph:GraphState,keys:Iterable<string>):Record<string,string>{
  return Object.fromEntries([...new Set(keys)].flatMap(key=>{
    const canvasId=layoutDependencyCanvas(key),version=canvasId&&graphLayoutVersion(graph,canvasId);
    return version?[[key,version]]:[];
  }));
}
