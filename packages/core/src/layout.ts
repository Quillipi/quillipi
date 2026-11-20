/**
 * How a notebook is arranged: its folders, the sections in them, and their order.
 *
 * Folders are real directories under `sections/`, so a notebook stays readable on GitHub and in
 * any editor. The files are the truth about which sections exist and which folder each is in;
 * `inklog.json` adds what files can't hold: the order, each folder's display name, and empty
 * folders (Git keeps no empty directories). `placeTree` joins the two, and repairs a tree that
 * disagrees with the files, so a hand-edited or out-of-date `inklog.json` never loses a section.
 *
 *   "tree": [
 *     "start-here",
 *     { "folder": "research", "name": "Research", "items": ["interviews", "pricing"] }
 *   ]
 *
 * A section is its permanent ID, kept in its file's front matter (see markdown.ts). A folder is
 * its directory's name, its display name and what it holds. A folder's path joins the directory
 * names from the top, such as `product/research`; `""` is the top itself.
 */

export interface TreeFolder {
  /** The directory's name: one path segment. */
  folder: string;
  /** What people see. */
  name: string;
  items: TreeItem[];
}

/** A section's ID, or a folder. */
export type TreeItem = string | TreeFolder;

export interface NotebookMeta {
  name?: string;
  /** One line on what the notebook is for, shown under its title (and as its GitHub repo's description). */
  about?: string;
  /** The notebook's own colour, as `#rrggbb`: its cover on Home and its tab, the same for everyone. */
  colour?: string;
  tree?: TreeItem[];
  /** Before folders, the order of the sections, by their paths. See upgradeIds. */
  sections?: string[];
}

/** Section IDs: lowercase letters and digits in words joined by hyphens, at most 60 characters. */
const SECTION_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_ID_LENGTH = 60;

export function isSectionId(value: string): boolean {
  return value.length <= MAX_ID_LENGTH && SECTION_ID.test(value);
}

/** Lowercase letters, digits and hyphens, for IDs and directory names made from a title. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MAX_ID_LENGTH)
    .replace(/^-+|-+$/g, '');
}

/** Names Windows keeps for devices and refuses for files and folders, with any extension, such as `aux.md`. */
export function isReservedName(name: string): boolean {
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name);
}

/**
 * `base`, or `base-2`, `base-3`… whichever isn't taken. Every name Quillipi makes becomes a file or
 * folder name, so the names Windows keeps for itself count as taken.
 */
