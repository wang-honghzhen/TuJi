import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function buildAiRuntime(outputDirectory = path.join(projectRoot, 'dist-ai')) {
  const outfile = path.join(outputDirectory, 'server.cjs');
  await build({ absWorkingDir: projectRoot, entryPoints: ['src/ai/server/http.ts'], outfile,
    bundle: true, platform: 'node', format: 'cjs', target: 'node24', sourcemap: true,
    alias: { '@': path.join(projectRoot, 'src') }, external: ['electron', 'pdfjs-dist', 'pdfjs-dist/*', '@napi-rs/canvas', 'tesseract.js'] });
  await build({ absWorkingDir: projectRoot, entryPoints: ['src/ai/server/layoutWorker.ts'], outfile: path.join(outputDirectory, 'layout-worker.cjs'),
    bundle: true, platform: 'node', format: 'cjs', target: 'node24', alias: { '@': path.join(projectRoot, 'src') } });
  return outfile;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildAiRuntime(); console.log('本地 AI 运行服务构建完成：dist-ai/server.cjs');
}
