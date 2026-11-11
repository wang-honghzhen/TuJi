import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export const storageSettingsPath = appData => path.join(appData, 'Tuji', 'data-directory.txt');

/** Keep user files outside the application tree, which the uninstaller removes. */
export function validateDataDirectory(directory, installDirectory, { mustExist = false } = {}) {
  if (typeof directory !== 'string' || !directory.trim() || /[\0\r\n]/.test(directory) || !path.isAbsolute(directory)) {
    throw new Error('数据目录必须是有效的绝对路径，请重新运行安装程序选择数据目录。');
  }
  const selected = path.resolve(directory);
  if (selected === path.parse(selected).root) throw new Error('请选择专门的数据文件夹，不能直接使用磁盘根目录。');
  const canonical = value => {
    const parts = []; let parent = value;
    while (!existsSync(parent)) { const next = path.dirname(parent); if (next === parent) break; parts.unshift(path.basename(parent)); parent = next; }
    return path.resolve(existsSync(parent) ? realpathSync(parent) : parent, ...parts).toLowerCase();
  };
  const data = canonical(selected), installation = canonical(installDirectory);
  const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);
  if (inside(data, installation) || inside(installation, data)) throw new Error('数据目录与程序安装目录必须分开，不能互相包含。');
  if (existsSync(selected)) {
    if (!statSync(selected).isDirectory()) throw new Error('所选数据路径不是文件夹。');
    accessSync(selected, constants.R_OK | constants.W_OK);
  } else if (mustExist) {
    throw new Error(`数据目录不可用：${selected}。请连接对应磁盘或重新运行安装程序；应用不会自动改用其他目录。`);
  }
  return selected;
}

export function resolveDataDirectory({ appData, installDirectory, projectRoot, packaged, override }) {
  if (override?.trim()) return path.resolve(override);
  if (!packaged) return path.join(projectRoot, '.local', 'data');
  let bytes;
  try { bytes = readFileSync(storageSettingsPath(appData)); }
  catch (error) { if (error.code === 'ENOENT') return path.join(appData, 'QIXUE-v2'); throw error; }
  if (bytes.length > 32768) throw new Error('数据目录设置文件过大，请重新运行安装程序。');
  const value = (bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8')).trim();
  return validateDataDirectory(value, installDirectory, { mustExist: true });
}
