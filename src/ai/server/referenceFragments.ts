import { isReferenceField } from './graphReferences';

export interface ReferenceEdit { start:number; end:number; text:string }
export type EmbeddedReferenceEdits = (key:string, row:Record<string,unknown>) => ReferenceEdit[] | undefined;
/** Track structural reference tokens through serialized argument/result wrappers, never body text. */
export function referenceEdits(text:string,encode:(id:string)=>string,record=true,
  embeddedRootFields:readonly string[]=record?['arguments','result']:[], embedded?:EmbeddedReferenceEdits):ReferenceEdit[] {
  let at=0;const edits:ReferenceEdit[]=[];
  let root:unknown;
  if(embedded)try{root=JSON.parse(text);}catch{return [];}
  const whitespace=()=>{while(at<text.length&&/\s/.test(text[at]))at++;};
  const string=()=>{
    const start=at++;
    while(at<text.length){const c=text[at++];if(c==='\\')at++;else if(c==='"')return {start,end:at,value:JSON.parse(text.slice(start,at)) as string};}
    throw new Error('Invalid string');
  };
  const value=(key:string,depth:number,arrayKey?:string,nested=false,decoded?:unknown,parent?:Record<string,unknown>):void=>{
    if(depth>100)throw new Error('Deep JSON');whitespace();
    if(text[at]==='"'){
      const token=string();
      if(isReferenceField(key)||arrayKey!==undefined&&isReferenceField(arrayKey,true)){
        const alias=encode(token.value);if(alias!==token.value)edits.push({start:token.start,end:token.end,text:JSON.stringify(alias)});
      }else{
        const inner=(parent&&embedded?.(key,parent))
          ??(nested&&/^[\s]*[\[{]/.test(token.value)?referenceEdits(token.value,encode,false,[],embedded):[]);
        if(inner.length){
          const boundaries:number[]=[token.start+1];let cursor=token.start+1;
          while(cursor<token.end-1){if(text[cursor]==='\\')cursor+=text[cursor+1]==='u'?6:2;else cursor++;boundaries.push(cursor);}
          for(const edit of inner)edits.push({start:boundaries[edit.start],end:boundaries[edit.end],text:JSON.stringify(edit.text).slice(1,-1)});
        }
      }
      return;
    }
    if(text[at]==='{'){
      at++;whitespace();if(text[at]==='}'){at++;return;}
      while(at<text.length){whitespace();if(text[at]!=='"')throw new Error('Invalid key');const property=string().value;
        whitespace();if(text[at++]!==':')throw new Error('Invalid colon');
        const row=decoded as Record<string,unknown>|undefined;
        value(property,depth+1,key==='temporaryRefs'?'refs':undefined,depth===0&&embeddedRootFields.includes(property),row?.[property],row);
        whitespace();if(text[at]==='}'){at++;return;}if(text[at++]!==',')throw new Error('Invalid object');}
      throw new Error('Unclosed object');
    }
    if(text[at]==='['){
      at++;whitespace();if(text[at]===']'){at++;return;}
      let index=0;
      while(at<text.length){value('',depth+1,key,['resultPages','expandedPages'].includes(key),Array.isArray(decoded)?decoded[index++]:undefined);whitespace();if(text[at]===']'){at++;return;}if(text[at++]!==',')throw new Error('Invalid array');}
      throw new Error('Unclosed array');
    }
    const literal=/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at));
    if(!literal)throw new Error('Invalid value');at+=literal[0].length;
  };
  try{value('',0,undefined,false,root);whitespace();return at===text.length?edits.sort((a,b)=>a.start-b.start):[];}catch{return [];}
}

/** Clip edits without changing archive offsets. A split token is emitted on its first page. */
export function sliceReferenceEdits(edits:ReferenceEdit[],start:number,end:number):ReferenceEdit[] {
  return edits.filter(edit=>edit.end>start&&edit.start<end).map(edit=>({
    start:Math.max(start,edit.start)-start,end:Math.min(end,edit.end)-start,text:edit.start>=start?edit.text:'',
  }));
}

/** Source offsets remain canonical even if a reference token straddles two material slices. */
export function projectReferenceFragment(source:string,start:number,end:number,edits:ReferenceEdit[]):string {
  let result='',at=start;
  for(const edit of edits){
    if(edit.end<=start||edit.start>=end)continue;
    if(edit.start>at)result+=source.slice(at,edit.start);
    if(edit.start>=start)result+=edit.text;
    at=Math.max(at,edit.end);
  }
  if(at<end)result+=source.slice(at,end);return result;
}
