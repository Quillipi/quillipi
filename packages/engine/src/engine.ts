/**
 * The engine owns one notebook. It keeps every section in memory and is the only writer, so the
 * editor, AI agents and the disk never race. Read "How a change flows" in docs/ARCHITECTURE.md first.
 *
 * Sections are known by permanent IDs, kept in their files' front matter, so a section can move
 * between folders without breaking anything that names it. Folders are directories under
 * `sections/`; inklog.json adds their names and the order (core/layout.ts).
 */
import {
  type Activity,
  type Actor,
  type Author,
  type Block,
  type CanvasElement,
  type CommitDetails,
  type CommitSection,
  type CommitSummary,
  type HeldChange,
  MAX_NOTEBOOK_TITLE,
  aboutLine,
  isNotebookColour,
  notebookTitle,
  type NotebookMeta,
  type PatchOp,
  type PendingChange,
  type RepoInfo,
  type SaveReply,
  type Section,
  type SectionData,
  type TreeItem,
  DEFAULT_ASPECT,
  INSTRUCTIONS_CHANGE,
  LAYOUT_CHANGE,
  MAX_INSTRUCTIONS,
  addFrontMatterId,
  applyPatch,
  byId,
  canvasElements,
  cloneTree,
  countChanges,
  diffBlocks,
  folderItems,
  folderNames,
  frontMatterId,
  isReservedName,
  joinPath,
  mergeBlocks,
  metaFile,
  newId,
  outline,
  parseMeta,
  detailsOf,
  type NotebookDetails,
  parseSection,
  readInstructions,
  renderInstructions,
  placeTree,
  plainInline,
  pruneTree,
  relatedBlocks,
  removalKey,
  renderCanvasSvg,
  renderHits,
  restoreIds,
  reviewReasons,
  sameBlocks,
  sameContent,
  sameTree,
  sectionPlaces,
  sectionTitle,
  serializeSection,
  slugify,
  stagedBlocks,
  textFingerprint,
  titleCase,
  uniqueName,
  upgradeIds,
  upgradeTree,
  withFrontMatterId,
  writeInstructions,
} from '@inklog/core';
import { digestHex } from './digest.js';
import { Emitter } from './emitter.js';
import { type FileChanges, LAYOUT, type NotebookStore } from './store.js';

/** Versions kept per section, so an editor save based on a recent one can still be merged. */
const KEPT_VERSIONS = 50;
/** Delay after the last change before a section is written to disk. */
const WRITE_DELAY_MS = 300;
/** How long after a person types in a block agents must leave it alone. */
const TYPING_GUARD_MS = 4000;
/**
 * The longest path Quillipi makes for a section file. With a notebook folder such as
 * `C:\Users\<you>\Documents\<notebook>\` in front, it stays inside Windows' 260-character limit.
 */
const MAX_PATH = 180;
const STATE_FILE = `${LAYOUT.local}/state.json`;
const AGENT_TRAILER = /\n\nInkLog-Agent: (.+)$/;
const UPGRADE_MESSAGE = 'Upgrade to folders: a permanent ID in every section, and the folders in inklog.json';
/** The arrangement's pending change, as `section key`. */
const LAYOUT_KEY = `${LAYOUT_CHANGE.section} ${LAYOUT_CHANGE.key}`;
/** The AI instructions' pending change, as `section key`. */
const INSTRUCTIONS_KEY = `${INSTRUCTIONS_CHANGE.section} ${INSTRUCTIONS_CHANGE.key}`;
/** An agent that hasn't had the owner's instructions for this long gets them again with its next call. */
const INSTRUCTIONS_EVERY_MS = 30 * 60_000;
/**
 * An image no section has used for this long, and that no commit holds, is removed from the
 * working files. Not at once: a person who deletes an image can still undo that in the editor.
 */
const UNUSED_ASSET_MS = 24 * 60 * 60_000;

/**
 * A section's version names one state of its text, as `<run>.<n>`: `run` is made each time the
 * engine opens, and `n` counts the section's changes. Versions live only in memory, so when the
 * engine starts again (a restart on the laptop, or a Durable Object waking from hibernation while
 * the editor stayed connected), a version from before can never pass for one after; a save based
 * on it is answered as stale instead of being merged against the wrong text.
 */
interface SectionState {
  blocks: Block[];
  /** The file's front matter, which always holds the section's ID. */
  frontMatter: string;
  changes: number;
  version: string;
  /** Recent versions and their blocks, so a save based on one of them can be merged. */
  versions: Map<string, Block[]>;
}

/** Local, uncommitted bookkeeping, kept in .inklog/state.json. */
interface LocalState {
  /** Who changed each block since the last commit: section → block ID → authors. */
  touches: Record<string, Record<string, Author[]>>;
  /** Who changed the arrangement (folders, their names, the order) since the last commit. */
  layout?: Author[];
  /** Changes the person left out of their next commit, as `section key`. */
  excluded: string[];
  held: HeldChange[];
  /** The commit each agent saw on its last visit. */
  seen: Record<string, string>;
  /** When each agent last got the owner's instructions, and which version of them. */
  instructed?: Record<string, { at: number; version: string }>;
  /** Images in assets/ that no section uses and no commit holds, with when that was first seen. */
  unusedAssets?: Record<string, number>;
  /** When the person last opened the notebook, for the bell's "since your last visit". */
  visited?: number;
  /** The agent that used the tools last, and when, for Home's status card. */
  lastAgent?: { agent: string; at: number };
}

/** Every section of one commit: their blocks and their files, by section ID. */
interface Snapshot {
  sections: Map<string, Block[]>;
  files: Map<string, string>;
}

/** An agent's ops for one section. */
export interface SectionEdit {
  path: string;
  ops: PatchOp[];
}

export interface SectionEvent {
  id: string;
  version: string;
  blocks: Block[];
  actor: Actor;
}

/**
 * One change to the arrangement. A folder is named by its path, such as `product/research`, and
 * `""` is the top. `after` is a section ID or folder path in the target folder to go after: null
 * for first, left out for last. In `move`, a path ending in `/` names a folder.
 */
export type OrganizeOp =
  | { op: 'section'; title: string; in?: string; after?: string | null }
  | { op: 'folder'; name: string; in?: string; after?: string | null }
  | { op: 'move'; id: string; to?: string; after?: string | null }
  | { op: 'rename'; folder: string; name: string };

export interface Organized {
  /** What each op did, one line each. */
  lines: string[];
  /** The sections it made, by ID, in order. */
  created: string[];
}

export class Engine extends Emitter<{ section: [SectionEvent]; repo: [] }> {
  private sections = new Map<string, SectionState>();
  /** Where each section's file is now, such as `sections/research/pricing.md`. */
  private files = new Map<string, string>();
  /** Section blocks as last read from or written to disk: the base for merging outside edits. */
  private onDisk = new Map<string, Block[]>();
  private tree: TreeItem[] = [];
  private head?: string;
  private headSections = new Map<string, Block[]>();
  private headFiles = new Map<string, string>();
  private headTree: TreeItem[] = [];
  private headMeta?: string;
  /** AGENTS.md now and at HEAD: Quillipi's guide, then the owner's instructions for this notebook. */
  private agents?: string;
  private headAgents?: string;
  private commits: CommitSummary[] = [];
  /** Each commit's first parent, for following a section back through history. */
  private parents = new Map<string, string | undefined>();
  private snapshots = new Map<string, Snapshot>();
  /** What each commit changed, once it has been asked for (commitDetails). */
  private commitDetailsKept = new Map<string, CommitDetails>();
  private state: LocalState = { touches: {}, excluded: [], held: [], seen: {} };
  private person = { name: 'You', email: 'you@localhost' };
  /** Every block ID in use, now or at HEAD, so new IDs never collide. */
  private taken = new Set<string>();
  /** Content Quillipi last wrote to each file, to tell its own writes from outside edits. */
  private written = new Map<string, string>();
  private typing = new Map<string, number>();
  private writeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private repoTimer?: ReturnType<typeof setTimeout>;
  private agentsSeen = new Map<string, number>();
  private activity: Activity[] = [];
  /** Commits run one at a time. */
  private committing: Promise<unknown> = Promise.resolve();
  /** This run of the engine; the first part of every section version. */
  private readonly run = newId();

  private constructor(
    readonly repo: NotebookStore,
    /** What inklog.json says about the notebook: its name, and its line and colour if it has them. */
    private notebook: NotebookDetails,
  ) {
    super();
  }

  get name(): string {
    return this.notebook.name;
  }

  /** The notebook's name, its line about what it is for, and its colour. */
  details(): NotebookDetails {
    return { ...this.notebook };
  }

  /** Opens the notebook in a store. On a laptop, openFolder (setup.ts) does this for a folder. */
  static async fromStore(store: NotebookStore, fallbackName = 'notebook'): Promise<Engine> {
    const metaText = await store.read(LAYOUT.meta);
    if (metaText === undefined) throw new Error('This is not a Quillipi notebook: it has no inklog.json.');
    const meta = parseMeta(metaText);
    const engine = new Engine(store, detailsOf(meta, fallbackName));
    await engine.load(meta);
    return engine;
  }

  private async load(meta: NotebookMeta): Promise<void> {
    this.person = await this.repo.person();
    this.state = { ...this.state, ...readState(await this.repo.read(STATE_FILE)) };
    await this.loadHead();
    if (meta.tree === undefined || (this.head && parseMeta(this.headMeta).tree === undefined)) await this.upgrade(meta);
    await this.loadFiles();
    const metaText = (await this.repo.read(LAYOUT.meta)) ?? '';
    this.tree = placeTree(parseMeta(metaText).tree ?? [], this.places());
    this.written.set(LAYOUT.meta, metaText);
    await this.writeMeta();
    this.agents = await this.repo.read(LAYOUT.agents);
    if (this.agents !== undefined) this.written.set(LAYOUT.agents, this.agents);
    await this.tidyAssets();
  }

  /**
   * Reads every section file. Its ID comes from its front matter; a file without one, or with an
   * ID another file already has (a copy), gets one from its file name, written into it once, the
   * way blocks without IDs get theirs.
   */
  private async loadFiles(): Promise<void> {
    const sources = new Map<string, { text: string; section: Section }>();
    for (const rel of await this.repo.list(LAYOUT.sections, '.md')) {
      const text = (await this.repo.read(rel)) ?? '';
      sources.set(rel, { text, section: parseSection(text) });
    }
    const ids = assignIds([...sources].map(([rel, { section }]) => [rel, frontMatterId(section.frontMatter)]), this.headFiles);
    for (const [rel, id] of ids) {
      const { text, section } = sources.get(rel)!;
      const read = await this.readSection(section, id, this.headSections.get(id) ?? [], (src) => this.repo.read(src));
      this.sections.set(id, this.newState(read.blocks, read.frontMatter));
      this.files.set(id, rel);
      this.onDisk.set(id, read.blocks);
      this.written.set(rel, text);
      // Files written by other tools are rewritten once in Quillipi's format, which adds IDs.
      if (serializeSection(read) !== text) this.scheduleWrite(id);
    }
  }

