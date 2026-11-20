/**
 * The library: one card for every notebook in the cloud, kept in its own Durable Object
 * (library-object.ts). It replaces the list of notebooks that used to sit in wrangler.jsonc, so a
 * notebook can be made with one click, with no deploy.
 *
 * - A notebook's ID is made from its title when it is made, such as `gym-rollup`. It is also its
 *   room's name and its GitHub repo's name, and it never changes; the title can.
 * - Claude's door asks the library before touching any room, so a name the library doesn't know
 *   creates nothing.
 * - Each room reports how it stands after a change (notebook-host.ts), so Home can draw every
 *   notebook from one request without waking them.
 * - It also keeps the owner's AI instructions for every notebook, with their earlier versions, and
 *   when each person last visited Home.
 * - And Quillipi's own settings (settings.ts), each under its name in the settings table, beside the
 *   default notebook, whether Claude has connected yet, and the storage version that wrote it.
 * - And the first-time setups in progress (setup.ts), each for an hour after its last step.
 */
import { MAX_INSTRUCTIONS, MAX_NOTEBOOK_TITLE, type LibraryMessage, type NotebookCard, type NotebookSummary, aboutLine, colourFor, isNotebookColour, isSectionId, notebookId, notebookTitle, slugify } from '@inklog/core';
import { UserError } from '@inklog/engine';
import { type SqlDatabase, claimStorage } from './durable-store.js';
import type { NewNotebookDetails } from './notebook-host.js';
import { SECRETS, SETTINGS, type SettingName, type SettingView, type Settings, isSetting, newSecret, own } from './settings.js';
import type { SetupRecord } from './setup.js';
import { type Admission, SignInLimits } from './sign-in-limits.js';

/** The library's Durable Object has this name; there is one. */
export const LIBRARY_NAME = 'library';
/** New notebooks a day, at most, so a runaway agent can't fill the organization with repos. */
export const NEW_NOTEBOOKS_PER_DAY = 20;
/** The longest title; GitHub allows 100 characters in a repo name, and IDs are cut to 60. */
export const MAX_TITLE = MAX_NOTEBOOK_TITLE;
/** Earlier versions of the instructions for every notebook that are kept. */
const KEPT_INSTRUCTIONS = 50;
/** How many rooms that already hold something New notebook tries before giving up. */
const ROOMS_TRIED = 5;
/** A setup in progress lasts this long after its last step: GitHub's code for a new App works for an hour too. */
export const SETUP_MS = 60 * 60_000;
/**
 * At most this many setups are kept at once, the oldest going first, so nobody can fill the
 * library by starting setups; an owner whose setup went that way simply starts again.
 */
export const SETUPS_KEPT = 20;
/** The key in the settings table that says Claude has connected. */
const CLAUDE_KEY = 'claude';
/**
 * The shape of the library's storage that this code reads and writes: its tables and what they
 * hold. 1 is the shape it has kept since step 3.3, including before it was recorded. A release that
 * changes the shape raises this and moves an older library forward when it opens (durable-store.ts).
 */
export const LIBRARY_STORAGE = 1;

/** The notebooks' rooms, as the library reaches them. */
export interface Rooms {
  create(id: string, details: NewNotebookDetails): Promise<'made' | 'taken'>;
  adopt(id: string): Promise<string>;
}

/** What Home is told when the library changes. */
export type LibraryChange = Exclude<LibraryMessage, { type: 'cards' }>;

/** What Claude's door needs: the notebooks, which one tools use when none is named, and the shared instructions. */
export interface Directory {
  notebooks: { id: string; title: string }[];
  default?: string;
}

export interface Route {
  id: string;
  /** The owner's instructions for every notebook, if there are any. */
  shared?: string;
}

export interface LibraryOptions {
  rooms: Rooms;
  now?: () => number;
  onChange?: (change: LibraryChange) => void;
}

export class Library {
  private readonly now: () => number;
  private readonly signIns: SignInLimits;

  constructor(
    private readonly sql: SqlDatabase,
    private readonly options: LibraryOptions,
  ) {
    this.now = options.now ?? Date.now;
    // The version is checked before anything else is written, so an older Quillipi changes nothing in a newer library.
    sql.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    claimStorage(sql, 'settings', LIBRARY_STORAGE, 'Quillipi’s library');
    sql.exec('CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, card TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS instructions (version INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, at INTEGER NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS visits (person TEXT PRIMARY KEY, at INTEGER NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS made (day TEXT PRIMARY KEY, count INTEGER NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS setups (id TEXT PRIMARY KEY, record TEXT NOT NULL, at INTEGER NOT NULL)');
    this.signIns = new SignInLimits(sql, this.now);
  }

  // Reading ---------------------------------------------------------------------

