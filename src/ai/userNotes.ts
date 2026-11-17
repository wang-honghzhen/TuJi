import type { UserNotePage } from './domain';

export interface UserNoteCrop { left: number; top: number; right: number; bottom: number }
export interface UserNoteImage {
  id: string; src: string; x: number; y: number; width: number; height: number; rotation: number;
  crop?: UserNoteCrop;
}
export type UserNoteBlock = { id: string; type: 'text'; text: string }
  | { id: string; type: 'images'; images: UserNoteImage[] };
export interface UserNoteDirectory { id: string; name: string; parentId?: string; createdAt: string; updatedAt: string; pageIds?: string[] }

/** Old plain-text pages keep their complete whitespace when first opened. */
export function userNoteBlocks(page: Pick<UserNotePage, 'id' | 'text' | 'blocks'>): UserNoteBlock[] {
  return page.blocks ?? [{ id: `${page.id}:text`, type: 'text', text: page.text }];
}
export function userNoteText(blocks: UserNoteBlock[]): string {
  return blocks.filter((block): block is Extract<UserNoteBlock, { type: 'text' }> => block.type === 'text').map(block => block.text).join('\n');
}
export function userNotePath(directories: UserNoteDirectory[], directoryId?: string): string {
  const byId = new Map(directories.map(directory => [directory.id, directory]));
  const names: string[] = [], visited = new Set<string>();
  let current = directoryId;
  while (current && !visited.has(current)) {
    visited.add(current);
    const directory = byId.get(current); if (!directory) break;
    names.unshift(directory.name); current = directory.parentId;
  }
  return '/' + names.join('/');
}
export function userNoteDirectoryPages(pages: UserNotePage[], directoryId: string, directories: UserNoteDirectory[] = []): UserNotePage[] {
  const members = pages.filter(page => page.directoryId === directoryId);
  const remaining = new Map(members.map(page => [page.id, page]));
  const ordered: UserNotePage[] = [];
  for (const id of directories.find(directory => directory.id === directoryId)?.pageIds ?? []) {
    const page = remaining.get(id);
    if (page) { ordered.push(page); remaining.delete(id); }
  }
  return [...ordered, ...remaining.values()];
}
