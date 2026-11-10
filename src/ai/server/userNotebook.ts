import type { UserNotePage } from '../domain';
import { requireValue, text } from './errors';
import { Repository, id, now } from './repository';

export function userNotebookCommand(repo: Repository, action: string, payload: Record<string, unknown>) {
  return repo.transaction(state => {
    const pages = state.userNotePages ??= [];
    const create = () => {
      const stamp = now();
      const page: UserNotePage = { id: id('user-page:'), text: '', version: 1, createdAt: stamp, updatedAt: stamp };
      pages.push(page); return page;
    };
    if (action === 'userNote.create' || action === 'userNote.ensure') {
      const page = action === 'userNote.ensure' && pages.length ? pages[0] : create();
      repo.event('user-notebook', 'user_note.opened', { pageId: page.id });
      return structuredClone(page);
    }
    const page = pages.find(value => value.id === text(payload.id, '笔记页 ID', 1000));
    requireValue(page, '这页笔记已被删除', 'NOT_FOUND');
    requireValue(Number.isInteger(payload.expectedVersion) && payload.expectedVersion === page.version,
      '这页笔记已在其他窗口修改，请保留当前文字并重新打开此页', 'VERSION_CONFLICT');
    if (action === 'userNote.save') {
      // Preserve every newline, tab and leading/trailing space, including an empty page.
      page.text = text(payload.text, '笔记正文', 2_000_000); page.version++; page.updatedAt = now();
      repo.event('user-notebook', 'user_note.saved', { pageId: page.id });
      return structuredClone(page);
    }
    const index = pages.indexOf(page); pages.splice(index, 1);
    if (!pages.length) create();
    repo.event('user-notebook', 'user_note.deleted', { pageId: page.id });
    return { nextPageId: pages[Math.min(index, pages.length - 1)].id };
  });
}
