/**
 * Undo this commit (step 3.2c), and the smaller things built with it: images nobody uses are
 * tidied away, titles are kept as plain text, and new notebooks keep Unix line endings.
 */
import { type Block, INSTRUCTIONS_CHANGE, LAYOUT_CHANGE, blockHash, readInstructions } from '@inklog/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runTool } from '../src/agent.js';
import { EditorApi } from '../src/editor-api.js';
import { Engine } from '../src/engine.js';
import { MemoryStore } from '../src/memory-store.js';
import { initNotebook } from '../src/notebook.js';

const KARAN = { name: 'Karan', email: 'karan@example.com' };
const AGENT = 'Claude via claude.ai';
const PERSON = { kind: 'person' } as const;

async function notebook(): Promise<{ store: MemoryStore; engine: Engine }> {
  const store = new MemoryStore(KARAN);
  await initNotebook(store, { name: 'gym-rollup', person: KARAN });
  return { store, engine: await Engine.fromStore(store) };
}

const texts = (engine: Engine, id: string) => engine.section(id)!.blocks.map((block) => block.text);
const block = (engine: Engine, id: string, text: string): Block => engine.section(id)!.blocks.find((candidate) => candidate.text === text)!;

afterEach(() => {
  vi.useRealTimers();
});

describe('undo this commit', () => {
  async function planned(): Promise<{ store: MemoryStore; engine: Engine; first: Block; second: Block }> {
    const { store, engine } = await notebook();
    const heading = engine.section('overview')!.blocks[0]!;
    await runTool(engine, AGENT, 'patch', {
      path: 'overview',
      ops: [
        { op: 'insert', after: heading.id, text: 'Price: 999 a month.' },
        { op: 'insert', after: heading.id, text: 'Open in Mumbai first.' },
      ],
      commit: 'Plan',
    });
    return { store, engine, first: block(engine, 'overview', 'Price: 999 a month.'), second: block(engine, 'overview', 'Open in Mumbai first.') };
  }

  it("turns a commit's changes back into the person's uncommitted changes", async () => {
    const { store, engine, first, second } = await planned();
    await runTool(engine, AGENT, 'patch', {
      path: 'overview',
      ops: [
        { op: 'replace', id: first.id, base: blockHash(first), text: 'Price: 1,499 a month.' },
        { op: 'delete', id: second.id, base: blockHash(second) },
        { op: 'insert', after: null, text: 'A new idea.' },
      ],
      commit: 'Change the plan',
    });
    const head = await store.head();
    expect(await engine.undoCommit('#3')).toEqual(["Undid #3's changes to overview."]);
    expect(texts(engine, 'overview')).toEqual(['Gym Rollup', 'Price: 999 a month.', 'Open in Mumbai first.']);
    expect(await store.head()).toBe(head);
    expect(engine.pending().map(({ key, change, by }) => ({ key, change, by }))).toEqual([
      { key: first.id, change: 'modified', by: ['person'] },
      { key: second.id, change: 'added', by: ['person'] },
      { key: expect.stringMatching(/^removed:/), change: 'removed', by: ['person'] },
    ]);
    // The person commits it; the text is as it was before #3.
    await engine.commit('Undo #3');
    expect(await engine.snapshot((await store.head())!)).toEqual(await engine.snapshot(engine.resolveCommit('#2')!));
  });

  it('keeps what was written since, and says which changes it kept', async () => {
    const { engine, first, second } = await planned();
    await runTool(engine, AGENT, 'patch', {
      path: 'overview',
      ops: [
        { op: 'replace', id: first.id, base: blockHash(first), text: 'Price: 1,499 a month.' },
        { op: 'replace', id: second.id, base: blockHash(second), text: 'Open in Pune first.' },
      ],
      commit: 'Change the plan',
    });
    const edited = block(engine, 'overview', 'Open in Pune first.');
    engine.save('overview', engine.section('overview')!.version, engine.section('overview')!.blocks.map((b) => (b.id === edited.id ? { ...b, text: 'Open in Pune and Nashik first.' } : b)));
    expect(await engine.undoCommit('#3')).toEqual(["Undid #3's changes to overview.", 'Kept 1 block(s) that #3 changed and that were changed again since.']);
    expect(texts(engine, 'overview')).toEqual(['Gym Rollup', 'Price: 999 a month.', 'Open in Pune and Nashik first.']);
  });

  it('removes a section the commit made, unless someone wrote in it since', async () => {
    const { engine } = await notebook();
    await runTool(engine, AGENT, 'organize', { ops: [{ op: 'section', name: 'Pricing' }, { op: 'section', name: 'Staff' }], commit: 'Add sections' });
    const heading = engine.section('staff')!.blocks[0]!;
    await runTool(engine, AGENT, 'patch', { path: 'staff', ops: [{ op: 'insert', after: heading.id, text: 'Hire two trainers.' }] });
    expect(await engine.undoCommit('#2')).toEqual(['Removed pricing, which #2 made.', "Undid #2's changes to staff."]);
    expect(engine.section('pricing')).toBeUndefined();
    expect(texts(engine, 'staff')).toEqual(['Hire two trainers.']);
    expect(engine.pending()).toContainEqual(expect.objectContaining({ section: 'pricing', change: 'removed', by: ['person'] }));
  });

  it('brings back a section the commit deleted, in its place, with its front matter', async () => {
    const { store, engine } = await notebook();
    await engine.organize([{ op: 'folder', name: 'Research' }, { op: 'section', title: 'Pricing', in: 'research' }], PERSON);
    await engine.commit('Add pricing');
    await engine.flush();
    const file = (await store.read('sections/research/pricing.md'))!;
    await engine.deleteSection('pricing');
    await engine.commit('Delete pricing');
    expect(await engine.undoCommit('#3')).toEqual(['Brought back pricing, which #3 deleted.']);
    await engine.flush();
    expect(await store.read('sections/research/pricing.md')).toBe(file);
    expect(engine.info().tree).toEqual(['overview', { folder: 'research', name: 'Research', items: ['pricing'] }]);
    expect(engine.pending()).toEqual([expect.objectContaining({ section: 'pricing', change: 'added', by: ['person'] })]);
  });

  it('moves a section back unless it was moved again since, and puts folders and their order back', async () => {
    const { engine } = await notebook();
    await engine.organize([{ op: 'folder', name: 'Research' }, { op: 'folder', name: 'Archive' }, { op: 'section', title: 'Pricing', in: 'research' }, { op: 'section', title: 'Staff', in: 'research' }], PERSON);
    await engine.commit('Arrange');
    const before = engine.info().tree;
    await engine.organize([{ op: 'move', id: 'pricing', to: '' }, { op: 'move', id: 'staff', to: '' }, { op: 'rename', folder: 'research', name: 'Studies' }], PERSON);
    await engine.commit('Rearrange');
    expect(await engine.undoCommit('#3')).toEqual(['Moved pricing to research/, staff to research/.', 'Put the folders and their order back as they were before #3.']);
    expect(engine.info().tree).toEqual(before);
    expect(engine.pending()).toEqual([{ ...LAYOUT_CHANGE, change: 'moved', by: ['person'], held: false, included: true }]);

    // Moved again since: it stays, and the order isn't touched.
    await engine.commit('Undo #3');
    await engine.organize([{ op: 'move', id: 'pricing', to: 'archive' }, { op: 'move', id: 'staff', to: 'archive' }], PERSON);
    await engine.commit('Archive');
    await engine.organize([{ op: 'move', id: 'staff', to: '' }], PERSON);
    expect(await engine.undoCommit('#5')).toEqual([
      'staff was moved again since #5, so it stays where it is.',
      'Moved pricing to research/.',
      'The folders and order changed again since #5, so only the moves were undone.',
    ]);
    expect(engine.info().sections.map(({ id, folder }) => [id, folder])).toEqual([['overview', ''], ['pricing', 'research'], ['staff', '']]);
  });

  it('leaves the folders and order alone when they changed again since, and says so', async () => {
    const { engine } = await notebook();
    await engine.organize([{ op: 'section', title: 'Pricing' }], PERSON);
    await engine.commit('Add pricing');
    await engine.organize([{ op: 'move', id: 'pricing', after: null }], PERSON);
    await engine.commit('Pricing first');
    expect(engine.info().tree).toEqual(['pricing', 'overview']);
    await engine.organize([{ op: 'folder', name: 'Later' }], PERSON);
    expect(await engine.undoCommit('#3')).toEqual(['The folders and order changed again since #3, so they stay as they are.']);
    expect(engine.info().tree).toEqual(['pricing', 'overview', { folder: 'later', name: 'Later', items: [] }]);
  });

  it('puts the AI instructions back, unless they changed since', async () => {
    const { store, engine } = await notebook();
    await engine.setInstructions('Be brief.');
    await engine.commit('Instructions');
    await engine.setInstructions('Be thorough.');
    await engine.commit('Change instructions');
    expect(await engine.undoCommit('#3')).toEqual(['Put the AI instructions back as they were before #3.']);
    expect(engine.instructions()).toBe('Be brief.');
    expect(engine.pending()).toEqual([{ ...INSTRUCTIONS_CHANGE, change: 'modified', by: ['person'], held: false, included: true }]);
    await engine.setInstructions('Be kind.');
    expect(await engine.undoCommit('#3')).toEqual(['The AI instructions changed since #3, so they stay as they are.']);
    expect(readInstructions(await store.read('AGENTS.md'))).toBe('Be kind.');
  });

  it('says when there is nothing to undo, and refuses the first commit, the upgrade and unknown commits', async () => {
    const { engine } = await planned();
    await engine.undoCommit('#2');
    await engine.commit('Undo #2');
    expect(await engine.undoCommit('#2')).toEqual(['Nothing to undo: everything #2 changed is already as it was before it.']);
    await expect(engine.undoCommit('#1')).rejects.toThrow('#1 started the notebook, so there is nothing before it to go back to.');
    await expect(engine.undoCommit('#99')).rejects.toThrow('No commit "#99"');
  });

  it('is an editor call', async () => {
    const { engine } = await planned();
    const api = new EditorApi(engine);
    const reply = await api.call({ method: 'POST', path: 'undo', query: new URLSearchParams(), body: async () => new TextEncoder().encode('{"commit":"#2"}') });
    expect(reply).toEqual({ status: 200, json: { lines: ["Undid #2's changes to overview."] } });
    expect(texts(engine, 'overview')).toEqual(['Gym Rollup']);
  });
});

