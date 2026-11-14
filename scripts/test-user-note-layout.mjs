import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const outfile = path.resolve('.cache/user-note-layout.test.mjs');
await build({ entryPoints: ['scripts/user-note-layout.test.ts'], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node24' });
await import(pathToFileURL(outfile).href);
