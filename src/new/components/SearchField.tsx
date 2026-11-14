import { forwardRef } from 'react';
import type { KeyboardEventHandler } from 'react';
import { Search, X } from 'lucide-react';
import './search.css';

export const SearchField = forwardRef<HTMLInputElement, {
  value: string; onChange: (value: string) => void; label: string; placeholder?: string;
  autoFocus?: boolean; onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
}>(function SearchField({ value, onChange, label, placeholder, autoFocus, onKeyDown }, ref) {
  return <div className="graph-search-field"><Search size={14} aria-hidden="true" />
    <input ref={ref} type="search" value={value} aria-label={label} placeholder={placeholder ?? label}
      autoFocus={autoFocus} onChange={event => onChange(event.target.value)} onKeyDown={onKeyDown} />
    {value && <button type="button" aria-label={'清空' + label} onClick={() => onChange('')}><X size={13} /></button>}
  </div>;
});

export function SearchHighlight({ text, query }: { text: string; query: string }) {
  const term = query.trim().split(/\s+/)[0];
  if (!term) return <>{text}</>;
  const index = text.toLocaleLowerCase().indexOf(term.toLocaleLowerCase());
  if (index < 0) return <>{text}</>;
  return <>{text.slice(0, index)}<mark>{text.slice(index, index + term.length)}</mark>{text.slice(index + term.length)}</>;
}