describe('images nobody uses', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

  it('are removed a day after Quillipi first finds them unused, unless a section or a commit has them', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-14T10:00:00Z'), toFake: ['Date'] });
    const { store, engine } = await notebook();
    const unused = await engine.addAsset(PNG, 'png');
    const committed = await engine.addAsset(new Uint8Array([...PNG, 4]), 'png');
    const used = await engine.addAsset(new Uint8Array([...PNG, 5]), 'png');
    const overview = engine.section('overview')!;
    const image = (id: string, src: string): Block => ({ id, type: 'image', text: '', attrs: { src } });
    engine.save('overview', overview.version, [...overview.blocks, image('imgaaaaa', committed)]);
    await engine.commit('Add a picture');
    const now = engine.section('overview')!;
    // The picture in the commit is deleted again; another one is in use but not committed.
    engine.save('overview', now.version, [...now.blocks.filter((b) => b.type !== 'image'), image('imgbbbbb', used)]);
    await engine.flush();

    await Engine.fromStore(store); // the clock starts for the unused one
    vi.setSystemTime(new Date('2026-11-15T09:59:00Z'));
    await Engine.fromStore(store);
    expect(await store.readBytes(unused)).toBeDefined();
    vi.setSystemTime(new Date('2026-11-15T10:01:00Z'));
    await (await Engine.fromStore(store)).flush();
    expect(await store.readBytes(unused)).toBeUndefined();
    expect(await store.readBytes(committed)).toBeDefined();
    expect(await store.readBytes(used)).toBeDefined();
    expect(JSON.parse((await store.read('.inklog/state.json'))!).unusedAssets).toBeUndefined();
  });
});

