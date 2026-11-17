import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, '.cache', 'layout-runtime');
for (const [input, output] of [['scripts/layout-runtime.test.ts', 'test.cjs'], ['scripts/layout-normalization.test.ts', 'normalization.cjs'], ['scripts/layout-expansion.test.ts', 'expansion.cjs'],
  ['scripts/layout-integration.test.ts', 'integration.cjs'], ['scripts/manual-layout.test.ts', 'manual.cjs'],
  ['scripts/manual-layout-integration.test.ts', 'manual-integration.cjs'], ['src/ai/server/layoutWorker.ts', 'layout-worker.cjs']]) {
  await build({ absWorkingDir: root, entryPoints: [input], outfile: path.join(out, output), bundle: true,
    platform: 'node', format: 'cjs', target: 'node24', alias: { '@': path.join(root, 'src') },
    external: ['electron', 'pdfjs-dist', 'pdfjs-dist/*', '@napi-rs/canvas', 'tesseract.js'] });
}
const result = spawnSync(process.execPath, ['--test', ...['test.cjs', 'normalization.cjs', 'expansion.cjs', 'integration.cjs', 'manual.cjs', 'manual-integration.cjs'].map(file => path.join(out, file))], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
