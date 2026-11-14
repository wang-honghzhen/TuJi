import type { UserNotePage } from '../domain';
import { userNoteText, type UserNoteBlock, type UserNoteDirectory, type UserNoteImage } from '../userNotes';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { requireValue, text } from './errors';
import { Repository, id, now } from './repository';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown, label: string) => { const result = text(value, label, 1000); requireValue(result.length > 0, label + '不能为空'); return result; };
const finite = (value: unknown, min: number, max: number, label: string): number => {
  requireValue(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max, label + '超出范围'); return value;
};

function normalizeBlocks(repo: Repository, value: unknown): UserNoteBlock[] {
  requireValue(Array.isArray(value), '笔记内容格式无效');
  const ids = new Set<string>();
  const uniqueId = (value: unknown) => { const result = identifier(value, '内容 ID'); requireValue(!ids.has(result), '内容 ID 不能重复'); ids.add(result); return result; };
  const result = value.map((block): UserNoteBlock => {
    requireValue(record(block), '笔记内容格式无效');
    const blockId = uniqueId(block.id);
    if (block.type === 'text') return { id: blockId, type: 'text', text: text(block.text, '笔记正文', 2_000_000) };
    requireValue(block.type === 'images' && Array.isArray(block.images), '图片区域格式无效');
    const images = block.images.map((image): UserNoteImage => {
      requireValue(record(image), '图片格式无效');
      const imageId = uniqueId(image.id), src = text(image.src, '图片地址', 200);
      const filename = /^\/api\/qixue\/user-note-images\/([a-f0-9]{64}\.png)$/.exec(src)?.[1];
      requireValue(filename && repo.artifactDirectory && existsSync(path.join(repo.artifactDirectory, 'user-notes', filename)), '笔记图片不存在，请重新粘贴', 'IMAGE_UNAVAILABLE');
      const sourceCrop = image.crop ?? { left: 0, top: 0, right: 0, bottom: 0 };
      requireValue(record(sourceCrop), '图片裁剪范围无效');
      const crop = { left: finite(sourceCrop.left, 0, 1, '裁剪左边界'), top: finite(sourceCrop.top, 0, 1, '裁剪上边界'),
        right: finite(sourceCrop.right, 0, 1, '裁剪右边界'), bottom: finite(sourceCrop.bottom, 0, 1, '裁剪下边界') };
      requireValue(crop.left + crop.right < 1 && crop.top + crop.bottom < 1, '裁剪后必须保留图片区域');
      return { id: imageId, src, x: finite(image.x, 0, 1_000_000, '图片位置'), y: finite(image.y, 0, 1_000_000, '图片位置'),
        width: finite(image.width, 1, 100_000, '图片宽度'), height: finite(image.height, 1, 100_000, '图片高度'),
        rotation: finite(image.rotation, -360_000, 360_000, '图片角度') % 360, crop };
    });
    return { id: blockId, type: 'images', images };
  });
  requireValue(userNoteText(result).length <= 2_000_000, '笔记正文过长，请新建一页');
  return result;
}