  private async loadHead(): Promise<void> {
    await this.loadHistory();
    const head = this.head ? await this.snapshotOf(this.head) : undefined;
    // Copies: commits change these in place, and the snapshot of this commit must not change with them.
    this.headSections = new Map(head?.sections);
    this.headFiles = new Map(head?.files);
    this.headTree = placeTree(parseMeta(this.headMeta).tree ?? [], placesOf(this.headFiles));
  }

  /** The latest commit and the list of commits. */
  private async loadHistory(): Promise<void> {
    this.head = await this.repo.head();
    this.headMeta = this.head ? await this.repo.readAt(this.head, LAYOUT.meta) : undefined;
    this.headAgents = this.head ? await this.repo.readAt(this.head, LAYOUT.agents) : undefined;
    const records = await this.repo.log();
    this.parents = new Map(records.map((record) => [record.oid, record.parent]));
    this.commits = records.map((record, index) => {
      const agent = AGENT_TRAILER.exec(record.message)?.[1];
      const message = record.message.replace(AGENT_TRAILER, '');
      return { oid: record.oid, number: records.length - index, message, author: record.author, at: record.at, ...(agent ? { agent } : {}) };
    });
  }

  /**
   * Notebooks from before folders named a section by its path and listed the order as `sections`
   * in inklog.json. This gives every section its permanent ID and turns directories into folders
   * (upgradeIds in core/layout.ts): first in one commit made from the last commit's files, so
   * uncommitted work stays uncommitted, then in the working files; local state follows the new IDs.
   * Both sides use the same old IDs, so they get the same new ones.
   */
  private async upgrade(meta: NotebookMeta): Promise<void> {
    const headMeta = parseMeta(this.headMeta);
    const headRels = this.head && headMeta.tree === undefined ? [...this.headFiles.values()] : [];
    const texts = new Map<string, string>();
    for (const rel of meta.tree === undefined ? await this.repo.list(LAYOUT.sections, '.md') : []) texts.set(rel, (await this.repo.read(rel)) ?? '');
    // Working files that already have an ID keep it and stay put, so running this again (say an
    // older Quillipi still running wrote the old inklog.json back) changes nothing it did before.
    const hasId = new Map([...texts].map(([rel, text]) => [rel, frontMatterId(parseSection(text).frontMatter)]));
    const workRels = [...texts.keys()].filter((rel) => !hasId.get(rel));
    const upgraded = upgradeIds([...headRels, ...workRels].map(oldIdOf), new Set([...hasId.values()].filter((id) => id !== undefined)));
    const headTexts = new Map<string, string>();
    for (const rel of headRels) headTexts.set(rel, (await this.repo.readAt(this.head!, rel)) ?? '');
    const titles = new Map<string, string>();
    for (const [rel, text] of [...texts, ...headTexts]) titles.set(oldIdOf(rel), sectionTitle(parseSection(text).blocks));

    // Files keep their names and places, so old names, which were paths, still find them. Only a
    // section with sections under it moves, into the folder they make, keeping its name if it is free there.
    const taken = new Set([...headRels, ...texts.keys()]);
    const targets = new Map<string, string>();
    for (const [old, { id, folder }] of upgraded) {
      const rel = sectionFile('', old);
      if (folder !== old) {
        targets.set(old, rel);
        continue;
      }
      const name = uniqueName(old.slice(old.lastIndexOf('/') + 1), (candidate) => taken.has(sectionFile(folder, candidate)));
      taken.add(sectionFile(folder, name));
      targets.set(old, sectionFile(folder, name));
    }
    const moved = (rels: readonly string[], text: (rel: string) => string) => {
      const writes = new Map<string, string>();
      for (const rel of rels) writes.set(targets.get(oldIdOf(rel))!, addFrontMatterId(text(rel), upgraded.get(oldIdOf(rel))!.id));
      // Paths that one file leaves and another takes are written, not removed.
      return { writes, removals: rels.filter((rel) => !writes.has(rel)) };
    };
    const only = (rels: readonly string[]) => new Map(rels.map((rel) => [oldIdOf(rel), upgraded.get(oldIdOf(rel))!]));

    if (headRels.length || (this.head && headMeta.tree === undefined)) {
      const { writes, removals } = moved(headRels, (rel) => headTexts.get(rel)!);
      const changes: FileChanges = new Map(writes);
      for (const rel of removals) changes.set(rel, null);
      changes.set(LAYOUT.meta, metaFile(detailsOf(headMeta, this.name), upgradeTree(headMeta.sections ?? [], only(headRels), titles)));
      await this.repo.commit(changes, UPGRADE_MESSAGE, this.person);
      await this.loadHead();
    }
    if (meta.tree === undefined) {
      const { writes, removals } = moved(workRels, (rel) => texts.get(rel)!);
      // New files first and the old ones last, so a stop halfway loses nothing.
      for (const [rel, text] of writes) await this.repo.write(rel, text);
      // With no file left to upgrade, the old order names paths that are gone; the upgraded last commit has the order.
      const tree = workRels.length ? upgradeTree(meta.sections ?? [], only(workRels), titles) : this.headTree;
      await this.repo.write(LAYOUT.meta, metaFile(detailsOf(meta, this.name), tree));
      for (const rel of removals) await this.repo.remove(rel);
    }
    const renamed = (old: string) => upgraded.get(old)?.id ?? old;
    this.state.touches = Object.fromEntries(Object.entries(this.state.touches).map(([old, touches]) => [renamed(old), touches]));
    this.state.excluded = this.state.excluded.map((full) => {
      const space = full.indexOf(' ');
      return space < 0 ? full : `${renamed(full.slice(0, space))}${full.slice(space)}`;
    });
    this.state.held = this.state.held.map((held) => ({ ...held, section: renamed(held.section) }));
    this.repoChanged();
  }

  /** Reads a parsed section file: restores missing block IDs from `previous`, loads canvases, and puts its ID in its front matter. */
  private async readSection(section: Section, id: string, previous: readonly Block[], read: (rel: string) => Promise<string | undefined>): Promise<Section & { frontMatter: string }> {
    const blocks = restoreIds(section.blocks, previous, this.taken);
    for (const block of blocks) {
      this.taken.add(block.id);
      if (block.type !== 'canvas') continue;
      const { src, ...attrs } = block.attrs ?? {};
      const json = src ? await read(src.replace(/\.svg$/, '.json')) : undefined;
      block.attrs = { ...attrs, elements: parseCanvasFile(json) };
    }
    return { blocks, frontMatter: withFrontMatterId(section.frontMatter, id) };
  }

  private newState(blocks: Block[], frontMatter: string): SectionState {
    const version = `${this.run}.1`;
    return { blocks, frontMatter, changes: 1, version, versions: new Map([[version, blocks]]) };
  }

  // ---------------------------------------------------------------------------
  // Reading

  info(): RepoInfo {
    const cutoff = Date.now() - 15 * 60_000;
    return {
      name: this.name,
      ...(this.notebook.about ? { about: this.notebook.about } : {}),
      ...(this.notebook.colour ? { colour: this.notebook.colour } : {}),
      person: this.person,
      sections: outline(this.tree).flatMap((entry) =>
        entry.kind === 'section' ? [{ id: entry.key, title: sectionTitle(this.sections.get(entry.key)?.blocks ?? []) || entry.key, folder: entry.in, depth: entry.depth }] : [],
      ),
      tree: cloneTree(this.tree),
      commits: this.commits,
      pending: this.pending(),
      held: this.state.held,
      activity: this.activity.slice(-50),
      agents: [...this.agentsSeen].filter(([, at]) => at > cutoff).map(([agent]) => agent),
    };
  }

  /** Every section, in tree order. */
  sectionIds(): string[] {
    return [...sectionPlaces(this.tree).keys()];
  }

  section(id: string): SectionData | undefined {
    const section = this.sections.get(id);
    return section && { version: section.version, blocks: section.blocks, head: this.headSections.get(id) ?? [] };
  }

  /**
   * The section a name points to: its ID, or its file's path, such as `research/pricing` (with or
   * without `sections/` and `.md`), which is what IDs looked like before folders, so old names in
   * notes and chats keep working while the file is where it was. Sections only in the last commit
   * count too, so their history can be asked for.
   */
  resolveSection(ref: string): string | undefined {
    const name = ref.trim().replace(/^\^/, '');
    const known = (id: string) => this.sections.has(id) || this.headFiles.has(id);
    if (known(name)) return name;
    if (known(name.toLowerCase())) return name.toLowerCase();
    const rel = `${LAYOUT.sections}/${name.replace(/^\/+/, '').replace(/^sections\//, '').replace(/\.md$/, '')}.md`;
    return idAt(this.files, rel) ?? idAt(this.headFiles, rel);
  }

  commitList(): CommitSummary[] {
    return this.commits;
  }

  /** Every section as it was at a commit, by ID. */
  async snapshot(commit: string): Promise<Map<string, Block[]>> {
    return (await this.snapshotOf(commit)).sections;
  }

  /** The folder each section is in, now or at a commit. */
  async sectionFolders(commit?: string): Promise<Map<string, string>> {
    return placesOf(commit ? (await this.snapshotOf(commit)).files : this.files);
  }

  private async snapshotOf(commit: string): Promise<Snapshot> {
    const cached = this.snapshots.get(commit);
    if (cached) return cached;
    const rels = [...(await this.repo.filesAt(commit)).keys()].filter(isSectionFile).sort();
    const sources = new Map<string, Section>();
    for (const rel of rels) sources.set(rel, parseSection((await this.repo.readAt(commit, rel)) ?? ''));
    // Commits from before folders have no IDs in their files; they get the IDs the upgrade gives them.
    const legacy = parseMeta(await this.repo.readAt(commit, LAYOUT.meta)).tree === undefined;
    const upgraded = legacy ? upgradeIds(rels.map(oldIdOf)) : undefined;
    const ids = upgraded
      ? new Map(rels.map((rel) => [rel, upgraded.get(oldIdOf(rel))!.id]))
      : assignIds(rels.map((rel) => [rel, frontMatterId(sources.get(rel)!.frontMatter)]));
    const snapshot: Snapshot = { sections: new Map(), files: new Map() };
    for (const [rel, id] of ids) {
      const read = await this.readSection(sources.get(rel)!, id, [], (src) => this.repo.readAt(commit, src));
      snapshot.sections.set(id, read.blocks);
      snapshot.files.set(id, rel);
    }
    this.snapshots.set(commit, snapshot);
    return snapshot;
  }

