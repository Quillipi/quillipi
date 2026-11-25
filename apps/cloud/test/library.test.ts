import { type NotebookSummary, NOTEBOOK_COLOURS } from '@inklog/core';
import { UserError } from '@inklog/engine';
import { describe, expect, it } from 'vitest';
import { LIBRARY_STORAGE, Library, type LibraryChange, NEW_NOTEBOOKS_PER_DAY, type Rooms } from '../src/library.js';
import { LibraryObject } from '../src/library-object.js';
import type { NewNotebookDetails } from '../src/notebook-host.js';
import { nodeSql } from './node-sql.js';

const DAY = 24 * 60 * 60_000;

/** Rooms that remember what they were asked, and can be told to be taken or to fail. */
function rooms({ taken = new Set<string>(), failing = new Set<string>(), adopt = async (id: string) => `${id}: importing.` } = {}) {
  const made: [string, NewNotebookDetails][] = [];
  const asked: string[] = [];
  const stub: Rooms = {
    async create(id, details) {
      asked.push(id);
      if (failing.has(id)) throw new Error('The room is down.');
      if (taken.has(id)) return 'taken';
      made.push([id, details]);
      return 'made';
    },
    adopt,
  };
  return { stub, made, asked };
}

function library({ now = () => 1_800_000_000_000, ...options }: { now?: () => number; rooms?: Rooms; changes?: LibraryChange[] } = {}) {
  const changes = options.changes ?? [];
  return new Library(nodeSql(), { rooms: options.rooms ?? rooms().stub, now, onChange: (change) => changes.push(change) });
}

function summary(over: Partial<NotebookSummary> = {}): NotebookSummary {
  return { title: 'T', sections: 1, folders: 0, commits: 1, uncommitted: 0, agentUncommitted: 0, held: 0, recent: [], agentCommits: [], backup: { state: 'backed-up', text: 'Backed up.' }, ...over };
}

