import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Repository } from '../src/ai/server/repository';
import { claimPresentationAutoFocus } from '../src/ai/server/presentationAutoFocus';
import { versionFixture } from './context-version-fixtures';

test('auto focus is per part, idempotent, session checked, and survives database reopen', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'qixue-autofocus-'));
  const database = path.join(directory, 'reading.sqlite');
  let repo = new Repository(database);
  try {
    const { state, task } = versionFixture(1);
    repo.transaction(current => {
      Object.assign(current, state);
      current.presentationParts = [1, 2, 8].map(seq => ({ id: `${task.id}:part:${seq}`, taskId: task.id, seq,
        revision: 1, graphRevision: current.graphRevision, targets: ['n0'], kind: 'text', version: 1, sealed: true, stable: true, dwellMs: 2000 }));
    });
    const payload = (seq: number) => ({ canvasId: task.canvasId, sessionId: task.sessionId, partId: `${task.id}:part:${seq}` });
    assert.throws(() => claimPresentationAutoFocus(repo, { ...payload(1), sessionId: 'another-session' }));
    assert.equal(repo.state.presentationAutoFocus?.[payload(1).partId], undefined);
    assert.deepEqual(claimPresentationAutoFocus(repo, payload(8)), { claimed: true });
    assert.deepEqual(claimPresentationAutoFocus(repo, payload(8)), { claimed: false });
    assert.deepEqual(claimPresentationAutoFocus(repo, payload(2)), { claimed: true }, 'skipped earlier parts have their own first visit');
    repo.close(); repo = new Repository(database);
    assert.deepEqual(claimPresentationAutoFocus(repo, payload(8)), { claimed: false });
    assert.deepEqual(claimPresentationAutoFocus(repo, payload(1)), { claimed: true });
    assert.throws(() => claimPresentationAutoFocus(repo, payload(0)), /引用段落/);
    assert.throws(() => claimPresentationAutoFocus(repo, payload(99)), /引用段落/);
  } finally {
    repo.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('qixue-autofocus-'));
    rmSync(directory, { recursive: true, force: true });
  }
});