  /** Changes since HEAD, with who made them and whether the next commit includes them. */
  pending(): PendingChange[] {
    const held = new Set(this.state.held.flatMap((item) => item.keys.map((key) => `${item.section} ${key}`)));
    const excluded = new Set(this.state.excluded);
    const changes: PendingChange[] = [];
    const add = (section: string, key: string, change: PendingChange['change']) => {
      const full = `${section} ${key}`;
      const by = this.state.touches[section]?.[blockIdOf(key)] ?? ['person'];
      changes.push({ section, key, change, by, held: held.has(full), included: !held.has(full) && !excluded.has(full) });
    };
    for (const id of this.allSectionIds()) {
      const diff = diffBlocks(this.headSections.get(id) ?? [], this.sections.get(id)?.blocks ?? []);
      for (const [blockId, change] of diff.changes) add(id, blockId, change);
      for (const removal of diff.removed) for (const block of removal.blocks) add(id, removalKey(block.id), 'removed');
    }
    if (this.layoutChanged()) {
      changes.push({ ...LAYOUT_CHANGE, change: 'moved', by: this.state.layout ?? ['person'], held: false, included: !excluded.has(LAYOUT_KEY) });
    }
    if (this.agents !== this.headAgents) {
      const change = this.headAgents === undefined ? 'added' : this.agents === undefined ? 'removed' : 'modified';
      changes.push({ ...INSTRUCTIONS_CHANGE, change, by: ['person'], held: false, included: !excluded.has(INSTRUCTIONS_KEY) });
    }
    return changes;
  }

  /**
   * Whether the arrangement differs from the last commit for the sections in both: where their
   * files are, their order, and the folders with their names. A section that is new or deleted
   * isn't an arrangement change; it comes and goes with its text.
   */
  private layoutChanged(): boolean {
    const both = new Set([...this.files.keys()].filter((id) => this.headFiles.has(id)));
    for (const id of both) if (this.files.get(id) !== this.headFiles.get(id)) return true;
    return !sameTree(pruneTree(this.tree, both), pruneTree(this.headTree, both));
  }

  /**
   * Commits that changed a section, newest first. It follows the section's ID back through moves,
   * where a path-based history (like Git without --follow) would stop.
   */
  async sectionHistory(id: string, limit: number): Promise<CommitSummary[]> {
    const listed = new Map<string, Map<string, string>>();
    const filesAt = async (oid: string) => {
      if (!listed.has(oid)) listed.set(oid, await this.repo.filesAt(oid));
      return listed.get(oid)!;
    };
    const found: CommitSummary[] = [];
    let rel = this.headFiles.get(id);
    for (let oid = this.head; oid && rel && found.length < limit; ) {
      const parent = this.parents.get(oid);
      const blob = (await filesAt(oid)).get(rel);
      if (blob === undefined) break;
      const before = parent ? await filesAt(parent) : new Map<string, string>();
      if (before.get(rel) !== blob) {
        const commit = this.commits.find((candidate) => candidate.oid === oid);
        if (commit) found.push(commit);
        // It arrived at this path here: moved from where the parent had it, or new.
        if (!before.has(rel)) rel = parent ? (await this.snapshotOf(parent)).files.get(id) : undefined;
      }
      oid = parent;
    }
    return found;
  }

  /**
   * The last commit that changed each section, by ID, for the notebook's overview, like the
   * commit beside each file on a repository's page on GitHub. A move counts as a change. One walk
   * back through history, stopping as soon as every section has its commit, so it costs little
   * in a notebook whose sections were all edited lately.
   */
  async lastCommits(): Promise<Map<string, CommitSummary>> {
    const found = new Map<string, CommitSummary>();
    // Each section's file at the commit being looked at; a section new since the last commit has none.
    let rels = new Map([...this.headFiles].filter(([id]) => this.sections.has(id)));
    for (let oid = this.head; oid && rels.size; ) {
      const parent = this.parents.get(oid);
      const files = await this.repo.filesAt(oid);
      const before = parent ? await this.repo.filesAt(parent) : new Map<string, string>();
      const commit = this.commits.find((candidate) => candidate.oid === oid);
      const next = new Map<string, string>();
      for (const [id, rel] of rels) {
        // Unchanged here; a section that arrived at this path (new or moved) has none in the parent.
        if (before.get(rel) === files.get(rel)) next.set(id, rel);
        else if (commit) found.set(id, commit);
      }
      rels = next;
      oid = parent;
    }
    return found;
  }

  /**
   * What a commit changed, section by section, for the History panel: each section it touched with
   * how many blocks it added, edited, moved and removed, and whether it changed the arrangement,
   * the AI instructions or the notebook's own details. A commit never changes, so the answer is
   * kept for as long as the engine runs.
   */
  async commitDetails(ref: string): Promise<CommitDetails> {
    const oid = this.resolveCommit(ref);
    if (!oid || !this.parents.has(oid)) throw new UserError(`No commit "${ref}". Use a number from history, such as #3.`);
    const kept = this.commitDetailsKept.get(oid);
    if (kept) return kept;

    const parent = this.parents.get(oid);
    const after = await this.snapshotOf(oid);
    const before: Snapshot = parent ? await this.snapshotOf(parent) : { sections: new Map(), files: new Map() };
    const [foldersAfter, foldersBefore] = [placesOf(after.files), placesOf(before.files)];
    const sections: CommitSection[] = [];
    // In the order the commit left them, then the sections it deleted.
    for (const id of new Set([...after.sections.keys(), ...before.sections.keys()])) {
      const was = before.sections.get(id);
      const made = after.sections.get(id);
      const moved = was !== undefined && made !== undefined && foldersBefore.get(id) !== foldersAfter.get(id);
      const counts = countChanges(diffBlocks(was ?? [], made ?? []));
      if (was && made && !moved && !counts.added && !counts.modified && !counts.moved && !counts.removed) continue;
      const what = !was ? 'made' : !made ? 'deleted' : moved ? 'moved' : undefined;
      sections.push({
        id,
        title: sectionTitle(made ?? was ?? []) || id,
        folder: (made ? foldersAfter.get(id) : foldersBefore.get(id)) ?? '',
        added: counts.added,
        edited: counts.modified,
        moved: counts.moved,
        removed: counts.removed,
        ...(what ? { what } : {}),
      });
    }

    const read = (commit: string | undefined, rel: string) => (commit ? this.repo.readAt(commit, rel) : Promise.resolve(undefined));
    const [metaAfter, metaBefore] = [parseMeta(await read(oid, LAYOUT.meta)), parseMeta(await read(parent, LAYOUT.meta))];
    const [treeAfter, treeBefore] = [await this.treeAt(oid, after), parent ? await this.treeAt(parent, before) : undefined];
    // Compared for the sections in both, as the arrangement's own pending change is: a new or deleted section isn't a rearrangement.
    const both = new Set([...after.files.keys()].filter((id) => before.files.has(id)));
    const layout =
      treeAfter !== undefined &&
      treeBefore !== undefined &&
      (!sameTree(pruneTree(treeAfter, both), pruneTree(treeBefore, both)) || !sameNames(folderNames(treeAfter), folderNames(treeBefore)));
    const details: CommitDetails = {
      oid,
      sections,
      layout,
      instructions: parent !== undefined && readInstructions(await read(oid, LAYOUT.agents)) !== readInstructions(await read(parent, LAYOUT.agents)),
      details: parent !== undefined && (metaAfter.name !== metaBefore.name || metaAfter.about !== metaBefore.about || metaAfter.colour !== metaBefore.colour),
    };
    this.commitDetailsKept.set(oid, details);
    return details;
  }

  /** Commit hash for `#12`, `head` or a hash prefix. */
  resolveCommit(ref: string): string | undefined {
    const trimmed = ref.trim();
    if (trimmed === 'head') return this.head;
    const number = /^#?(\d+)$/.exec(trimmed)?.[1];
    if (number) return this.commits.find((commit) => commit.number === Number(number))?.oid;
    return trimmed.length >= 4 ? this.commits.find((commit) => commit.oid.startsWith(trimmed))?.oid : undefined;
  }

  // ---------------------------------------------------------------------------
  // Changes from people (the editor) and from outside tools

  /**
   * A save from the editor, based on `baseVersion` of the section. Anything that changed since
   * (an agent's edit, an outside edit) is merged in block by block; the person's version wins
   * when both changed the same block. Returns the merged blocks when they differ from the save.
   *
   * A base this engine doesn't know (from before it started, or older than the kept versions)
   * can't be merged safely, so nothing changes and the reply is stale, with the current text; the
   * editor then merges its words into that text and saves again (core/after-save.ts).
   */
  save(id: string, baseVersion: string, incoming: Block[]): SaveReply {
    const section = this.sections.get(id);
    if (!section) throw new UserError(`No section "${id}".`);
    const base = section.versions.get(baseVersion);
    if (!base) return { version: section.version, blocks: section.blocks, stale: true };
    const saved = restoreIds(incoming, section.blocks, this.taken);
    const { blocks } = mergeBlocks(base, section.blocks, saved);
    const now = Date.now();
    for (const blockId of this.update(id, blocks, { kind: 'person' })) this.typing.set(blockId, now);
    return { version: section.version, blocks: sameBlocks(blocks, saved) ? undefined : blocks };
  }

