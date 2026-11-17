import { useState } from 'react';
import { ArrowUp, BookOpen, ChevronRight, Folder, FolderPlus } from 'lucide-react';
import { useAiStore } from '../client';
import { userNoteDirectoryPages, type UserNoteDirectory } from '../userNotes';
import { AiError, AiModal, useAction } from './common';
import { noteDirectoryPath, notePreview } from './notebookNavigation';

export function UserNoteTransferDialog({ pageId, flush, onClose }: { pageId: string; flush: () => Promise<void>; onClose: () => void }) {
  const snapshot = useAiStore(s => s.snapshot), command = useAiStore(s => s.command), action = useAction();
  const pages = snapshot?.userNotePages ?? [], directories = snapshot?.userNoteDirectories ?? [];
  const page = pages.find(page => page.id === pageId);
  const [folderId, setFolderId] = useState(''), [creating, setCreating] = useState(false), [name, setName] = useState('');
  const [confirming, setConfirming] = useState(false);
  const folder = directories.find(directory => directory.id === folderId);
  const children = directories.filter(directory => (directory.parentId ?? '') === folderId);
  const hasPages = pages.some(page => page.directoryId === folderId), canPlace = !!folder && !children.length;
  const destination = noteDirectoryPath(directories, folderId);
  const ancestors: UserNoteDirectory[] = [], seen = new Set<string>();
  let ancestor = folder;
  while (ancestor && !seen.has(ancestor.id)) { ancestors.unshift(ancestor); seen.add(ancestor.id); ancestor = directories.find(directory => directory.id === ancestor!.parentId); }
  const navigate = (id: string) => { setFolderId(id); setCreating(false); setName(''); setConfirming(false); action.setError(''); };
  const transfer = (mode: 'move' | 'copy') => void action.run(async () => {
    await flush();
    const latest = useAiStore.getState().snapshot?.userNotePages?.find(value => value.id === pageId);
    if (!latest) throw new Error('这页笔记已被删除。');
    // If another window classified this page while the picker was open, ask before moving it.
    if (latest.directoryId && !confirming) { setConfirming(true); return; }
    await command('userNote.transfer', { id: pageId, directoryId: folderId, mode, expectedVersion: latest.version });
    onClose();
  });
  return <AiModal title="将此页添加到..." className="note-workspace note-dialog" onClose={onClose} dismissible={!action.busy}
    footer={<><button className="note-text-button" disabled={action.busy} onClick={confirming ? () => setConfirming(false) : onClose}>{confirming ? '返回目录' : '取消'}</button><span />
      {confirming ? <><button className="note-text-button" disabled={!page || !canPlace || action.busy} onClick={() => transfer('copy')}>复制一份</button>
        <button className="note-primary" disabled={!page || !canPlace || page.directoryId === folderId || action.busy} onClick={() => transfer('move')}>迁移到此目录</button></>
        : <button className="note-primary" disabled={!page || !canPlace || action.busy} onClick={() => transfer('move')}>添加到此目录</button>}</>}>
    <AiError text={action.error} />
    {!page ? <p role="alert">这页笔记已被删除。</p> : confirming ? <div className="note-transfer-choice">
      <BookOpen size={24} /><p>此页已在 <strong>{noteDirectoryPath(directories, page.directoryId ?? '')}</strong> 中。</p>
      <p>目标目录：<strong>{destination}</strong></p>
      <p>{page.directoryId === folderId ? '此页已在目标目录中，可以再复制一份。' : '迁移原页，或保留原页并创建独立副本。'}</p>
    </div> : <>
      <nav className="note-dialog-path" aria-label="选择目标目录">
        <button className="note-icon" aria-label="返回上级目录" disabled={!folderId || action.busy} onClick={() => navigate(folder?.parentId ?? '')}><ArrowUp size={16} /></button>
        <button disabled={action.busy} onClick={() => navigate('')}>笔记目录</button>
        {ancestors.map(directory => <span key={directory.id}><ChevronRight size={13} /><button disabled={action.busy} onClick={() => navigate(directory.id)}>{directory.name}</button></span>)}
      </nav>
      {!folder && folderId && <p role="alert">该目录已被删除，请返回上级目录。</p>}
      <div className="note-dialog-folders">{children.map(child => <button className="note-dialog-folder" key={child.id} disabled={action.busy} onClick={() => navigate(child.id)}>
        <Folder size={20} /><span>{child.name}</span><ChevronRight size={16} /></button>)}
        {!children.length && <p className="note-dialog-hint">{folder ? (hasPages ? '可以将这页笔记添加到此目录。' : '空目录，可以添加笔记页或创建子目录。') : '先新建一个目录，再放入笔记。'}</p>}
      </div>
      {!hasPages && (!folderId || folder) && <button className="note-text-button" disabled={action.busy} onClick={() => { setCreating(true); setName(''); }}><FolderPlus size={16} />新建目录</button>}
      {creating && <form className="note-dialog-create" onSubmit={event => { event.preventDefault(); void action.run(async () => {
        const created = await command<UserNoteDirectory>('userNote.directory.create', { name: name.trim(), parentId: folderId }); navigate(created.id);
      }); }}><input autoFocus aria-label="新目录名称" placeholder="目录名称" maxLength={120} value={name} disabled={action.busy} onChange={event => setName(event.target.value)} />
        <button className="note-primary" disabled={!name.trim() || action.busy}>创建</button><button type="button" className="note-text-button" disabled={action.busy} onClick={() => setCreating(false)}>取消</button></form>}
      {!!children.length && <p className="note-dialog-hint">此目录包含子目录，请进入下级目录后添加笔记。</p>}
    </>}
  </AiModal>;
}

