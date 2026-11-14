import assert from 'node:assert/strict';
import { emptyState } from '../src/ai/server/repository';
import { resolveNoteReference } from '../src/ai/noteReferences';
import { withNoteProvenance, sourceVisible } from '../src/ai/memory';
import { sourceChanges } from '../src/ai/server/sourceFreshness';
import { writeAiNote, editNotebookContent } from '../src/ai/server/notebooks';
import type { Note, Task, MemorySnapshot } from '../src/ai/domain';

export function testNoteScope() {
  const state = emptyState(), ref = { kind: 'note' as const, id: 'note:shared', version: 2 };
  for (const id of ['parent', 'child', 'unrelated']) {
    state.sessions.push({ id, workspaceId: `workspace:${id}`, canvasId: 'canvas', mode: 'explore', title: id, lifecycle: 'active', createdAt: 'now' });
    state.workspaces.push({ id: `workspace:${id}`, sessionId: id, workNotes: [], pinnedNotes: [], snapshotIds: [], artifactIds: [] });
  }
  const makeNote = (body: string): Note => ({ id: ref.id, version: 2, text: body, type: 'finding', updatedAt: 'now',
    sourceRefs: [{ kind: 'message', id: `message:${body}`, version: 1 }] });
  const child = state.workspaces[1];
  state.workspaces[0].workNotes.push(makeNote('parent'));
  child.workNotes.push(makeNote('child'));
  state.workspaces[2].workNotes.push(makeNote('unrelated'));
  assert.equal(resolveNoteReference(state, 'child', ref).note?.text, 'child');
  assert.deepEqual(withNoteProvenance(state, [ref], 'child').map(value => value.id), [ref.id, 'message:child']);

  // A temporary session shares the source notebook, without regaining other branches.
  state.sessions.push({ ...state.sessions[1], id: 'temporary', workspaceId: 'workspace:temporary', mode: 'temporary',
    temporaryContext: { mode: 'custom', sourceSessionId: 'child', revision: 1 } });
  state.workspaces.push({ ...child, id: 'workspace:temporary', sessionId: 'temporary', workNotes: [], pinnedNotes: [] });
  assert.equal(resolveNoteReference(state, 'temporary', ref).note?.text, 'child');

  const task = { id: 'task', sessionId: 'child', workspaceId: child.id, canvasId: 'canvas', inputBindings: { targetIds: [], artifactIds: [], artifactVersions: {} } } as Task;
  // An identical fork copy in a snapshot does not invent ambiguity.
  const snapshot = { id: 'snapshot', notes: [structuredClone(child.workNotes[0])], messages: [], sourceRefs: [], revoked: false } as unknown as MemorySnapshot;
  state.snapshots.push(snapshot); child.snapshotIds.push(snapshot.id);
  assert.equal(resolveNoteReference(state, 'child', ref).status, 'ok');
  assert.doesNotThrow(() => withNoteProvenance(state, [ref], 'child'));

  // Legacy records with equal IDs/revisions and unequal material fail closed.
  snapshot.notes[0] = makeNote('old-other-branch');
  assert.equal(resolveNoteReference(state, 'child', ref).status, 'ambiguous');
  assert.throws(() => withNoteProvenance(state, [ref], 'child'), (error: any) => error.code === 'SOURCE_VERSION_AMBIGUOUS');
  assert.equal(sourceVisible(state, task, [ref]), false);
  assert.equal(sourceChanges(state, task, [ref])[0].state, 'unavailable');

  // Revoked or unselected copies neither grant access nor create false conflicts.
  snapshot.revoked = true;
  assert.equal(resolveNoteReference(state, 'child', ref).note?.text, 'child');
  child.workNotes = [];
  assert.equal(resolveNoteReference(state, 'child', ref).status, 'missing');
  assert.throws(() => withNoteProvenance(state, [ref], 'child'), (error: any) => error.code === 'SOURCE_VERSION_UNAVAILABLE');
  assert.equal(sourceVisible(state, task, [ref]), false);

  const cyclic = makeNote('cycle'); cyclic.sourceRefs = [ref]; child.workNotes.push(cyclic);
  assert.throws(() => withNoteProvenance(state, [ref], 'child'), (error: any) => error.code === 'INVALID_SOURCE');
  assert.equal(sourceChanges(state, task, [ref])[0].state, 'unavailable');

  // Delivery archives survive closing the temporary session. They are readable
  // immutable versions, while explicitly current dependencies stay checked.
  child.workNotes = [{ ...makeNote('foundation'), id: 'note:foundation', version: 1, sourceRefs: [] }];
  const temp = state.sessions.find(value => value.id === 'temporary')!;
  const temporaryTask = { ...task, id: 'task:temporary', sessionId: temp.id, workspaceId: temp.workspaceId,
    notebookBinding: { id: child.id, revision: 1 } } as Task;
  state.messages.push({ id: 'message:temporary', workspaceId: temp.workspaceId, taskId: temporaryTask.id, role: 'user', text: 'delivery',
    version: 1, status: 'complete', createdAt: 'now', relatedOperationIds: [], targetRefs: [],
    sourceRefs: [{ kind: 'note', id: 'note:foundation', version: 1, tracking: 'current' }] });
  const receipt = writeAiNote(state, temporaryTask, { text: 'current delivery', type: 'finding', lifecycle: 'multi_task', receiptId: 'delivery:current',
    sourceRefs: [{ kind: 'message', id: 'message:temporary', version: 1, tracking: 'current' }] });
  const historical = writeAiNote(state, temporaryTask, { text: 'historical delivery', type: 'finding', lifecycle: 'multi_task', receiptId: 'delivery:historical',
    sourceRefs: [{ kind: 'message', id: 'message:temporary', version: 1 }] });
  state.sessions = state.sessions.filter(value => value.id !== temp.id);
  state.workspaces = state.workspaces.filter(value => value.id !== temp.workspaceId);
  state.messages = state.messages.filter(value => value.workspaceId !== temp.workspaceId);
  const currentDelivery = { kind: 'note' as const, id: receipt.noteId, version: receipt.version };
  assert.deepEqual(sourceChanges(state, task, [currentDelivery]), []);
  assert.ok(sourceVisible(state, task, [currentDelivery]));
  assert.doesNotThrow(() => withNoteProvenance(state, [currentDelivery], task.sessionId));
  editNotebookContent(state, child, { id: 'note:foundation', expectedVersion: 1, text: 'updated foundation' });
  assert.ok(sourceChanges(state, task, [currentDelivery]).some(change => change.source.id === 'note:foundation' && change.state === 'changed'));
  assert.deepEqual(sourceChanges(state, task, [{ kind: 'note', id: historical.noteId, version: historical.version }]), []);

  console.log('PASS note identity: scoped ownership, equivalent and ambiguous forks, revoked sources, cycles, durable temporary delivery with current/historical dependencies');
}
