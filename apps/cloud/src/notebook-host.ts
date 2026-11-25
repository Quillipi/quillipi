/**
 * One notebook in the cloud: its store, its engine (opened on first use) and its GitHub mirror.
 * The Durable Object (notebook-object.ts) is a thin wrapper around this, so the tests can run it
 * in Node.
 *
 * After every change the room tells the library (library.ts) how it stands: a short summary for
 * the notebook's card on Home, sent at most every few seconds.
 */
import type { Actor, BackupState, NotebookSummary, PendingChange, Person, RecentEdit, SectionMark, ServerMessage, TreeItem } from '@inklog/core';
import { EditorApi, type EditorCall, type EditorReply, Engine, LAYOUT, UserError, initNotebook, runTool } from '@inklog/engine';
import type { DurableStore } from './durable-store.js';
import type { Directory } from './library.js';
import type { Mirror } from './mirror.js';

export interface NotebookStatus {
  exists: boolean;
  sections?: number;
  commits?: number;
  uncommitted?: number;
  /** How the GitHub mirror stands, when it is set up. */
  mirror?: string;
}

/** What the library adds to a tool call (library.ts, route): the owner's instructions for every notebook, and for map the notebooks there are. */
export interface RoomContext {
  shared?: string;
  directory?: Directory;
}

/** What New notebook gives a room to start with. */
export interface NewNotebookDetails {
  title: string;
  about?: string;
  colour?: string;
}

export interface NotebookHostOptions {
  /** Sends the room's summary to the library. A failure is retried with the next report. */
  report?: (summary: NotebookSummary) => Promise<void>;
  /** Asks for flushReport() to run no later than `time` (the Durable Object's alarm). */
  schedule?: (time: number) => Promise<void>;
  /**
   * Sends a message to every open editor but `except`: a section changed elsewhere, or the
   * notebook's info. In a Durable Object, its hibernating WebSockets.
   */
  broadcast?: (message: ServerMessage, except?: unknown) => void;
  now?: () => number;
}

/** Reports to the library are at least this far apart, so a burst of edits sends one. */
export const REPORT_GAP_MS = 2000;
/** Sections remembered as edited lately; the card shows the newest four that still exist. */
const RECENT_KEPT = 12;
const RECENT_SHOWN = 4;
const AGENT_COMMITS_SHOWN = 10;
/** Sections listed with uncommitted or held changes on the card, at most. */
const MARKED_SHOWN = 20;
const RECENT_KEY = 'recent-edits';
const REPORT_DUE_KEY = 'report-due';

export class NotebookHost {
  private engine?: Promise<Engine>;
  private editorApi?: EditorApi;
  /** The owner's instructions for every notebook, as the library gave them for the editor's current call. */
  private shared?: string;
  private lastReport?: { at: number; text: string };

  constructor(
    readonly store: DurableStore,
    readonly name: string,
    private readonly person: Person,
    /** The GitHub mirror, when the GitHub App is set up. */
    readonly mirror?: Mirror,
    private readonly options: NotebookHostOptions = {},
  ) {}

  /** The notebook's engine. Without a mirror, a notebook that doesn't exist yet is started, empty. */
  open(): Promise<Engine> {
    this.engine ??= this.load().catch((error: unknown) => {
      this.engine = undefined; // let the next call try again
      throw error;
    });
    return this.engine;
  }

  /**
   * Starts a new notebook here: an About section and a first commit, so it can be written in at
   * once; its GitHub repo is made in the background. 'taken' if this room already holds one.
   */
  async create(details: NewNotebookDetails): Promise<'made' | 'taken'> {
    if ((await this.store.read(LAYOUT.meta)) !== undefined || this.store.commitCount() > 0 || this.engine) return 'taken';
    await initNotebook(this.store, { name: details.title, person: this.person, starter: 'about', about: details.about, colour: details.colour });
    await this.mirror?.begin();
    await this.reportSoon();
    return 'made';
  }

  /** Links this room to the notebook's repo already on GitHub, which is imported in the background. */
  async adopt(): Promise<string> {
    if (!this.mirror) throw new UserError('Adding a notebook from GitHub needs the GitHub App: GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY.');
    const text = await this.mirror.adopt();
    await this.reportSoon();
    return text;
  }

