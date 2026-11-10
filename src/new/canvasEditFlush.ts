/** UI save barrier. Automatic executor turns do not call this or save drafts. */
const editors=new Map<string,Set<()=>Promise<boolean>>>();
const mutations=new Map<string,Set<Promise<unknown>>>();
export function registerCanvasEditor(canvasId:string,finish:()=>Promise<boolean>){
  const set=editors.get(canvasId)??new Set();set.add(finish);editors.set(canvasId,set);
  return ()=>{set.delete(finish);if(!set.size)editors.delete(canvasId);};
}
export function trackCanvasMutation<T>(canvasId:string,operation:Promise<T>):Promise<T>{
  const set=mutations.get(canvasId)??new Set();set.add(operation);mutations.set(canvasId,set);
  void operation.finally(()=>{set.delete(operation);if(!set.size)mutations.delete(canvasId);}).catch(()=>undefined);
  return operation;
}
export async function flushCanvasEdits(canvasId:string){
  // Capture in-flight saves before awaiting editors, so a rejection cannot vanish.
  const pending=[...mutations.get(canvasId)??[]];
  const saves=await Promise.allSettled([...editors.get(canvasId)??[]].map(finish=>finish()));
  const writes=await Promise.allSettled([...pending,...mutations.get(canvasId)??[]]);
  if(saves.some(r=>r.status==='rejected'||!r.value)||writes.some(r=>r.status==='rejected'))
    throw new Error('画布修改尚未成功保存，请处理编辑错误后再发送；消息草稿已保留。');
}