  /**
   * A section file changed on disk without Quillipi: another editor, `git pull`, a script. A new file
   * carrying the ID of a section whose own file is gone is that section, moved (as with `git mv`);
   * one carrying the ID of a section whose file is still there is a copy, and gets an ID of its own.
   * A file without an ID in its front matter is taken to carry the one its name gives.
   */
  async fileChanged(rel: string): Promise<void> {
    if (rel === LAYOUT.agents) return this.agentsChanged();
    if (!isSectionFile(rel)) return;
    const text = await this.repo.read(rel);
    if (text === this.written.get(rel)) return; // Quillipi's own write
    const known = idAt(this.files, rel);
    if (text === undefined) {
      this.written.delete(rel);
      if (known) {
        this.dropSection(known);
        await this.arrangeFromFiles();
      }
      return;
    }
    this.written.set(rel, text);
    const source = parseSection(text);
    let id = known;
    let moved = false;
    if (!id) {
      // The ID in its front matter, or else the one its name gives, as when a tool dropped the front matter.
      const claimed = frontMatterId(source.frontMatter) ?? (slugify(stemOf(rel)) || undefined);
      const elsewhere = claimed === undefined ? undefined : this.files.get(claimed);
      if (claimed && elsewhere && (await this.repo.read(elsewhere)) === undefined) {
        id = claimed;
        moved = true;
        this.written.delete(elsewhere);
        this.files.set(id, rel);
        this.touchLayout({ kind: 'person' });
      } else if (claimed && !this.files.has(claimed)) {
        id = claimed;
      } else {
        id = uniqueName(slugify(stemOf(rel)) || 'untitled', (name) => this.files.has(name) || this.sections.has(name));
      }
    }
    const existing = this.sections.get(id);
    const read = await this.readSection(source, id, existing?.blocks ?? this.headSections.get(id) ?? [], (src) => this.repo.read(src));
    if (!existing) {
      this.sections.set(id, this.newState(read.blocks, read.frontMatter));
      this.files.set(id, rel);
      this.onDisk.set(id, read.blocks);
      await this.arrangeFromFiles();
    } else {
      const { blocks } = mergeBlocks(this.onDisk.get(id) ?? existing.blocks, existing.blocks, read.blocks);
      this.onDisk.set(id, read.blocks);
      existing.frontMatter = read.frontMatter;
      this.update(id, blocks, { kind: 'person' });
      if (moved) await this.arrangeFromFiles();
    }
    // A file without its ID, or with another section's, gets the right one written back.
    if (serializeSection(read) !== text) this.scheduleWrite(id);
  }

  /** Adds a section with its title as a heading, credited to whoever made it, so an agent's commit includes it. */
  async createSection(title: string, folder = '', actor: Actor = { kind: 'person' }): Promise<string> {
    return (await this.organize([{ op: 'section', title, in: folder }], actor)).created[0]!;
  }

  /**
   * Makes sections and folders, moves them, and renames folders, all or nothing: every op is tried
   * on a copy of the arrangement, and nothing changes unless they all work. Deleting is for the
   * person only, through deleteSection and deleteFolder.
   */
  async organize(ops: readonly OrganizeOp[], actor: Actor): Promise<Organized> {
    if (!ops.length) throw new UserError('Say what to organize.');
    const plan = new Arrangement(this.tree, this.files, (id) => this.sections.has(id) || this.headFiles.has(id));
    const lines = ops.map((op, index) => {
      try {
        return plan.apply(op);
      } catch (error) {
        if (error instanceof UserError && ops.length > 1) throw new UserError(`Op ${index + 1}: ${error.message} Nothing changed.`);
        throw error;
      }
    });

    // Every change in memory happens at once, before any file is written, so a call that comes in
    // while the files are being written sees the whole arrangement or none of it.
    const moves = [...new Set(plan.moved)].filter((id) => this.files.has(id) && this.files.get(id) !== plan.files.get(id)).map((id) => [id, plan.files.get(id)!] as const);
    const left = moves.map(([id]) => this.files.get(id)!);
    for (const [id, rel] of moves) this.files.set(id, rel);
    for (const { id } of plan.created) {
      this.sections.set(id, this.newState([], withFrontMatterId(undefined, id)));
      this.files.set(id, plan.files.get(id)!);
    }
    this.tree = plan.tree;
    if (plan.arranged) this.touchLayout(actor);
    for (const { id, title } of plan.created) {
      // The title is plain text, written as the editor would write it, so it shows exactly as typed.
      const heading: Block = { id: newId(this.taken), type: 'h1', text: plainInline(title) };
      this.taken.add(heading.id);
      this.update(id, [heading], actor);
    }
    await this.writeMoves(moves.map(([id]) => id), left);
    await this.writeMeta();
    this.repoChanged();
    return { lines, created: plan.created.map(({ id }) => id) };
  }

  /** Deletes a section, as the person. Its removal is an uncommitted change like any other. */
  async deleteSection(id: string): Promise<void> {
    if (!this.files.has(id)) throw new UserError(`No section "${id}".`);
    const rel = this.dropSection(id);
    this.tree = placeTree(this.tree, this.places());
    await this.removeFiles([rel]);
    await this.arrangeFromFiles();
  }

  /** Deletes a folder and everything in it, as the person. Returns how many sections went with it. */
  async deleteFolder(ref: string): Promise<number> {
    const path = folderPathOf(ref);
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const items = folderItems(this.tree, parent);
    const at = items?.findIndex((item) => typeof item !== 'string' && joinPath(parent, item.folder) === path) ?? -1;
    if (!path || !items || at < 0) throw new UserError(`No folder "${ref}".`);
    const inside = [...this.files].filter(([, rel]) => rel.startsWith(`${LAYOUT.sections}/${path}/`)).map(([id]) => id);
    const removed = inside.map((id) => this.dropSection(id));
    items.splice(at, 1);
    this.tree = placeTree(this.tree, this.places());
    this.touchLayout({ kind: 'person' });
    await this.removeFiles(removed);
    await this.arrangeFromFiles();
    return inside.length;
  }

  /** Includes or leaves out one change from the person's next commit. */
  setIncluded(section: string, key: string, included: boolean): void {
    const full = `${section} ${key}`;
    const excluded = new Set(this.state.excluded);
    if (included) excluded.delete(full);
    else excluded.add(full);
    this.state.excluded = [...excluded];
    this.repoChanged();
  }

  /** Stores an image under a name made from its content, so the same image is stored once. */
  async addAsset(bytes: Uint8Array, extension: string): Promise<string> {
    const rel = `${LAYOUT.assets}/${(await digestHex('SHA-256', bytes)).slice(0, 16)}.${extension}`;
    if ((await this.repo.readBytes(rel)) === undefined) await this.repo.write(rel, bytes);
    return rel;
  }

  // ---------------------------------------------------------------------------
  // Changes from agents

  /** Applies an agent's patch to one section and returns the text reply for the agent. */
  agentPatch(id: string, ops: PatchOp[], agent: string): string {
    return this.agentPatchSections([{ path: id, ops }], agent).text;
  }

  /**
   * Applies an agent's edits to one or more sections, all or nothing: if any op anywhere fails,
   * no section changes. Several entries for the same section are joined in order.
   */
  agentPatchSections(edits: readonly SectionEdit[], agent: string): { ok: boolean; text: string } {
    this.agentsSeen.set(agent, Date.now());
    const joined = new Map<string, PatchOp[]>();
    for (const { path, ops } of edits) joined.set(path, [...(joined.get(path) ?? []), ...ops]);
    const several = joined.size > 1;

    const missing = [...joined.keys()].filter((path) => !this.sections.has(path));
    if (missing.length) {
      return { ok: false, text: `✗ no section ${missing.map((path) => `"${path}"`).join(', ')}. Call map to see the sections.${several ? ' Nothing changed.' : ''}` };
    }
    const now = Date.now();
    const busy = [...joined.values()].flat().flatMap((op) => ('id' in op && now - (this.typing.get(op.id) ?? 0) < TYPING_GUARD_MS ? [`^${op.id}`] : []));
    if (busy.length) {
      return { ok: false, text: `✗ ${this.person.name} is typing in ${busy.join(', ')} right now. Nothing changed. Edit other blocks, or try again in a few seconds.` };
    }

    // Try every section on a copy of the IDs in use, so new IDs stay unique across sections and a
    // failed call reserves none of them.
    const taken = new Set(this.taken);
    const results = [...joined].map(([path, ops]) => ({ path, result: applyPatch(this.sections.get(path)!.blocks, ops, taken) }));
    const ok = results.every(({ result }) => result.ok);
    for (const { path } of results) this.logActivity(agent, `edited ${path}${ok ? '' : ' (failed)'}`);

    const lines: string[] = [];
    for (const { path, result } of results) {
      if (several) lines.push(`${path}:`);
      lines.push(...(several ? result.lines.map((line) => `  ${line}`) : result.lines));
    }
    if (!ok) {
      if (several) lines.push('Nothing changed in any section: all edits in one call apply together or not at all.');
      return { ok, text: lines.join('\n') };
    }

    for (const id of taken) this.taken.add(id);
    for (const { path, result } of results) this.update(path, result.blocks, { kind: 'agent', agent });

    const changed = results.flatMap(({ result }) => result.blocks.filter((block) => result.touched.includes(block.id)));
    const others = this.sectionIds()
      .filter((other) => !joined.has(other))
      .map((other) => ({ id: other, blocks: this.sections.get(other)?.blocks ?? [] }));
    const related = relatedBlocks(changed, others);
    if (related.length) lines.push('', renderHits('These blocks in other sections mention the same things. Check whether they need the same change:', related));
    return { ok, text: lines.join('\n') };
  }

  /**
   * Commits the agent's own changes. Blocks a person also edited are left for the person, and
   * risky changes (long deletions, big cuts) are held until the person approves them. The
   * arrangement goes in only when the agent alone changed it.
   */
  async agentCommit(message: string, agent: string): Promise<string> {
    this.agentsSeen.set(agent, Date.now());
    const pending = this.pending();
    const mine = pending.filter((change) => change.by.includes('agent') && !change.by.includes('person') && !change.held);
    const shared = pending.filter((change) => change.by.includes('agent') && change.by.includes('person'));
    const lines: string[] = [];
    const keys = new Set<string>();

    for (const section of new Set(mine.map((change) => change.section))) {
      const items = mine.filter((change) => change.section === section);
      if (section === LAYOUT_CHANGE.section) {
        for (const change of items) keys.add(`${section} ${change.key}`);
        continue;
      }
      const ids = new Set(items.map((change) => blockIdOf(change.key)));
      const reasons = reviewReasons(this.blocksAtHead(section), this.sections.get(section)?.blocks ?? [], ids);
      if (reasons.length) {
        this.state.held.push({ section, keys: items.map((change) => change.key), reasons, message, agent, at: Date.now() });
        lines.push(`⏸ held the changes to ${section} for ${this.person.name} to review: ${reasons.join('; ')}`);
      } else {
        for (const change of items) keys.add(`${section} ${change.key}`);
      }
    }

    if (keys.size) {
      const commit = await this.commitKeys(keys, message, agent);
      if (commit) lines.unshift(`✓ committed #${commit.number}: ${message}`);
    }
    if (!lines.length) lines.push('Nothing of yours to commit.');
    if (shared.length) {
      const what = shared.some((change) => change.section === LAYOUT_CHANGE.section && change.key === LAYOUT_CHANGE.key) ? ' (the folders and order among them)' : '';
      lines.push(`Left ${shared.length} change(s)${what} uncommitted for ${this.person.name}, who also made changes there.`);
    }
    this.logActivity(agent, lines[0]);
    this.repoChanged();
    return lines.join('\n');
  }

