/** Shared by settings and the executor; credentials never cross provider origins. */
export function officialDeepSeek(config: { apiFamily?: string; baseUrl: string }): boolean {
  try {
    const url = new URL(config.baseUrl);
    return config.apiFamily === 'deepseek' && url.origin === 'https://api.deepseek.com'
      && !url.username && !url.password && !url.search && !url.hash
      && ['', '/v1'].includes(url.pathname.replace(/\/+$/, ''));
  } catch { return false; }
}
export function webAccessEnabled(config: { apiFamily?: string; baseUrl: string; supportsTools: boolean; webSearchEnabled?: boolean; webSearchProvider?: 'deepseek' }): boolean {
  return config.webSearchEnabled === true && config.supportsTools && (config.webSearchProvider === 'deepseek' || officialDeepSeek(config));
}
export function webUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || Array.from(value).length > 8192 || /[\u0000-\u0020\u007f]/.test(value)) return;
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol) && url.hostname && !url.username && !url.password) return url.href;
  } catch { /* Not an external web URL. */ }
}
