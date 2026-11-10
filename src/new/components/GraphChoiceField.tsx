import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PathSegment } from '@/v3/paths';
import { GraphPathLabel } from './GraphPathLabel';

interface Choice { id: string; label: string; segments?: PathSegment[] }
export function GraphChoiceField({ value, options, onChange, placeholder, searchable = true, field, disabled = false }: {
  value: string; options: Choice[]; onChange: (id: string) => void; placeholder: string; searchable?: boolean; field: string; disabled?: boolean;
}) {
  const trigger = useRef<HTMLButtonElement>(null); const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false); const [search, setSearch] = useState(''); const [point, setPoint] = useState({ x: 0, y: 0 });
  const chosen = options.find((item) => item.id === value);
  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const rect = trigger.current.getBoundingClientRect(); const bounds = menu.current.getBoundingClientRect();
    setPoint({ x: Math.max(8, Math.min(innerWidth - bounds.width - 8, rect.left)),
      y: rect.bottom + bounds.height + 6 > innerHeight - 8 ? Math.max(8, rect.top - bounds.height - 6) : rect.bottom + 6 });
  }, [open, search, options.length]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.isComposing) { event.stopPropagation(); setOpen(false); trigger.current?.focus(); } };
    window.addEventListener('pointerdown', outside, true); window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', key, true); };
  }, [open]);
  return <><button ref={trigger} type="button" disabled={disabled} data-action-field={field} aria-haspopup="dialog" aria-expanded={open && !disabled}
    className="space-choice-trigger min-w-0 text-left text-xs break-words"
    onClick={() => { setSearch(''); setOpen(!open); }}>{chosen?.segments ? <GraphPathLabel segments={chosen.segments} /> : chosen?.label ?? placeholder}</button>
    {open && !disabled && createPortal(<div ref={menu} data-canvas-interactive data-choice-menu={field} role="dialog" aria-label={placeholder}
      className="space-menu fixed z-[280] w-80 max-w-[calc(100vw-16px)] p-2 text-xs"
      style={{ left: point.x, top: point.y }} onPointerDown={(event) => event.stopPropagation()}>
      {searchable && <input autoFocus data-choice-search value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索路径或名称" className="w-full mb-2 rounded border border-slate-700 bg-slate-900 px-2 py-1.5 outline-none focus:border-blue-400" />}
      <div className="max-h-52 overflow-y-auto new-scroll">{options.filter((item) => item.label.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map((item) =>
        <button key={item.id} type="button" data-choice-option={item.id} className={`block w-full px-2 py-1.5 rounded text-left break-words hover:bg-blue-500/20 ${item.id === value ? 'bg-blue-500/15' : ''}`}
          onClick={() => { onChange(item.id); setOpen(false); trigger.current?.focus(); }}>{item.segments ? <GraphPathLabel segments={item.segments} /> : item.label}</button>)}</div>
    </div>, document.body)}
  </>;
}
