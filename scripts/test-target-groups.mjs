import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(root, '.cache', 'target-groups');
mkdirSync(cache, { recursive: true });
const output = path.join(cache, 'target-groups.cjs');
await build({ absWorkingDir: root, entryPoints: ['scripts/target-groups.test.ts'], outfile: output,
  bundle: true, platform: 'node', format: 'cjs', target: 'node24', alias: { '@': path.join(root, 'src') },
  external: ['electron', 'pdfjs-dist', 'pdfjs-dist/*', '@napi-rs/canvas', 'tesseract.js'] });
const result = spawnSync(process.execPath, ['--test', output], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