  /**
   * Runs an agent's tool call. Everything it changed is saved before the reply goes back, and any
   * new commit is then pushed to GitHub. With a mirror, the first call imports the notebook.
   */
  async runTool(agent: string, tool: string, args: unknown, { shared, directory }: RoomContext = {}): Promise<string> {
    await this.mirror?.ready();
    const engine = await this.open();
    const notebooks = directory && { ids: directory.notebooks.map((notebook) => notebook.id), fallback: directory.default, here: this.name };
    try {
      // map shows how the mirror stands when it needs a person, and names the notebooks.
      return await runTool(engine, agent, tool, args, { sharedInstructions: shared, notice: tool === 'map' ? this.mirror?.notice() : undefined, notebooks });
    } finally {
      await this.settle();
    }
  }

  /** After a call: everything saved, any new commit on its way to GitHub, and the library told. */
  private async settle(): Promise<void> {
    const engine = await this.open();
    await engine.flush();
    // A push that can't be scheduled is reported by the mirror later; it never fails the call.
    await this.mirror?.changed().catch((error: unknown) => console.error('Could not schedule a push:', error));
    await this.reportSoon();
  }

  /** The editor's side of the notebook, made with the engine, so open editors hear agents' changes too. */
  private async editor(): Promise<EditorApi> {
    await this.open();
    return this.editorApi!;
  }

  /**
   * One call from the editor (editor-api.ts), the same calls the laptop answers. Like a tool call,
   * everything it changed is saved before the reply goes back, and a commit is then pushed.
   */
  async editorCall(call: EditorCall, sharedInstructions?: string): Promise<EditorReply> {
    await this.mirror?.ready();
    const editor = await this.editor();
    this.shared = sharedInstructions;
    try {
      return await editor.call(call);
    } finally {
      await this.settle();
    }
  }

  /**
   * A message from an open editor's live connection, `from`: its reply, or nothing. Saves are not
   * flushed one by one; the engine writes a section 300 ms after its last change, and a room
   * doesn't nap while that timer waits.
   */
  async editorMessage(text: string, from: unknown): Promise<ServerMessage | undefined> {
    await this.mirror?.ready();
    const reply = (await this.editor()).receive(text, from);
    await this.reportSoon();
    return reply;
  }

  /** The alarm: the mirror's next step, then a report if one is due. Open editors hear how the backup stands. */
  async alarm(): Promise<void> {
    try {
      await this.mirror?.step();
    } finally {
      await this.reportSoon();
      if (this.editorApi) this.options.broadcast?.({ type: 'repo', info: this.editorApi.info() });
    }
  }

  /** A short summary, without starting or importing a notebook that doesn't exist. */
  async status(): Promise<NotebookStatus> {
    const mirror = this.mirror ? { mirror: this.mirror.status() } : {};
    if ((await this.store.read(LAYOUT.meta)) === undefined) return { exists: false, ...mirror };
    const info = (await this.open()).info();
    return { exists: true, sections: info.sections.length, commits: info.commits.length, uncommitted: info.pending.length, ...mirror };
  }

  /** How the notebook's backup to GitHub stands. */
  backup(): BackupState {
    return this.mirror?.backup() ?? { state: 'off', text: 'Not backed up: the GitHub App is not set up here.' };
  }

  /** What the library keeps on the notebook's card. A notebook still being imported has only its backup state. */
  async summary(): Promise<NotebookSummary> {
    const backup = this.backup();
    if ((await this.store.read(LAYOUT.meta)) === undefined) {
      return { title: this.name, sections: 0, folders: 0, commits: 0, uncommitted: 0, agentUncommitted: 0, held: 0, recent: [], agentCommits: [], backup };
    }
    const engine = await this.open();
    const info = engine.info();
    const { name: title, about, colour } = engine.details();
    const places = new Map(info.sections.map((section) => [section.id, section]));
    const recent: RecentEdit[] = [];
    for (const edit of this.recentEdits()) {
      const section = places.get(edit.id);
      if (section && recent.length < RECENT_SHOWN) recent.push({ ...edit, title: section.title, folder: section.folder });
    }
    const latest = info.commits[0];
    return {
      title,
      ...(about ? { about } : {}),
      ...(colour ? { colour } : {}),
      sections: info.sections.length,
      folders: countFolders(info.tree),
      commits: info.commits.length,
      ...(latest ? { last: { number: latest.number, message: latest.message, ...(latest.agent ? { agent: latest.agent } : {}), at: latest.at } } : {}),
      uncommitted: info.pending.length,
      agentUncommitted: info.pending.filter((change) => change.by.includes('agent')).length,
      held: info.held.length,
      recent,
      agentCommits: info.commits
        .filter((commit) => commit.agent)
        .slice(0, AGENT_COMMITS_SHOWN)
        .map((commit) => ({ number: commit.number, agent: commit.agent!, message: commit.message, at: commit.at })),
      pendingSections: marks(info.pending.filter((change) => !change.held), places),
      heldSections: marks(info.pending.filter((change) => change.held), places),
      ...(engine.lastAgent() ? { lastAgent: engine.lastAgent() } : {}),
      backup,
    };
  }

