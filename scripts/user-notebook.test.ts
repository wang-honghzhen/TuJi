import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { Repository, type RepositoryUpdate } from '../src/ai/server/repository';
import { Application } from '../src/ai/server/application';
import { startHttpServer } from '../src/ai/server/http';
import type { UserNotePage } from '../src/ai/domain';
import { userNoteBlocks, userNoteDirectoryPages, userNotePath, type UserNoteBlock, type UserNoteDirectory } from '../src/ai/userNotes';

export async function testUserNotebook(root: string) {
  const directory = await mkdtemp(path.join(root, '.cache', 'user-notebook-'));
  const database = path.join(directory, 'test.sqlite'), assets = path.join(directory, 'artifacts');
  let repo = new Repository(database), app = new Application(repo, { artifactDirectory: assets });
  let http: Awaited<ReturnType<typeof startHttpServer>> | undefined;
  try {
    await app.ready();
    const updates: RepositoryUpdate[] = []; repo.subscribe(update => updates.push(update));
    const command = <T>(action: string, payload: Record<string, unknown> = {}) => app.dispatch(action, payload) as Promise<T>;
    const folder = (name: string, parentId = '') => command<UserNoteDirectory>('userNote.directory.create', { name, parentId });
    const page = (directoryId?: string) => command<UserNotePage>('userNote.create', { directoryId });
    const saved = (id: string) => structuredClone(repo.state.userNotePages!.find(page => page.id === id)!);

    const legacy = await command<UserNotePage>('userNote.ensure');
    const originalText = '\t leading\n\ntrailing  \n';
    const edited = await command<UserNotePage>('userNote.save', { id: legacy.id, expectedVersion: legacy.version, text: originalText });
    assert.equal(edited.text, originalText); assert.equal(userNoteBlocks(edited)[0].type, 'text');
    await assert.rejects(command('userNote.save', { id: legacy.id, expectedVersion: legacy.version, text: 'stale overwrite' }), /其他窗口修改/);
    assert.equal(saved(legacy.id).text, originalText);

    const school = await folder('学习'), math = await folder('数学', school.id), science = await folder('科学', school.id);
    assert.equal(userNotePath(repo.state.userNoteDirectories!, math.id), '/学习/数学');
    await assert.rejects(folder('数学', school.id), /已有/);
    await assert.rejects(folder('../escape'), /斜杠/);
    await assert.rejects(folder('a\\b'), /斜杠/);
    await assert.rejects(folder('bad', 'missing'), /不存在/);
    await assert.rejects(page(school.id), /包含子目录/);
    const first = await page(math.id), middle = await page(), third = await page(math.id);
    await assert.rejects(folder('不允许', math.id), /包含笔记页/);
    await assert.rejects(command('userNote.assign', { id: first.id, directoryId: science.id, expectedVersion: first.version }), /已在其他目录/);
    assert.equal(saved(first.id).directoryId, math.id);
    assert.deepEqual(userNoteDirectoryPages(repo.state.userNotePages!, math.id).map(page => page.id), [first.id, third.id]);
    const numberBefore = repo.state.userNotePages!.findIndex(page => page.id === third.id);
    await command('userNote.delete', { id: middle.id, expectedVersion: middle.version });
    assert.equal(repo.state.userNotePages!.findIndex(page => page.id === third.id), numberBefore - 1);
    assert.deepEqual(userNoteDirectoryPages(repo.state.userNotePages!, math.id).map(page => page.id), [first.id, third.id]);
    const detached = await command<UserNotePage>('userNote.assign', { id: third.id, directoryId: '', expectedVersion: third.version });
    assert.equal(detached.directoryId, undefined);
    const assigned = await command<UserNotePage>('userNote.assign', { id: third.id, directoryId: science.id, expectedVersion: detached.version });
    assert.equal(assigned.directoryId, science.id);
    const countBefore = repo.state.userNotePages!.length;
    await command('userNote.directory.delete', { id: school.id, deletePages: false });
    assert.equal(repo.state.userNoteDirectories!.length, 0);
    assert.equal(repo.state.userNotePages!.length, countBefore);
    assert.equal(saved(first.id).directoryId, undefined); assert.equal(saved(third.id).directoryId, undefined);
    assert.ok(updates.some(update => update.records.some(record => record.collection === 'userNoteDirectories' && record.record === undefined)));
    await assert.rejects(command('userNote.directory.delete', { id: '', deletePages: true }), /不能为空/);

    const trash = await folder('待删除'), nested = await folder('下级', trash.id), retained = await folder('保留');
    const doomed = await page(nested.id), kept = await page(retained.id);
    await assert.rejects(command('userNote.directory.delete', { id: trash.id }), /请选择/);
    const deleted = await command<{ deletedPageIds: string[] }>('userNote.directory.delete', { id: trash.id, deletePages: true });
    assert.deepEqual(deleted.deletedPageIds, [doomed.id]);
    assert.ok(!repo.state.userNotePages!.some(page => page.id === doomed.id));
    assert.equal(saved(kept.id).directoryId, retained.id);

    const canvas = createCanvas(64, 40), context = canvas.getContext('2d');
    context.fillStyle = '#376e66'; context.fillRect(0, 0, 64, 40);
    const dataUrl = 'data:image/png;base64,' + (await canvas.encode('png')).toString('base64');
    const image = await command<{ src: string; width: number; height: number }>('userNote.image.upload', { dataUrl });
    assert.equal(image.width, 64); assert.equal(image.height, 40);
    assert.match(image.src, /^\/api\/qixue\/user-note-images\/[a-f0-9]{64}\.png$/);
    assert.deepEqual(await command('userNote.image.upload', { dataUrl }), image);
    assert.equal(repo.state.artifacts.length, 0, 'Notebook pictures do not become chat artifacts or trigger OCR');
    await assert.rejects(command('userNote.image.upload', { dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }), /PNG/);
    await assert.rejects(command('userNote.image.upload', { dataUrl: 'data:image/png;base64,AAAA' }), /图片尺寸/);
    const blocks: UserNoteBlock[] = [
      { id: 'before', type: 'text', text: '前半段\n' },
      { id: 'pictures', type: 'images', images: [{ id: 'picture', src: image.src, x: 12, y: 24, width: 160, height: 100, rotation: 33,
        crop: { left: .1, right: .2, top: .05, bottom: .15 } }] },
      { id: 'after', type: 'text', text: '后半段  ' },
    ];
    const rich = await command<UserNotePage>('userNote.save', { id: kept.id, expectedVersion: kept.version, blocks });
    assert.deepEqual(rich.blocks, blocks); assert.equal(rich.text, '前半段\n\n后半段  ');
    await assert.rejects(command('userNote.save', { id: rich.id, expectedVersion: rich.version, text: 'lossy old client' }), /完整保存/);
    const invalid = structuredClone(blocks); (invalid[1] as Extract<UserNoteBlock, { type: 'images' }>).images[0].src = 'https://example.com/exfil.png';
    await assert.rejects(command('userNote.save', { id: rich.id, expectedVersion: rich.version, blocks: invalid }), /图片不存在/);
    (invalid[1] as Extract<UserNoteBlock, { type: 'images' }>).images[0] = structuredClone((blocks[1] as Extract<UserNoteBlock, { type: 'images' }>).images[0]);
    (invalid[1] as Extract<UserNoteBlock, { type: 'images' }>).images[0].crop = { left: .6, right: .5, top: 0, bottom: 0 };
    await assert.rejects(command('userNote.save', { id: rich.id, expectedVersion: rich.version, blocks: invalid }), /保留图片区域/);
    assert.deepEqual(saved(rich.id).blocks, blocks, 'Rejected saves roll back the entire note');

    http = await startHttpServer({ application: app, subscribe: listener => repo.subscribe(listener) });
    const handshake = await fetch(http.url + '/api/qixue/connection');
    const cookie = handshake.headers.get('set-cookie')!;
    assert.ok(cookie.includes('HttpOnly') && cookie.includes('SameSite=Strict'));
    assert.equal((await fetch(http.url + image.src)).status, 401);
    const imageResponse = await fetch(http.url + image.src, { headers: { cookie: cookie.split(';')[0] } });
    assert.equal(imageResponse.status, 200); assert.equal(imageResponse.headers.get('content-type'), 'image/png');
    assert.ok((await imageResponse.arrayBuffer()).byteLength > 0);
    assert.equal((await fetch(http.url + image.src, { headers: { cookie: cookie.split(';')[0], 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await fetch(http.url + '/api/qixue/snapshot', { headers: { cookie: cookie.split(';')[0] } })).status, 401, 'Image cookie cannot authorize other APIs');
    await http.close(); http = undefined;

    await app.close(); repo.close();
    repo = new Repository(database); app = new Application(repo, { artifactDirectory: assets }); await app.ready();
    assert.deepEqual(saved(rich.id).blocks, blocks); assert.equal(saved(legacy.id).text, originalText);
    assert.equal(userNotePath(repo.state.userNoteDirectories!, retained.id), '/保留');
    const filename = image.src.split('/').at(-1)!;
    assert.equal((await app.readUserNoteImage(filename)).mimeType, 'image/png');
    await assert.rejects(app.readUserNoteImage('../test.sqlite'), /地址无效/);
    const file = path.join(assets, 'user-notes', filename), original = await readFile(file);
    await writeFile(file, 'corrupt'); await assert.rejects(app.readUserNoteImage(filename), /校验失败/); await writeFile(file, original);
    console.log('PASS user notebook: directory invariants, atomic assignments, independent numbering, both recursive deletion modes, legacy text, rich-save conflicts, normalized images, authenticated reads, and restart persistence');
  } finally { await http?.close(); await app.close(); repo.close(); }
}
