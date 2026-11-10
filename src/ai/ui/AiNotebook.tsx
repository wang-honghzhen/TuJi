import { useLayoutEffect, useRef, useState } from 'react';
import { useAiStore } from '../client';
import type { Note, Session } from '../domain';
import { notebookUsage, notebookWorkspace } from '../notebook';
import { PaperEditor } from './PaperEditor';

interface Entry { id: string; text: string; version: number; clientRequestId?: string }

function NoteLine({ session, entry, draftKey, onCreated, onDeleted, onNext, readOnly }: {
  session: Session; entry?: Entry; draftKey: string; onCreated: (id: string) => void; onDeleted: () => void; onNext: () => void; readOnly: boolean;
}) {
  const identity = useRef(entry); if (entry) identity.current = entry;
  const command = useAiStore(s => s.command);
  return <div className="paper-note-row" data-ai-note={entry?.id ?? 'draft'}>
    <PaperEditor text={entry?.text ?? ''} version={entry?.version ?? 0} label="AI 笔记内容" autoFocus={!entry} readOnly={readOnly}
      placeholder="写下这条笔记…" onNext={onNext} save={async (value, version) => {
        if (!value.trim()) throw new Error('笔记内容为空，可右键删除这条笔记。');
        if (!identity.current) {
          const note = await command<Note>('note.save', { sessionId: session.id, kind: 'work', text: value, sourceRefs: [], clientRequestId: draftKey }, { reportError: false });
          identity.current = note; onCreated(note.id); return { text: note.text, version: note.version };
        }
        await command('note.edit', { sessionId: session.id, id: identity.current.id, text: value, expectedVersion: version }, { reportError: false });
        return { text: value, version: Number(version) + 1 };
      }} onDelete={async version => {
        if (identity.current) await command('note.delete', { sessionId: session.id, kind: 'work', noteId: identity.current.id, expectedVersion: version }, { reportError: false });
        onDeleted();
      }} />
  </div>;
}

export function AiNotebook({ session }: { session: Session }) {
  const snapshot = useAiStore(s => s.snapshot);
  const workspace = snapshot ? notebookWorkspace(snapshot, session) : undefined;
  const [drafts, setDrafts] = useState<Array<{ key: string; noteId?: string }>>([]);
  const paper = useRef<HTMLDivElement>(null), addingDraft = useRef(false);
  useLayoutEffect(() => { addingDraft.current = false; }, [drafts]);
  if (!snapshot || !workspace) return <p className="paper-notebook-info">选择来源会话的聊天记录后，可查看和修改该会话的笔记。</p>;
  const entries = workspace.workNotes, usage = notebookUsage(snapshot, workspace);
  const owner = snapshot.sessions.find(value => value.id === workspace.sessionId), readOnly = owner?.lifecycle !== 'active';
  const add = () => {
    const empty = Array.from(paper.current?.querySelectorAll<HTMLTextAreaElement>('[data-paper-input]') ?? [])
      .find(input => !input.value.trim());
    if (empty) { empty.focus(); return; }
    // Repeated requests before the new editor mounts must share the same draft.
    if (addingDraft.current) return;
    addingDraft.current = true;
    setDrafts(values => [...values, { key: crypto.randomUUID() }]);
  };
  const rows = [...entries.map(entry => ({ key: entry.clientRequestId ?? drafts.find(draft => draft.noteId === entry.id)?.key ?? entry.id, entry })),
    ...drafts.filter(draft => !draft.noteId && !entries.some(entry => entry.clientRequestId === draft.key)).map(draft => ({ key: draft.key, entry: undefined }))];
  return <section className="paper-notebook" data-ai-notebook>
    <div ref={paper} className="notebook-paper paper-work-notes" onClick={event => { if (!readOnly && event.target === event.currentTarget) add(); }}>
      <h3>AI笔记：</h3>
      <>
        {rows.map(row => <NoteLine key={row.key} draftKey={row.key} session={session} entry={row.entry} readOnly={readOnly}
          onCreated={id => setDrafts(values => values.map(value => value.key === row.key ? { ...value, noteId: id } : value))}
          onDeleted={() => setDrafts(values => values.filter(value => value.key !== row.key))} onNext={add} />)}
        {!readOnly && <button type="button" className="paper-note-blank" aria-label="在空白行写入新的 AI 笔记" onClick={add}>
          {!rows.length ? '点击空白行，写下第一条笔记' : '\u00a0'}
        </button>}
      </>
    </div>
    <p className="paper-notebook-info">{session.mode === 'temporary' ? '与来源会话共享 · ' : ''}{readOnly ? '只读 · ' : ''}容量 {usage.used.toLocaleString()} / {usage.limit.toLocaleString()} token</p>
  </section>;
}
