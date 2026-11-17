import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(root, '.cache'); mkdirSync(cache, { recursive: true });
const output = path.join(mkdtempSync(path.join(cache, 'notebook-tests-')), 'workflows.cjs');
await build({ absWorkingDir: root, entryPoints: ['scripts/notebook-workflows.test.ts'], outfile: output, bundle: true,
  platform: 'node', format: 'cjs', target: 'node24', alias: { '@': path.join(root, 'src') }, external: ['electron', 'pdfjs-dist', 'pdfjs-dist/*', '@napi-rs/canvas', 'tesseract.js'] });
const result = spawnSync(process.execPath, ['--test', output], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
