import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { Repository } from '../src/ai/server/repository';
import { userNotebookCommand } from '../src/ai/server/userNotebook';
import { userNoteDirectoryPages, type UserNoteDirectory } from '../src/ai/userNotes';
import type { UserNotePage } from '../src/ai/domain';
import { reconcileNotebookView } from '../src/desktop/notebookViewState';

function fixture(location = ':memory:') {
  const repo = new Repository(location);
  const command = <T>(action: string, payload: Record<string, unknown> = {}) => userNotebookCommand(repo, action, payload) as T;
  const folder = (name: string, parentId?: string) => command<UserNoteDirectory>('userNote.directory.create', { name, parentId });
  const create = (directoryId?: string) => command<UserNotePage>('userNote.create', { directoryId });
  const order = (directoryId: string) => userNoteDirectoryPages(repo.state.userNotePages!, directoryId, repo.state.userNoteDirectories).map(page => page.id);
  const page = (id: string) => repo.state.userNotePages!.find(page => page.id === id)!;
  return { repo, command, folder, create, order, page };
}

test('reorder resolves the original anchor, keeps page versions/global order, broadcasts and survives restart', t => {
  const cache = path.resolve('.cache'); mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(path.join(cache, 'notebook-workflows-'));
  const location = path.join(directory, 'notebook.sqlite');
  const f = fixture(location); t.after(() => f.repo.close());
  const folder = f.folder('研究'), pages = Array.from({ length: 4 }, () => f.create(folder.id));
  const original = pages.map(page => page.id), global = f.repo.state.userNotePages!.map(page => page.id);
  const updates: unknown[] = []; f.repo.subscribe(update => updates.push(update));
  f.command('userNote.reorder', { id: original[1], directoryId: folder.id, referencePageId: original[3], placement: 'after', expectedPageIds: original });
  const expected = [original[0], original[2], original[3], original[1]];
  assert.deepEqual(f.order(folder.id), expected);
  assert.deepEqual(f.repo.state.userNotePages!.map(page => page.id), global);
  assert.ok(f.repo.state.userNotePages!.every(page => page.version === 1));
  assert.ok(JSON.stringify(updates).includes('pageIds'));
  const view = { notePageId: original[1], noteDirectoryId: folder.id, noteTabs: [{ id: 'reader', directoryId: folder.id, kind: 'pages' as const, pageId: original[1] }] };
  assert.equal(reconcileNotebookView(view, f.repo.state.userNotePages!, f.repo.state.userNoteDirectories!), undefined);
  f.repo.close();
  const reopened = fixture(location); t.after(() => reopened.repo.close());
  assert.deepEqual(reopened.order(folder.id), expected);
  assert.deepEqual(reopened.repo.state.userNotePages!.map(page => page.id), global);
  f.repo.close();
});

test('reorder rejects stale membership/order and missing anchors without side effects; self is a no-op', t => {
  const f = fixture(); t.after(() => f.repo.close()); const dir = f.folder('目录');
  const a = f.create(dir.id), b = f.create(dir.id), original = f.order(dir.id);
  const before = structuredClone(f.repo.state);
  f.command('userNote.reorder', { id: a.id, directoryId: dir.id, referencePageId: a.id, placement: 'before', expectedPageIds: original });
  assert.deepEqual(f.repo.state, before);
  assert.throws(() => f.command('userNote.reorder', { id: a.id, directoryId: dir.id, referencePageId: 'missing', placement: 'after', expectedPageIds: original }), /参考页/);
  f.create(dir.id); const afterCreate = structuredClone(f.repo.state);
  assert.throws(() => f.command('userNote.reorder', { id: a.id, directoryId: dir.id, referencePageId: b.id, placement: 'after', expectedPageIds: original }), /页号已发生变化/);
  assert.deepEqual(f.repo.state, afterCreate);
  const current = f.order(dir.id);
  f.command('userNote.reorder', { id: current[2], directoryId: dir.id, referencePageId: a.id, placement: 'before', expectedPageIds: current });
  assert.deepEqual(f.order(dir.id), [current[2], a.id, b.id]);
});