  /** Every tool call: who called, for the presence line in the editor and Home's status card. */
  noteAgentCall(agent: string): void {
    const at = Date.now();
    this.agentsSeen.set(agent, at);
    this.state.lastAgent = { agent, at };
    this.repoChanged();
  }

  /** The agent that used the tools last, and when, kept across restarts. */
  lastAgent(): { agent: string; at: number } | undefined {
    return this.state.lastAgent;
  }

  /** The person opened the notebook: returns when they did before, for the bell's "since your last visit". */
  personVisit(): number | undefined {
    const before = this.state.visited;
    this.state.visited = Date.now();
    this.repoChanged();
    return before;
  }

  noteAgentVisit(agent: string): string | undefined {
    this.agentsSeen.set(agent, Date.now());
    const previous = this.state.seen[agent];
    if (this.head) this.state.seen[agent] = this.head;
    this.repoChanged();
    return previous;
  }

  logActivity(agent: string, text: string): void {
    this.activity.push({ at: Date.now(), agent, text });
    if (this.activity.length > 200) this.activity.splice(0, this.activity.length - 200);
    this.repoChanged();
  }

  // ---------------------------------------------------------------------------
  // AI instructions (core/instructions.ts)

  /** The notebook's own AI instructions, from its AGENTS.md. */
  instructions(): string {
    return readInstructions(this.agents);
  }

  /** The owner's instructions as an agent gets them, those for every notebook first; '' when there are none. */
  instructionsText(shared?: string): string {
    return renderInstructions({ owner: this.person.name, shared, notebook: this.instructions() });
  }

  /**
   * The owner's instructions for an agent's reply, or '' when it already has them: always with map,
   * the first call of every chat, and with any other call when the agent hasn't had them for 30
   * minutes or they changed since. Kept in local state, so a cloud room waking from a nap
   * doesn't send them again.
   */
  instructionsFor(agent: string, shared: string | undefined, always: boolean): string {
    const text = this.instructionsText(shared);
    if (!text) return '';
    const version = textFingerprint(text);
    const last = this.state.instructed?.[agent];
    if (!always && last?.version === version && Date.now() - last.at < INSTRUCTIONS_EVERY_MS) return '';
    this.state.instructed = { ...this.state.instructed, [agent]: { at: Date.now(), version } };
    this.repoChanged();
    return text;
  }

  /**
   * The person sets the notebook's AI instructions; a change is uncommitted, like any other. No
   * agent tool can do this, so an AI can never rewrite its own rules.
   */
  async setInstructions(text: string): Promise<void> {
    if (text.length > MAX_INSTRUCTIONS) throw new UserError(`AI instructions can be at most ${MAX_INSTRUCTIONS} characters: they are sent with every map.`);
    const next = writeInstructions(this.agents, text);
    if (next !== this.agents) await this.writeAgents(next);
  }

  private async writeAgents(text: string | undefined): Promise<void> {
    this.agents = text;
    if (text === undefined) {
      this.written.delete(LAYOUT.agents);
      await this.repo.remove(LAYOUT.agents);
    } else {
      this.written.set(LAYOUT.agents, text);
      await this.repo.write(LAYOUT.agents, text);
    }
    this.repoChanged();
  }

  /** AGENTS.md changed on disk without Quillipi, such as edited by hand. */
  private async agentsChanged(): Promise<void> {
    const text = await this.repo.read(LAYOUT.agents);
    if (text === this.agents) return;
    this.agents = text;
    if (text === undefined) this.written.delete(LAYOUT.agents);
    else this.written.set(LAYOUT.agents, text);
    this.repoChanged();
  }

  // ---------------------------------------------------------------------------
  // The notebook's own details

  /**
   * The person renames the notebook, or changes its line or colour. These live in inklog.json, so
   * they travel with the notebook, and the change is committed at once, on its own, like renaming
   * a repository: the history says when the notebook was called what. Anything uncommitted,
   * including a change to the folders, stays uncommitted. Returns the commit, or nothing when
   * nothing changed.
   */
  async setDetails(changes: { name?: string; about?: string; colour?: string }): Promise<CommitSummary | undefined> {
    const next: NotebookDetails = { ...this.notebook };
    const said: string[] = [];
    if (changes.name !== undefined) {
      const name = notebookTitle(changes.name);
      if (!name) throw new UserError('A notebook needs a title.');
      if (name.length > MAX_NOTEBOOK_TITLE) throw new UserError(`A title can be at most ${MAX_NOTEBOOK_TITLE} characters.`);
      if (name !== next.name) said.push(`Rename the notebook to “${name}”`);
      next.name = name;
    }
    if (changes.about !== undefined) {
      const about = aboutLine(changes.about);
      if (about !== (next.about ?? '')) said.push(about ? 'Change what the notebook is for' : 'Remove the line about what the notebook is for');
      if (about) next.about = about;
      else delete next.about;
    }
    if (changes.colour !== undefined) {
      if (!isNotebookColour(changes.colour)) throw new UserError(`"${changes.colour}" is not a colour; give one as #rrggbb.`);
      if (changes.colour !== next.colour) said.push('Change the notebook’s colour');
      next.colour = changes.colour;
    }
    if (!said.length) return undefined;
    const run = this.committing.then(async () => {
      this.notebook = next;
      await this.writeMeta();
      // The last commit's tree, so a change to the folders that isn't committed stays uncommitted.
      const meta = metaFile(next, this.headTree);
      const oid = await this.repo.commit(new Map([[LAYOUT.meta, meta]]), said.join('; '), this.person);
      this.snapshots.set(oid, { sections: new Map(this.headSections), files: new Map(this.headFiles) });
      await this.loadHistory();
      this.repoChanged();
      return this.commits[0];
    });
    this.committing = run.catch(() => undefined);
    return run;
  }

  // ---------------------------------------------------------------------------
  // Commits

  /** Commits everything the person has included, except changes held for review. */
  async commit(message: string): Promise<CommitSummary | undefined> {
    const keys = new Set(this.pending().filter((change) => change.included).map((change) => `${change.section} ${change.key}`));
    return this.commitKeys(keys, message.trim() || this.draftMessage(keys));
  }

  async approveHeld(index: number): Promise<CommitSummary | undefined> {
    const held = this.state.held[index];
    if (!held) throw new UserError('That review is no longer pending.');
    this.state.held.splice(index, 1);
    return this.commitKeys(new Set(held.keys.map((key) => `${held.section} ${key}`)), held.message, held.agent);
  }

  /** Undoes the agent changes in a held review, putting those blocks back as they are at HEAD. */
  rejectHeld(index: number): void {
    const held = this.state.held[index];
    if (!held) throw new UserError('That review is no longer pending.');
    this.state.held.splice(index, 1);
    const section = this.sections.get(held.section);
    if (!section) return this.repoChanged();
    const head = this.blocksAtHead(held.section);
    const inHead = new Set(head.map((block) => block.id));
    // Reverting is a partial commit in the other direction: from the working blocks to HEAD.
    const reverse = new Set(held.keys.map((key) => (key.startsWith('removed:') ? blockIdOf(key) : inHead.has(key) ? key : removalKey(key))));
    this.update(held.section, stagedBlocks(section.blocks, head, (key) => reverse.has(key)), { kind: 'person' });
  }

  /**
   * Undo this commit: turns a commit's changes back into uncommitted changes, credited to the
   * person, to review and commit. Each section is merged three ways, with the commit as the base,
   * its parent as one side and the text now as the other, so the commit's changes are reversed
   * while anything written since stays as it is. A section the commit made goes, unless someone
   * wrote in it since; one it deleted comes back. A section it moved goes back unless something
   * moved it since, and when nothing changed the arrangement since, the order and folder names go
   * back too. Returns what was done, one line each.
   */
  async undoCommit(ref: string): Promise<string[]> {
    const oid = this.resolveCommit(ref);
    const commit = oid ? this.commits.find((candidate) => candidate.oid === oid) : undefined;
    if (!oid || !commit) throw new UserError(`No commit "${ref}". Use a number from history, such as #3.`);
    const parent = this.parents.get(oid);
    const name = `#${commit.number}`;
    if (!parent) throw new UserError(`${name} started the notebook, so there is nothing before it to go back to.`);
    if (commit.message === UPGRADE_MESSAGE) throw new UserError(`${name} upgraded the notebook to folders, which can't be undone.`);

    const before = await this.snapshotOf(parent);
    const after = await this.snapshotOf(oid);
    const trees = { before: await this.treeAt(parent, before), after: await this.treeAt(oid, after) };
    // Asked before anything changes: the order and folder names go back only if nothing changed them since.
    const arrangedSince = !trees.after || this.arrangedSince(after, trees.after);
    const lines: string[] = [];
    let notUndone = 0;

    for (const id of new Set([...after.sections.keys(), ...before.sections.keys()])) {
      const was = before.sections.get(id);
      const made = after.sections.get(id);
      if (was && made && sameBlocks(was, made)) continue;
      const now = this.sections.get(id);
      if (!now) {
        if (was && !made) lines.push(await this.restoreSection(id, was, parent, before.files.get(id)!, name));
        else if (was) lines.push(`${id} was deleted since ${name}, so it stays deleted.`);
        continue;
      }
      const { blocks } = mergeBlocks(made ?? [], was ?? [], now.blocks);
      notUndone += changesKept(was ?? [], made ?? [], blocks);
      if (!was && !blocks.length) {
        await this.deleteSection(id);
        lines.push(`Removed ${id}, which ${name} made.`);
      } else if (this.update(id, blocks, PERSON).length) {
        lines.push(`Undid ${name}'s changes to ${id}.`);
      }
    }
    if (trees.before && trees.after) lines.push(...(await this.undoArrangement(before, after, trees.before, trees.after, !arrangedSince, name)));

    const agentsBefore = await this.repo.readAt(parent, LAYOUT.agents);
    const agentsAfter = await this.repo.readAt(oid, LAYOUT.agents);
    if (agentsBefore !== agentsAfter) {
      if (this.agents !== agentsAfter) lines.push(`The AI instructions changed since ${name}, so they stay as they are.`);
      else {
        await this.writeAgents(agentsBefore);
        lines.push(`Put the AI instructions back as they were before ${name}.`);
      }
    }
    if (notUndone) lines.push(`Kept ${notUndone} block(s) that ${name} changed and that were changed again since.`);
    if (!lines.length) lines.push(`Nothing to undo: everything ${name} changed is already as it was before it.`);
    this.repoChanged();
    return lines;
  }