export function UserNoteReorderDialog({ pageId, directoryId, onClose }: { pageId: string; directoryId: string; onClose: () => void }) {
  const snapshot = useAiStore(s => s.snapshot), command = useAiStore(s => s.command), action = useAction();
  const pages = snapshot?.userNotePages ?? [], directories = snapshot?.userNoteDirectories ?? [];
  const current = userNoteDirectoryPages(pages, directoryId, directories);
  const [originalIds, setOriginalIds] = useState(() => current.map(page => page.id));
  const [number, setNumber] = useState('1'), [placement, setPlacement] = useState<'before' | 'after'>('before');
  const stale = originalIds.length !== current.length || current.some((page, index) => page.id !== originalIds[index]);
  const n = Number(number), referenceId = Number.isInteger(n) && n >= 1 && n <= originalIds.length ? originalIds[n - 1] : undefined;
  const reference = pages.find(page => page.id === referenceId), exists = current.some(page => page.id === pageId);
  return <AiModal title="改变当前页顺序" className="note-workspace note-dialog note-reorder-dialog" onClose={onClose} dismissible={!action.busy}
    footer={<><button className="note-text-button" disabled={action.busy} onClick={onClose}>取消</button><span /><button className="note-primary" disabled={!referenceId || !exists || stale || action.busy}
      onClick={() => void action.run(async () => { await command('userNote.reorder', { id: pageId, directoryId, referencePageId: referenceId, placement, expectedPageIds: originalIds }); onClose(); })}>确认顺序</button></>}>
    <AiError text={action.error} />
    <p>将当前页（第 {originalIds.indexOf(pageId) + 1} 页）放到：</p>
    <div className="note-reorder-controls"><label>第 <input type="number" inputMode="numeric" min={1} max={originalIds.length} aria-label="调整顺序的参考页号" value={number} disabled={action.busy} onChange={event => setNumber(event.target.value)} /> / {originalIds.length} 页</label>
      <select aria-label="放在参考页前面或后面" disabled={action.busy} value={placement} onChange={event => setPlacement(event.target.value as 'before' | 'after')}><option value="before">前面</option><option value="after">后面</option></select></div>
    <p className="note-dialog-hint">页号以本次调整前为准。当前页将保持打开。</p>
    {reference && <p className="note-reorder-preview">参考页：{notePreview(reference)}</p>}
    {referenceId === pageId && <p className="note-dialog-hint">选择当前页自身时，顺序保持不变。</p>}
    {!referenceId && <p role="alert">请输入 1 到 {originalIds.length} 的整数页号。</p>}
    {stale && <p role="alert">目录页号已发生变化。<button className="note-text-button" disabled={action.busy} onClick={() => { setOriginalIds(current.map(page => page.id)); setNumber('1'); action.setError(''); }}>刷新页号并重新选择</button></p>}
    {!exists && <p role="alert">当前页已移出或删除，请关闭此窗口。</p>}
  </AiModal>;
}