test('move is atomic and appends to target, ordinary assign remains guarded and rejects conflicts', t => {
  const f = fixture(); t.after(() => f.repo.close());
  const source = f.folder('来源'), target = f.folder('目标'), mixed = f.folder('父目录'); f.folder('子目录', mixed.id);
  const oldUnassigned = f.create(), a = f.create(source.id), b = f.create(target.id);
  const originalGlobal = f.repo.state.userNotePages!.map(page => page.id);
  assert.throws(() => f.command('userNote.assign', { id: a.id, directoryId: target.id, expectedVersion: a.version }), /先移出/);
  const before = structuredClone(f.repo.state);
  assert.throws(() => f.command('userNote.transfer', { id: a.id, directoryId: mixed.id, mode: 'move', expectedVersion: a.version }), /包含子目录/);
  assert.deepEqual(f.repo.state, before);
  f.command('userNote.transfer', { id: a.id, directoryId: target.id, mode: 'move', expectedVersion: a.version });
  assert.deepEqual(f.order(source.id), []); assert.deepEqual(f.order(target.id), [b.id, a.id]);
  assert.equal(f.page(a.id).directoryId, target.id);
  assert.deepEqual(f.repo.state.userNotePages!.map(page => page.id), originalGlobal);
  assert.throws(() => f.command('userNote.transfer', { id: a.id, directoryId: source.id, mode: 'move', expectedVersion: a.version }), /其他窗口修改/);
  f.command('userNote.assign', { id: oldUnassigned.id, directoryId: target.id, expectedVersion: oldUnassigned.version });
  assert.deepEqual(f.order(target.id), [b.id, a.id, oldUnassigned.id]);
  f.command('userNote.delete', { id: a.id, expectedVersion: f.page(a.id).version });
  assert.deepEqual(f.order(target.id), [b.id, oldUnassigned.id]);
  assert.deepEqual(f.repo.state.userNoteDirectories!.find(dir => dir.id === target.id)!.pageIds, [b.id, oldUnassigned.id]);
});

test('copy creates an independent rich page and preserves every image transform while sharing immutable assets', t => {
  const f = fixture(); t.after(() => f.repo.close()); const a = f.folder('来源'), b = f.folder('目标'), source = f.create(a.id);
  f.repo.transaction(() => {
    const page = f.page(source.id); page.text = '文字\n尾部';
    page.blocks = [{ id: 't1', type: 'text', text: '文字' }, { id: 'images', type: 'images', images: [{ id: 'image', src: '/api/qixue/user-note-images/shared.png',
      x: 12, y: 24, width: 600, height: 400, rotation: 90, crop: { left: .1, top: .2, right: .15, bottom: 0 } }] }, { id: 't2', type: 'text', text: '尾部' }];
  });
  const original = structuredClone(f.page(source.id));
  const copy = f.command<UserNotePage>('userNote.transfer', { id: source.id, directoryId: b.id, mode: 'copy', expectedVersion: source.version });
  assert.notEqual(copy.id, source.id); assert.equal(copy.version, 1); assert.equal(copy.text, original.text);
  assert.deepEqual(f.page(source.id), original); assert.deepEqual(f.order(a.id), [source.id]); assert.deepEqual(f.order(b.id), [copy.id]);
  const copiedImage = copy.blocks!.find(block => block.type === 'images')!.images[0];
  const originalImage = original.blocks!.find(block => block.type === 'images')!.images[0];
  assert.notEqual(copiedImage.id, originalImage.id); assert.deepEqual({ ...copiedImage, id: originalImage.id }, originalImage);
  assert.ok(copy.blocks!.every((block, i) => block.id !== original.blocks![i].id));
  f.repo.transaction(() => { f.page(copy.id).text = '独立编辑'; });
  f.command('userNote.delete', { id: copy.id, expectedVersion: copy.version });
  assert.deepEqual(f.page(source.id), original);
});

test('legacy or partial directory order falls back safely and reader reconciliation chooses sorted first page', t => {
  const f = fixture(); t.after(() => f.repo.close()); const dir = f.folder('目录'), a = f.create(dir.id), b = f.create(dir.id), c = f.create();
  f.repo.transaction(() => { delete f.repo.state.userNoteDirectories![0].pageIds; });
  assert.deepEqual(f.order(dir.id), [a.id, b.id]);
  f.repo.transaction(() => { f.repo.state.userNoteDirectories![0].pageIds = [b.id, b.id, 'missing', c.id]; });
  assert.deepEqual(f.order(dir.id), [b.id, a.id]);
  const patch = reconcileNotebookView({ notePageId: a.id, noteDirectoryId: dir.id, noteTabs: [{ id: 'tab', directoryId: dir.id, kind: 'pages', pageId: 'missing' }] }, f.repo.state.userNotePages!, f.repo.state.userNoteDirectories!);
  assert.equal(patch?.noteTabs?.[0].pageId, b.id);
});
