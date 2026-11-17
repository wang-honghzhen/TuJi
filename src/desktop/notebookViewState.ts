import type { UserNotePage } from '@/ai/domain';
import { userNoteDirectoryPages, type UserNoteDirectory } from '@/ai/userNotes';
import type { NotebookTab, PanelState } from './api';

type NotebookView = Pick<PanelState, 'noteTabs' | 'notePageId' | 'noteDirectoryId'>;

/** Retain page identity across renumbering, membership changes and restart. */
export function reconcileNotebookView(view: NotebookView, pages: UserNotePage[], directories: UserNoteDirectory[]): Partial<NotebookView> | undefined {
  const patch: Partial<NotebookView> = {};
  const directoryIds = new Set(directories.map(directory => directory.id));
  const parents = new Set(directories.map(directory => directory.parentId ?? ''));
  const pageId = pages.some(page => page.id === view.notePageId) ? view.notePageId : pages[0]?.id ?? '';
  if (pageId !== view.notePageId) patch.notePageId = pageId;
  if (view.noteDirectoryId && !directoryIds.has(view.noteDirectoryId)) patch.noteDirectoryId = '';
  let changed = false;
  const noteTabs = (view.noteTabs ?? []).map((tab): NotebookTab => {
    const directoryId = directoryIds.has(tab.directoryId) ? tab.directoryId : '';
    // A directory browser remains a browser when a first page is added: opening
    // its reader is an explicit action that must create a separate new tab.
    const kind = directoryId && !parents.has(directoryId) ? tab.kind : 'directory';
    const candidates = userNoteDirectoryPages(pages, directoryId, directories);
    const pageId = kind === 'pages' ? (candidates.some(page => page.id === tab.pageId) ? tab.pageId : candidates[0]?.id) : undefined;
    if (directoryId === tab.directoryId && kind === tab.kind && pageId === tab.pageId) return tab;
    changed = true;
    return { id: tab.id, directoryId, kind, ...(pageId ? { pageId } : {}) };
  });
  if (changed) patch.noteTabs = noteTabs;
  return Object.keys(patch).length ? patch : undefined;
}