describe('titles and new notebooks', () => {
  it('keeps titles as plain text, written as the editor writes them', async () => {
    const { engine } = await notebook();
    await runTool(engine, AGENT, 'organize', { ops: [{ op: 'section', name: 'create_section and *stars*' }] });
    expect(texts(engine, 'create-section-and-stars')).toEqual(['create\\_section and \\*stars\\*']);
    expect(engine.info().sections.at(-1)?.title).toBe('create_section and *stars*');
  });

  it('stores what an agent writes as the editor writes it, and finds it by its plain form too', async () => {
    const { engine } = await notebook();
    const heading = engine.section('overview')!.blocks[0]!;
    await runTool(engine, AGENT, 'patch', { path: 'overview', ops: [{ op: 'insert', after: heading.id, text: 'Uses create_section and *this*.' }] });
    const written = block(engine, 'overview', 'Uses create\\_section and _this_.');
    expect(written).toBeDefined();
    const reply = await runTool(engine, AGENT, 'patch', { path: 'overview', ops: [{ op: 'replace', id: written.id, base: blockHash(written), find: 'create_section', with: 'organize_section' }] });
    expect(reply).toContain(`✓ edited ^${written.id}`);
    expect(texts(engine, 'overview')[1]).toBe('Uses organize\\_section and _this_.');
  });

  it("keeps a person's italics inside a word when an agent edits elsewhere in the block", async () => {
    vi.useFakeTimers({ now: new Date('2026-11-14T10:00:00Z'), toFake: ['Date'] });
    const { engine } = await notebook();
    const overview = engine.section('overview')!;
    // As the editor writes it: italics inside a word with `_`.
    engine.save('overview', overview.version, [...overview.blocks, { id: 'personaa', type: 'p', text: 'un_believ_able and a\\_b' }]);
    const person = block(engine, 'overview', 'un_believ_able and a\\_b');
    expect(person).toBeDefined();
    vi.setSystemTime(new Date('2026-11-14T10:00:05Z')); // past the guard on blocks a person just typed in
    await runTool(engine, AGENT, 'patch', { path: 'overview', ops: [{ op: 'replace', id: person.id, base: blockHash(person), find: 'a\\_b', with: 'snake_case' }] });
    expect(texts(engine, 'overview')[1]).toBe('un_believ_able and snake\\_case');
  });

  it('gives a new notebook a .gitattributes that keeps Unix line endings', async () => {
    const { store } = await notebook();
    expect(await store.readAt((await store.head())!, '.gitattributes')).toBe('# Unix line endings on every computer, as Quillipi writes them.\n* text=auto eol=lf\n');
  });
});

