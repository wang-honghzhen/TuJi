import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Session } from '../src/ai/domain';
import { GLOBAL_TEMPORARY_CANVAS, isGlobalTemporary, isIndependentTemporary, normalizeTemporaryNumbers,
  temporaryLabel, temporaryNumber, TEMPORARY_IDLE_MS } from '../src/ai/temporaryModes';
import { Repository } from '../src/ai/server/repository';
import { SessionService } from '../src/ai/server/sessions';
import { Application } from '../src/ai/server/application';
import { minimalTools } from '../src/ai/server/minimalChat';
import { Runtime } from '../src/ai/server/runtime';
import type { ModelRequest } from '../src/ai/server/providers';
import { emptyGraph } from '../src/v3/storage';

function fixture() {
  const repo = new Repository(':memory:');
  repo.transaction(state => {
    state.graph = emptyGraph();
    state.graph.canvases.push({ ...structuredClone(state.graph.canvases[0]), canvasId: 'second-canvas', isDraft: false });
  });
  return { repo, sessions: new SessionService(repo), canvas: repo.state.graph!.canvases[0].canvasId };
}

function temporaryDirectory() {
  const root = path.resolve('.cache'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(path.join(root, 'temporary-sessions-'));
  return { directory, cleanup() {
    assert.ok(path.resolve(directory).startsWith(root + path.sep));
    rmSync(directory, { recursive: true, force: true });
  } };
}

test('temporary labels are globally unique by type and reuse holes without renumbering survivors', () => {
  const { repo, sessions, canvas } = fixture();
  try {
    const first = sessions.create({ canvasId: canvas, mode: 'temporary', temporaryMode: 'minimal' });
    const second = sessions.create({ canvasId: 'second-canvas', mode: 'temporary', temporaryMode: 'minimal' });
    const global = sessions.createGlobalTemporary();
    const desktop = sessions.createDesktopTemporary();
    assert.deepEqual([first, second, global, desktop].map(temporaryLabel), ['极简1', '极简2', '极简3', '悬浮窗1']);
    sessions.closeTemporary(second.id);
    const replacement = sessions.createGlobalTemporary();
    assert.equal(temporaryLabel(replacement), '极简2');
    assert.equal(temporaryLabel(repo.state.sessions.find(session => session.id === global.id)!), '极简3');
    sessions.closeTemporary(desktop.id);
    assert.equal(temporaryLabel(sessions.createDesktopTemporary()), '悬浮窗1');
    repo.transaction(state => state.sessions.reverse());
    new SessionService(repo);
    assert.equal(temporaryLabel(repo.state.sessions.find(session => session.id === global.id)!), '极简3');
  } finally { repo.close(); }
});

test('changing mode allocates in the destination type and only releases the old type number', () => {
  const { repo, sessions, canvas } = fixture();
  try {
    const source = sessions.ensure(canvas);
    const minimal = sessions.create({ canvasId: canvas, mode: 'temporary', temporaryMode: 'minimal' });
    const existing = sessions.create({ canvasId: canvas, mode: 'temporary', temporaryMode: 'branch', sourceSessionId: source.id });
    const moved = sessions.configureTemporary({ sessionId: minimal.id, mode: 'branch', expectedRevision: 1,
      sourceSessionId: source.id, currentSessionId: source.id });
    assert.equal(temporaryLabel(existing), '分支1');
    assert.equal(temporaryLabel(moved), '分支2');
    assert.equal(temporaryLabel(sessions.createGlobalTemporary()), '极简1');
    const sameMode = sessions.configureTemporary({ sessionId: moved.id, mode: 'branch', expectedRevision: 2,
      sourceSessionId: source.id, currentSessionId: source.id });
    assert.equal(temporaryLabel(sameMode), '分支2');
    const custom = sessions.configureTemporary({ sessionId: moved.id, mode: 'custom', expectedRevision: 3,
      sourceSessionId: source.id, currentSessionId: source.id, orderedTasks: [] });
    assert.equal(temporaryLabel(custom), '自定义1');
    const newBranch = sessions.create({ canvasId: canvas, mode: 'temporary', temporaryMode: 'branch', sourceSessionId: source.id });
    assert.equal(temporaryLabel(newBranch), '分支2');
  } finally { repo.close(); }
});

test('global minimal sessions need no canvas, have their own cap, and cannot acquire canvas context', () => {
  const repo = new Repository(':memory:'), sessions = new SessionService(repo);
  try {
    const first = sessions.createGlobalTemporary();
    sessions.createGlobalTemporary(); sessions.createGlobalTemporary();
    assert.equal(repo.state.graph, null);
    assert.equal(first.canvasId, GLOBAL_TEMPORARY_CANVAS);
    assert.ok(isGlobalTemporary(first)); assert.ok(isIndependentTemporary(first));
    assert.throws(() => sessions.createGlobalTemporary(), { code: 'TEMPORARY_LIMIT' });
    assert.throws(() => sessions.configureTemporary({ sessionId: first.id, mode: 'branch', expectedRevision: 1 }), { code: 'MODE_LOCKED' });
    assert.equal(temporaryLabel(sessions.createDesktopTemporary()), '悬浮窗1');
    repo.transaction(state => { state.graph = emptyGraph(); state.graph.canvases[0].canvasId = 'new-canvas'; });
    assert.equal(repo.state.sessions.find(session => session.id === first.id)?.canvasId, GLOBAL_TEMPORARY_CANVAS);
    assert.equal(repo.state.workspaces.find(workspace => workspace.sessionId === first.id)?.snapshotIds.length, 0);
  } finally { repo.close(); }
});

test('legacy numbers are repaired deterministically, preserve occupied numbers, and persist across restart', () => {
  const files = temporaryDirectory(), database = path.join(files.directory, 'test.sqlite');
  let repo = new Repository(database);
  try {
    const sessions = new SessionService(repo), desktop = sessions.createDesktopTemporary();
    repo.transaction(state => {
      const saved = state.sessions.find(session => session.id === desktop.id)!;
      delete saved.temporaryContext!.number; saved.temporaryContext!.desktopNumber = 7;
      const legacy = (id: string, number?: number): Session => ({ id, canvasId: 'old-canvas', workspaceId: id + ':workspace',
        mode: 'temporary', title: id, lifecycle: 'active', createdAt: '2026-01-01T00:00:00Z',
        temporaryContext: { mode: 'minimal', revision: 1, ...(number === undefined ? {} : { number }) } });
      state.sessions.push(legacy('old-a'), legacy('old-b', 1), legacy('old-c', 1));
    });
    repo.close(); repo = new Repository(database); new SessionService(repo);
    assert.equal(temporaryLabel(repo.state.sessions.find(session => session.id === desktop.id)!), '悬浮窗7');
    assert.deepEqual(['old-a', 'old-b', 'old-c'].map(id => temporaryNumber(repo.state.sessions.find(session => session.id === id)!)), [2, 1, 3]);
    const labels = repo.state.sessions.map(temporaryLabel);
    assert.equal(normalizeTemporaryNumbers(repo.state.sessions), false);
    repo.close(); repo = new Repository(database); new SessionService(repo);
    assert.deepEqual(repo.state.sessions.map(temporaryLabel), labels);
    assert.equal(temporaryLabel(new SessionService(repo).createDesktopTemporary()), '悬浮窗1');
  } finally { repo.close(); files.cleanup(); }
});

test('the application routes global creation, expires idle sessions, and reuses their numbers', async () => {
  const files = temporaryDirectory(), repo = new Repository(':memory:');
  const app = new Application(repo, { artifactDirectory: files.directory });
  try {
    await app.ready();
    const first = await app.dispatch('temporary.createGlobal', {}) as Session;
    const kept = await app.dispatch('temporary.createGlobal', {}) as Session;
    repo.transaction(state => {
      state.sessions.find(session => session.id === first.id)!.temporaryContext!.expiresAt = new Date(Date.now() - 1).toISOString();
    });
    await app.cleanupExpiredTemporary();
    assert.equal(repo.state.sessions.some(session => session.id === first.id), false);
    assert.equal(temporaryLabel(repo.state.sessions.find(session => session.id === kept.id)!), '极简2');
    const next = await app.dispatch('temporary.createGlobal', {}) as Session;
    assert.equal(temporaryLabel(next), '极简1');
    assert.ok(Date.parse(next.temporaryContext!.expiresAt!) >= Date.now() + TEMPORARY_IDLE_MS - 1000);
    // Sending can construct the real minimal request without any graph or provider call.
    app.runtime.kick = () => undefined;
    const task = app.runtime.send({ sessionId: next.id, text: '独立问题', clientMessageId: 'minimal-test', intent: 'new', targetIds: [], artifactIds: [] });
    assert.equal(task.canvasId, GLOBAL_TEMPORARY_CANVAS);
    assert.equal(minimalTools(repo.state, task).some(tool => /graph|note|canvas/.test(tool.name)), false);
    repo.transaction(state => { state.sessions.find(session => session.id === next.id)!.temporaryContext!.expiresAt = new Date(Date.now() - 1).toISOString(); });
    await app.cleanupExpiredTemporary();
    assert.ok(repo.state.sessions.some(session => session.id === next.id), 'In-flight sessions keep their reserved number');
  } finally { await app.close(); repo.close(); files.cleanup(); }
});

test('global sessions complete normal questions and resume queued work after service recovery without a canvas', async () => {
  const repo = new Repository(':memory:'), sessions = new SessionService(repo), session = sessions.createGlobalTemporary();
  const requests: ModelRequest[] = [];
  const caller: ConstructorParameters<typeof Runtime>[1] = async (_provider, _credential, request) => {
    requests.push(structuredClone(request));
    return { text: '独立回答 ' + requests.length, toolCalls: [], finishReason: 'stop', inputTokens: 10, outputTokens: 5 };
  };
  repo.credential = 'local-test-only';
  let runtime = new Runtime(repo, caller);
  const waitForTask = async (id: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (runtime.getTask(id).status === 'completed') return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Task did not complete: ' + JSON.stringify(runtime.getTask(id)));
  };
  try {
    const first = runtime.send({ sessionId: session.id, text: '第一问', clientMessageId: 'one', intent: 'new', targetIds: [], artifactIds: [] });
    await waitForTask(first.id);
    assert.equal(runtime.getTask(first.id).outcome, 'success');
    assert.equal(repo.state.graph, null);
    runtime.kick = () => undefined;
    const second = runtime.send({ sessionId: session.id, text: '第二问', clientMessageId: 'two', intent: 'new', targetIds: [], artifactIds: [] });
    await runtime.dispose();
    runtime = new Runtime(repo, caller);
    assert.equal(runtime.getTask(second.id).status, 'paused');
    runtime.resume(second.id); await waitForTask(second.id);
    assert.equal(requests.length, 2);
    assert.ok(requests[1].messages.some(message => message.content === '第一问'));
    assert.ok(requests[1].messages.some(message => message.content === '独立回答 1'));
    assert.ok(requests[1].messages.some(message => message.content === '第二问'));
    assert.equal(requests.some(request => request.tools.some(tool => /graph|note|canvas/.test(tool.name))), false);
    assert.equal(temporaryLabel(runtime.getSession(session.id)), '极简1');
  } finally { await runtime.dispose(); repo.close(); }
});
