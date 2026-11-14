import type { UserNotePage } from '../domain';

export interface NoteDirectoryEntry { id: string; name: string; parentId?: string }
export function noteDirectoryPath(directories: NoteDirectoryEntry[], id: string): string {
  const names: string[] = [], seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id); const entry = directories.find(value => value.id === id);
    if (!entry) break;
    names.unshift(entry.name); id = entry.parentId ?? '';
  }
  return '/' + names.join('/');
}
export function notePreview(page: UserNotePage): string {
  return page.text.replace(/\s+/g, ' ').trim() || (page.blocks?.some(block => block.type === 'images') ? '图片笔记' : '空白页');
}
export function noteSnippet(text: string, query: string): string {
  const index = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()), start = Math.max(0, index - 24);
  return (start ? '…' : '') + text.slice(start, start + 120).replace(/\s+/g, ' ') + (text.length > start + 120 ? '…' : '');
}
