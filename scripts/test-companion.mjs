import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.cwd(), outfile = path.join(root, '.cache', 'companion-backend-test.cjs');
await build({ entryPoints: ['scripts/companion-backend.test.ts'], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node24',
  alias: { '@': path.join(root, 'src') }, external: ['pdfjs-dist', '@napi-rs/canvas', 'tesseract.js'] });
await (await import(pathToFileURL(outfile).href)).testBackend(root);
const child = spawn(process.execPath, ['scripts/test-companion-desktop.mjs', ...process.argv.slice(2)], { cwd: root, windowsHide: true, stdio: 'inherit' });
const [code] = await once(child, 'exit'); process.exitCode = code ?? 1;
