import { create } from 'zustand';
import type { AppSnapshot, PresentationPart } from './domain';

export const presentationOwner = (()=>{
  const key='qixue-presentation-window';let value=sessionStorage.getItem(key);
  if(!value){value=crypto.randomUUID();sessionStorage.setItem(key,value);}return value;
})();
export interface CanvasPlayback {taskId:string;cursor:number;mode:'follow'|'review';cameraFollow:boolean;locate:number;consumedLocate?:number;interactionBusy?:boolean;followRequest?:number}
interface PlaybackStore {byCanvas:Record<string,CanvasPlayback>;set:(canvasId:string,value:Partial<CanvasPlayback>)=>void}
export const usePlaybackStore=create<PlaybackStore>((set)=>({byCanvas:{},set:(canvasId,value)=>set(state=>{
  const previous = state.byCanvas[canvasId] ?? {taskId:'',cursor:0,mode:'follow' as const,cameraFollow:true,locate:0};
  const changedPart = value.taskId !== undefined && value.taskId !== previous.taskId || value.cursor !== undefined && value.cursor !== previous.cursor;
  return {byCanvas:{...state.byCanvas,[canvasId]:{...previous,...(changedPart ? {consumedLocate: previous.locate} : {}),...value}}};
})}));
/** The v2 journal is the only authority; missing parts are never synthesized. */
export function taskParts(snapshot:AppSnapshot|null,taskId?:string):PresentationPart[]{
  if(!snapshot||!taskId)return [];
  return (snapshot.presentationParts??[]).filter(p=>p.taskId===taskId).sort((a,b)=>a.seq-b.seq);
}
