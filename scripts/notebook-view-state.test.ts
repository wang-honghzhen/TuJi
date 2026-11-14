import assert from 'node:assert/strict';
import { reconcileNotebookView } from '../src/desktop/notebookViewState';
import type { UserNotePage } from '../src/ai/domain';
import type { UserNoteDirectory } from '../src/ai/userNotes';
import type { NotebookTab } from '../src/desktop/api';

export function testNotebookViewState() {
  const makePage = (id: string, directoryId?: string): UserNotePage => ({ id, text: id, directoryId, version: 1, createdAt: '', updatedAt: '' });
  const directories: UserNoteDirectory[] = [{ id: 'folder', name: '目录', createdAt: '', updatedAt: '' }];
  let pages = [makePage('earlier'), makePage('first', 'folder'), makePage('second', 'folder')];
  let view = { notePageId: '', noteDirectoryId: 'folder', noteTabs: [{ id: 'reader', directoryId: 'folder', kind: 'pages' } as NotebookTab] };
  view = { ...view, ...reconcileNotebookView(view, pages, directories) };
  assert.equal(view.notePageId, 'earlier'); assert.equal(view.noteTabs[0].pageId, 'first');
  pages[0] = makePage('earlier', 'folder');
  assert.equal(reconcileNotebookView(view, pages, directories), undefined, 'Adding an earlier page must not change the currently read first page');
  view.noteTabs[0] = { ...view.noteTabs[0], pageId: 'second' };
  pages[2] = makePage('second');
  view = { ...view, ...reconcileNotebookView(view, pages, directories) };
  assert.equal(view.noteTabs[0].pageId, 'earlier');
  pages[2] = makePage('second', 'folder');
  assert.equal(reconcileNotebookView(view, pages, directories), undefined, 'Re-adding a removed page must not unexpectedly jump back to its old cached selection');
  pages = pages.map(page => makePage(page.id));
  view = { ...view, ...reconcileNotebookView(view, pages, directories) };
  assert.equal(view.noteTabs[0].pageId, undefined);
  assert.equal(view.noteTabs[0].kind, 'pages', 'An empty existing reader can create a new page');
  const nested = [...directories, { id: 'child', name: '下级', parentId: 'folder', createdAt: '', updatedAt: '' }];
  view = { ...view, ...reconcileNotebookView(view, pages, nested) };
  assert.equal(view.noteTabs[0].kind, 'directory', 'A folder repurposed to hold child directories must show its directory list');
  view.noteTabs.push({ id: 'source-browser', directoryId: 'child', kind: 'directory' });
  assert.equal(reconcileNotebookView(view, [...pages, makePage('new', 'child')], nested), undefined, 'Adding a first page must not turn its source browser into an inline reader');
  const lost = reconcileNotebookView({ ...view, notePageId: 'deleted' }, pages, [])!;
  assert.equal(lost.noteDirectoryId, ''); assert.equal(lost.notePageId, pages[0].id);
  assert.ok(lost.noteTabs!.every(tab => tab.kind === 'directory' && tab.directoryId === '' && tab.pageId === undefined));
  const restored = JSON.parse(JSON.stringify({ ...view, ...lost }));
  assert.equal(reconcileNotebookView(restored, pages, []), undefined, 'Reconciled state stays stable across JSON persistence and reload');
  assert.deepEqual(reconcileNotebookView({ notePageId: 'deleted', noteTabs: [] }, [], []), { notePageId: '' });
  console.log('PASS notebook view: stable initial selection, membership removal/re-add, directory mode change, deleted paths, empty library and restart normalization');
}
