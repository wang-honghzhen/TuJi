import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDirectory, storageSettingsPath, validateDataDirectory } from '../desktop/data-directory.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(projectRoot, '.cache'); await fs.mkdir(cache, { recursive: true });
const directory = await fs.mkdtemp(path.join(cache, 'storage-test-'));
const options = { projectRoot, appData: path.join(directory, '用户配置'), installDirectory: path.join(directory, '程序'), packaged: true };
const selected = path.join(directory, '中文 数据目录');
await fs.mkdir(options.installDirectory, { recursive: true });
await fs.mkdir(selected, { recursive: true });

test('legacy installs and development retain their existing defaults', () => {
  assert.equal(resolveDataDirectory(options), path.join(options.appData, 'QIXUE-v2'));
  assert.equal(resolveDataDirectory({ ...options, packaged: false }), path.join(projectRoot, '.local', 'data'));
});
test('installer UTF-16 setting round trips Chinese and spaces without touching old data', async () => {
  const settings = storageSettingsPath(options.appData);
  await fs.mkdir(path.dirname(settings), { recursive: true });
  const legacy = path.join(options.appData, 'QIXUE-v2'); await fs.mkdir(legacy, { recursive: true });
  const sentinel = path.join(legacy, 'keep.txt'); await fs.writeFile(sentinel, 'existing notes');
  await fs.writeFile(settings, Buffer.from('\ufeff' + selected, 'utf16le'));
  assert.equal(resolveDataDirectory(options), selected);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'existing notes');
  assert.equal(resolveDataDirectory({ ...options, override: path.join(directory, 'override') }), path.join(directory, 'override'));
});
test('bad or unavailable saved locations fail instead of opening an empty default database', async () => {
  const settings = storageSettingsPath(options.appData);
  for (const value of ['', 'relative-path', path.join(directory, 'disconnected-disk'), options.installDirectory,
    path.join(options.installDirectory, 'notes'), directory, path.parse(directory).root]) {
    await fs.writeFile(settings, Buffer.from('\ufeff' + value, 'utf16le'));
    assert.throws(() => resolveDataDirectory(options), undefined, value);
  }
});
test('junctions into the installation tree cannot be used for data', async () => {
  const alias = path.join(directory, '程序链接');
  await fs.symlink(options.installDirectory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => validateDataDirectory(path.join(alias, 'notes'), options.installDirectory));
});
