/**
 * Folders and permanent section IDs (step 3.2b): organize, the arrangement as one committable
 * change, deletes, history and comparisons across moves, old names, and the one-time upgrade of
 * notebooks from before folders. On a store in memory; the laptop's folder with Git is covered in
 * apps/inklog/test/folders.test.ts.
 */
import { type Block, LAYOUT_CHANGE, blockHash, parseMeta } from '@inklog/core';
import { describe, expect, it } from 'vitest';
import { runTool } from '../src/agent.js';
import { EditorApi } from '../src/editor-api.js';
import { Engine, UserError } from '../src/engine.js';
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

/** A notebook with a folder `research` holding `pricing`, and `overview` at the top, all committed. */
async function withResearch(): Promise<{ store: MemoryStore; engine: Engine }> {
  const opened = await notebook();
  await opened.engine.organize([{ op: 'folder', name: 'Research' }, { op: 'section', title: 'Pricing', in: 'research' }], PERSON);
  await opened.engine.commit('Add research');
  await opened.engine.flush();
  return opened;
}

async function committedFiles(store: MemoryStore): Promise<string[]> {
  return [...(await store.filesAt((await store.head())!)).keys()].filter((rel) => rel.startsWith('sections/')).sort();
}

const heading = (engine: Engine, id: string): Block => engine.section(id)!.blocks[0]!;

