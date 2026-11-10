import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Artifact } from '../domain';
import type { AttachmentLimits, ImageAssetRef } from '../attachments';
import { requireValue } from './errors';

/** Inspect dimensions before decoding an untrusted image into a pixel buffer. */
export function imageHeader(bytes: Uint8Array): { mimeType: string; width: number; height: number; firstFrameOnly?: boolean } | undefined {
  const b = Buffer.from(bytes), tag = (a: number, z: number) => b.subarray(a, z).toString('ascii');
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
    return { mimeType: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length >= 10 && ['GIF87a','GIF89a'].includes(tag(0,6))) return { mimeType: 'image/gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8), firstFrameOnly: true };
  if (b.length >= 25 && tag(0,4) === 'RIFF' && tag(8,12) === 'WEBP') {
    if (b.length >= 30 && tag(12,16) === 'VP8X') return { mimeType:'image/webp', width: b.readUIntLE(24,3)+1, height:b.readUIntLE(27,3)+1 };
    if (b.length >= 30 && tag(12,16) === 'VP8 ' && b[23] === 0x9d && b[24] === 1 && b[25] === 0x2a)
      return { mimeType:'image/webp', width:b.readUInt16LE(26)&0x3fff, height:b.readUInt16LE(28)&0x3fff };
    if (tag(12,16) === 'VP8L' && b[20] === 0x2f) { const bits=b.readUInt32LE(21); return {mimeType:'image/webp',width:(bits&0x3fff)+1,height:((bits>>>14)&0x3fff)+1}; }
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let offset=2;
    while(offset+4<=b.length){
      if(b[offset++]!==0xff)break;
      while(b[offset]===0xff)offset++;
      const marker=b[offset++]; if(marker===0xda||marker===0xd9)break;
      if(marker===0x01||marker>=0xd0&&marker<=0xd7)continue;
      if(offset+2>b.length)break; const length=b.readUInt16BE(offset);
      if(length<2||offset+length>b.length)break;
      if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)&&length>=7)
        return {mimeType:'image/jpeg',width:b.readUInt16BE(offset+5),height:b.readUInt16BE(offset+3)};
      offset+=length;
    }
  }
}
export function validateImageDimensions(header: ReturnType<typeof imageHeader>, limits: AttachmentLimits) {
  requireValue(header && header.width > 0 && header.height > 0 && header.width*header.height <= limits.imagePixels,
    `图片格式无效或解码像素超过 ${limits.imagePixels} 上限`, 'IMAGE_SIZE_LIMIT');
  return header;
}
export async function renderArtifactImages(artifact: Artifact, directory: string, limits: AttachmentLimits,
  options: { pages?: unknown; crop?: unknown; signal?: AbortSignal } = {}): Promise<ImageAssetRef[]> {
  requireValue(/^[a-f0-9]{64}$/.test(artifact.hash), '原文件对象地址无效', 'IMAGE_UNAVAILABLE');
  const original=await fs.readFile(path.join(directory,'objects',artifact.hash));
  requireValue(createHash('sha256').update(original).digest('hex')===artifact.hash,'原文件校验失败','IMAGE_UNAVAILABLE');
  const moduleName='@napi-rs/canvas'; const {createCanvas,loadImage}=await import(moduleName) as typeof import('@napi-rs/canvas');
  const crop=options.crop as {x:number;y:number;width:number;height:number}|undefined;
  if(crop)requireValue([crop.x,crop.y,crop.width,crop.height].every(Number.isFinite)&&crop.x>=0&&crop.y>=0&&crop.width>0&&crop.height>0
    &&crop.x+crop.width<=1&&crop.y+crop.height<=1,'crop须是图片内0到1的归一化矩形','INVALID_ARGUMENT');
  const pdf=artifact.mimeType==='application/pdf';
  requireValue(pdf||artifact.mimeType.startsWith('image/'),'此附件不支持图像查看','INVALID_ARGUMENT');
  const pages=options.pages===undefined?[1]:options.pages;
  requireValue(Array.isArray(pages)&&pages.length>0&&pages.length<=limits.imagePages&&pages.every(p=>Number.isSafeInteger(p)&&p>=1&&p<=(pdf?artifact.pages??0:1)),
    `请选择合法物理页，一次最多 ${limits.imagePages} 页`,'INVALID_ARGUMENT');
  const result:ImageAssetRef[]=[];
  let document:import('pdfjs-dist').PDFDocumentProxy|undefined,loading:import('pdfjs-dist').PDFDocumentLoadingTask|undefined;
  try{
    if(pdf){requireValue(artifact.visualState!=='unavailable','PDF页面图像不可用','IMAGE_UNAVAILABLE');const pdfModule='pdfjs-dist/legacy/build/pdf.mjs';
      const pdfjs=await import(pdfModule) as typeof import('pdfjs-dist');
      loading=pdfjs.getDocument({data:new Uint8Array(original),useSystemFonts:true,verbosity:0,maxImageSize:limits.imagePixels});document=await loading.promise;
      requireValue(document.numPages<=limits.pdfPages,'PDF页数超过查看上限','PDF_PAGE_LIMIT');}
    for(const pageNumber of [...new Set(pages as number[])]){
      options.signal?.throwIfAborted();
      let source:import('@napi-rs/canvas').Canvas|import('@napi-rs/canvas').Image;
      const edge=crop?limits.cropEdge:limits.previewEdge;
      if(document){const page=await document.getPage(pageNumber),base=page.getViewport({scale:1});
        const scale=Math.min(edge/Math.max(base.width*(crop?.width??1),base.height*(crop?.height??1)),Math.sqrt(limits.imagePixels/(base.width*base.height)));
        const viewport=page.getViewport({scale}),canvas=createCanvas(Math.max(1,Math.floor(viewport.width)),Math.max(1,Math.floor(viewport.height)));
        const rendering=page.render({viewport,canvasContext:canvas.getContext('2d'),canvas} as unknown as Parameters<typeof page.render>[0]);
        const abort=()=>rendering.cancel();options.signal?.addEventListener('abort',abort,{once:true});
        try{await rendering.promise;}finally{options.signal?.removeEventListener('abort',abort);page.cleanup();}source=canvas;
      }else{validateImageDimensions(imageHeader(original),limits);source=await loadImage(original);}
      const x=(crop?.x??0)*source.width,y=(crop?.y??0)*source.height,w=(crop?.width??1)*source.width,h=(crop?.height??1)*source.height;
      const scale=Math.min(1,edge/Math.max(w,h)),width=Math.max(1,Math.round(w*scale)),height=Math.max(1,Math.round(h*scale));
      const target=createCanvas(width,height),ctx=target.getContext('2d');ctx.drawImage(source,x,y,w,h,0,0,width,height);
      const bytes=await target.encode('png'),assetId=createHash('sha256').update(bytes).digest('hex');
      await fs.mkdir(path.join(directory,'visual'),{recursive:true});
      await fs.writeFile(path.join(directory,'visual',`${assetId}.png`),bytes,{flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e;});
      result.push({assetId,mimeType:'image/png',width,height,artifactId:artifact.id,version:artifact.version,...(pdf?{page:pageNumber}:{}),...(crop?{crop}: {})});
    }
  }finally{await loading?.destroy();}
  return result;
}
export async function imageAssetData(directory:string, image:ImageAssetRef):Promise<string>{
  requireValue(/^[a-f0-9]{64}$/.test(image.assetId),'图像资产地址无效','IMAGE_UNAVAILABLE');
  const bytes=await fs.readFile(path.join(directory,'visual',`${image.assetId}.png`));
  requireValue(createHash('sha256').update(bytes).digest('hex')===image.assetId,'图像资产校验失败','IMAGE_UNAVAILABLE');
  return `data:${image.mimeType};base64,${bytes.toString('base64')}`;
}