  /**
   * Sends the summary to the library if it changed, at most every REPORT_GAP_MS; a report that has
   * to wait asks the alarm for it. A report that fails stays due, and never fails the caller.
   */
  async reportSoon(): Promise<void> {
    const { report, schedule } = this.options;
    if (!report) return;
    const now = (this.options.now ?? Date.now)();
    if (this.lastReport && now - this.lastReport.at < REPORT_GAP_MS) {
      this.store.setMeta(REPORT_DUE_KEY, '1');
      await schedule?.(this.lastReport.at + REPORT_GAP_MS);
      return;
    }
    try {
      const summary = await this.summary();
      const text = JSON.stringify(summary);
      if (text !== this.lastReport?.text || this.store.getMeta(REPORT_DUE_KEY)) await report(summary);
      this.lastReport = { at: now, text };
      this.store.setMeta(REPORT_DUE_KEY, undefined);
    } catch (error) {
      this.store.setMeta(REPORT_DUE_KEY, '1');
      console.error('Could not report to the library:', error);
    }
  }

  private async load(): Promise<Engine> {
    if ((await this.store.read(LAYOUT.meta)) === undefined) {
      await initNotebook(this.store, { name: this.name, person: this.person });
    }
    const engine = await Engine.fromStore(this.store, this.name);
    engine.on('section', ({ id, actor }) => this.noteEdit(id, actor));
    this.editorApi = new EditorApi(engine, {
      // The editor shows how the backup stands, beside the notebook's info.
      info: (info) => ({ ...info, backup: this.backup() }),
      sharedInstructions: () => this.shared,
    });
    const { broadcast } = this.options;
    if (broadcast) this.editorApi.listen(broadcast);
    return engine;
  }

  /** Remembers who edited a section and when, in the room's own storage, so a nap doesn't forget it. */
  private noteEdit(id: string, actor: Actor): void {
    const edit = { id, by: actor.kind === 'agent' ? actor.agent : this.person.name, agent: actor.kind === 'agent', at: (this.options.now ?? Date.now)() };
    const kept = [edit, ...this.recentEdits().filter((earlier) => earlier.id !== id)].slice(0, RECENT_KEPT);
    this.store.setMeta(RECENT_KEY, JSON.stringify(kept));
  }

  private recentEdits(): Omit<RecentEdit, 'title' | 'folder'>[] {
    const saved = this.store.getMeta(RECENT_KEY);
    return saved ? (JSON.parse(saved) as Omit<RecentEdit, 'title' | 'folder'>[]) : [];
  }
}

/** The sections that have changes, with how many and whether an agent made any; changes with no section of their own are left out. */
function marks(changes: readonly PendingChange[], places: ReadonlyMap<string, { title: string; folder: string }>): SectionMark[] {
  const found = new Map<string, SectionMark>();
  for (const change of changes) {
    const place = places.get(change.section);
    if (!place) continue;
    const mark = found.get(change.section) ?? { id: change.section, title: place.title, folder: place.folder, count: 0, agent: false };
    mark.count += 1;
    mark.agent ||= change.by.includes('agent');
    found.set(change.section, mark);
  }
  return [...found.values()].slice(0, MARKED_SHOWN);
}

function countFolders(items: readonly TreeItem[]): number {
  return items.reduce((sum, item) => (typeof item === 'string' ? sum : sum + 1 + countFolders(item.items)), 0);
}