describe('organize', () => {
  it('makes folders and sections in them, with files named after their IDs', async () => {
    const { store, engine } = await notebook();
    const reply = await runTool(engine, AGENT, 'organize', {
      ops: [
        { op: 'folder', name: 'Research & Interviews' },
        { op: 'section', name: 'Pricing', in: 'research-interviews' },
        { op: 'folder', name: 'Raw', in: 'research-interviews/' },
        { op: 'section', name: 'Call with Priya', in: 'Raw', after: null },
        { op: 'section', name: 'Pricing', after: 'overview' },
      ],
    });
    expect(reply).toContain(
      '✓ folder research-interviews/ "Research & Interviews"\n✓ section pricing in research-interviews/\n✓ folder research-interviews/raw/ "Raw"\n✓ section call-with-priya in research-interviews/raw/\n✓ section pricing-2 in the top',
    );
    expect(reply).toMatch(/pricing-2 "Pricing" · 1 blocks .*\n\^[a-z2-9]{8} h1 @[0-9a-f]+ Pricing$/);
    expect(engine.info().tree).toEqual([
      'overview',
      'pricing-2',
      { folder: 'research-interviews', name: 'Research & Interviews', items: ['pricing', { folder: 'raw', name: 'Raw', items: ['call-with-priya'] }] },
    ]);
    await engine.flush();
    expect(await store.read('sections/research-interviews/raw/call-with-priya.md')).toMatch(/^---\nid: call-with-priya\n---\n\n# Call with Priya \^/);
    expect(parseMeta(await store.read('inklog.json')).tree).toEqual(engine.info().tree);
    expect(engine.info().sections.map(({ id, folder, depth }) => `${id}@${folder}:${depth}`)).toEqual([
      'overview@:0',
      'pricing-2@:0',
      'pricing@research-interviews:1',
      'call-with-priya@research-interviews/raw:2',
    ]);
  });

  it('moves sections and folders, and renames folders, moving their files', async () => {
    const { store, engine } = await withResearch();
    await engine.organize([{ op: 'folder', name: 'Archive' }, { op: 'move', id: 'research/', to: 'archive' }, { op: 'move', id: 'overview', to: 'archive/research' }], PERSON);
    await engine.organize([{ op: 'rename', folder: 'archive/research', name: 'Old Research' }], PERSON);
    await engine.flush();
    expect(engine.info().tree).toEqual([{ folder: 'archive', name: 'Archive', items: [{ folder: 'old-research', name: 'Old Research', items: ['pricing', 'overview'] }] }]);
    expect((await store.list('sections', '.md')).sort()).toEqual(['sections/archive/old-research/overview.md', 'sections/archive/old-research/pricing.md']);
    // Within a folder, a move without `to` reorders.
    await engine.organize([{ op: 'move', id: 'overview', after: null }], PERSON);
    expect(engine.info().tree).toEqual([{ folder: 'archive', name: 'Archive', items: [{ folder: 'old-research', name: 'Old Research', items: ['overview', 'pricing'] }] }]);
  });

  it('keeps both of two arrangements that arrive at once, and lets two files swap places', async () => {
    const { store, engine } = await withResearch();
    await Promise.all([engine.organize([{ op: 'move', id: 'pricing', to: '' }], PERSON), engine.organize([{ op: 'folder', name: 'Ideas' }], PERSON)]);
    expect(engine.info().tree).toEqual(['overview', { folder: 'research', name: 'Research', items: [] }, 'pricing', { folder: 'ideas', name: 'Ideas', items: [] }]);

    // Two sections whose files share a name, in different folders, trade folders in one call.
    await store.write('sections/research/notes.md', '---\nid: one\n---\n\n# One ^aaaaaaaa\n');
    await store.write('sections/ideas/notes.md', '---\nid: two\n---\n\n# Two ^bbbbbbbb\n');
    await engine.fileChanged('sections/research/notes.md');
    await engine.fileChanged('sections/ideas/notes.md');
    await engine.organize([{ op: 'move', id: 'one', to: 'ideas' }, { op: 'move', id: 'two', to: 'research' }], PERSON);
    await engine.flush();
    // The first to move finds the name taken and is named after its ID; the second takes the freed name.
    expect((await store.list('sections', '.md')).sort()).toEqual(['sections/ideas/one.md', 'sections/overview.md', 'sections/pricing.md', 'sections/research/notes.md']);
    expect(await store.read('sections/ideas/one.md')).toContain('# One');
    expect(await store.read('sections/research/notes.md')).toContain('# Two');

    // A chain: two leaves research/notes.md, and one takes it in the same call. Nothing is lost on the way.
    await engine.organize([{ op: 'move', id: 'two', to: '' }, { op: 'move', id: 'one', to: 'research' }, { op: 'move', id: 'one', to: 'ideas' }, { op: 'move', id: 'one', to: 'research' }], PERSON);
    await engine.flush();
    expect(await store.read('sections/notes.md')).toContain('# Two');
    expect(await store.read('sections/research/one.md')).toContain('# One');
  });

  it('applies all of its ops or none, and says which op failed', async () => {
    const { engine } = await withResearch();
    const before = JSON.stringify(engine.info().tree);
    await expect(engine.organize([{ op: 'folder', name: 'Ideas' }, { op: 'move', id: 'pricing', to: 'nowhere' }], PERSON)).rejects.toThrow(
      'Op 2: No folder "nowhere". The folders are: research/, ideas/. Nothing changed.',
    );
    expect(JSON.stringify(engine.info().tree)).toBe(before);
    expect(engine.pending()).toEqual([]);
  });

  it('refuses what would break the notebook', async () => {
    const { engine } = await withResearch();
    const refuse = (op: Parameters<Engine['organize']>[0][number]) => expect(engine.organize([op], PERSON)).rejects.toThrow(UserError);
    await refuse({ op: 'move', id: 'research/', to: 'research' });
    await refuse({ op: 'folder', name: 'research' });
    await refuse({ op: 'folder', name: '!!!' });
    await refuse({ op: 'section', title: '  ' });
    await refuse({ op: 'rename', folder: '', name: 'Top' });
    await refuse({ op: 'move', id: 'ghost', to: '' });
    await refuse({ op: 'section', title: 'x', after: 'not-here' });
    // Names never reach outside the notebook: they become slugs.
    await engine.organize([{ op: 'folder', name: '../../etc' }], PERSON);
    expect(engine.info().tree).toContainEqual({ folder: 'etc', name: '../../etc', items: [] });
    // Names Windows keeps for devices never become file or folder names.
    expect((await engine.organize([{ op: 'folder', name: 'Con' }, { op: 'section', title: 'Aux', in: 'con-folder' }], PERSON)).lines).toEqual([
      '✓ folder con-folder/ "Con"',
      '✓ section aux-2 in con-folder/',
    ]);
    // Folders nest only as deep as Windows' path limit allows.
    const deep = Array.from({ length: 4 }, (_, n) => `${'f'.repeat(40)}${n}`);
    await expect(
      engine.organize(
        deep.map((name, n) => ({ op: 'folder' as const, name, in: deep.slice(0, n).join('/') })),
        PERSON,
      ),
    ).rejects.toThrow('too long for Windows');
  });
});

describe('the arrangement in commits', () => {
  it('is one pending change, and a commit can hold only it', async () => {
    const { store, engine } = await withResearch();
    await engine.organize([{ op: 'move', id: 'overview', to: 'research', after: null }], PERSON);
    expect(engine.pending()).toEqual([{ ...LAYOUT_CHANGE, change: 'moved', by: ['person'], held: false, included: true }]);
    expect(await engine.commit('')).toMatchObject({ number: 3, message: 'Organize folders' });
    expect(engine.pending()).toEqual([]);
    expect(await committedFiles(store)).toEqual(['sections/research/overview.md', 'sections/research/pricing.md']);
    expect(parseMeta(await store.readAt((await store.head())!, 'inklog.json')).tree).toEqual([{ folder: 'research', name: 'Research', items: ['overview', 'pricing'] }]);
  });

  it('when left out, commits the text where the sections were, and keeps the move uncommitted', async () => {
    const { store, engine } = await withResearch();
    await engine.organize([{ op: 'move', id: 'pricing', to: '' }], PERSON);
    const title = heading(engine, 'pricing');
    engine.save('pricing', engine.section('pricing')!.version, [{ ...title, text: 'Pricing plans' }]);
    engine.setIncluded(LAYOUT_CHANGE.section, LAYOUT_CHANGE.key, false);
    await engine.commit('Rename the pricing section');
    expect(await committedFiles(store)).toEqual(['sections/overview.md', 'sections/research/pricing.md']);
    expect(await store.readAt((await store.head())!, 'sections/research/pricing.md')).toContain('# Pricing plans');
    expect(engine.pending().map((change) => change.key)).toEqual([LAYOUT_CHANGE.key]);
    expect(await store.read('sections/pricing.md')).toBeDefined(); // the working file stays where it moved

    engine.setIncluded(LAYOUT_CHANGE.section, LAYOUT_CHANGE.key, true);
    await engine.commit('Move pricing to the top');
    expect(await committedFiles(store)).toEqual(['sections/overview.md', 'sections/pricing.md']);
    expect(engine.pending()).toEqual([]);
  });

  it("goes in an agent's commit only when no person changed it too", async () => {
    const { engine } = await withResearch();
    const reply = await runTool(engine, AGENT, 'organize', { ops: [{ op: 'folder', name: 'Ideas' }, { op: 'move', id: 'overview', in: 'ideas' }], commit: 'File the overview under ideas' });
    expect(reply).toMatch(/✓ committed #3: File the overview under ideas/);
    expect(engine.commitList()[0]).toMatchObject({ agent: AGENT });
    expect(engine.pending()).toEqual([]);

    await engine.organize([{ op: 'move', id: 'overview', to: '' }], PERSON);
    await runTool(engine, AGENT, 'organize', { ops: [{ op: 'move', id: 'pricing', in: 'ideas' }] });
    const left = await runTool(engine, AGENT, 'commit', { message: 'Move pricing' });
    expect(left).toContain('Nothing of yours to commit.');
    expect(left).toContain('Left 1 change(s) (the folders and order among them) uncommitted for Karan');
    expect(engine.pending()).toMatchObject([{ key: 'layout', by: ['person', 'agent'] }]);
  });

  it('puts a new section in a new folder into the commit even when other moves are left out', async () => {
    const { store, engine } = await withResearch();
    await engine.organize([{ op: 'move', id: 'overview', to: 'research' }], PERSON);
    engine.setIncluded(LAYOUT_CHANGE.section, LAYOUT_CHANGE.key, false);
    await runTool(engine, AGENT, 'organize', { ops: [{ op: 'folder', name: 'Ideas' }, { op: 'section', name: 'Gyms in Pune', in: 'ideas' }] });
    await runTool(engine, AGENT, 'commit', { message: 'Add an idea' });
    expect(await committedFiles(store)).toEqual(['sections/ideas/gyms-in-pune.md', 'sections/overview.md', 'sections/research/pricing.md']);
    expect(parseMeta(await store.readAt((await store.head())!, 'inklog.json')).tree).toEqual([
      'overview',
      { folder: 'research', name: 'Research', items: ['pricing'] },
      { folder: 'ideas', name: 'Ideas', items: ['gyms-in-pune'] },
    ]);
  });
});

describe('deleting', () => {
  it('is the person’s change, even in blocks an agent edited', async () => {
    const { store, engine } = await withResearch();
    const title = heading(engine, 'pricing');
    await runTool(engine, AGENT, 'patch', { path: 'pricing', ops: [{ op: 'replace', id: title.id, base: blockHash(title), text: 'Prices' }] });
    await engine.deleteSection('pricing');
    expect(engine.pending()).toMatchObject([{ section: 'pricing', key: `removed:${title.id}`, by: ['agent', 'person'] }]);
    expect(await runTool(engine, AGENT, 'commit', { message: 'Delete pricing' })).toContain('Nothing of yours to commit.');
    await engine.commit('Delete pricing');
    expect(await committedFiles(store)).toEqual(['sections/overview.md']);
    expect(engine.info().tree).toEqual(['overview', { folder: 'research', name: 'Research', items: [] }]);
  });

  it('takes a folder with everything in it', async () => {
    const { store, engine } = await withResearch();
    const title = heading(engine, 'pricing');
    expect(await engine.deleteFolder('research/')).toBe(1);
    expect(engine.info().tree).toEqual(['overview']);
    expect(engine.pending().map((change) => change.key)).toEqual([`removed:${title.id}`, 'layout']);
    await engine.commit('');
    expect(await committedFiles(store)).toEqual(['sections/overview.md']);
    expect(parseMeta(await store.readAt((await store.head())!, 'inklog.json')).tree).toEqual(['overview']);
    await expect(engine.deleteFolder('nope')).rejects.toThrow('No folder "nope"');
  });
});

describe('history across moves', () => {
  it('follows a section back through a move, and shows the move in compare and changes', async () => {
    const { engine } = await withResearch();
    await runTool(engine, AGENT, 'map', {});
    await engine.organize([{ op: 'move', id: 'pricing', to: '' }], PERSON);
    await engine.commit('Move pricing');
    const title = heading(engine, 'pricing');
    await runTool(engine, AGENT, 'patch', { path: 'pricing', ops: [{ op: 'replace', id: title.id, base: blockHash(title), text: 'Prices' }], commit: 'Rename' });

    expect(await runTool(engine, AGENT, 'history', { path: 'pricing' })).toMatch(/^#4 .*Rename\n#3 .*Move pricing\n#2 .*Add research$/);
    expect(await runTool(engine, AGENT, 'compare', { from: '#2' })).toBe(
      `Changes from #2 to now:\npricing:\n  ↪ moved from research/ to the top\n  ~ ^${title.id} h1: Pricing → Prices`,
    );
    expect(await runTool(engine, AGENT, 'map', {})).toContain('since your last visit: pricing: 1 edited, moved from research/ to the top');
  });

  it('answers to the old names, which were paths', async () => {
    const { engine } = await withResearch();
    expect(engine.resolveSection('research/pricing')).toBe('pricing');
    expect(engine.resolveSection('sections/research/pricing.md')).toBe('pricing');
    expect(engine.resolveSection('Pricing')).toBe('pricing');
    expect(engine.resolveSection('nothing')).toBeUndefined();
    expect(await runTool(engine, AGENT, 'read', { path: 'research/pricing' })).toMatch(/^pricing "Pricing"/);
    const title = heading(engine, 'pricing');
    await runTool(engine, AGENT, 'patch', { ops: [{ op: 'replace', path: 'research/pricing', id: title.id, base: blockHash(title), text: 'Prices' }] });
    expect(heading(engine, 'pricing').text).toBe('Prices');
  });

  it('shows folders in map', async () => {
    const { engine } = await withResearch();
    const map = await runTool(engine, AGENT, 'map', {});
    expect(map).toContain('gym-rollup · 2 sections · 1 folder · 2 blocks');
    expect(map).toMatch(/\nresearch\/ "Research" · 1 section\n\n {2}pricing "Pricing" · 1 blocks/);
  });
});

describe('section IDs from files', () => {
  it('gives a file without an ID one from its name, and a copy an ID of its own', async () => {
    const { store, engine } = await withResearch();
    const original = (await store.read('sections/research/pricing.md'))!;
    await store.write('sections/research/pricing-copy.md', original);
    await engine.fileChanged('sections/research/pricing-copy.md');
    await store.write('sections/handmade.md', '# Made by hand\n');
    await engine.fileChanged('sections/handmade.md');
    await engine.flush();
    expect(original).toMatch(/^---\nid: pricing\n---/);
    expect(engine.sectionIds().sort()).toEqual(['handmade', 'overview', 'pricing', 'pricing-copy']);
    expect(await store.read('sections/research/pricing-copy.md')).toMatch(/^---\nid: pricing-copy\n---/);
    expect(await store.read('sections/handmade.md')).toMatch(/^---\nid: handmade\n---\n\n# Made by hand \^[a-z2-9]{8}\n$/);
  });

  it('gives a copy made while Quillipi was closed an ID of its own when the notebook opens', async () => {
    const { store, engine } = await withResearch();
    await store.write('sections/research/pricing-copy.md', (await store.read('sections/research/pricing.md'))!);
    await store.write('sections/a-copy-first.md', (await store.read('sections/research/pricing.md'))!);
    const reopened = await Engine.fromStore(store);
    await reopened.flush();
    // The file with the ID that comes first by path keeps it; the others are named after their files.
    expect(reopened.sectionIds().sort()).toEqual(['a-copy-first', 'overview', 'pricing', 'pricing-copy']);
    expect(await store.read('sections/a-copy-first.md')).toMatch(/^---\nid: a-copy-first\n---/);
    expect(engine.sectionIds()).toContain('pricing');
  });

  it('sees a file moved by a tool that dropped its front matter as the same section, moved', async () => {
    const { store, engine } = await withResearch();
    const text = (await store.read('sections/research/pricing.md'))!.replace(/^---\nid: pricing\n---\n\n/, '');
    await store.remove('sections/research/pricing.md');
    await store.write('sections/pricing.md', text);
    await engine.fileChanged('sections/pricing.md');
    await engine.fileChanged('sections/research/pricing.md');
    await engine.flush();
    expect(engine.sectionIds()).toEqual(['overview', 'pricing']);
    expect(engine.pending().map((change) => change.key)).toEqual(['layout']);
    expect(await store.read('sections/pricing.md')).toMatch(/^---\nid: pricing\n---/);
  });

  it('sees a file moved outside Quillipi as the same section, moved', async () => {
    const { store, engine } = await withResearch();
    const text = (await store.read('sections/research/pricing.md'))!;
    await store.write('sections/pricing.md', text);
    await store.remove('sections/research/pricing.md');
    await engine.fileChanged('sections/pricing.md');
    await engine.fileChanged('sections/research/pricing.md');
    expect(engine.sectionIds()).toEqual(['overview', 'pricing']);
    expect(engine.pending()).toEqual([{ ...LAYOUT_CHANGE, change: 'moved', by: ['person'], held: false, included: true }]);
  });
});

describe("the editor's calls", () => {
  it('organizes and deletes as the person, checking the ops', async () => {
    const { engine } = await withResearch();
    const api = new EditorApi(engine);
    const post = (path: string, body: unknown) =>
      api.call({ method: 'POST', path, query: new URLSearchParams(), contentType: 'application/json', body: async () => new TextEncoder().encode(JSON.stringify(body)) });
    expect(await post('organize', { ops: [{ op: 'folder', name: 'Ideas' }] })).toEqual({ status: 200, json: { lines: ['✓ folder ideas/ "Ideas"'], created: [] } });
    expect((await post('organize', { ops: [{ op: 'explode' }] })).status).toBe(400);
    expect(await post('organize', { ops: [{ op: 'move' }] })).toEqual({ status: 400, json: { error: 'Op 1 (move) needs id.' } });
    expect(await post('sections', { title: 'Gyms', folder: 'ideas' })).toEqual({ status: 200, json: { id: 'gyms' } });
    expect(await post('delete', { folder: 'ideas' })).toEqual({ status: 200, json: { sections: 1 } });
    expect(await post('delete', { section: 'pricing' })).toEqual({ status: 200, json: { ok: true } });
    expect((await post('delete', {})).status).toBe(400);
    expect(engine.pending().every((change) => change.by.includes('person'))).toBe(true);
    const repo = await api.call({ method: 'GET', path: 'repo', query: new URLSearchParams(), body: async () => new Uint8Array() });
    expect((repo as { json: { tree: unknown } }).json.tree).toEqual(['overview', { folder: 'research', name: 'Research', items: [] }]);
  });
});

describe('upgrading a notebook from before folders', () => {
  /** A notebook as the code before folders kept it: IDs were paths, and `product` had a section under it. */
  async function legacy(): Promise<MemoryStore> {
    const store = new MemoryStore(KARAN);
    const files = new Map<string, string>([
      ['inklog.json', `${JSON.stringify({ name: 'old', sections: ['product', 'product/pricing', 'notes/ideas'] }, null, 2)}\n`],
      ['AGENTS.md', 'A guide.\n'],
      ['sections/product.md', '# Product ^aaaaaaaa\n'],
      ['sections/product/pricing.md', '# Pricing ^bbbbbbbb\n\nFree. ^cccccccc\n'],
      ['sections/notes/ideas.md', '# Ideas ^dddddddd\n'],
    ]);
    for (const [rel, text] of files) await store.write(rel, text);
    await store.commit(files, 'Start old', KARAN);
    // Uncommitted work by an agent, as the old engine recorded it.
    await store.write('sections/product/pricing.md', '# Pricing ^bbbbbbbb\n\nFree for one person. ^cccccccc\n');
    await store.write('.inklog/state.json', JSON.stringify({ touches: { 'product/pricing': { cccccccc: ['agent'] } }, excluded: ['notes/ideas dddddddd'], held: [], seen: {} }));
    return store;
  }

  it('gives every section its ID and makes the folders, in one commit, keeping uncommitted work', async () => {
    const store = await legacy();
    const engine = await Engine.fromStore(store);
    expect(engine.commitList().map((commit) => commit.message)).toEqual(['Upgrade to folders: a permanent ID in every section, and the folders in inklog.json', 'Start old']);
    expect(engine.info().tree).toEqual([
      { folder: 'product', name: 'Product', items: ['product', 'pricing'] },
      { folder: 'notes', name: 'Notes', items: ['ideas'] },
    ]);
    expect(await committedFiles(store)).toEqual(['sections/notes/ideas.md', 'sections/product/pricing.md', 'sections/product/product.md']);
    expect(await store.readAt((await store.head())!, 'sections/product/pricing.md')).toBe('---\nid: pricing\n---\n\n# Pricing ^bbbbbbbb\n\nFree. ^cccccccc\n');
    expect(await store.read('sections/product.md')).toBeUndefined();
    expect(await store.read('sections/product/pricing.md')).toContain('Free for one person.');
    // The uncommitted edit is still the agent's, under the new ID; the arrangement matches the commit.
    expect(engine.pending()).toEqual([{ section: 'pricing', key: 'cccccccc', change: 'modified', by: ['agent'], held: false, included: true }]);
    expect(await runTool(engine, AGENT, 'compare', { from: '#1' })).toBe(
      'Changes from #1 to now:\nproduct:\n  ↪ moved from the top to product/\npricing:\n  ~ ^cccccccc p: Free. → Free for one person.',
    );
    expect(await runTool(engine, AGENT, 'history', { path: 'product' })).toMatch(/^#2 .*Upgrade to folders.*\n#1 .*Start old$/);
    await engine.flush();

    const again = await Engine.fromStore(store);
    expect(again.commitList()).toHaveLength(2);
    expect(again.pending()).toHaveLength(1);
    await again.flush();

    // An older Quillipi, still running, writes the old inklog.json back: opening again changes nothing.
    await store.write('inklog.json', `${JSON.stringify({ name: 'old', sections: ['product', 'product/pricing', 'notes/ideas'] }, null, 2)}\n`);
    const third = await Engine.fromStore(store);
    expect(third.commitList()).toHaveLength(2);
    expect(third.info().tree).toEqual(engine.info().tree);
    expect(third.pending()).toHaveLength(1);
    expect((await store.list('sections', '.md')).sort()).toEqual(['sections/notes/ideas.md', 'sections/product/pricing.md', 'sections/product/product.md']);
  });

  it('works on a notebook whose sections are only in a directory, as this project’s own notebook was', async () => {
    const store = new MemoryStore(KARAN);
    const files = new Map<string, string>([
      ['inklog.json', `${JSON.stringify({ name: 'inklog', sections: ['inklog-notebook/about', 'inklog-notebook/roadmap', 'start-here'] }, null, 2)}\n`],
      ['sections/inklog-notebook/about.md', '# Quillipi ^aaaaaaaa\n'],
      ['sections/inklog-notebook/roadmap.md', '# Status and roadmap ^bbbbbbbb\n'],
      ['sections/start-here.md', '# Start here ^cccccccc\n'],
    ]);
    for (const [rel, text] of files) await store.write(rel, text);
    await store.commit(files, 'Start', KARAN);
    const engine = await Engine.fromStore(store);
    expect(engine.info().tree).toEqual([{ folder: 'inklog-notebook', name: 'Inklog Notebook', items: ['about', 'roadmap'] }, 'start-here']);
    expect(engine.pending()).toEqual([]);
    expect(await committedFiles(store)).toEqual(['sections/inklog-notebook/about.md', 'sections/inklog-notebook/roadmap.md', 'sections/start-here.md']);
    expect(await runTool(engine, AGENT, 'read', { path: 'inklog-notebook/about' })).toMatch(/^about "Quillipi"/);
  });
});