  /** A section a commit deleted, back where its parent had it, or beside that if the place is taken. */
  private async restoreSection(id: string, blocks: Block[], commit: string, rel: string, name: string): Promise<string> {
    const source = parseSection((await this.repo.readAt(commit, rel)) ?? '');
    const used = new Set(this.files.values());
    const folder = folderOf(rel);
    const target = used.has(rel) ? sectionFile(folder, uniqueName(stemOf(rel), (stem) => used.has(sectionFile(folder, stem)))) : rel;
    this.sections.set(id, this.newState([], withFrontMatterId(source.frontMatter, id)));
    this.files.set(id, target);
    this.update(id, blocks, PERSON);
    await this.arrangeFromFiles();
    return `Brought back ${id}, which ${name} deleted.`;
  }

  /** The tree as a commit has it, or undefined for a commit from before folders. */
  private async treeAt(commit: string, snapshot: Snapshot): Promise<TreeItem[] | undefined> {
    const tree = parseMeta(await this.repo.readAt(commit, LAYOUT.meta)).tree;
    return tree && placeTree(tree, placesOf(snapshot.files));
  }

  /** Whether the arrangement changed since a commit, for the sections in both, as layoutChanged asks of the last commit. */
  private arrangedSince(commit: Snapshot, tree: readonly TreeItem[]): boolean {
    const both = new Set([...this.files.keys()].filter((id) => commit.files.has(id)));
    for (const id of both) if (this.files.get(id) !== commit.files.get(id)) return true;
    return !sameTree(pruneTree(this.tree, both), pruneTree(tree, both)) || !sameNames(folderNames(this.tree), folderNames(tree));
  }

  /**
   * Moves sections back to the folders a commit took them from, and puts the order and folder
   * names back too when `whole`: when nothing changed them since.
   */
  private async undoArrangement(before: Snapshot, after: Snapshot, beforeTree: TreeItem[], afterTree: TreeItem[], whole: boolean, name: string): Promise<string[]> {
    const lines: string[] = [];
    const ops: OrganizeOp[] = [];
    const folders = new Set(outline(this.tree).flatMap((entry) => (entry.kind === 'folder' ? [entry.key] : [])));
    const names = folderNames(beforeTree);
    const ensure = (path: string): void => {
      if (!path || folders.has(path)) return;
      ensure(parentOf(path));
      ops.push({ op: 'folder', name: names.get(path) ?? titleCase(path.slice(path.lastIndexOf('/') + 1)), in: parentOf(path) });
      folders.add(path);
    };
    const moved: string[] = [];
    for (const [id, rel] of before.files) {
      const to = after.files.get(id);
      const now = this.files.get(id);
      if (!to || !now || folderOf(rel) === folderOf(to)) continue;
      if (folderOf(now) !== folderOf(to)) {
        lines.push(`${id} was moved again since ${name}, so it stays where it is.`);
        continue;
      }
      ensure(folderOf(rel));
      ops.push({ op: 'move', id, to: folderOf(rel) });
      moved.push(`${id} to ${where(folderOf(rel))}`);
    }
    if (ops.length) {
      try {
        await this.organize(ops, PERSON);
        lines.push(`Moved ${moved.join(', ')}.`);
      } catch (error) {
        if (!(error instanceof UserError)) throw error;
        lines.push(`Couldn't move sections back: ${error.message}`);
        return lines;
      }
    }
    const target = placeTree(beforeTree, this.places(), names);
    if (!whole) {
      if (!sameTree(beforeTree, afterTree)) lines.push(`The folders and order changed again since ${name}, so ${moved.length ? 'only the moves were undone' : 'they stay as they are'}.`);
    } else if (!sameTree(target, this.tree)) {
      this.tree = target;
      this.touchLayout(PERSON);
      await this.writeMeta();
      lines.push(`Put the folders and their order back as they were before ${name}.`);
    }
    return lines;
  }

  private commitKeys(keys: Set<string>, message: string, agent?: string): Promise<CommitSummary | undefined> {
    const run = this.committing.then(() => this.writeCommit(keys, message, agent));
    this.committing = run.catch(() => undefined);
    return run;
  }

  /**
   * Builds the commit for the included changes, writing its files directly so the working files
   * keep everything that was left out. Each section in the commit goes where the arrangement being
   * committed puts it: its file now when the arrangement is included (or unchanged), else where the
   * last commit had it; a moved section's old file goes. inklog.json gets the matching tree.
   */
  private async writeCommit(keys: Set<string>, message: string, agent?: string): Promise<CommitSummary | undefined> {
    const changes: FileChanges = new Map();
    const removed = new Set<string>();
    const committed = new Map<string, Block[]>();
    const after = new Map<string, string>();
    const layoutPending = this.layoutChanged();
    const withLayout = !layoutPending || keys.has(LAYOUT_KEY);
    const headAssets = new Set([...this.headSections.values()].flat().flatMap(assetsOf));

    for (const id of this.allSectionIds()) {
      const base = this.blocksAtHead(id);
      const section = this.sections.get(id);
      const atHead = this.headFiles.get(id);
      const staged = stagedBlocks(base, section?.blocks ?? [], (key) => keys.has(`${id} ${key}`));
      for (const block of base) {
        if (block.type === 'canvas' && !staged.some((other) => other.id === block.id)) {
          removed.add(`${LAYOUT.canvas}/${block.id}.json`);
          removed.add(`${LAYOUT.canvas}/${block.id}.svg`);
        }
      }
      // In the commit: a section from the last commit whose removal isn't committed, or one with committed text.
      if (!staged.length && !(section && atHead)) {
        if (atHead) removed.add(atHead);
        continue;
      }
      const target = withLayout ? (this.files.get(id) ?? atHead!) : (atHead ?? this.files.get(id)!);
      after.set(id, target);
      const changed = !sameBlocks(staged, base);
      if (!changed && target === atHead) continue;
      if (changed) committed.set(id, staged);
      if (atHead && atHead !== target) removed.add(atHead);
      for (const [file, content] of sectionFiles(target, staged, section?.frontMatter ?? withFrontMatterId(undefined, id))) changes.set(file, content);
      for (const src of staged.flatMap(assetsOf)) {
        const bytes = headAssets.has(src) ? undefined : await this.repo.readBytes(src);
        if (bytes) changes.set(src, bytes);
      }
    }
    // A path one section leaves and another takes is written, not removed.
    for (const rel of removed) if (!changes.has(rel)) changes.set(rel, null);
    // Taken now: the person may change the instructions again while the commit is written.
    const agents = keys.has(INSTRUCTIONS_KEY) && this.agents !== this.headAgents ? { text: this.agents } : undefined;
    if (agents) changes.set(LAYOUT.agents, agents.text ?? null);
    const tree = placeTree(withLayout ? this.tree : this.headTree, placesOf(after), folderNames(this.tree));
    const meta = metaFile(this.notebook, tree);
    if ((changes.size || (withLayout && layoutPending)) && meta !== this.headMeta) changes.set(LAYOUT.meta, meta);
    if (!changes.size) return undefined;

    const oid = await this.repo.commit(changes, agent ? `${message}\n\nInkLog-Agent: ${agent}` : message, this.person);
    for (const [id, staged] of committed) this.headSections.set(id, staged);
    for (const id of [...this.headSections.keys()]) if (!after.has(id)) this.headSections.delete(id);
    this.headFiles = after;
    this.headTree = tree;
    if (agents) this.headAgents = agents.text;
    this.snapshots.set(oid, { sections: new Map(this.headSections), files: new Map(after) });
    await this.loadHistory();
    this.forgetCommitted();
    this.repoChanged();
    await this.tidyAssets();
    return this.commits[0];
  }

  /** Drops bookkeeping for changes that are no longer pending. */
  private forgetCommitted(): void {
    const pending = new Set(this.pending().map((change) => `${change.section} ${change.key}`));
    this.state.excluded = this.state.excluded.filter((key) => pending.has(key));
    this.state.held = this.state.held.filter((item) => item.keys.some((key) => pending.has(`${item.section} ${key}`)));
    for (const [section, touches] of Object.entries(this.state.touches)) {
      for (const blockId of Object.keys(touches)) {
        if (!pending.has(`${section} ${blockId}`) && !pending.has(`${section} ${removalKey(blockId)}`)) delete touches[blockId];
      }
      if (!Object.keys(touches).length) delete this.state.touches[section];
    }
    if (!pending.has(LAYOUT_KEY)) delete this.state.layout;
  }

  private draftMessage(keys: Set<string>): string {
    // The arrangement and the instructions have no section; each is named by its own key.
    const parts = [...new Set([...keys].map((key) => (key.startsWith(' ') ? key : key.slice(0, key.indexOf(' ')))))];
    if (parts.length === 1 && parts[0] === LAYOUT_KEY) return 'Organize folders';
    const titles = parts.map((part) =>
      part === LAYOUT_KEY ? 'folders' : part === INSTRUCTIONS_KEY ? 'AI instructions' : sectionTitle(this.sections.get(part)?.blocks ?? []) || part,
    );
    return `Update ${titles.slice(0, 3).join(', ')}${titles.length > 3 ? ` and ${titles.length - 3} more` : ''}`;
  }

  // ---------------------------------------------------------------------------
  // State changes and disk writes

  /** Replaces a section's blocks. Returns the IDs of the blocks that changed. */
  private update(id: string, blocks: Block[], actor: Actor): string[] {
    const section = this.sections.get(id)!;
    const diff = diffBlocks(section.blocks, blocks);
    const changed = [...diff.changes.keys(), ...diff.removed.flatMap((removal) => removal.blocks.map((block) => block.id))];
    if (!changed.length) return [];

    section.blocks = blocks;
    section.version = `${this.run}.${++section.changes}`;
    section.versions.set(section.version, blocks);
    if (section.versions.size > KEPT_VERSIONS) section.versions.delete(section.versions.keys().next().value!);
    for (const block of blocks) this.taken.add(block.id);

    const touches = (this.state.touches[id] ??= {});
    const author: Author = actor.kind;
    for (const blockId of changed) touches[blockId] = [...new Set([...(touches[blockId] ?? []), author])];

    this.scheduleWrite(id);
    this.emit('section', { id, version: section.version, blocks, actor });
    this.repoChanged();
    return changed;
  }

