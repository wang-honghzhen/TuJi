import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(root, '.cache'); mkdirSync(cache, { recursive: true });
const temporary = mkdtempSync(path.join(cache, 'note-image-tests-'));
try {
  const output = path.join(temporary, 'actions.cjs');
  await build({ absWorkingDir: root, entryPoints: ['scripts/user-note-image-actions.test.ts'], outfile: output, bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['@napi-rs/canvas'] });
  const result = spawnSync(process.execPath, ['--test', output], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { rmSync(temporary, { recursive: true, force: true }); }
