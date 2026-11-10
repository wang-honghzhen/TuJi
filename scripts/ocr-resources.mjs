export const ocrRevision = '87416418657359cb625c412a48b6e1d6d41c29bd';
export const ocrSource = filename => `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${ocrRevision}/${filename}`;

/** Both endpoints serve the same revision from the official Tesseract repository. */
export async function downloadOcrResource(filename) {
  const urls = [ocrSource(filename),
    `https://api.github.com/repos/tesseract-ocr/tessdata_fast/contents/${filename}?ref=${ocrRevision}`];
  let reason = 'unknown';
  for (const url of urls) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'error',
        headers: { Accept: 'application/vnd.github.raw+json', 'User-Agent': 'Tuji-OCR-Setup' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) { reason = error.message; }
  }
  throw new Error(`OCR 资源 ${filename} 下载失败：${reason}`);
}