export function uniqueName(base: string, taken: (name: string) => boolean): string {
  if (!taken(base) && !isReservedName(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const name = `${base.slice(0, MAX_ID_LENGTH - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!taken(name)) return name;
  }
}

/** A readable name for a directory that has none yet, such as "Inklog Notebook" for `inklog-notebook`. */
export function titleCase(name: string): string {
  return name.replace(/[-_]+/g, ' ').trim().replace(/\b\w/g, (letter) => letter.toUpperCase()) || name;
}

/**
 * Whether a directory name can be a folder: one path segment that stays inside the notebook. Names
 * Quillipi makes are slugs; names already on disk are kept as they are, since the files are the truth.
 */
export function isFolderName(name: string): boolean {
  return name.length > 0 && name.length <= 100 && !/[/\\:*?"<>|\u0000-\u001f]/.test(name) && !name.startsWith('.') && name.trim() === name;
}

// ---------------------------------------------------------------------------
// Reading and writing inklog.json

export function parseMeta(text: string | undefined): NotebookMeta {
  let value: unknown;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as { name?: unknown; about?: unknown; colour?: unknown; tree?: unknown; sections?: unknown };
  const meta: NotebookMeta = {};
  if (typeof raw.name === 'string') meta.name = raw.name;
  if (typeof raw.about === 'string' && aboutLine(raw.about)) meta.about = aboutLine(raw.about);
  if (typeof raw.colour === 'string' && isNotebookColour(raw.colour.toLowerCase())) meta.colour = raw.colour.toLowerCase();
  if (Array.isArray(raw.tree)) meta.tree = readItems(raw.tree);
  if (Array.isArray(raw.sections)) meta.sections = raw.sections.filter((id): id is string => typeof id === 'string');
  return meta;
}

/** Keeps what is well formed; placeTree puts back anything a damaged tree lost. */
function readItems(raw: readonly unknown[]): TreeItem[] {
  const items: TreeItem[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      if (isSectionId(item)) items.push(item);
    } else if (item && typeof item === 'object') {
      const { folder, name, items: inner } = item as { folder?: unknown; name?: unknown; items?: unknown };
      if (typeof folder !== 'string' || !isFolderName(folder)) continue;
      items.push({ folder, name: typeof name === 'string' && name.trim() ? name.trim() : titleCase(folder), items: Array.isArray(inner) ? readItems(inner) : [] });
    }
  }
  return items;
}

/** What inklog.json says about the notebook itself, besides its tree. */
export interface NotebookDetails {
  name: string;
  about?: string;
  colour?: string;
}

/** The details in a parsed inklog.json, with a name to use when it has none. */
export function detailsOf(meta: NotebookMeta, fallbackName: string): NotebookDetails {
  return { name: meta.name ?? fallbackName, ...(meta.about ? { about: meta.about } : {}), ...(meta.colour ? { colour: meta.colour } : {}) };
}

export function metaFile({ name, about, colour }: NotebookDetails, tree: readonly TreeItem[]): string {
  return `${JSON.stringify({ name, ...(about ? { about } : {}), ...(colour ? { colour } : {}), tree }, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// A notebook's line and colour

/** The longest line about what a notebook is for; GitHub cuts a repo's description at 350. */
export const MAX_ABOUT = 300;
/** The longest notebook title; GitHub allows 100 characters in a repo name, and IDs are cut to 60. */
export const MAX_NOTEBOOK_TITLE = 100;

/** A notebook's title as it is kept: one line, trimmed. */
export function notebookTitle(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The permanent ID a new notebook gets from its title: its slug (`notebook` when the title has no
 * Latin letters or digits), then -2, -3… while `taken`, within 60 characters. The library makes
 * IDs with this, and New notebook shows the one it will get.
 */
export function notebookId(title: string, taken: (id: string) => boolean): string {
  const base = slugify(notebookTitle(title)) || 'notebook';
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '' : `-${n}`;
    const id = `${base.slice(0, MAX_ID_LENGTH - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!taken(id)) return id;
  }
}

/** A line about a notebook as it is kept: one line, trimmed and cut to MAX_ABOUT, or "" for none. */
export function aboutLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_ABOUT).trim();
}

/**
 * The colours offered for notebooks, picked to stay readable as covers and tabs on the light page
 * and the dark panel. Violet is left out on purpose: in Quillipi it always means an AI.
 */
export const NOTEBOOK_COLOURS = ['#2f5bd3', '#0f8b8d', '#2e8b57', '#7a8a2e', '#c98a1b', '#d0652a', '#c4413b', '#c2477f', '#56657a', '#8a5a3c'] as const;

export function isNotebookColour(value: string): boolean {
  return /^#[0-9a-f]{6}$/.test(value);
}

/** The colour a notebook gets when none is chosen: always the same for the same ID. */
export function colourFor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return NOTEBOOK_COLOURS[hash % NOTEBOOK_COLOURS.length]!;
}

// ---------------------------------------------------------------------------
// Walking a tree

export interface OutlineEntry {
  /** A section's ID, or for a folder its path. */
  key: string;
  kind: 'section' | 'folder';
  /** The folder it is in, as a path; "" for the top. */
  in: string;
  depth: number;
  /** A folder's display name. */
  name?: string;
}

export function joinPath(folder: string, name: string): string {
  return folder ? `${folder}/${name}` : name;
}

/** Every folder and section, top to bottom, as a tree view lists them. */
export function outline(tree: readonly TreeItem[]): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  const walk = (items: readonly TreeItem[], path: string, depth: number) => {
    for (const item of items) {
      if (typeof item === 'string') {
        entries.push({ key: item, kind: 'section', in: path, depth });
      } else {
        const inner = joinPath(path, item.folder);
        entries.push({ key: inner, kind: 'folder', in: path, depth, name: item.name });
        walk(item.items, inner, depth + 1);
      }
    }
  };
  walk(tree, '', 0);
  return entries;
}

/** Which folder each section is in, in tree order. */
export function sectionPlaces(tree: readonly TreeItem[]): Map<string, string> {
  return new Map(outline(tree).flatMap((entry) => (entry.kind === 'section' ? [[entry.key, entry.in] as const] : [])));
}

/** Every folder's display name, by path. */
export function folderNames(tree: readonly TreeItem[]): Map<string, string> {
  return new Map(outline(tree).flatMap((entry) => (entry.kind === 'folder' ? [[entry.key, entry.name!] as const] : [])));
}

/** The items of the folder at `path` ("" for the top), or undefined if there is no such folder. */
export function folderItems(tree: TreeItem[], path: string): TreeItem[] | undefined {
  let items = tree;
  for (const segment of path ? path.split('/') : []) {
    const folder = items.find((item): item is TreeFolder => typeof item !== 'string' && item.folder === segment);
    if (!folder) return undefined;
    items = folder.items;
  }
  return items;
}

export function cloneTree(tree: readonly TreeItem[]): TreeItem[] {
  return tree.map((item) => (typeof item === 'string' ? item : { ...item, items: cloneTree(item.items) }));
}

/** The tree with only the sections in `keep`. Folders stay, even when they end up empty. */
export function pruneTree(tree: readonly TreeItem[], keep: ReadonlySet<string>): TreeItem[] {
  return tree.flatMap((item): TreeItem[] => (typeof item === 'string' ? (keep.has(item) ? [item] : []) : [{ ...item, items: pruneTree(item.items, keep) }]));
}

export function sameTree(a: readonly TreeItem[], b: readonly TreeItem[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The tree for the sections that exist: `wanted` gives the order, the folders and their names;
 * `where` gives each section that exists and the folder its file is in. A section stays where
 * `wanted` has it when that is the folder its file is in. Any other section goes at the end of its
 * folder, in the order of `where`, with folders made as needed, named from `names` or after their
 * directory. Folders in `wanted` stay, even empty ones.
 */
export function placeTree(wanted: readonly TreeItem[], where: ReadonlyMap<string, string>, names: ReadonlyMap<string, string> = new Map()): TreeItem[] {
  const placed = new Set<string>();
  const keep = (items: readonly TreeItem[], path: string): TreeItem[] => {
    const kept: TreeItem[] = [];
    const folders = new Set<string>();
    for (const item of items) {
      if (typeof item === 'string') {
        if (where.get(item) === path && !placed.has(item)) {
          placed.add(item);
          kept.push(item);
        }
      } else if (!folders.has(item.folder)) {
        folders.add(item.folder);
        kept.push({ folder: item.folder, name: item.name, items: keep(item.items, joinPath(path, item.folder)) });
      }
    }
    return kept;
  };
  const tree = keep(wanted, '');
  for (const [id, path] of where) {
    if (placed.has(id)) continue;
    placed.add(id);
    makeFolder(tree, path, names).push(id);
  }
  return tree;
}

/** The items of the folder at `path`, making it and any folder above it that is missing. */
export function makeFolder(tree: TreeItem[], path: string, names: ReadonlyMap<string, string> = new Map()): TreeItem[] {
  let items = tree;
  let at = '';
  for (const segment of path ? path.split('/') : []) {
    at = joinPath(at, segment);
    let folder = items.find((item): item is TreeFolder => typeof item !== 'string' && item.folder === segment);
    if (!folder) {
      folder = { folder: segment, name: names.get(at) ?? titleCase(segment), items: [] };
      items.push(folder);
    }
    items = folder.items;
  }
  return items;
}

// ---------------------------------------------------------------------------
// From nested sections to folders, once

export interface UpgradedSection {
  /** The section's permanent ID. */
  id: string;
  /** The folder its file goes in. */
  folder: string;
}

/**
 * Before folders, a section's ID was its path, such as `product/pricing`, and a section could have
 * sections under it. Each now gets a permanent ID from its file name (`pricing`; `pricing-2` when
 * two files share a name, in sorted order) and keeps its directory as its folder. A section with
 * sections under it moves into the folder they make, so the folder holds it and them together.
 * The same old IDs always give the same result, so the last commit and the working files agree.
 * `inUse` holds IDs that files already have, which the new ones must not repeat.
 */
export function upgradeIds(oldIds: readonly string[], inUse: ReadonlySet<string> = new Set()): Map<string, UpgradedSection> {
  const sorted = [...new Set(oldIds)].sort();
  const parents = new Set(sorted.filter((id) => sorted.some((other) => other.startsWith(`${id}/`))));
  const taken = new Set(inUse);
  const upgraded = new Map<string, UpgradedSection>();
  for (const old of sorted) {
    const slash = old.lastIndexOf('/');
    const id = uniqueName(slugify(old.slice(slash + 1)) || 'untitled', (name) => taken.has(name));
    taken.add(id);
    upgraded.set(old, { id, folder: parents.has(old) ? old : slash < 0 ? '' : old.slice(0, slash) });
  }
  return upgraded;
}

/**
 * The tree for upgraded sections: `order` is the old order of their old IDs. A folder made from a
 * section takes its title, from `titles`; other folders are named after their directory.
 */
export function upgradeTree(order: readonly string[], upgraded: ReadonlyMap<string, UpgradedSection>, titles: ReadonlyMap<string, string>): TreeItem[] {
  const listed = [...new Set(order.filter((old) => upgraded.has(old)))];
  for (const old of [...upgraded.keys()].sort()) if (!listed.includes(old)) listed.push(old);
  const names = new Map<string, string>();
  for (const [old, { folder }] of upgraded) if (folder === old && titles.get(old)) names.set(folder, titles.get(old)!);
  return placeTree([], new Map(listed.map((old) => [upgraded.get(old)!.id, upgraded.get(old)!.folder])), names);
}
