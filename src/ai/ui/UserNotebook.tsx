import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUp, BookOpen, Check, ChevronLeft, ChevronRight, FilePlus, Folder, FolderPlus, MoreHorizontal, Plus, Search, Trash2, X } from 'lucide-react';
import { useAiStore } from '../client';
import type { UserNotePage } from '../domain';
import { userNoteDirectoryPages } from '../userNotes';
import { AiError, useAction } from './common';
import { UserNoteEditor, type UserNoteEditorHandle } from './UserNoteEditor';
import { panelCommand, setPanelReading, usePanelState } from '@/desktop/panelState';
import type { NotebookTab } from '@/desktop/api';
import { noteDirectoryPath, notePreview, noteSnippet } from './notebookNavigation';
import { UserNoteTransferDialog, UserNoteReorderDialog } from './UserNoteDialogs';
import './userNotebook.css';

const searchHighlights = new Map<string, { pageId: string; query: string }>();

export function UserNotebook({ tabId = 'notebook' }: { tabId?: string }) {
  const snapshot = useAiStore(s => s.snapshot), command = useAiStore(s => s.command), ui = usePanelState(), action = useAction();
  const pages = snapshot?.userNotePages ?? [], directories = snapshot?.userNoteDirectories ?? [];
  const tab = ui.noteTabs?.find(t => t.id === tabId), global = tabId === 'notebook';
  const requested = tabId === 'note-directory' ? ui.noteDirectoryId ?? '' : tab?.directoryId ?? '';
  const directoryId = directories.some(d => d.id === requested) ? requested : '';
  const directory = directories.find(d => d.id === directoryId), path = noteDirectoryPath(directories, directoryId);
  const contentView = global || (tab?.kind === 'pages' && !!directory);
  const children = directories.filter(d => (d.parentId ?? '') === directoryId);
  const localPages = directoryId ? userNoteDirectoryPages(pages, directoryId, directories) : [];
  const visiblePages = global ? pages : localPages;
  const page = visiblePages.find(p => p.id === (global ? ui.notePageId : tab?.pageId)) ?? visiblePages[0];
  const index = Math.max(0, visiblePages.findIndex(p => p.id === page?.id)), globalNumber = page ? pages.indexOf(page) + 1 : 0;
  const [pathEdit, setPathEdit] = useState<string>(), [pageEdit, setPageEdit] = useState<string>();
  const [searching, setSearching] = useState(false), [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false), [name, setName] = useState('');
  const [picking, setPicking] = useState(false), [chosen, setChosen] = useState<string[]>([]), [pickerQuery, setPickerQuery] = useState('');
  const [menu, setMenu] = useState<string>();
  const [transferPageId, setTransferPageId] = useState<string>(), [reorderPageId, setReorderPageId] = useState<string>();
  const [editorToolbar, setEditorToolbar] = useState<HTMLDivElement | null>(null);
  const editor = useRef<UserNoteEditorHandle>(null), paper = useRef<HTMLDivElement>(null), pageInput = useRef<HTMLInputElement>(null), searchInput = useRef<HTMLInputElement>(null);
  const readingKey = contentView && page ? (global ? 'note:' + page.id : 'note:' + tabId + ':' + page.id) : 'directory:' + tabId;
  useEffect(() => { if (snapshot && global && !pages.length) void action.run(() => command('userNote.ensure')); }, [!!snapshot, global, pages.length]);
  useLayoutEffect(() => { if (paper.current) paper.current.scrollTop = usePanelState.getState().reading[readingKey]?.top ?? 0; }, [readingKey, query, picking]);
  useLayoutEffect(() => { if (pageEdit !== undefined) { pageInput.current?.focus(); pageInput.current?.select(); } }, [pageEdit !== undefined]);
  useEffect(() => { if (searching) searchInput.current?.focus(); }, [searching]);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: PointerEvent) => { if (!(event.target as Element).closest('[data-note-menu]')) setMenu(undefined); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(undefined); };
    document.addEventListener('pointerdown', dismiss); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape); };
  }, [menu]);
  const patchTab = async (patch: Partial<NotebookTab>) => {
    const state = usePanelState.getState();
    if (global) await panelCommand('patch-view', { notePageId: patch.pageId });
    else if (tabId === 'note-directory') await panelCommand('patch-view', { noteDirectoryId: patch.directoryId ?? directoryId });
    else await panelCommand('patch-view', { noteTabs: (state.noteTabs ?? []).map(t => t.id === tabId ? { ...t, ...patch } : t) });
  };
  const openDirectory = async (id: string, newTab = true, pageId?: string, highlight?: string) => {
    await editor.current?.flush();
    const latest = useAiStore.getState().snapshot;
    const firstPage = id ? userNoteDirectoryPages(latest?.userNotePages ?? [], id, latest?.userNoteDirectories ?? [])[0] : undefined;
    const containsPages = !!pageId || !!firstPage;
    if (containsPages || newTab || global) {
      const next: NotebookTab = { id: 'note-view:' + crypto.randomUUID(), directoryId: id, kind: containsPages ? 'pages' : 'directory', pageId: pageId ?? firstPage?.id };
      if (pageId && highlight) searchHighlights.set(next.id, { pageId, query: highlight });
      const state = usePanelState.getState();
      await panelCommand('patch-view', { noteTabs: [...(state.noteTabs ?? []), next], activeTab: next.id });
    } else await patchTab({ directoryId: id, kind: 'directory', pageId: undefined });
    setPathEdit(undefined); setMenu(undefined);
  };
  const changePage = async (id: string) => { await editor.current?.flush(); await patchTab({ pageId: id }); };
  const createPage = async () => {
    await editor.current?.flush();
    const created = await command<UserNotePage>('userNote.create', { ...(directoryId ? { directoryId } : {}) });
    if (!contentView) await openDirectory(directoryId, true, created.id);
    else await patchTab({ pageId: created.id });
  };
  const deletePage = async () => {
    if (!page) return;
    await editor.current?.flush();
    const latest = useAiStore.getState().snapshot?.userNotePages?.find(p => p.id === page.id);
    if (!latest) return;
    const next = visiblePages[index + 1] ?? visiblePages[index - 1];
    const result = await command<{ nextPageId: string }>('userNote.delete', { id: page.id, expectedVersion: latest.version });
    await patchTab({ pageId: global ? result.nextPageId : next?.id }); setMenu(undefined);
  };
  const removePage = async () => {
    if (!page) return;
    await editor.current?.flush();
    const latest = useAiStore.getState().snapshot?.userNotePages?.find(p => p.id === page.id) ?? page;
    await command('userNote.assign', { id: latest.id, directoryId: '', expectedVersion: latest.version }); setMenu(undefined);
  };
  const deleteDirectory = async (id: string, deletePages: boolean) => {
    await editor.current?.flush(); await command('userNote.directory.delete', { id, deletePages }); setMenu(undefined);
  };
  const finishPage = () => {
    const number = Number(pageEdit); setPageEdit(undefined);
    if (Number.isInteger(number) && number >= 1 && number <= visiblePages.length) void action.run(() => changePage(visiblePages[number - 1].id));
  };
  const paths = [{ id: '', path: '/' }, ...directories.map(d => ({ id: d.id, path: noteDirectoryPath(directories, d.id) }))];
  const matchingPaths = paths.filter(d => d.path.toLocaleLowerCase().includes((pathEdit ?? '').trim().toLocaleLowerCase())).slice(0, 10);
  const goPath = () => {
    const input = (pathEdit ?? '').trim().replace(/\/+$/, '') || '/', target = paths.find(d => d.path === input);
    if (!target) { action.setError('没有找到这个目录，请选择下方匹配的路径。'); return; }
    void action.run(() => openDirectory(target.id, false));
  };
  const needle = query.trim().toLocaleLowerCase();
  const results = needle ? pages.filter(p => p.text.toLocaleLowerCase().includes(needle)
    || (p.directoryId && noteDirectoryPath(directories, p.directoryId).toLocaleLowerCase().includes(needle))) : [];
  const pickable = pages.filter(p => !p.directoryId && (notePreview(p).toLocaleLowerCase().includes(pickerQuery.trim().toLocaleLowerCase()) || String(pages.indexOf(p) + 1) === pickerQuery.trim()));
  const openResult = async (target: UserNotePage) => {
    await editor.current?.flush();
    if (target.directoryId) await openDirectory(target.directoryId, true, target.id, query.trim());
    else { searchHighlights.set('notebook', { pageId: target.id, query: query.trim() }); await panelCommand('patch-view', { activeTab: 'notebook', notePageId: target.id }); setQuery(''); setSearching(false); }
  };
  const recordScroll = (top: number) => {
    const state = usePanelState.getState();
    if (state.activeTab !== tabId || state.host !== (window.tujiDesktop?.role ?? 'main') || needle || picking) return;
    setPanelReading(readingKey, { top, following: false });
  };
  const directoryMenu = (id: string) => <div className="note-menu" role="menu">
    <button type="button" role="menuitem" onClick={() => void action.run(() => deleteDirectory(id, false))}><Folder size={14} />删除目录，保留笔记</button>
    <button type="button" role="menuitem" className="note-danger" onClick={() => void action.run(() => deleteDirectory(id, true))}><Trash2 size={14} />删除目录及全部笔记</button>
  </div>;
  return <section className="utility-notebook note-workspace" aria-label="用户笔记" aria-busy={action.busy}
    onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); e.stopPropagation(); setSearching(true); } }}>
    <div className="note-navigation">
      {!global ? <div className="note-address-wrap" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setPathEdit(undefined); }}>
        <button type="button" className="note-icon" aria-label="返回上级目录" title="返回上级目录" disabled={!directoryId || action.busy}
          onClick={() => void action.run(() => openDirectory(directory?.parentId ?? '', false))}><ArrowUp size={16} /></button>
        <div className="note-address"><Folder size={14} aria-hidden /><input aria-label="笔记目录路径" role="combobox" aria-expanded={pathEdit !== undefined}
          aria-controls="note-path-options" autoComplete="off" value={pathEdit ?? path} onFocus={() => setPathEdit(path)} onChange={e => setPathEdit(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'ArrowDown') { e.preventDefault(); e.currentTarget.closest('.note-address-wrap')?.querySelector<HTMLButtonElement>('[role="option"]')?.focus(); }
            if (e.key === 'Enter') { e.preventDefault(); goPath(); }
            if (e.key === 'Escape') { setPathEdit(undefined); e.currentTarget.blur(); }
          }} /></div>
        {pathEdit !== undefined && <div id="note-path-options" role="listbox" aria-label="匹配的目录" className="note-path-options">
          {matchingPaths.map(item => <button key={item.id} type="button" role="option" aria-selected={item.path === pathEdit}
            onMouseDown={e => e.preventDefault()} onClick={() => void action.run(() => openDirectory(item.id, false))}><Folder size={14} /><span>{item.path === '/' ? '/ 笔记目录' : item.path}</span></button>)}
          {!matchingPaths.length && <p>没有匹配的目录</p>}
        </div>}
      </div> : <div className="note-library-title"><BookOpen size={16} /><span>全部笔记</span><small>{pages.length} 页</small></div>}
      <button type="button" className={'note-icon' + (searching ? ' is-active' : '')} aria-label="搜索笔记" title="搜索全部笔记 · Ctrl+F"
        onClick={() => { setSearching(!searching); setQuery(''); }}><Search size={17} /></button>
    </div>
    {searching && <div className="note-search"><Search size={15} /><input ref={searchInput} aria-label="笔记搜索关键词" placeholder="搜索笔记文字或目录路径…" value={query}
      onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') { setQuery(''); setSearching(false); } }} />
      <button type="button" className="note-icon" aria-label="关闭笔记搜索" onClick={() => { setQuery(''); setSearching(false); }}><X size={14} /></button></div>}
    <AiError text={action.error} />
    {needle ? <div className="note-scroll new-scroll" role="region" aria-label="笔记搜索结果">
      <div className="note-section-label">{results.length} 个匹配页面 <span>全部笔记</span></div>
      {results.map(result => {
        const local = userNoteDirectoryPages(pages, result.directoryId ?? '', directories).findIndex(p => p.id === result.id) + 1;
        return <button type="button" className="note-result" key={result.id} onClick={() => void action.run(() => openResult(result))}>
          <span className="note-result-heading">全局第 {pages.indexOf(result) + 1} 页 <ChevronRight size={14} /></span>
          <span className="note-result-path">{result.directoryId ? noteDirectoryPath(directories, result.directoryId) + ' · 目录内第 ' + local + ' 页' : '未归类'}</span>
          <span className="note-result-snippet">{noteSnippet(result.text, query.trim()) || notePreview(result)}</span>
        </button>;
      })}
      {!results.length && <div className="note-empty"><Search size={28} /><strong>没有找到匹配的笔记</strong><p>试试更短的关键词或目录名。</p></div>}
    </div> : picking ? <div className="note-picker">
      <div className="note-picker-heading"><button className="note-icon" aria-label="返回目录" onClick={() => setPicking(false)}><ArrowLeft size={16} /></button><strong>放入现有页</strong><span>{chosen.length} 已选</span></div>
      <div className="note-search"><Search size={15} /><input aria-label="筛选未归类笔记" placeholder="按页号或文字筛选…" value={pickerQuery} onChange={e => setPickerQuery(e.target.value)} /></div>
      <div className="note-scroll new-scroll">{pickable.map(p => <label className="note-pick-row" key={p.id}>
        <input type="checkbox" checked={chosen.includes(p.id)} onChange={() => setChosen(current => current.includes(p.id) ? current.filter(id => id !== p.id) : [...current, p.id])} />
        <span><strong>第 {pages.indexOf(p) + 1} 页</strong><small>{notePreview(p)}</small></span></label>)}
        {!pickable.length && <div className="note-empty"><BookOpen size={28} /><strong>没有可放入的页</strong><p>这里只显示尚未归类的笔记。</p></div>}
      </div>
      <div className="note-picker-footer"><span>加入 {path}</span><button className="note-primary" disabled={!chosen.length || action.busy} onClick={() => void action.run(async () => {
        for (const id of chosen) {
          const current = useAiStore.getState().snapshot?.userNotePages?.find(p => p.id === id);
          if (current) await command('userNote.assign', { id, directoryId, expectedVersion: current.version });
        }
        setPicking(false); setChosen([]); await openDirectory(directoryId);
      })}><Check size={15} />放入 {chosen.length || ''} 页</button></div>
    </div> : !contentView ? <>
      <div className="note-directory-heading"><div><strong>{directory?.name ?? '笔记目录'}</strong><span>{children.length ? children.length + ' 个目录' : localPages.length ? localPages.length + ' 页笔记' : '用目录整理你的笔记'}</span></div>
        <div className="note-menu-anchor" data-note-menu>{directoryId && <><button className="note-icon" aria-label="当前目录操作" onClick={() => setMenu(menu ? undefined : 'current')}><MoreHorizontal size={18} /></button>{menu === 'current' && directoryMenu(directoryId)}</>}</div>
      </div>
      <div className="note-directory-actions">
        {!localPages.length && <button className="note-text-button" disabled={action.busy} onClick={() => { setCreating(!creating); setName(''); }}><FolderPlus size={16} />新建目录</button>}
        {directoryId && !children.length && <><button className="note-text-button" disabled={action.busy} onClick={() => void action.run(createPage)}><FilePlus size={16} />新建页</button>
          <button className="note-text-button" onClick={() => { setPicking(true); setChosen([]); }}><Plus size={16} />放入现有页</button></>}
      </div>
      {creating && <form className="note-create-form" onSubmit={e => { e.preventDefault(); void action.run(async () => {
        await command('userNote.directory.create', { name: name.trim(), parentId: directoryId }); setCreating(false); setName('');
      }); }}><Folder size={16} /><input autoFocus aria-label="新目录名称" placeholder="目录名称" maxLength={120} value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setCreating(false); }} />
        <button className="note-primary" disabled={!name.trim() || action.busy}>创建</button><button type="button" className="note-icon" aria-label="取消新建目录" onClick={() => setCreating(false)}><X size={15} /></button>
      </form>}
      <div ref={paper} className="note-scroll new-scroll" onScroll={e => recordScroll(e.currentTarget.scrollTop)}>
        {children.map(child => {
          const count = directories.filter(d => d.parentId === child.id).length, childPages = pages.filter(p => p.directoryId === child.id).length;
          return <div className="note-folder-row" key={child.id}>
            <button className="note-folder-open" disabled={action.busy} onClick={() => void action.run(() => openDirectory(child.id))}><span className="note-folder-icon">{childPages ? <BookOpen size={21} /> : <Folder size={21} />}</span>
              <span><strong>{child.name}</strong><small>{childPages ? childPages + ' 页笔记' : count ? count + ' 个目录' : '空目录'}</small></span><ChevronRight size={15} /></button>
            <div className="note-menu-anchor" data-note-menu><button className="note-icon" aria-label={'目录操作 ' + child.name} onClick={() => setMenu(menu === child.id ? undefined : child.id)}><MoreHorizontal size={17} /></button>{menu === child.id && directoryMenu(child.id)}</div>
          </div>;
        })}
        {!!localPages.length && <button className="note-directory-reader" onClick={() => void action.run(() => openDirectory(directoryId))}><BookOpen size={24} /><span><strong>阅读这个目录的笔记</strong><small>{localPages.length} 页 · 在新标签中打开</small></span><ChevronRight size={18} /></button>}
        {!children.length && !localPages.length && !creating && <div className="note-empty"><Folder size={34} strokeWidth={1.25} /><strong>{directoryId ? '从这里开始整理' : '给笔记一个位置'}</strong><p>{directoryId ? '创建下级目录，或直接存放笔记页。' : '新建目录，再将相关的笔记放在一起。'}</p></div>}
      </div><footer className="note-footer">{directoryId ? '目录与笔记页分开存放' : '根目录只存放目录'}</footer>
    </> : null}
    {contentView && <div className="note-content-view" hidden={!!needle || picking}>
      <div className="paper-page-toolbar note-page-toolbar"><div className="note-page-controls">
        <button type="button" className="note-icon" aria-label="上一页笔记" disabled={action.busy || index === 0 || !page} onClick={() => void action.run(() => changePage(visiblePages[index - 1].id))}><ChevronLeft size={17} /></button>
        <span className="paper-page-counter">第 {pageEdit !== undefined ? <input ref={pageInput} className="paper-page-number" aria-label="用户笔记页码" inputMode="numeric" value={pageEdit}
          onChange={e => setPageEdit(e.target.value)} onBlur={finishPage} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); finishPage(); } if (e.key === 'Escape') setPageEdit(undefined); }} />
          : <button className="paper-page-number" data-user-note-current-page disabled={!page} aria-label={'第 ' + (page ? index + 1 : 0) + ' 页，点击修改页码'} onClick={() => setPageEdit(String(index + 1))}>{page ? index + 1 : 0}</button>}
          <span data-user-note-page-total>/ {visiblePages.length}</span> 页</span>
        <button type="button" className="note-icon" aria-label="下一页笔记" disabled={action.busy || !page || index >= visiblePages.length - 1} onClick={() => void action.run(() => changePage(visiblePages[index + 1].id))}><ChevronRight size={17} /></button>
      </div><div className="note-page-actions">
        <button type="button" className="note-text-button" disabled={action.busy} onClick={() => void action.run(createPage)}><Plus size={15} />新建一页</button>
        <div className="note-menu-anchor" data-note-menu><button className="note-icon" aria-label="笔记页操作" title="笔记页操作" onClick={() => setMenu(menu ? undefined : 'page')}><MoreHorizontal size={18} /></button>
          {menu === 'page' && <div className="note-menu" role="menu">
            <button role="menuitem" disabled={!page || action.busy} onClick={() => void action.run(async () => { await editor.current?.flush(); setTransferPageId(page!.id); setMenu(undefined); })}><FolderPlus size={14} />将此页添加到...</button>
            {!global && <button role="menuitem" disabled={!page || localPages.length < 2 || action.busy} onClick={() => { setReorderPageId(page!.id); setMenu(undefined); }}><ArrowUp size={14} />改变当前页顺序</button>}
            {!global && <button role="menuitem" onClick={() => { setPicking(true); setMenu(undefined); }}><Plus size={14} />放入现有页</button>}
            {page?.directoryId && <button role="menuitem" onClick={() => void action.run(removePage)}><ArrowLeft size={14} />将当前页移出目录</button>}
            <button role="menuitem" className="note-danger" disabled={!page} onClick={() => void action.run(deletePage)}><Trash2 size={14} />删除当前页</button>
          </div>}
        </div>
      </div></div>
      <div className="utility-paper-scroll new-scroll" ref={paper} onScroll={e => recordScroll(e.currentTarget.scrollTop)}>
        {page ? <div className="notebook-paper paper-user-page" data-user-notebook-page={page.id}>
          <UserNoteEditor key={page.id} ref={editor} page={page} label={'用户笔记第 ' + globalNumber + ' 页'} toolbarTarget={editorToolbar} highlight={searchHighlights.get(tabId)?.pageId === page.id ? searchHighlights.get(tabId)?.query : undefined}
            save={(blocks, expectedVersion) => command<UserNotePage>('userNote.save', { id: page.id, blocks, expectedVersion }, { reportError: false })}
            uploadImage={dataUrl => command('userNote.image.upload', { dataUrl }, { reportError: false })} onDelete={deletePage} />
        </div> : <div className="note-empty"><BookOpen size={30} /><strong>这里还没有笔记</strong><p>新建一页，或从未归类笔记中放入。</p><button className="note-primary" onClick={() => void action.run(createPage)}><Plus size={15} />新建一页</button></div>}
      </div><footer className="note-footer note-editor-footer">
        <span className="note-page-location" title={page?.directoryId ? noteDirectoryPath(directories, page.directoryId) : '未分类'}>{page?.directoryId ? noteDirectoryPath(directories, page.directoryId) : '未分类'}</span>
        <span className="note-global-page">{!global && page ? '全局第 ' + globalNumber + ' 页' : ''}</span>
        <div ref={setEditorToolbar} />
      </footer>
    </div>}
    {transferPageId && <UserNoteTransferDialog pageId={transferPageId} flush={() => editor.current?.flush() ?? Promise.resolve()} onClose={() => setTransferPageId(undefined)} />}
    {reorderPageId && <UserNoteReorderDialog pageId={reorderPageId} directoryId={directoryId} onClose={() => setReorderPageId(undefined)} />}
  </section>;
}