export function userNotebookCommand(repo: Repository, action: string, payload: Record<string, unknown>) {
  return repo.transaction(state => {
    const pages = state.userNotePages ??= [], directories = state.userNoteDirectories ??= [];
    const findDirectory = (directoryId: string) => {
      const directory = directories.find(value => value.id === directoryId);
      requireValue(directory, '目录已被删除或不存在', 'NOT_FOUND'); return directory;
    };
    const pageDestination = (directoryId: unknown): string | undefined => {
      if (directoryId === undefined || directoryId === '') return undefined;
      const target = identifier(directoryId, '目录 ID'); findDirectory(target);
      requireValue(!directories.some(directory => directory.parentId === target), '此目录包含子目录，不能放入笔记页', 'DIRECTORY_HAS_CHILDREN');
      return target;
    };
    const touchDirectory = (directoryId?: string) => { if (directoryId) { const directory = directories.find(d => d.id === directoryId); if (directory) directory.updatedAt = now(); } };
    const create = (directoryId?: string) => {
      const stamp = now();
      const page: UserNotePage = { id: id('user-page:'), text: '', version: 1, createdAt: stamp, updatedAt: stamp, ...(directoryId ? { directoryId } : {}) };
      pages.push(page); touchDirectory(directoryId); return page;
    };
    if (action === 'userNote.directory.create') {
      const name = text(payload.name, '目录名称', 200).trim();
      requireValue(name && name !== '.' && name !== '..' && !/[\\/\u0000-\u001f]/.test(name), '目录名称不能为空，也不能包含斜杠或控制字符');
      const parentId = payload.parentId === undefined || payload.parentId === '' ? undefined : identifier(payload.parentId, '父目录 ID');
      if (parentId) findDirectory(parentId);
      requireValue(!parentId || !pages.some(page => page.directoryId === parentId), '此目录包含笔记页，不能创建子目录', 'DIRECTORY_HAS_PAGES');
      requireValue(!directories.some(directory => directory.parentId === parentId && directory.name === name), '同一目录下已有这个名称', 'DIRECTORY_NAME_EXISTS');
      const stamp = now(), directory: UserNoteDirectory = { id: id('note-dir:'), name, ...(parentId ? { parentId } : {}), createdAt: stamp, updatedAt: stamp };
      directories.push(directory); touchDirectory(parentId);
      repo.event('user-notebook', 'user_note.directory_created', { directoryId: directory.id }); return structuredClone(directory);
    }
    if (action === 'userNote.directory.delete') {
      const directory = findDirectory(identifier(payload.id, '目录 ID'));
      requireValue(typeof payload.deletePages === 'boolean', '请选择删除目录或删除目录及全部笔记');
      const deleted = new Set([directory.id]), queue = [directory.id];
      while (queue.length) { const parent = queue.shift()!; for (const child of directories) if (child.parentId === parent && !deleted.has(child.id)) { deleted.add(child.id); queue.push(child.id); } }
      const deletedPageIds: string[] = [];
      for (let i = pages.length - 1; i >= 0; i--) {
        const page = pages[i]; if (!page.directoryId || !deleted.has(page.directoryId)) continue;
        if (payload.deletePages) { deletedPageIds.push(page.id); pages.splice(i, 1); }
        else { delete page.directoryId; page.version++; page.updatedAt = now(); }
      }
      state.userNoteDirectories = directories.filter(value => !deleted.has(value.id));
      touchDirectory(directory.parentId);
      repo.event('user-notebook', 'user_note.directory_deleted', { directoryIds: [...deleted], deletedPageIds, deletePages: payload.deletePages });
      return { deletedDirectoryIds: [...deleted], deletedPageIds };
    }
    if (action === 'userNote.create' || action === 'userNote.ensure') {
      const destination = pageDestination(payload.directoryId);
      const page = action === 'userNote.ensure' && pages.length ? pages[0] : create(destination);
      repo.event('user-notebook', 'user_note.opened', { pageId: page.id });
      return structuredClone(page);
    }
    requireValue(['userNote.save', 'userNote.delete', 'userNote.assign'].includes(action), '不支持的笔记操作');
    const page = pages.find(value => value.id === text(payload.id, '笔记页 ID', 1000));
    requireValue(page, '这页笔记已被删除', 'NOT_FOUND');
    requireValue(Number.isInteger(payload.expectedVersion) && payload.expectedVersion === page.version,
      '这页笔记已在其他窗口修改，请保留当前内容并重新打开此页', 'VERSION_CONFLICT');
    if (action === 'userNote.assign') {
      const destination = pageDestination(payload.directoryId);
      requireValue(!destination || !page.directoryId || destination === page.directoryId, '这页笔记已在其他目录，请先移出原目录', 'PAGE_ALREADY_ASSIGNED');
      touchDirectory(page.directoryId); touchDirectory(destination);
      if (destination) page.directoryId = destination; else delete page.directoryId;
      page.version++; page.updatedAt = now();
      repo.event('user-notebook', 'user_note.assigned', { pageId: page.id, directoryId: destination }); return structuredClone(page);
    }
    if (action === 'userNote.save') {
      if (payload.blocks !== undefined) { page.blocks = normalizeBlocks(repo, payload.blocks); page.text = userNoteText(page.blocks); }
      else {
        requireValue(!page.blocks?.some(block => block.type === 'images' && block.images.length), '图文笔记需要完整保存，请重新打开此页', 'RICH_CONTENT_REQUIRED');
        page.text = text(payload.text, '笔记正文', 2_000_000); delete page.blocks;
      }
      page.version++; page.updatedAt = now();
      repo.event('user-notebook', 'user_note.saved', { pageId: page.id });
      return structuredClone(page);
    }
    const index = pages.indexOf(page); pages.splice(index, 1); touchDirectory(page.directoryId);
    if (!pages.length) create();
    repo.event('user-notebook', 'user_note.deleted', { pageId: page.id });
    return { nextPageId: pages[Math.min(index, pages.length - 1)].id };
  });
}