describe('making notebooks', () => {
  it('gives each a permanent ID from its title, its own colour, and a card; the room starts with the title and line', async () => {
    const room = rooms();
    const changes: LibraryChange[] = [];
    const lib = library({ rooms: room.stub, changes });
    const card = await lib.create({ title: '  Gym   rollup ', about: 'Take over struggling gyms\nand standardise them', by: 'Claude via claude.ai', byAgent: true });
    expect(card).toMatchObject({ id: 'gym-rollup', title: 'Gym rollup', about: 'Take over struggling gyms and standardise them', createdBy: 'Claude via claude.ai', byAgent: true, from: 'new', archived: false });
    expect(NOTEBOOK_COLOURS).toContain(card.colour);
    expect(room.made).toEqual([['gym-rollup', { title: 'Gym rollup', about: 'Take over struggling gyms and standardise them', colour: card.colour }]]);
    expect(changes).toEqual([{ type: 'card', card }]);
    // The same title again gets the next free ID; a chosen colour is kept.
    expect((await lib.create({ title: 'Gym Rollup!', colour: '#0f8b8d', by: 'The Octocat' })).id).toBe('gym-rollup-2');
    expect(lib.card('gym-rollup-2')).toMatchObject({ colour: '#0f8b8d', createdBy: 'The Octocat', byAgent: false });
    expect((await lib.create({ title: '日本', by: 'The Octocat' })).id).toBe('notebook');
    expect((await lib.create({ title: 'x'.repeat(100), by: 'The Octocat' })).id).toBe('x'.repeat(60));
    expect((await lib.create({ title: 'x'.repeat(100), by: 'The Octocat' })).id).toBe(`${'x'.repeat(58)}-2`);
  });

  it('takes the ID before asking the room, so two at once never get the same one', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const room = rooms();
    const slow: Rooms = { ...room.stub, create: async (id, details) => (await gate, room.stub.create(id, details)) };
    const lib = library({ rooms: slow });
    const both = Promise.all([lib.create({ title: 'Plan', by: 'a' }), lib.create({ title: 'Plan', by: 'b' })]);
    release();
    expect((await both).map((card) => card.id)).toEqual(['plan', 'plan-2']);
  });

  it('skips a room that already holds a notebook the library does not list, and takes back a card whose room failed', async () => {
    const room = rooms({ taken: new Set(['inklog-notebook-test']), failing: new Set(['broken']) });
    const changes: LibraryChange[] = [];
    const lib = library({ rooms: room.stub, changes });
    expect((await lib.create({ title: 'Inklog notebook test', by: 'k' })).id).toBe('inklog-notebook-test-2');
    expect(room.asked).toEqual(['inklog-notebook-test', 'inklog-notebook-test-2']);
    await expect(lib.create({ title: 'Broken', by: 'k' })).rejects.toThrow('The room is down.');
    expect(lib.card('broken')).toBeUndefined();
    expect(changes.filter((change) => change.type === 'removed').map((change) => (change as { id: string }).id)).toEqual(['inklog-notebook-test', 'broken']);
  });

  it(`makes at most ${NEW_NOTEBOOKS_PER_DAY} a day, counted by UTC day`, async () => {
    let now = Date.UTC(2026, 10, 15, 23, 0);
    const lib = library({ now: () => now });
    for (let i = 0; i < NEW_NOTEBOOKS_PER_DAY; i++) await lib.create({ title: `Idea ${i}`, by: 'Claude' });
    await expect(lib.create({ title: 'One more', by: 'Claude' })).rejects.toThrow(`Quillipi makes at most ${NEW_NOTEBOOKS_PER_DAY} notebooks a day, to stop a runaway agent.`);
    now += 2 * 60 * 60_000; // past midnight UTC
    expect((await lib.create({ title: 'One more', by: 'Claude' })).id).toBe('one-more');
  });

  it('refuses a missing or long title and a colour that is not #rrggbb, before touching a room', async () => {
    const room = rooms();
    const lib = library({ rooms: room.stub });
    await expect(lib.create({ title: '   ', by: 'k' })).rejects.toThrow('A new notebook needs a title.');
    await expect(lib.create({ title: 'x'.repeat(101), by: 'k' })).rejects.toThrow('at most 100 characters');
    await expect(lib.create({ title: 'Ok', colour: 'violet', by: 'k' })).rejects.toThrow('"violet" is not a colour');
    expect(room.asked).toEqual([]);
    expect(lib.cards()).toEqual([]);
  });
});

describe('adding a notebook from GitHub', () => {
  it("takes the repo's name as the ID, accepts owner/name, and asks the room to begin the import", async () => {
    const adopted: string[] = [];
    const lib = library({ rooms: rooms({ adopt: async (id) => (adopted.push(id), `octo-notebooks/${id}: importing, listing commits, 0 found so far.`) }).stub });
    const { card, status } = await lib.add({ repo: 'octo-notebooks/inklog', by: 'Claude via claude.ai', byAgent: true });
    expect(card).toMatchObject({ id: 'inklog', title: 'inklog', from: 'github', createdBy: 'Claude via claude.ai', byAgent: true });
    expect(status).toBe('octo-notebooks/inklog: importing, listing commits, 0 found so far.');
    expect(adopted).toEqual(['inklog']);
    await expect(lib.add({ repo: 'inklog', by: 'k' })).rejects.toThrow('The notebook inklog is already here.');
    await expect(lib.add({ repo: 'My_Notes', by: 'k' })).rejects.toThrow('"My_Notes" can\'t be a notebook\'s ID');
  });

  it('keeps no card when the room says what is missing on GitHub', async () => {
    const lib = library({ rooms: rooms({ adopt: async () => Promise.reject(new UserError('There is no notebook "nope" yet.')) }).stub });
    await expect(lib.add({ repo: 'nope', by: 'k' })).rejects.toThrow('There is no notebook "nope" yet.');
    expect(lib.cards()).toEqual([]);
  });
});

