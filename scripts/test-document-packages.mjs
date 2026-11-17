import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.cache', 'document-packages', 'tests.cjs');
await build({ absWorkingDir: root, entryPoints: ['scripts/document-packages.test.ts'], outfile: output, bundle: true,
  platform: 'node', format: 'cjs', target: 'node24', alias: { '@': path.join(root, 'src') },
  external: ['electron', 'pdfjs-dist', 'pdfjs-dist/*', '@napi-rs/canvas', 'tesseract.js'] });
const result = spawnSync(process.execPath, ['--test', output], { stdio: 'inherit', cwd: root });
process.exitCode = result.status ?? 1;
