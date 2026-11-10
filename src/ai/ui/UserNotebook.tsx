import { useLayoutEffect, useRef, useState } from 'react';
import { BookOpen, ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { useAiStore } from '../client';
import type { UserNotePage } from '../domain';
import { AiError, AiModal, useAction } from './common';
import { PaperContextMenu, PaperEditor, type PaperEditorHandle } from './PaperEditor';

export function UserNotebook() {
  const pages = useAiStore(s => s.snapshot?.userNotePages), command = useAiStore(s => s.command);
  const [open, setOpen] = useState(false), [pageId, setPageId] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  const [pageEdit, setPageEdit] = useState<string>();
  const pageInput = useRef<HTMLInputElement>(null), pageButton = useRef<HTMLButtonElement>(null);
  const editingPage = useRef<string>(); editingPage.current = pageEdit;
  const editor = useRef<PaperEditorHandle>(null), action = useAction();
  const page = pages?.find(value => value.id === pageId) ?? pages?.[0], index = Math.max(0, pages?.findIndex(value => value.id === page?.id) ?? 0);
  const changePage = (id: string) => { void action.run(async () => { await editor.current?.flush(); setMenu(undefined); setPageId(id); }); };
  useLayoutEffect(() => { if (pageEdit !== undefined) { pageInput.current?.focus(); pageInput.current?.select(); } }, [pageEdit !== undefined]);
  const finishPageEdit = (commit: boolean, restoreFocus = false) => {
    const text = editingPage.current; if (text === undefined) return;
    editingPage.current = undefined; setPageEdit(undefined);
    const number = Number(text.trim());
    if (commit && /^\d+$/.test(text.trim()) && Number.isSafeInteger(number) && number >= 1 && number <= (pages?.length ?? 0) && number !== index + 1)
      changePage(pages![number - 1].id);
    if (restoreFocus) requestAnimationFrame(() => pageButton.current?.focus());
  };
  return <>
    <button type="button" className="ai-temporary-bookmark user-notebook-bookmark" aria-label="打开用户笔记" title="用户笔记" data-user-notebook-bookmark
      disabled={action.busy} aria-expanded={open} onClick={() => void action.run(async () => {
        const first = await command<UserNotePage>('userNote.ensure');
        setPageId(previous => pages?.some(value => value.id === previous) ? previous : first.id); setOpen(true);
      })}><BookOpen size={16} /><span>用户笔记</span></button>
    {!open && action.error && <div className="user-notebook-error"><AiError text={action.error} /></div>}
    {open && <AiModal title="用户笔记" className="paper-modal" adjustable onClose={() => void action.run(async () => { await editor.current?.flush(); setOpen(false); setMenu(undefined); })}
      navigation={<div className="paper-page-toolbar">
        <button type="button" className="ai-icon-button" aria-label="上一页笔记" disabled={action.busy || index === 0} onClick={() => changePage(pages![index - 1].id)}><ChevronLeft size={17} /></button>
        <span className="paper-page-counter">第 {pageEdit !== undefined ? <input ref={pageInput} className="paper-page-number" aria-label="用户笔记页码" inputMode="numeric" value={pageEdit}
          onChange={event => { editingPage.current = event.target.value; setPageEdit(event.target.value); }} onBlur={() => finishPageEdit(true)}
          onKeyDown={event => { if (event.key === 'Enter' || event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finishPageEdit(event.key === 'Enter', true); } }} />
          : <button ref={pageButton} type="button" className="paper-page-number" data-user-note-current-page disabled={action.busy} title="点击修改页码" aria-label={`第 ${index + 1} 页，点击修改页码`} onClick={() => setPageEdit(String(index + 1))}>{index + 1}</button>}
          页 <span data-user-note-page-total>/ {pages?.length ?? 0}</span></span>
        <button type="button" className="ai-icon-button" aria-label="下一页笔记" disabled={action.busy || index === (pages?.length ?? 0) - 1} onClick={() => changePage(pages![index + 1].id)}><ChevronRight size={17} /></button>
        <button type="button" className="paper-new-page" disabled={action.busy} onClick={() => void action.run(async () => {
          await editor.current?.flush(); const created = await command<UserNotePage>('userNote.create'); setPageId(created.id);
        })}><Plus size={15} />新建一页</button>
      </div>}
      footer={<><span>自动保存 · 自由书写与换行 · 右键删除当前页</span><AiError text={action.error} /></>}>
      {page && <div className="notebook-paper paper-user-page" data-user-notebook-page={page.id} onContextMenu={event => {
        event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY });
      }}>
        <PaperEditor key={page.id} ref={editor} text={page.text} version={page.version} label={`用户笔记第 ${index + 1} 页`} allowTab autoFocus
          placeholder="从这里开始记录…" save={(text, expectedVersion) => command<UserNotePage>('userNote.save', { id: page.id, text, expectedVersion }, { reportError: false })}
          deleteLabel={`删除第 ${index + 1} 页`} onDelete={async expectedVersion => {
            const result = await command<{ nextPageId: string }>('userNote.delete', { id: page.id, expectedVersion }, { reportError: false });
            setPageId(result.nextPageId); setMenu(undefined);
          }} />
        {menu && <PaperContextMenu {...menu} label={`删除第 ${index + 1} 页`} onClose={() => setMenu(undefined)} onDelete={() => { setMenu(undefined); void editor.current?.remove().catch(() => undefined); }} />}
      </div>}
    </AiModal>}
  </>;
}
