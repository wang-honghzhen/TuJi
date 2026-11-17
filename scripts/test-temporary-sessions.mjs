import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const program = ts.createProgram([...parsed.fileNames, path.join(root, 'scripts/temporary-sessions.test.ts')], parsed.options);
const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
if (diagnostics.length) {
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: f => f, getCurrentDirectory: () => root, getNewLine: () => '\n' }));
  process.exit(1);
}
const cache = path.join(root, '.cache'); mkdirSync(cache, { recursive: true });
const directory = mkdtempSync(path.join(cache, 'temporary-session-tests-'));
try {
  const output = path.join(directory, 'tests.cjs');
  await build({ absWorkingDir: root, entryPoints: ['scripts/temporary-sessions.test.ts'], outfile: output,
    bundle: true, platform: 'node', format: 'cjs', target: 'node24', alias: { '@': path.join(root, 'src') },
    external: ['electron', 'pdfjs-dist', 'pdfjs-dist/*', '@napi-rs/canvas', 'tesseract.js'] });
  const result = spawnSync(process.execPath, ['--test', output], { stdio: 'inherit', cwd: root });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  if (!path.resolve(directory).startsWith(cache + path.sep)) throw new Error('Invalid test artifact directory');
  rmSync(directory, { recursive: true, force: true });
}
