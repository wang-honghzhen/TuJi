import { build } from 'esbuild';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(root, '.cache');
await mkdir(cache, { recursive: true });
const directory = await mkdtemp(path.join(cache, 'version-review-'));
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Network is disabled for version review'); };
try {
  for (const [suite, entry] of [['runtime', 'runReviewRuntime'], ['canvas', 'runCanvasReview'],
    ['notes', 'runNotesReview'], ['memory', 'testMemoryReview']]) {
    const outfile = path.join(directory, `${suite}.cjs`);
    await build({ absWorkingDir: root, entryPoints: [`scripts/version-review-${suite}.test.ts`], outfile,
      bundle: true, platform: 'node', format: 'cjs', target: 'node24', alias: { '@': path.join(root, 'src') },
      external: ['pdfjs-dist', 'pdfjs-dist/*', '@napi-rs/canvas', 'tesseract.js'] });
    await (await import(pathToFileURL(outfile).href))[entry]();
  }
  console.log('All extended version safety regressions passed; no provider calls or persistent test databases.');
} finally {
  globalThis.fetch = originalFetch;
  const relative = path.relative(cache, directory);
  if (relative.startsWith('version-review-') && !relative.startsWith('..') && !path.isAbsolute(relative))
    await rm(directory, { recursive: true, force: true });
}