  private touchLayout(actor: Actor): void {
    this.state.layout = [...new Set([...(this.state.layout ?? []), actor.kind])];
  }

  /**
   * Writes moved sections at their new paths, then removes the paths they `left`. Every new file
   * is written before any old one goes, and a path another section uses by then is kept, so two
   * sections can swap places and a move that comes in meanwhile is safe.
   */
  private async writeMoves(ids: readonly string[], left: readonly string[]): Promise<void> {
    for (const id of ids) {
      clearTimeout(this.writeTimers.get(id));
      await this.writeSection(id);
    }
    await this.removeFiles(left);
  }

  /** Removes files no section uses any more. */
  private async removeFiles(rels: readonly string[]): Promise<void> {
    for (const rel of rels) {
      if ([...this.files.values()].includes(rel)) continue;
      // Forgotten first, so the watcher's word that it is gone is taken as Quillipi's own doing.
      this.written.delete(rel);
      await this.repo.remove(rel);
    }
  }

  /**
   * Takes a section out of the working state and returns where its file was. Its removal is the
   * person's, even where an agent edited its blocks, so an agent's commit never commits a deletion
   * the agent didn't make.
   */
  private dropSection(id: string): string {
    const rel = this.files.get(id)!;
    clearTimeout(this.writeTimers.get(id));
    this.writeTimers.delete(id);
    const touches = (this.state.touches[id] ??= {});
    for (const block of this.blocksAtHead(id)) touches[block.id] = [...new Set([...(touches[block.id] ?? []), 'person' as const])];
    this.sections.delete(id);
    this.files.delete(id);
    this.onDisk.delete(id);
    return rel;
  }

  /** Brings the tree in line with the files, after sections came, went or moved. */
  private async arrangeFromFiles(): Promise<void> {
    this.tree = placeTree(this.tree, this.places());
    await this.writeMeta();
    this.repoChanged();
  }

  private scheduleWrite(id: string): void {
    clearTimeout(this.writeTimers.get(id));
    this.writeTimers.set(
      id,
      setTimeout(() => void this.writeSection(id).catch((error) => console.error(`Could not save ${id}:`, error)), WRITE_DELAY_MS),
    );
  }

  private async writeSection(id: string): Promise<void> {
    this.writeTimers.delete(id);
    const section = this.sections.get(id);
    const rel = this.files.get(id);
    if (!section || !rel) return;
    for (const [file, content] of sectionFiles(rel, section.blocks, section.frontMatter)) {
      if (this.written.get(file) === content) continue;
      this.written.set(file, content);
      await this.repo.write(file, content);
    }
    this.onDisk.set(id, section.blocks);
    await this.removeUnusedCanvasFiles();
  }

  private async removeUnusedCanvasFiles(): Promise<void> {
    const used = new Set([...this.sections.values()].flatMap((section) => section.blocks.filter((block) => block.type === 'canvas').map((block) => block.id)));
    for (const rel of [...(await this.repo.list(LAYOUT.canvas, '.json')), ...(await this.repo.list(LAYOUT.canvas, '.svg'))]) {
      if (!used.has(fileName(rel).replace(/\.(json|svg)$/, ''))) await this.repo.remove(rel);
    }
  }

  /**
   * Removes images nobody needs: in assets/, used by no section and in no commit, for a day. An image
   * a commit holds stays, so every version can be shown and undo this commit can bring it back.
   */
  private async tidyAssets(): Promise<void> {
    const files = await this.repo.list(LAYOUT.assets, '');
    const unused = this.state.unusedAssets ?? {};
    if (!files.length && !Object.keys(unused).length) return;
    const used = new Set([...this.sections.values()].flatMap((section) => section.blocks.flatMap(assetsOf)));
    const committed = this.head ? await this.repo.filesAt(this.head) : new Map<string, string>();
    const now = Date.now();
    const still: Record<string, number> = {};
    for (const rel of files) {
      if (used.has(rel) || committed.has(rel)) continue;
      const since = unused[rel] ?? now;
      if (now - since < UNUSED_ASSET_MS) still[rel] = since;
      else await this.repo.remove(rel);
    }
    if (JSON.stringify(still) === JSON.stringify(unused)) return;
    if (Object.keys(still).length) this.state.unusedAssets = still;
    else delete this.state.unusedAssets;
    this.repoChanged();
  }

  /** Writes inklog.json when the tree differs from what is on disk. */
  private async writeMeta(): Promise<void> {
    const meta = metaFile(this.notebook, this.tree);
    if (this.written.get(LAYOUT.meta) === meta) return;
    this.written.set(LAYOUT.meta, meta);
    await this.repo.write(LAYOUT.meta, meta);
  }

  /** Saves local state and tells listeners once things settle, at most every 200 ms. */
  private repoChanged(): void {
    if (this.repoTimer) return;
    this.repoTimer = setTimeout(() => {
      this.repoTimer = undefined;
      void this.repo.write(STATE_FILE, `${JSON.stringify(this.state, null, 2)}\n`).catch((error) => console.error('Could not save state:', error));
      this.emit('repo');
    }, 200);
  }

  /** Writes everything still waiting. Call before the process exits. */
  async flush(): Promise<void> {
    const ids = [...this.writeTimers.keys()];
    for (const id of ids) clearTimeout(this.writeTimers.get(id));
    for (const id of ids) await this.writeSection(id);
    const waiting = this.repoTimer !== undefined;
    clearTimeout(this.repoTimer);
    this.repoTimer = undefined;
    await this.repo.write(STATE_FILE, `${JSON.stringify(this.state, null, 2)}\n`);
    // Open editors still hear about it; in the cloud a room flushes after every call, before the timer would.
    if (waiting) this.emit('repo');
  }

  private blocksAtHead(id: string): Block[] {
    return this.headSections.get(id) ?? [];
  }

  /** Sections now, in tree order, then those only in the last commit. */
  private allSectionIds(): string[] {
    return [...new Set([...this.sectionIds(), ...this.files.keys(), ...this.headFiles.keys()])];
  }

  /** The folder each section's file is in now. */
  private places(): Map<string, string> {
    return placesOf(this.files);
  }
}

/** A problem the user (or agent) can fix, reported as a plain message rather than a crash. */
export class UserError extends Error {}

// -----------------------------------------------------------------------------
// The arrangement, while organize tries its ops

/**
 * A copy of the tree and of where each section's file is, which organize changes op by op. Any
 * op that can't be done throws, and the engine's own state is untouched.
 */
class Arrangement {
  readonly tree: TreeItem[];
  readonly files: Map<string, string>;
  readonly created: { id: string; title: string }[] = [];
  /**
   * Sections whose files moved, in the order they moved. A path is only ever taken after the
   * section that had it moved away, so writing in this order never overwrites a file not yet written elsewhere.
   */
  readonly moved: string[] = [];
  /** Whether a section or folder moved, or a folder was made or renamed. */
  arranged = false;

  constructor(
    tree: readonly TreeItem[],
    files: ReadonlyMap<string, string>,
    /** Section IDs in use outside this copy, such as ones only in the last commit. */
    private readonly inUse: (id: string) => boolean,
  ) {
    this.tree = cloneTree(tree);
    this.files = new Map(files);
  }

  apply(op: OrganizeOp): string {
    switch (op.op) {
      case 'section':
        return this.addSection(op.title, op.in ?? '', op.after);
      case 'folder':
        return this.addFolder(op.name, op.in ?? '', op.after);
      case 'move':
        return this.move(op.id, op.to, op.after);
      case 'rename':
        return this.rename(op.folder, op.name);
    }
  }

  private addSection(title: string, into: string, after: string | null | undefined): string {
    const folder = this.folder(into);
    const clean = oneLine(title);
    if (!clean) throw new UserError('A section needs a title.');
    const id = uniqueName(slugify(clean) || 'untitled', (name) => this.inUse(name) || this.files.has(name));
    this.files.set(id, this.fileFor(folder, id, id));
    this.insert(folder, id, after);
    this.created.push({ id, title: clean });
    return `✓ section ${id} in ${where(folder)}`;
  }

  private addFolder(name: string, into: string, after: string | null | undefined): string {
    const parent = this.folder(into);
    const clean = folderName(name);
    const dir = folderDir(clean);
    if (!dir) throw new UserError(`"${name}" has no letters or digits to name a folder with.`);
    const path = joinPath(parent, dir);
    if (this.items(parent).some((item) => typeof item !== 'string' && item.folder === dir)) throw new UserError(`There is already a folder ${path}/.`);
    this.checkLength(sectionFile(path, 'x'.repeat(20)));
    this.insert(parent, { folder: dir, name: clean, items: [] }, after);
    this.arranged = true;
    return `✓ folder ${path}/ "${clean}"`;
  }

  private move(ref: string, to: string | undefined, after: string | null | undefined): string {
    const section = ref.trim().endsWith('/') ? undefined : resolveIn(this.files, ref);
    if (section) {
      const from = folderOf(this.files.get(section)!);
      const dest = to === undefined ? from : this.folder(to);
      this.take(from, (item) => item === section);
      this.insert(dest, section, after);
      if (dest !== from) this.place(section, this.fileFor(dest, stemOf(this.files.get(section)!), section));
      this.arranged = true;
      return dest === from ? `✓ moved ${section} within ${where(dest)}` : `✓ moved ${section} to ${where(dest)}`;
    }
    const path = this.folder(ref, `No section or folder "${ref}".`);
    if (!path) throw new UserError("The top can't be moved.");
    const parent = parentOf(path);
    const dest = to === undefined ? parent : this.folder(to);
    if (dest === path || dest.startsWith(`${path}/`)) throw new UserError(`${path}/ can't go inside itself.`);
    const item = this.take(parent, (candidate) => typeof candidate !== 'string' && joinPath(parent, candidate.folder) === path) as Exclude<TreeItem, string>;
    if (dest !== parent && this.items(dest).some((other) => typeof other !== 'string' && other.folder === item.folder)) {
      throw new UserError(`There is already a folder ${joinPath(dest, item.folder)}/.`);
    }
    this.insert(dest, item, after);
    this.repath(path, joinPath(dest, item.folder));
    this.arranged = true;
    return dest === parent ? `✓ moved ${path}/ within ${where(dest)}` : `✓ moved ${path}/ to ${where(dest)}`;
  }