describe('finding notebooks', () => {
  it('routes by ID, by title, or to the default: the one made first until another is chosen', async () => {
    let now = 1_800_000_000_000;
    const lib = library({ now: () => now++ });
    expect(() => lib.route()).toThrow('There are no notebooks yet. Make one with create_notebook.');
    await lib.create({ title: 'First', by: 'k' });
    await lib.create({ title: 'Gym rollup', by: 'k' });
    expect(lib.route()).toEqual({ id: 'first' });
    // map names the notebooks, so a route for it carries them.
    expect(lib.route('first', true)).toEqual({ id: 'first', directory: { notebooks: [{ id: 'gym-rollup', title: 'Gym rollup' }, { id: 'first', title: 'First' }], default: 'first' } });
    expect(lib.route('gym-rollup').id).toBe('gym-rollup');
    expect(lib.route('Gym Rollup').id).toBe('gym-rollup');
    expect(lib.route(' GYM-ROLLUP ').id).toBe('gym-rollup');
    lib.update('gym-rollup', summary({ title: 'Gyms, standardised' }));
    expect(lib.route('gym rollup').id).toBe('gym-rollup'); // its ID still finds it after a rename
    expect(lib.route('Gyms, standardised').id).toBe('gym-rollup');
    expect(() => lib.route('gym')).toThrow(/^No notebook "gym"\. The notebooks here are: (gym-rollup, first|first, gym-rollup)\.$/);
    lib.setDefault('gym-rollup');
    expect(lib.route().id).toBe('gym-rollup');
    expect(() => lib.setDefault('nope')).toThrow('No notebook "nope".');
  });

  it("leaves archived notebooks out of the AIs' list, while their names still work", async () => {
    const lib = library();
    await lib.create({ title: 'Old idea', by: 'k' });
    await lib.create({ title: 'New idea', by: 'k' });
    lib.archive('old-idea', true);
    expect(lib.directory().notebooks.map((notebook) => notebook.id)).toEqual(['new-idea']);
    expect(lib.route('old-idea').id).toBe('old-idea');
  });

  it("keeps each room's report on its card, with the title, line and colour the notebook keeps", async () => {
    let now = 1_800_000_000_000;
    const changes: LibraryChange[] = [];
    const lib = library({ now: () => (now += 1000), changes });
    await lib.create({ title: 'Plan', about: 'First line', by: 'k' });
    lib.update('plan', summary({ title: 'Renamed plan', colour: '#c4413b' }));
    expect(lib.card('plan')).toMatchObject({ title: 'Renamed plan', colour: '#c4413b', summary: { title: 'Renamed plan' } });
    expect(lib.card('plan')!.about).toBeUndefined();
    expect(changes.at(-1)).toEqual({ type: 'card', card: lib.card('plan') });
    lib.update('gone', summary()); // a room the library no longer lists
    expect(lib.cards().map((card) => card.id)).toEqual(['plan']);
  });
});

describe("the owner's instructions for every notebook", () => {
  it('keeps every version, newest first, and gives the newest to every tool call', () => {
    let now = 1_800_000_000_000;
    const lib = library({ now: () => (now += 1000) });
    expect(lib.instructions()).toBe('');
    lib.setInstructions('Write completely and correctly.\r\n');
    lib.setInstructions('Write completely and correctly.'); // unchanged: no new version
    lib.setInstructions("Write completely and correctly. Say what you didn't check.");
    expect(lib.instructionHistory().map((version) => version.text)).toEqual(["Write completely and correctly. Say what you didn't check.", 'Write completely and correctly.']);
    expect(() => lib.setInstructions('x'.repeat(20_001))).toThrow('at most 20000 characters');
    for (let i = 0; i < 60; i++) lib.setInstructions(`Version ${i}`);
    expect(lib.instructionHistory()).toHaveLength(50);
    expect(lib.instructions()).toBe('Version 59');
  });

  it('passes them with every route', async () => {
    const lib = library();
    await lib.create({ title: 'Plan', by: 'k' });
    lib.setInstructions('Write completely and correctly.');
    expect(lib.route('plan')).toEqual({ id: 'plan', shared: 'Write completely and correctly.' });
  });
});