  /** Every card, the one changed most recently first. */
  cards(): NotebookCard[] {
    const cards = this.sql.exec('SELECT card FROM cards').toArray().map((row) => JSON.parse(String(row.card)) as NotebookCard);
    return cards.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  }

  card(id: string): NotebookCard | undefined {
    const row = this.sql.exec('SELECT card FROM cards WHERE id = ?', id).toArray()[0];
    return row ? (JSON.parse(String(row.card)) as NotebookCard) : undefined;
  }

  /** The notebooks that aren't archived, for the instructions Claude reads when it connects. */
  directory(): Directory {
    const notebooks = this.cards()
      .filter((card) => !card.archived)
      .map((card) => ({ id: card.id, title: card.title }));
    const fallback = this.defaultId();
    return { notebooks, ...(fallback ? { default: fallback } : {}) };
  }

  /**
   * The notebook a tool call is for: the one named, by its ID or by its title, or the default.
   * An unknown name is answered with the list, and touches no room.
   */
  route(name?: string): Route {
    const shared = this.instructions();
    const id = name === undefined ? this.defaultId() : this.find(name);
    if (!id) {
      const known = this.directory().notebooks.map((notebook) => notebook.id);
      if (name === undefined) throw new UserError('There are no notebooks yet. Make one with create_notebook.');
      throw new UserError(`No notebook "${name}". ${known.length ? `The notebooks here are: ${known.join(', ')}.` : 'There are no notebooks yet. Make one with create_notebook.'}`);
    }
    return { id, ...(shared ? { shared } : {}) };
  }

  // New notebooks -------------------------------------------------------------------

  /**
   * Makes a notebook: picks its permanent ID from the title, writes its card, and starts its room
   * with an About section and a first commit. The ID is taken before the room is asked, so two
   * New notebooks at the same moment never get the same one.
   */
  async create({ title, about, colour, by }: { title: string; about?: string; colour?: string; by: string }): Promise<NotebookCard> {
    const name = notebookTitle(title);
    if (!name) throw new UserError('A new notebook needs a title.');
    if (name.length > MAX_TITLE) throw new UserError(`A title can be at most ${MAX_TITLE} characters.`);
    if (colour !== undefined && !isNotebookColour(colour)) throw new UserError(`"${colour}" is not a colour; give one as #rrggbb.`);
    const line = about === undefined ? '' : aboutLine(about);
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const madeToday = Number(this.sql.exec('SELECT count FROM made WHERE day = ?', day).toArray()[0]?.count ?? 0);
    if (madeToday >= NEW_NOTEBOOKS_PER_DAY) {
      throw new UserError(`Quillipi makes at most ${NEW_NOTEBOOKS_PER_DAY} notebooks a day, to stop a runaway agent. Try again tomorrow (UTC), or use a notebook that exists.`);
    }
    const occupied = new Set<string>();
    for (let tries = 0; tries < ROOMS_TRIED; tries++) {
      const id = notebookId(name, (candidate) => occupied.has(candidate) || this.card(candidate) !== undefined);
      const now = this.now();
      const card: NotebookCard = { id, title: name, ...(line ? { about: line } : {}), colour: colour ?? colourFor(id), createdBy: by, createdAt: now, from: 'new', archived: false, updatedAt: now };
      this.save(card);
      let made: 'made' | 'taken';
      try {
        made = await this.options.rooms.create(id, { title: name, ...(line ? { about: line } : {}), colour: card.colour });
      } catch (error) {
        this.remove(id);
        throw error;
      }
      if (made === 'taken') {
        // A room that holds a notebook the library doesn't list, such as one from before it.
        this.remove(id);
        occupied.add(id);
        continue;
      }
      this.sql.exec('INSERT INTO made (day, count) VALUES (?, 1) ON CONFLICT (day) DO UPDATE SET count = count + 1', day);
      this.sql.exec('DELETE FROM made WHERE day < ?', day);
      const latest = this.card(id) ?? card;
      this.options.onChange?.({ type: 'card', card: latest });
      return latest;
    }
    throw new UserError(`Couldn't find a free ID for "${name}". Try a different title.`);
  }