  private rename(ref: string, name: string): string {
    const path = this.folder(ref);
    if (!path) throw new UserError("The top can't be renamed.");
    const clean = folderName(name);
    const dir = folderDir(clean);
    if (!dir) throw new UserError(`"${name}" has no letters or digits to name a folder with.`);
    const parent = parentOf(path);
    const siblings = this.items(parent);
    const folder = siblings.find((item): item is Exclude<TreeItem, string> => typeof item !== 'string' && joinPath(parent, item.folder) === path)!;
    if (dir !== folder.folder && siblings.some((item) => typeof item !== 'string' && item.folder === dir)) throw new UserError(`There is already a folder ${joinPath(parent, dir)}/.`);
    const renamed = joinPath(parent, dir);
    folder.name = clean;
    folder.folder = dir;
    this.repath(path, renamed);
    this.arranged = true;
    return `✓ renamed ${path}/ to ${renamed}/ "${clean}"`;
  }

  /**
   * A folder's path from a name for it: its path (with or without a trailing `/`), or, when only
   * one folder has it, its display name or directory name. "" is the top.
   */
  private folder(ref: string, missing?: string): string {
    const path = folderPathOf(ref);
    if (folderItems(this.tree, path)) return path;
    const wanted = path.toLowerCase();
    const matches = outline(this.tree).filter(
      (entry) => entry.kind === 'folder' && (entry.name!.toLowerCase() === wanted || entry.key.slice(entry.key.lastIndexOf('/') + 1).toLowerCase() === wanted),
    );
    if (matches.length === 1) return matches[0]!.key;
    const folders = outline(this.tree).filter((entry) => entry.kind === 'folder');
    const list = folders.length ? ` The folders are: ${folders.slice(0, 12).map((entry) => `${entry.key}/`).join(', ')}${folders.length > 12 ? ' …' : ''}.` : ' There are no folders yet.';
    throw new UserError(`${missing ?? `No folder "${ref}".`}${list}`);
  }

  private items(path: string): TreeItem[] {
    return folderItems(this.tree, path)!;
  }

  private insert(folder: string, item: TreeItem, after: string | null | undefined): void {
    const items = this.items(folder);
    if (after === undefined) return void items.push(item);
    if (after === null) return void items.unshift(item);
    const name = after.trim();
    const section = name.endsWith('/') ? undefined : resolveIn(this.files, name);
    const path = folderPathOf(name);
    const at = items.findIndex((candidate) =>
      typeof candidate === 'string' ? candidate === section : joinPath(folder, candidate.folder) === path || candidate.folder === path,
    );
    if (at < 0) throw new UserError(`"${after}" isn't in ${where(folder)}, so nothing can go after it there.`);
    items.splice(at + 1, 0, item);
  }

  private take(folder: string, match: (item: TreeItem) => boolean): TreeItem {
    const items = this.items(folder);
    const at = items.findIndex(match);
    if (at < 0) throw new Error(`The tree has lost track of an item in ${where(folder)}.`);
    return items.splice(at, 1)[0]!;
  }

  /** The file for a section in a folder: named `stem` if that is free there, else after its ID. */
  private fileFor(folder: string, stem: string, id: string): string {
    const taken = (rel: string) => [...this.files].some(([other, file]) => other !== id && file === rel);
    let rel = sectionFile(folder, stem);
    if (taken(rel)) rel = sectionFile(folder, id);
    if (taken(rel)) throw new UserError(`Another file is already called ${fileName(rel)} in ${where(folder)}.`);
    this.checkLength(rel);
    return rel;
  }

  /** Every section under folder `from` now lives under `to`. */
  private repath(from: string, to: string): void {
    if (from === to) return;
    const prefix = `${LAYOUT.sections}/${from}/`;
    for (const [id, rel] of this.files) {
      if (!rel.startsWith(prefix)) continue;
      const moved = `${LAYOUT.sections}/${to}/${rel.slice(prefix.length)}`;
      this.checkLength(moved);
      this.place(id, moved);
    }
  }

  private place(id: string, rel: string): void {
    this.files.set(id, rel);
    this.moved.push(id);
  }

  private checkLength(rel: string): void {
    if (rel.length > MAX_PATH) throw new UserError(`That would make the path ${rel} too long for Windows. Use shorter names or fewer folders.`);
  }
}

// -----------------------------------------------------------------------------
// Helpers

function fileName(rel: string): string {
  return rel.slice(rel.lastIndexOf('/') + 1);
}

/** A section file's path, for a folder path ("" for the top) and a file name without `.md`. */
export function sectionFile(folder: string, stem: string): string {
  return `${LAYOUT.sections}/${joinPath(folder, stem)}.md`;
}

function isSectionFile(rel: string): boolean {
  return rel.startsWith(`${LAYOUT.sections}/`) && rel.endsWith('.md');
}

/** Before folders, a section's ID was its path inside `sections/`, without `.md`. */
function oldIdOf(rel: string): string {
  return rel.slice(LAYOUT.sections.length + 1, -'.md'.length);
}

function stemOf(rel: string): string {
  return fileName(rel).slice(0, -'.md'.length);
}

/** The folder a section file is in, such as `research` for `sections/research/pricing.md`. */
function folderOf(rel: string): string {
  const inner = rel.slice(LAYOUT.sections.length + 1);
  return inner.includes('/') ? inner.slice(0, inner.lastIndexOf('/')) : '';
}

function parentOf(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

function placesOf(files: ReadonlyMap<string, string>): Map<string, string> {
  return new Map([...files].map(([id, rel]) => [id, folderOf(rel)]));
}

/** A folder path from a name for it: no slashes at either end, "" for the top. */
function folderPathOf(ref: string): string {
  return ref.trim().replace(/^\/+|\/+$/g, '');
}

function where(folder: string): string {
  return folder ? `${folder}/` : 'the top';
}

/** A folder's directory name from its display name: a slug, never one of the names Windows keeps. */
function folderDir(name: string): string {
  const slug = slugify(name);
  return slug && isReservedName(slug) ? `${slug}-folder` : slug;
}

/** A folder's display name, on one line and at most 100 characters. */
function folderName(name: string): string {
  const clean = oneLine(name);
  if (clean.length > 100) throw new UserError('A folder name can be at most 100 characters.');
  return clean;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function idAt(files: ReadonlyMap<string, string>, rel: string): string | undefined {
  for (const [id, file] of files) if (file === rel) return id;
  return undefined;
}

/** A section ID from a name for it, among `files`: the ID itself, or its file's path. */
function resolveIn(files: ReadonlyMap<string, string>, ref: string): string | undefined {
  const name = ref.trim().replace(/^\^/, '');
  if (files.has(name)) return name;
  if (files.has(name.toLowerCase())) return name.toLowerCase();
  return idAt(files, `${LAYOUT.sections}/${name.replace(/^\/+/, '').replace(/^sections\//, '').replace(/\.md$/, '')}.md`);
}

/**
 * IDs for section files, in their order: the ID in each file's front matter, and one from its file
 * name for a file without one. When several files claim an ID, such as a file and its copy, the
 * one at that ID's path in `known` (the last commit) keeps it, then one named after it, then the
 * first; the others get IDs from their names. So a copy never takes the ID of its original.
 */
function assignIds(files: readonly (readonly [string, string | undefined])[], known: ReadonlyMap<string, string> = new Map()): Map<string, string> {
  const claims = new Map<string, string[]>();
  for (const [rel, id] of files) if (id) claims.set(id, [...(claims.get(id) ?? []), rel]);
  const ids = new Map<string, string>();
  const used = new Set<string>();
  for (const [id, rels] of claims) {
    ids.set(rels.find((rel) => known.get(id) === rel) ?? rels.find((rel) => stemOf(rel) === id) ?? rels[0]!, id);
    used.add(id);
  }
  for (const [rel] of files) {
    if (ids.has(rel)) continue;
    const id = uniqueName(slugify(stemOf(rel)) || 'untitled', (name) => used.has(name));
    ids.set(rel, id);
    used.add(id);
  }
  return new Map(files.map(([rel]) => [rel, ids.get(rel)!]));
}

function blockIdOf(key: string): string {
  return key.replace(/^removed:/, '');
}

/** The files that store a section: its Markdown, plus a JSON source and an SVG preview per canvas. */
function sectionFiles(rel: string, blocks: Block[], frontMatter: string): Map<string, string> {
  const files = new Map([[rel, serializeSection({ blocks, frontMatter })]]);
  for (const block of blocks) {
    if (block.type !== 'canvas') continue;
    // An editor's save is checked like a file, so only well-formed elements are ever written.
    const elements = canvasElements(block.attrs?.elements);
    files.set(`${LAYOUT.canvas}/${block.id}.json`, `${JSON.stringify({ version: 1, elements }, null, 2)}\n`);
    files.set(`${LAYOUT.canvas}/${block.id}.svg`, `${renderCanvasSvg(elements, { aspect: block.attrs?.aspect ?? DEFAULT_ASPECT })}\n`);
  }
  return files;
}

/** A canvas file's elements, only the well-formed ones: the file may have come from anyone's Git history. */
function parseCanvasFile(json: string | undefined): CanvasElement[] {
  if (!json) return [];
  try {
    return canvasElements(JSON.parse(json)?.elements);
  } catch {
    return [];
  }
}

/** Repo files a block depends on: image files, including images inside canvases. */
function assetsOf(block: Block): string[] {
  if (block.type === 'image' && block.attrs?.src) return [block.attrs.src];
  if (block.type === 'canvas') return (block.attrs?.elements ?? []).flatMap((element) => (element.kind === 'image' ? [element.src] : []));
  return [];
}

/** Local state from .inklog/state.json; a damaged file starts afresh rather than stopping the notebook from opening. */
function readState(text: string | undefined): Partial<LocalState> {
  try {
    const state = JSON.parse(text ?? '{}');
    return state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  } catch {
    return {};
  }
}

/** The editor acts for the person, and so does undo. */
const PERSON = { kind: 'person' } as const;

/**
 * How many of the blocks a commit changed (`was` → `made`) aren't back as they were in `result`:
 * those changed again since, which a merge keeps.
 */
function changesKept(was: readonly Block[], made: readonly Block[], result: readonly Block[]): number {
  const diff = diffBlocks(was, made);
  const touched = [...[...diff.changes].flatMap(([id, change]) => (change === 'moved' ? [] : [id])), ...diff.removed.flatMap((removal) => removal.blocks.map((block) => block.id))];
  const before = byId(was);
  const now = byId(result);
  return touched.filter((id) => {
    const old = before.get(id);
    const current = now.get(id);
    return old && current ? !sameContent(old, current) : old !== current;
  }).length;
}

function sameNames(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  return a.size === b.size && [...a].every(([path, name]) => b.get(path) === name);
}
