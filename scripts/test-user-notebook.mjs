import { build } from 'esbuild';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.cwd(), outfile = path.join(root, '.cache', 'user-notebook-tests.cjs');
await build({ entryPoints: ['scripts/user-notebook.test.ts'], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node24',
  alias: { '@': path.join(root, 'src') }, external: ['pdfjs-dist', '@napi-rs/canvas', 'tesseract.js'] });
await (await import(pathToFileURL(outfile).href)).testUserNotebook(root);
const viewOutput = path.join(root, '.cache', 'notebook-view-state-tests.cjs');
await build({ entryPoints: ['scripts/notebook-view-state.test.ts'], outfile: viewOutput, bundle: true, platform: 'node', format: 'cjs', target: 'node24', alias: { '@': path.join(root, 'src') } });
(await import(pathToFileURL(viewOutput).href)).testNotebookViewState();
