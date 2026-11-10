import { useRef } from 'react';
import { useAiStore } from '../client';
import { notebookWorkspace } from '../notebook';
import type { Session } from '../domain';
import { AiError, AiModal, useAction } from './common';
import { AiNotebook } from './AiNotebook';
import { PaperEditor, PaperSaveScope } from './PaperEditor';

export function AiWorkspacePanel({ session, onClose }: { session: Session; onClose: () => void }) {
  const snapshot = useAiStore(s => s.snapshot), command = useAiStore(s => s.command);
  const workspace = snapshot ? notebookWorkspace(snapshot, session) : undefined;
  const owner = snapshot?.sessions.find(value => value.id === workspace?.sessionId);
  const saves = useRef(new Map<symbol, () => Promise<void>>()), action = useAction();
  const close = () => { void action.run(async () => { await Promise.all([...saves.current.values()].map(flush => flush())); onClose(); }); };
  return <AiModal title="固定要求与 AI 笔记" className="paper-modal" adjustable onClose={close}
    footer={<><span>自动保存 · 点击文字编辑 · 右键删除笔记</span><AiError text={action.error} /></>}>
    <PaperSaveScope.Provider value={saves}>
      <div className="paper-notebook">
        {workspace && owner && <section className="notebook-paper paper-requirements" data-fixed-requirements>
          <h3>固定要求：</h3>
          <PaperEditor key={workspace.id} label="固定要求内容" text={workspace.pinnedNotes.map(note => note.text).join('\n')}
            version={JSON.stringify(workspace.pinnedNotes.map(note => [note.id, note.version]))} readOnly={owner.lifecycle !== 'active'}
            placeholder="写下希望 AI 始终遵守的要求…" save={(text, expectedVersion) => command('note.requirements', { sessionId: owner.id, text, expectedVersion }, { reportError: false })}
            deleteLabel="删除固定要求" onDelete={expectedVersion => command('note.requirements', { sessionId: owner.id, text: '', expectedVersion }, { reportError: false })} />
        </section>}
        <AiNotebook key={workspace?.id ?? session.id} session={session} />
      </div>
    </PaperSaveScope.Provider>
  </AiModal>;
}