describe('what a commit changed, for the History panel', () => {
  it('counts the blocks a commit added, edited, moved and removed in each section', async () => {
    const { engine } = await notebook();
    const heading = engine.section('overview')!.blocks[0]!;
    await runTool(engine, AGENT, 'patch', {
      path: 'overview',
      ops: [
        { op: 'insert', after: heading.id, text: 'Price: 999 a month.' },
        { op: 'insert', after: heading.id, text: 'Open in Mumbai first.' },
        { op: 'insert', after: heading.id, text: 'Hire two trainers.' },
      ],
      commit: 'Plan',
    });
    const price = block(engine, 'overview', 'Price: 999 a month.');
    const mumbai = block(engine, 'overview', 'Open in Mumbai first.');
    const trainers = block(engine, 'overview', 'Hire two trainers.');
    await runTool(engine, AGENT, 'patch', {
      path: 'overview',
      ops: [
        { op: 'replace', id: price.id, base: blockHash(price), text: 'Price: 1,499 a month.' },
        { op: 'delete', id: mumbai.id, base: blockHash(mumbai) },
        { op: 'move', id: trainers.id, after: heading.id },
        { op: 'insert', after: price.id, text: 'A cross-gym pass later.' },
      ],
      commit: 'Reprice',
    });

    expect(await engine.commitDetails('#2')).toEqual({
      oid: engine.resolveCommit('#2'),
      sections: [{ id: 'overview', title: 'Gym Rollup', folder: '', added: 3, edited: 0, moved: 0, removed: 0 }],
      layout: false,
      instructions: false,
      details: false,
    });
    const reprice = await engine.commitDetails('#3');
    expect(reprice.sections).toEqual([{ id: 'overview', title: 'Gym Rollup', folder: '', added: 1, edited: 1, moved: 1, removed: 1 }]);
    // The same answer, kept, the second time.
    expect(await engine.commitDetails('#3')).toBe(reprice);
  });

  it('says which sections a commit made, deleted or moved, and what else it changed', async () => {
    const { engine } = await notebook();
    await engine.organize([{ op: 'section', title: 'Pricing' }], PERSON);
    await engine.commit('Add pricing');
    await engine.organize([{ op: 'folder', name: 'Research' }, { op: 'move', id: 'pricing', to: 'research' }], PERSON);
    await engine.setInstructions('Write completely.');
    await engine.commit('File pricing under research');
    await engine.deleteSection('pricing');
    await engine.commit('Drop pricing');
    await engine.setDetails({ name: 'Gym rollup plan' });

    const made = await engine.commitDetails('#2');
    expect(made.sections).toEqual([{ id: 'pricing', title: 'Pricing', folder: '', added: 1, edited: 0, moved: 0, removed: 0, what: 'made' }]);
    expect(made.layout).toBe(false);

    const filed = await engine.commitDetails('#3');
    expect(filed.sections).toEqual([{ id: 'pricing', title: 'Pricing', folder: 'research', added: 0, edited: 0, moved: 0, removed: 0, what: 'moved' }]);
    expect(filed).toMatchObject({ layout: true, instructions: true, details: false });

    const dropped = await engine.commitDetails('#4');
    expect(dropped.sections).toEqual([{ id: 'pricing', title: 'Pricing', folder: 'research', added: 0, edited: 0, moved: 0, removed: 1, what: 'deleted' }]);
    expect(dropped).toMatchObject({ layout: false, instructions: false });

    expect(await engine.commitDetails('#5')).toMatchObject({ sections: [], details: true, layout: false });
    // The first commit made the notebook's first section.
    expect((await engine.commitDetails('#1')).sections.map((section) => section.what)).toEqual(['made']);
    await expect(engine.commitDetails('#99')).rejects.toThrow('No commit "#99"');
  });

  it('answers the editor at GET commit', async () => {
    const { engine } = await notebook();
    const api = new EditorApi(engine);
    const reply = await api.call({ method: 'GET', path: 'commit', query: new URLSearchParams({ commit: '#1' }), body: async () => new Uint8Array() });
    expect(reply).toMatchObject({ status: 200, json: { sections: [{ id: 'overview', what: 'made' }] } });
    // The commits that changed one section, for the panel's "This section".
    await engine.organize([{ op: 'section', title: 'Pricing' }], PERSON);
    await engine.commit('Add pricing');
    const history = await api.call({ method: 'GET', path: 'history', query: new URLSearchParams({ section: 'pricing' }), body: async () => new Uint8Array() });
    expect(history).toEqual({ status: 200, json: { commits: [engine.resolveCommit('#2')] } });
    const missing = await api.call({ method: 'GET', path: 'commit', query: new URLSearchParams({ commit: '#7' }), body: async () => new Uint8Array() });
    expect(missing.status).toBe(400);
  });
});