it('remembers when each person last opened Home', () => {
  let now = 1_800_000_000_000;
  const lib = library({ now: () => now });
  expect(lib.visit('The Octocat')).toBeUndefined();
  now += DAY;
  expect(lib.visit('The Octocat')).toBe(1_800_000_000_000);
  expect(lib.visit('The Octocat')).toBe(1_800_000_000_000 + DAY);
});

describe('the first AI app’s connection', () => {
  it('is noted once, and every open Home is told the first time', () => {
    const changes: LibraryChange[] = [];
    const shelf = library({ changes });
    expect(shelf.aiConnected()).toBe(false);
    shelf.noteAiConnected();
    shelf.noteAiConnected();
    expect(shelf.aiConnected()).toBe(true);
    expect(changes).toEqual([{ type: 'ai' }]);
    // It is no setting: nothing outside the library sees it as one.
    expect(shelf.settings()).toEqual({});
  });

  it('is still known from the note Claude’s connection left before 0.5.0, under the same key', () => {
    const sql = nodeSql();
    sql.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    sql.exec("INSERT INTO settings (key, value) VALUES ('claude', '1800000000000')");
    expect(new Library(sql, { rooms: rooms().stub }).aiConnected()).toBe(true);
  });
});

describe("the library's Durable Object", () => {
  it('tells every open Home what changed, and skips a connection that has gone', async () => {
    const sql = nodeSql();
    const sent: string[][] = [[], []];
    const gone = () => {
      throw new Error('closed');
    };
    const sockets = [{ send: (message: string) => void sent[0]!.push(message) }, { send: gone }, { send: (message: string) => void sent[1]!.push(message) }];
    const ctx = { storage: { sql: { exec: (query: string, ...bindings: never[]) => sql.exec(query, ...bindings) }, transactionSync: (body: () => unknown) => sql.transaction(body) }, getWebSockets: () => sockets };
    const room = { create: async () => 'made', adopt: async () => 'ok', runTool: async () => 'map' };
    const env = { NOTEBOOK: { idFromName: (name: string) => name, get: () => room } };
    const library = new LibraryObject(ctx as never, env as never);
    const card = await library.create({ title: 'Plan', by: 'The Octocat' });
    expect(sent[0]).toEqual([JSON.stringify({ type: 'card', card })]);
    expect(sent[1]).toEqual(sent[0]);
    expect(library.ping()).toBe('ok');
  });
});

describe("the library's storage version", () => {
  it('is recorded, is not a setting, and a library a newer Quillipi wrote is refused and left as it was', async () => {
    const sql = nodeSql();
    const first = new Library(sql, { rooms: rooms().stub });
    expect(sql.exec("SELECT value FROM settings WHERE key = 'storage'").toArray()[0]?.value).toBe(String(LIBRARY_STORAGE));
    expect(first.settings()).toEqual({});
    await first.create({ title: 'Plan', by: 'The Octocat' });
    sql.exec("UPDATE settings SET value = '2' WHERE key = 'storage'");
    sql.exec('DROP TABLE visits'); // as a newer shape might have
    expect(() => new Library(sql, { rooms: rooms().stub })).toThrow("Quillipi’s library was saved by a newer Quillipi (storage version 2; this one reads up to 1). Update this Quillipi to its newest release; nothing was changed.");
    expect(sql.exec("SELECT name FROM sqlite_master WHERE name = 'visits'").toArray()).toEqual([]);
    expect(sql.exec('SELECT id FROM cards').toArray()).toEqual([{ id: 'plan' }]);
  });
});
