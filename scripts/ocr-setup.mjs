import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ocrRevision as revision, ocrSource, downloadOcrResource } from './ocr-resources.mjs';

// Official Tesseract fast LSTM models, fixed to a reviewed source revision.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.resolve(process.env.QIXUE_OCR_DATA_DIR ?? path.join(process.env.QIXUE_DATA_DIR ?? path.join(root, '.local', 'data'), 'ocr'));
const languages = (process.env.QIXUE_OCR_LANGUAGE ?? 'chi_sim+eng').split('+');
if (!languages.length || languages.some(language => !['chi_sim', 'chi_tra', 'eng'].includes(language))) throw new Error('此安装命令支持 chi_sim、chi_tra、eng。');
await fs.mkdir(directory, { recursive: true });
const records = [];
for (const language of languages) {
  const source = ocrSource(`${language}.traineddata`);
  const data = await downloadOcrResource(`${language}.traineddata`);
  if (data.length < 100000 || data.length > 30000000) throw new Error(`语言模型 ${language} 文件大小异常`);
  const temporary = path.join(directory, `.${language}.${randomUUID()}.tmp`), target = path.join(directory, `${language}.traineddata`);
  const handle = await fs.open(temporary, 'wx');
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temporary, target);
  records.push({ language, source, revision, size: data.length, sha256: createHash('sha256').update(data).digest('hex') });
  console.log(`OCR语言模型已保存：${language} (${data.length} bytes)`);
}
await fs.writeFile(path.join(directory, 'models.manifest.json'), JSON.stringify({ format: 'qixue-local-ocr-v1', installedAt: new Date().toISOString(), models: records }, null, 2));
console.log(`本地OCR目录：${directory}。识别用户文档时不会下载模型或上传文件。`);
