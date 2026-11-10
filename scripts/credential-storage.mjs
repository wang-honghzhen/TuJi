import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const header = 'QIXUE-CREDENTIAL-1\n';
// The key travels over stdin/stdout only, never in command arguments or logs.
const windowsScript = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Security
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $payload = [Convert]::FromBase64String($request.data)
  $entropy = [Text.Encoding]::UTF8.GetBytes('QIXUE-v2/API-key')
  $scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
  if ($request.operation -eq 'protect') {
    $result = [Security.Cryptography.ProtectedData]::Protect($payload, $entropy, $scope)
  } elseif ($request.operation -eq 'unprotect') {
    $result = [Security.Cryptography.ProtectedData]::Unprotect($payload, $entropy, $scope)
  } else { exit 1 }
  [Console]::Out.Write([Convert]::ToBase64String($result))
} catch { exit 1 }
`;

function windowsCrypt(operation, input) {
  return new Promise((resolve, reject) => {
    const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsScript, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 15000, maxBuffer: 128 * 1024, encoding: 'utf8' }, (error, stdout) => {
        const output = stdout.trim();
        if (error || !output || !/^[A-Za-z0-9+/]+={0,2}$/.test(output)) {
          reject(new Error('系统加密凭据存储失败，请重试保存密钥。')); return;
        }
        resolve(Buffer.from(output, 'base64'));
      });
    child.stdin.on('error', () => { /* execFile reports a failed helper without exposing its input. */ });
    child.stdin.end(JSON.stringify({ operation, data: input.toString('base64') }));
  });
}

/** Windows hosts share current-user DPAPI storage across desktop/dev/serve.
 * Existing Electron ciphertext is migrated by the desktop that can decrypt it.
 * No plaintext file or success-with-memory-only fallback is used. */
export function createCredentialStorage(directory, { safeStorage } = {}) {
  const filename = path.join(directory, 'credential.bin');
  const electronEncryption = () => Boolean(safeStorage?.isEncryptionAvailable()
    && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'));
  const encrypt = async value => {
    if (process.platform === 'win32') return { kind: 'windows-dpapi', data: (await windowsCrypt('protect', Buffer.from(value, 'utf8'))).toString('base64') };
    if (electronEncryption()) return { kind: 'electron-safe-storage', data: safeStorage.encryptString(value).toString('base64') };
    throw new Error('当前系统无法加密保存密钥，请使用桌面版并启用系统凭据存储。');
  };
  const storage = {
    async get() {
      let saved;
      try {
        const stat = await fs.stat(filename);
        if (stat.size > 128 * 1024) return null;
        saved = await fs.readFile(filename);
      } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('无法读取本地加密凭据，请检查数据目录权限。'); }
      let value;
      try {
        const encoded = saved.toString('utf8');
        if (encoded.startsWith(header)) {
          const record = JSON.parse(encoded.slice(header.length));
          if (typeof record.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(record.data)) return null;
          const payload = Buffer.from(record.data, 'base64');
          if (record.kind === 'windows-dpapi' && process.platform === 'win32') value = (await windowsCrypt('unprotect', payload)).toString('utf8');
          else if (record.kind === 'electron-safe-storage' && electronEncryption()) value = safeStorage.decryptString(payload);
          else return null;
        } else if (electronEncryption()) value = safeStorage.decryptString(saved);
        else return null;
      } catch { return null; } // Preserve unreadable ciphertext so the user can replace it explicitly.
      if (!value || value.length >= 20000 || /[\r\n]/.test(value)) return null;
      if (!saved.toString('utf8').startsWith(header)) await storage.set(value);
      return value;
    },
    async set(value) {
      if (typeof value !== 'string' || !value || value.length >= 20000 || /[\r\n]/.test(value)) throw new Error('调用凭据格式无效。');
      const encrypted = await encrypt(value);
      await fs.mkdir(directory, { recursive: true });
      const temporary = `${filename}.${randomUUID()}.tmp`;
      try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(header + JSON.stringify(encrypted)); await handle.sync(); } finally { await handle.close(); }
        await fs.rename(temporary, filename);
      } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw new Error('加密凭据临时文件清理失败。'); }); }
    },
    async clear() { await fs.unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw new Error('无法清除本地加密凭据。'); }); },
  };
  return storage;
}
