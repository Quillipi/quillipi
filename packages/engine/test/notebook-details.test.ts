/**
 * A notebook's own details in inklog.json (step 3.3): its line about what it is for and its colour,
 * kept through everything that rewrites the file, and the About section a new cloud notebook starts with.
 */
import { parseMeta } from '@inklog/core';
import { describe, expect, it } from 'vitest';
import { Engine } from '../src/engine.js';
import { MemoryStore } from '../src/memory-store.js';
import { initNotebook } from '../src/notebook.js';

const PERSON = { kind: 'person' } as const;
const OWNER = { name: 'The Octocat', email: 'karan@example.com' };

async function meta(store: MemoryStore, at?: string) {
  return parseMeta(at ? await store.readAt(at, 'inklog.json') : await store.read('inklog.json'));
}

describe("a notebook's line and colour", () => {
  it('start an About section, and stay in inklog.json through organize, commits and reopening', async () => {
    const store = new MemoryStore(OWNER);
    await initNotebook(store, { name: 'Gym rollup', person: OWNER, starter: 'about', about: 'Take over struggling gyms', colour: '#0f8b8d' });
    const engine = await Engine.fromStore(store);
    expect(engine.details()).toEqual({ name: 'Gym rollup', about: 'Take over struggling gyms', colour: '#0f8b8d' });
    expect(engine.sectionIds()).toEqual(['about']);
    expect(engine.section('about')!.blocks.map((block) => [block.type, block.text])).toEqual([
      ['h1', 'About'],
      ['p', 'Take over struggling gyms'],
    ]);
    await engine.organize([{ op: 'folder', name: 'Research' }, { op: 'section', title: 'Pricing', in: 'research' }], PERSON);
    await engine.flush();
    expect(await meta(store)).toMatchObject({ name: 'Gym rollup', about: 'Take over struggling gyms', colour: '#0f8b8d' });
    await engine.commit('Add research');
    expect(await meta(store, await store.head())).toMatchObject({ about: 'Take over struggling gyms', colour: '#0f8b8d', tree: ['about', { folder: 'research', items: ['pricing'] }] });
    expect((await Engine.fromStore(store)).details()).toEqual({ name: 'Gym rollup', about: 'Take over struggling gyms', colour: '#0f8b8d' });
  });

  it('are optional, and a colour that is not #rrggbb is refused', async () => {
    const store = new MemoryStore(OWNER);
    await initNotebook(store, { name: 'Plain', person: OWNER, starter: 'about', about: '  ' });
    expect(Object.keys(JSON.parse((await store.read('inklog.json'))!))).toEqual(['name', 'tree']);
    expect((await Engine.fromStore(store)).section('about')!.blocks).toHaveLength(1);
    await expect(initNotebook(new MemoryStore(OWNER), { name: 'X', person: OWNER, colour: 'blue' })).rejects.toThrow('"blue" is not a colour');
  });
});
