import { build } from 'esbuild';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(path.join(root, '.cache'), { recursive: true });
const directory = await mkdtemp(path.join(root, '.cache', 'version-audit-'));
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Network is disabled for version audit'); };
try {
  for (const [suite, entry, source] of [['runtime', 'runRuntimeAudit'], ['canvas', 'testCanvasVersions'],
    ['memory', 'testMemoryAudit'], ['notes', 'testNotesAudit'], ['note-scope', 'testNoteScope', 'scripts/version-note-scope.test.ts'],
    ['notifications', 'testVersionNotifications', 'scripts/version-notifications.test.ts']]) {
    const outfile = path.join(directory, `${suite}.cjs`);
    await build({ absWorkingDir: root, entryPoints: [source ?? `scripts/version-audit-${suite}.test.ts`], outfile,
      bundle: true, platform: 'node', format: 'cjs', target: 'node24', alias: { '@': path.join(root, 'src') },
      external: ['pdfjs-dist', 'pdfjs-dist/*', '@napi-rs/canvas', 'tesseract.js'] });
    console.log(`\n--- ${suite} audit ---`);
    const results = await (await import(pathToFileURL(outfile).href))[entry]();
    if (suite === 'canvas') results.forEach(line => console.log(line));
  }
  console.log('\nAll version regression checks passed; no provider calls or persistent test databases.');
} finally {
  globalThis.fetch = originalFetch;
  const relative = path.relative(path.join(root, '.cache'), directory);
  if (!relative.startsWith('..') && !path.isAbsolute(relative) && relative.startsWith('version-audit-'))
    await rm(directory, { recursive: true, force: true });
}