  /**
   * Adds a notebook whose repo is already in the organization for notebooks, such as one moved
   * there from the laptop. Its history is imported in the background, on its first use.
   */
  async add({ repo, by }: { repo: string; by: string }): Promise<{ card: NotebookCard; status: string }> {
    const id = repo.trim().replace(/^.*\//, '');
    if (!isSectionId(id)) {
      throw new UserError(`"${id}" can't be a notebook's ID: use a repo whose name has only lowercase letters, digits and hyphens (rename it on GitHub if needed), at most 60 characters.`);
    }
    if (this.card(id)) throw new UserError(`The notebook ${id} is already here.`);
    const now = this.now();
    const card: NotebookCard = { id, title: id, colour: colourFor(id), createdBy: by, createdAt: now, from: 'github', archived: false, updatedAt: now };
    this.save(card);
    let status: string;
    try {
      status = await this.options.rooms.adopt(id);
    } catch (error) {
      this.remove(id);
      throw error;
    }
    const latest = this.card(id) ?? card;
    this.options.onChange?.({ type: 'card', card: latest });
    return { card: latest, status };
  }

  // Changes -----------------------------------------------------------------------------

  /** A room's report: its card takes the title, line and colour the notebook itself keeps. */
  update(id: string, summary: NotebookSummary): void {
    const card = this.card(id);
    if (!card) return; // a room the library no longer lists
    const next: NotebookCard = {
      ...card,
      title: summary.title || card.title,
      colour: summary.colour ?? card.colour,
      summary,
      updatedAt: this.now(),
    };
    if (summary.about) next.about = summary.about;
    else delete next.about;
    this.save(next);
    this.options.onChange?.({ type: 'card', card: next });
  }

  archive(id: string, archived: boolean): NotebookCard {
    const card = this.need(id);
    const next = { ...card, archived, updatedAt: this.now() };
    this.save(next);
    this.options.onChange?.({ type: 'card', card: next });
    return next;
  }

  /** Which notebook tools use when they name none. */
  setDefault(id: string): void {
    this.need(id);
    this.sql.exec('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', 'default', id);
  }

  // Instructions for every notebook ------------------------------------------------------

  /** The owner's instructions for every notebook, or "" when there are none. */
  instructions(): string {
    const row = this.sql.exec('SELECT text FROM instructions ORDER BY version DESC LIMIT 1').toArray()[0];
    return row ? String(row.text) : '';
  }

  /** Every version kept, newest first, with when each was saved. */
  instructionHistory(): { version: number; text: string; at: number }[] {
    return this.sql
      .exec('SELECT version, text, at FROM instructions ORDER BY version DESC')
      .toArray()
      .map((row) => ({ version: Number(row.version), text: String(row.text), at: Number(row.at) }));
  }

  /** Saves a new version, if the text changed. Only the person does this; no agent tool can. */
  setInstructions(text: string): void {
    const clean = text.replace(/\r\n?/g, '\n').trim();
    if (clean.length > MAX_INSTRUCTIONS) throw new UserError(`Instructions can be at most ${MAX_INSTRUCTIONS} characters; these are ${clean.length}.`);
    if (clean === this.instructions()) return;
    this.sql.exec('INSERT INTO instructions (text, at) VALUES (?, ?)', clean, this.now());
    this.sql.exec('DELETE FROM instructions WHERE version <= (SELECT MAX(version) FROM instructions) - ?', KEPT_INSTRUCTIONS);
  }

  // Quillipi's settings ---------------------------------------------------------------------

  /** The settings kept here, secrets included: only for the Worker and the rooms, never shown. */
  settings(): Settings {
    const kept: Settings = {};
    for (const row of this.sql.exec('SELECT key, value FROM settings').toArray()) {
      const name = String(row.key);
      if (isSetting(name)) kept[name] = String(row.value);
    }
    return kept;
  }

  /**
   * Run when the library opens, with the Worker's own variables and secrets. It keeps a copy of
   * each non-secret one that holds a value, so they hold if the Worker's variables go; secrets
   * are never copied. And when neither the Worker nor the library has a secret for the browser's
   * cookie, it makes one, so a new Quillipi never needs one made by hand.
   */
  keepSettings(worker: Settings): void {
    const kept = this.settings();
    for (const name of SETTINGS) {
      const value = own(worker, name);
      if (value !== undefined && !SECRETS.has(name) && kept[name] !== value) this.putSetting(name, value);
    }
    if (!own(worker, 'SESSION_SECRET') && !kept.SESSION_SECRET) this.putSetting('SESSION_SECRET', newSecret());
  }

  /** Each setting as the owner may see it: where its value comes from, whether it is kept here, and no secret's value. */
  settingsView(worker: Settings): SettingView[] {
    const kept = this.settings();
    return SETTINGS.map((name) => {
      const secret = SECRETS.has(name);
      const value = own(worker, name) ?? kept[name];
      return {
        name,
        secret,
        from: own(worker, name) !== undefined ? 'worker' : value !== undefined ? 'quillipi' : 'missing',
        kept: kept[name] !== undefined && (secret || kept[name] === value),
        ...(!secret && value !== undefined ? { value } : {}),
      };
    });
  }

  /** Whether Claude has connected at least once, for Home's Get started card. */
  claudeConnected(): boolean {
    return this.sql.exec('SELECT value FROM settings WHERE key = ?', CLAUDE_KEY).toArray().length > 0;
  }

  /** Whether a stranger may start one more sign-in step (sign-in-limits.ts); if so, it is counted. */
  admitSignIn(visitor: string): Admission {
    return this.signIns.admit(visitor);
  }

  /** Notes that Claude has connected; the first time, every open Home is told. */
  noteClaudeConnected(): void {
    if (this.claudeConnected()) return;
    this.sql.exec('INSERT INTO settings (key, value) VALUES (?, ?)', CLAUDE_KEY, String(this.now()));
    this.options.onChange?.({ type: 'claude' });
  }

  private putSetting(name: SettingName, value: string): void {
    this.sql.exec('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', name, value);
  }

  // The first-time setup ----------------------------------------------------------------------

  /** Keeps a new setup in progress and returns its ID, which only the browser that started it holds. */
  startSetup(record: SetupRecord): string {
    const id = newSecret();
    this.sql.exec('DELETE FROM setups WHERE at <= ?', this.now() - SETUP_MS);
    this.sql.exec('INSERT INTO setups (id, record, at) VALUES (?, ?, ?)', id, JSON.stringify(record), this.now());
    this.sql.exec('DELETE FROM setups WHERE id NOT IN (SELECT id FROM setups ORDER BY at DESC, rowid DESC LIMIT ?)', SETUPS_KEPT);
    return id;
  }

  /** A setup in progress, unless it has gone: finished, started again, or an hour without a step. */
  setup(id: string): SetupRecord | undefined {
    const row = this.sql.exec('SELECT record FROM setups WHERE id = ? AND at > ?', id, this.now() - SETUP_MS).toArray()[0];
    return row ? (JSON.parse(String(row.record)) as SetupRecord) : undefined;
  }

  /** Saves a step of a setup in progress, which gives it another hour. False if it has gone. */
  saveSetup(id: string, record: SetupRecord): boolean {
    if (!this.setup(id)) return false;
    this.sql.exec('UPDATE setups SET record = ?, at = ? WHERE id = ?', JSON.stringify(record), this.now(), id);
    return true;
  }

  endSetup(id: string): void {
    this.sql.exec('DELETE FROM setups WHERE id = ?', id);
  }

  /**
   * The last step: keeps the settings the setup found, secrets included, and ends it, together.
   * False if the setup has gone, so nothing is kept from it.
   */
  finishSetup(id: string, settings: Settings): boolean {
    return this.sql.transaction(() => {
      if (!this.setup(id)) return false;
      for (const name of SETTINGS) {
        const value = own(settings, name);
        if (value !== undefined) this.putSetting(name, value);
      }
      this.endSetup(id);
      return true;
    });
  }

  // Visits ----------------------------------------------------------------------------------

  /** Records that a person opened Home now, and returns when they did before, for "Since your last visit". */
  visit(person: string): number | undefined {
    const before = this.sql.exec('SELECT at FROM visits WHERE person = ?', person).toArray()[0]?.at;
    this.sql.exec('INSERT INTO visits (person, at) VALUES (?, ?) ON CONFLICT (person) DO UPDATE SET at = excluded.at', person, this.now());
    return before === undefined ? undefined : Number(before);
  }

  // Inside ----------------------------------------------------------------------------------

  /** The chosen default, or the notebook made first. */
  private defaultId(): string | undefined {
    const chosen = this.sql.exec("SELECT value FROM settings WHERE key = 'default'").toArray()[0]?.value;
    if (chosen !== undefined && this.card(String(chosen))) return String(chosen);
    return this.cards().sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0]?.id;
  }

  /** A notebook by its ID, or by a title that makes its ID, such as "Gym rollup" for gym-rollup. */
  private find(name: string): string | undefined {
    const trimmed = name.trim();
    if (this.card(trimmed)) return trimmed;
    const slug = slugify(trimmed);
    if (slug && this.card(slug)) return slug;
    const lower = trimmed.toLowerCase();
    return this.cards().find((card) => card.title.toLowerCase() === lower)?.id;
  }

  private need(id: string): NotebookCard {
    const card = this.card(id);
    if (!card) throw new UserError(`No notebook "${id}".`);
    return card;
  }

  private save(card: NotebookCard): void {
    this.sql.exec('INSERT INTO cards (id, card) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET card = excluded.card', card.id, JSON.stringify(card));
  }

  /** Takes back a card whose room didn't start; Home may have seen it from the room's first report. */
  private remove(id: string): void {
    this.sql.exec('DELETE FROM cards WHERE id = ?', id);
    this.options.onChange?.({ type: 'removed', id });
  }
}
