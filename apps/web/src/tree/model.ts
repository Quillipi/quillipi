/**
 * The notebook's tree as the panel works with it, with no React and no browser, so it is tested in
 * Node: where a dragged row lands as an organize op, where a section or folder may move to, which
 * folders lead to a section, and the order of the tabs.
 */
import type { TreeItem } from '@inklog/core';

/** A row of the tree: a section by its ID, or a folder by its path. */
export type Row = { kind: 'section'; id: string } | { kind: 'folder'; path: string };

/** Where a row is dropped on another: before it, after it, or (on a folder) inside it, last. */
export type Drop = 'before' | 'after' | 'inside';

/** The editor call's organize op (packages/engine, ORGANIZE_OPS). */
export interface MoveOp {
  op: 'move';
  id: string;
  in: string;
  after?: string | null;
}

export function parentOf(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

/** The items of a folder ("" is the top), or undefined if there is no such folder. */
export function itemsOf(tree: readonly TreeItem[], folder: string): readonly TreeItem[] | undefined {
  if (!folder) return tree;
  let items: readonly TreeItem[] = tree;
  for (const part of folder.split('/')) {
    const found = items.find((item) => typeof item !== 'string' && item.folder === part);
    if (!found || typeof found === 'string') return undefined;
    items = found.items;
  }
  return items;
}

/** The folder a section is in ("" for the top), or undefined if it isn't in the tree. */
export function folderOfSection(tree: readonly TreeItem[], id: string, folder = ''): string | undefined {
  for (const item of tree) {
    if (item === id) return folder;
    if (typeof item !== 'string') {
      const found = folderOfSection(item.items, id, join(folder, item.folder));
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** Every folder from the top down to `folder`: 'a/b' gives ['a', 'a/b']. */
export function foldersTo(folder: string): string[] {
  const parts = folder ? folder.split('/') : [];
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
}

/** How a row is named in an organize op: a section by its ID, a folder by its path ending in /. */
const ref = (row: Row) => (row.kind === 'section' ? row.id : `${row.path}/`);

/** The folder a row sits in. */
export function placeOf(tree: readonly TreeItem[], row: Row): string | undefined {
  return row.kind === 'section' ? folderOfSection(tree, row.id) : parentOf(row.path);
}

/**
 * The organize op that puts `dragged` where it was dropped, or undefined when the drop changes
 * nothing or can't be done (a folder into itself or a folder inside it).
 */
export function dropOp(tree: readonly TreeItem[], dragged: Row, target: Row, drop: Drop): MoveOp | undefined {
  if (dragged.kind === target.kind && ref(dragged) === ref(target)) return undefined;
  if (dragged.kind === 'folder') {
    const inside = (path: string) => path === dragged.path || path.startsWith(`${dragged.path}/`);
    if (target.kind === 'folder' && inside(target.path)) return undefined;
    if (target.kind === 'section' && inside(folderOfSection(tree, target.id) ?? '')) return undefined;
  }
  if (drop === 'inside') {
    if (target.kind !== 'folder') return undefined;
    if (placeOf(tree, dragged) === target.path) {
      // Already in it: going inside means going last.
      const items = itemsOf(tree, target.path) ?? [];
      const last = items[items.length - 1];
      if (last !== undefined && sameItem(last, dragged, target.path)) return undefined;
    }
    return { op: 'move', id: ref(dragged), in: target.path };
  }
  const folder = placeOf(tree, target);
  if (folder === undefined) return undefined;
  // Siblings without the dragged row, since it is taken out before it is put back.
  const siblings = (itemsOf(tree, folder) ?? []).filter((item) => !sameItem(item, dragged, folder));
  const at = siblings.findIndex((item) => sameItem(item, target, folder));
  if (at < 0) return undefined;
  const before = drop === 'before' ? siblings[at - 1] : siblings[at];
  const after = before === undefined ? null : typeof before === 'string' ? before : `${join(folder, before.folder)}/`;
  // Nothing changes when it would land where it already is.
  const now = itemsOf(tree, folder) ?? [];
  const index = now.findIndex((item) => sameItem(item, dragged, folder));
  if (index >= 0) {
    const previous = now[index - 1];
    const was = previous === undefined ? null : typeof previous === 'string' ? previous : `${join(folder, previous.folder)}/`;
    if (was === after) return undefined;
  }
  return { op: 'move', id: ref(dragged), in: folder, after };
}

function sameItem(item: TreeItem, row: Row, folder: string): boolean {
  return typeof item === 'string' ? row.kind === 'section' && row.id === item : row.kind === 'folder' && row.path === join(folder, item.folder);
}

/** Where Move to… may send a row: the top and every folder, except where it is and, for a folder, itself and what is inside it. */
export function moveTargets(tree: readonly TreeItem[], row: Row): { path: string; name: string; depth: number }[] {
  const here = placeOf(tree, row);
  const targets: { path: string; name: string; depth: number }[] = [];
  const walk = (items: readonly TreeItem[], folder: string, depth: number) => {
    for (const item of items) {
      if (typeof item === 'string') continue;
      const path = join(folder, item.folder);
      if (row.kind === 'folder' && (path === row.path || path.startsWith(`${row.path}/`))) continue;
      targets.push({ path, name: item.name, depth });
      walk(item.items, path, depth + 1);
    }
  };
  targets.push({ path: '', name: 'Top of the notebook', depth: 0 });
  walk(tree, '', 1);
  return targets.filter((target) => target.path !== here);
}

export interface Heading {
  id: string;
  text: string;
}

/** The tabs with one moved to another place, as when it is dragged. */
export function moveTab(tabs: readonly string[], id: string, to: number): string[] {
  const from = tabs.indexOf(id);
  if (from < 0) return [...tabs];
  const rest = tabs.filter((tab) => tab !== id);
  const at = Math.max(0, Math.min(rest.length, to > from ? to - 1 : to));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** Sections whose title has every word typed, in tree order, with the folder each is in. */
export function findSections(sections: readonly { id: string; title: string; folder: string }[], query: string): { id: string; title: string; folder: string }[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return sections.filter((section) => {
    const title = section.title.toLowerCase();
    return words.every((word) => title.includes(word));
  });
}
