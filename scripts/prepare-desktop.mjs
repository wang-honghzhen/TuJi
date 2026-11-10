import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { ocrRevision as revision, downloadOcrResource } from './ocr-resources.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, '.cache', 'desktop', 'ocr');
await fs.mkdir(directory, { recursive: true });
let cached = false;
try {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'models.manifest.json'), 'utf8'));
  cached = manifest.models.length === 2;
  for (const language of ['chi_sim', 'eng']) {
    const record = manifest.models.find(item => item.language === language && item.revision === revision);
    const bytes = await fs.readFile(path.join(directory, `${language}.traineddata`));
    if (!record || bytes.length !== record.size || createHash('sha256').update(bytes).digest('hex') !== record.sha256) cached = false;
  }
} catch { /* A fresh build prepares only public, pinned OCR resources. */ }
if (!cached) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/ocr-setup.mjs'], {
      cwd: root, windowsHide: true, stdio: 'inherit',
      env: { ...process.env, QIXUE_OCR_DATA_DIR: directory, QIXUE_OCR_LANGUAGE: 'chi_sim+eng' },
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`OCR 资源准备失败 (${code})`)));
  });
}
const license = path.join(directory, 'LICENSE');
try { await fs.access(license); }
catch {
  const contents = (await downloadOcrResource('LICENSE')).toString('utf8');
  if (!contents.includes('Apache License')) throw new Error('OCR 许可文件内容无效');
  await fs.writeFile(license, contents);
}
console.log('桌面资源已准备：简体中文、英文 OCR 模型及许可文件。');
