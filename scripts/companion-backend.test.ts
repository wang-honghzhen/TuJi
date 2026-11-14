import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { Repository } from '../src/ai/server/repository';
import { Application } from '../src/ai/server/application';
import { emptyGraph } from '../src/v3/storage';
import { isDesktopTemporary, TEMPORARY_IDLE_MS } from '../src/ai/temporaryModes';
import type { Session } from '../src/ai/domain';

export async function testBackend(root: string) {
  const directory = await mkdtemp(path.join(root, '.cache', 'companion-backend-'));
  let repo = new Repository(path.join(directory, 'test.sqlite'));
  let app = new Application(repo, { artifactDirectory: path.join(directory, 'artifacts') });
  try {
    await app.ready();
    // Desktop creation and minimal preview work even before a canvas exists.
    const first = await app.dispatch('temporary.createDesktop') as Session;
    assert.ok(isDesktopTemporary(first)); assert.equal(first.temporaryContext?.desktopNumber, 1);
    const preview = await app.dispatch('context.preview', { sessionId: first.id, text: 'hello' }) as any;
    assert.ok(preview); assert.equal(repo.state.graph, null);
    repo.transaction(state => { state.graph = emptyGraph(); });
    const canvasId = repo.state.graph!.canvases[0].canvasId;
    const canvasSessions = [];
    for (let i = 0; i < 3; i++) canvasSessions.push(await app.dispatch('session.create', { canvasId, mode: 'temporary', temporaryMode: 'minimal' }) as Session);
    // Missing scope is the legacy format and must still count toward the canvas quota.
    assert.equal(canvasSessions[0].temporaryContext?.scope, undefined);
    const created = await Promise.allSettled(Array.from({ length: 3 }, () => app.dispatch('temporary.createDesktop')));
    assert.equal(created.filter(r => r.status === 'fulfilled').length, 2);
    assert.equal(created.filter(r => r.status === 'rejected').length, 1);
    assert.equal(repo.state.sessions.filter(s => s.mode === 'temporary').length, 6);
    await assert.rejects(app.dispatch('session.create', { canvasId, mode: 'temporary', temporaryMode: 'minimal' }), /三个/);
    await assert.rejects(app.dispatch('temporary.configure', { sessionId: first.id, mode: 'branch', expectedRevision: 1 }), /固定使用极简/);
    const task = app.runtime.send({ sessionId: first.id, clientMessageId: 'isolated-send', text: 'hello', intent: 'new', targetIds: ['not-in-scope'], artifactIds: [] });
    assert.deepEqual(task.inputBindings.targetIds, []);
    // Running tasks protect an expired temporary session, then deletion removes its task/messages.
    repo.transaction(state => { state.sessions.find(s => s.id === first.id)!.temporaryContext!.expiresAt = new Date(Date.now() - 1).toISOString(); });
    await app.cleanupExpiredTemporary();
    assert.ok(repo.state.sessions.some(s => s.id === first.id));
    await app.dispatch('temporary.close', { sessionId: first.id });
    assert.equal(repo.state.tasks.some(t => t.sessionId === first.id), false);
    assert.equal(repo.state.messages.some(m => m.workspaceId === first.workspaceId), false);
    const fourth = await app.dispatch('temporary.createDesktop') as Session;
    assert.equal(fourth.temporaryContext?.desktopNumber, 4);
    const createdAt = Date.parse(fourth.temporaryContext!.lastActiveAt!);
    assert.equal(Date.parse(fourth.temporaryContext!.expiresAt!) - createdAt, TEMPORARY_IDLE_MS);
    const backup = await app.dispatch('backup.export') as any;
    await app.dispatch('backup.import', { backup });
    assert.ok(repo.state.sessions.filter(isDesktopTemporary).every(s => s.lifecycle === 'active'));
    repo.transaction(state => { state.sessions.find(s => s.id === fourth.id)!.temporaryContext!.expiresAt = new Date(Date.now() - 1).toISOString(); });
    await app.cleanupExpiredTemporary();
    assert.equal(repo.state.sessions.some(s => s.id === fourth.id), false);
    const remainingNumbers = repo.state.sessions.filter(isDesktopTemporary).map(s => s.temporaryContext?.desktopNumber);
    assert.deepEqual(remainingNumbers, [2, 3]);
    const note = await app.dispatch('userNote.ensure') as any;
    await app.dispatch('userNote.save', { id: note.id, expectedVersion: note.version, text: 'keep this note' });
    await app.close(); repo.close();
    repo = new Repository(path.join(directory, 'test.sqlite'));
    app = new Application(repo, { artifactDirectory: path.join(directory, 'artifacts') }); await app.ready();
    const fifth = await app.dispatch('temporary.createDesktop') as Session;
    assert.equal(fifth.temporaryContext?.desktopNumber, 5);
    assert.equal(repo.state.userNotePages?.[0].text, 'keep this note');
    assert.deepEqual(repo.state.sessions.filter(isDesktopTemporary).map(s => s.temporaryContext?.desktopNumber), [2, 3, 5]);
    console.log('PASS: independent/atomic quotas, legacy records, global minimal chat, deletion, expiry protection, stable numbers and restart persistence');
  } finally { await app.close(); repo.close(); }
}
