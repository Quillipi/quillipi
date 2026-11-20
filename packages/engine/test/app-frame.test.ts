/**
 * What the app's notebook pages ask of the engine (step 3.4a): renaming a notebook and changing its
 * line or colour, each committed at once; the last commit that changed each section, for the
 * overview; the person's visits; who called the tools last; and open editors hearing about a flush.
 */
import { parseMeta } from '@inklog/core';
import { describe, expect, it, vi } from 'vitest';
import { runTool } from '../src/agent.js';
import { EditorApi } from '../src/editor-api.js';
import { Engine, UserError } from '../src/engine.js';
import { MemoryStore } from '../src/memory-store.js';
import { initNotebook } from '../src/notebook.js';

const PERSON = { kind: 'person' } as const;
const OWNER = { name: 'The Octocat', email: 'karan@example.com' };

async function notebook(): Promise<{ store: MemoryStore; engine: Engine }> {
  const store = new MemoryStore(OWNER);
  await initNotebook(store, { name: 'Gym rollup', person: OWNER, starter: 'about', about: 'Take over struggling gyms', colour: '#0f8b8d' });
  return { store, engine: await Engine.fromStore(store) };
}

describe("the notebook's details", () => {
  it('are renamed in a commit of their own, leaving everything uncommitted as it was', async () => {
    const { store, engine } = await notebook();
    const about = engine.section('about')!;
    engine.save('about', about.version, [...about.blocks, { id: 'n1', type: 'p', text: 'Unsaved thought' }]);
    await engine.organize([{ op: 'folder', name: 'Research' }], PERSON);
    const pendingBefore = engine.pending().map((change) => `${change.section} ${change.key}`);

    const commit = await engine.setDetails({ name: '  Gym   roll-up  ' });
    expect(commit).toMatchObject({ number: 2, message: 'Rename the notebook to “Gym roll-up”', author: 'The Octocat' });
    expect(engine.details()).toEqual({ name: 'Gym roll-up', about: 'Take over struggling gyms', colour: '#0f8b8d' });
    // Only inklog.json changed in the commit, with the last commit's tree: the new folder isn't in it.
    const head = await store.head();
    const files = await store.filesAt(head!);
    const parent = await store.filesAt((await store.log())[1]!.oid);
    expect([...files.keys()].filter((path) => files.get(path) !== parent.get(path))).toEqual(['inklog.json']);
    expect(parseMeta(await store.readAt(head!, 'inklog.json'))).toMatchObject({ name: 'Gym roll-up', tree: ['about'] });
    expect(engine.pending().map((change) => `${change.section} ${change.key}`)).toEqual(pendingBefore);
    await engine.flush();
    expect(parseMeta(await store.read('inklog.json'))).toMatchObject({ name: 'Gym roll-up', tree: ['about', { folder: 'research', items: [] }] });
    // Opened again, it keeps the new name.
    expect((await Engine.fromStore(store)).name).toBe('Gym roll-up');
  });

  it('change the line and the colour, together, in one commit, and nothing when nothing changes', async () => {
    const { engine } = await notebook();
    expect(await engine.setDetails({ name: 'Gym rollup', colour: '#0f8b8d' })).toBeUndefined();
    const commit = await engine.setDetails({ about: '  ', colour: '#c4413b' });
    expect(commit!.message).toBe('Remove the line about what the notebook is for; Change the notebook’s colour');
    expect(engine.details()).toEqual({ name: 'Gym rollup', colour: '#c4413b' });
    expect(engine.info()).toMatchObject({ name: 'Gym rollup', colour: '#c4413b' });
    expect(engine.info().about).toBeUndefined();
    expect((await engine.setDetails({ about: 'Standardise gyms\nacross the city' }))!.message).toBe('Change what the notebook is for');
    expect(engine.details().about).toBe('Standardise gyms across the city');
  });

  it('refuse an empty title, one too long, and a colour that is not #rrggbb', async () => {
    const { engine } = await notebook();
    await expect(engine.setDetails({ name: '   ' })).rejects.toThrow(UserError);
    await expect(engine.setDetails({ name: 'x'.repeat(101) })).rejects.toThrow('at most 100 characters');
    await expect(engine.setDetails({ colour: 'teal' })).rejects.toThrow('"teal" is not a colour');
    expect(engine.commitList()).toHaveLength(1);
  });

  it('wait for a commit already being written, so the two never interleave', async () => {
    const { engine } = await notebook();
    const about = engine.section('about')!;
    engine.save('about', about.version, [...about.blocks, { id: 'n1', type: 'p', text: 'More' }]);
    const [commit, renamed] = await Promise.all([engine.commit('Add a line'), engine.setDetails({ name: 'Gyms' })]);
    expect(commit!.number).toBe(2);
    expect(renamed!.number).toBe(3);
    expect(engine.commitList().map((entry) => entry.message)).toEqual(['Rename the notebook to “Gyms”', 'Add a line', 'Start Gym rollup']);
  });
});

describe("the overview's last commit for each section", () => {
  it('names the commit that last changed each section, following a section through a move', async () => {
    const { engine } = await notebook();
    await engine.organize([{ op: 'section', title: 'Plan' }, { op: 'section', title: 'Pricing' }, { op: 'folder', name: 'Research' }], PERSON);
    await engine.commit('Add plan and pricing'); // #2
    const plan = engine.section('plan')!;
    engine.save('plan', plan.version, [...plan.blocks, { id: 'p1', type: 'p', text: 'Step one' }]);
    await engine.commit('Write the plan'); // #3
    await engine.organize([{ op: 'move', id: 'pricing', to: 'research' }], PERSON);
    await engine.commit('Move pricing into research'); // #4
    await engine.setDetails({ colour: '#c4413b' }); // #5 touches no section
    await engine.organize([{ op: 'section', title: 'Draft' }], PERSON); // never committed

    const last = await engine.lastCommits();
    expect(Object.fromEntries([...last].map(([id, commit]) => [id, commit.number]))).toEqual({ about: 1, plan: 3, pricing: 4 });
    expect(last.has('draft')).toBe(false);
  });

  it('answers the editor at GET overview, and an agent who edited is named', async () => {
    const { engine } = await notebook();
    const api = new EditorApi(engine);
    await runTool(engine, 'Claude via claude.ai', 'organize', { ops: [{ op: 'section', name: 'Plan' }], commit: 'Add a plan' });
    const reply = await api.call({ method: 'GET', path: 'overview', query: new URLSearchParams(), body: async () => new Uint8Array() });
    expect(reply).toMatchObject({ status: 200, json: { last: { about: { number: 1 }, plan: { number: 2, agent: 'Claude via claude.ai', message: 'Add a plan' } } } });
  });
});

describe('visits and the last agent', () => {
  it("remember the person's last visit and the last agent across a restart, as a cloud room's nap is", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 15, 10) });
    try {
      const { store, engine } = await notebook();
      const api = new EditorApi(engine);
      const visit = () => api.call({ method: 'POST', path: 'visit', query: new URLSearchParams(), body: async () => new Uint8Array() });
      expect(await visit()).toEqual({ status: 200, json: { before: null } });
      vi.setSystemTime(Date.UTC(2026, 10, 15, 11));
      await runTool(engine, 'Claude via Claude Code', 'map', {});
      expect(engine.lastAgent()).toEqual({ agent: 'Claude via Claude Code', at: Date.UTC(2026, 10, 15, 11) });
      await engine.flush();

      const again = await Engine.fromStore(store);
      expect(again.lastAgent()).toEqual({ agent: 'Claude via Claude Code', at: Date.UTC(2026, 10, 15, 11) });
      vi.setSystemTime(Date.UTC(2026, 10, 15, 12));
      expect(again.personVisit()).toBe(Date.UTC(2026, 10, 15, 10));
      expect(again.personVisit()).toBe(Date.UTC(2026, 10, 15, 12));
    } finally {
      vi.useRealTimers();
    }
  });

  it('count every tool call, even one that fails, as the agent being here', async () => {
    const { engine } = await notebook();
    await expect(runTool(engine, 'Claude via claude.ai', 'read', { path: 'nope' })).rejects.toThrow('No section "nope"');
    expect(engine.lastAgent()?.agent).toBe('Claude via claude.ai');
    expect(engine.info().agents).toEqual(['Claude via claude.ai']);
  });
});

describe('editing the details from the editor', () => {
  it('commits at POST details and tells open editors', async () => {
    const { engine } = await notebook();
    const api = new EditorApi<string>(engine);
    const sent: string[] = [];
    api.listen((message) => sent.push(message.type));
    const body = new TextEncoder().encode(JSON.stringify({ name: 'Gym roll-up', colour: '#2e8b57' }));
    const reply = await api.call({ method: 'POST', path: 'details', query: new URLSearchParams(), body: async () => body });
    expect(reply).toMatchObject({ status: 200, json: { commit: { number: 2 } } });
    const bad = new TextEncoder().encode(JSON.stringify({ colour: 'green' }));
    expect(await api.call({ method: 'POST', path: 'details', query: new URLSearchParams(), body: async () => bad })).toMatchObject({ status: 400 });
    // A flush tells open editors what a timer would have, so a cloud room that flushes after every call still updates them.
    await engine.flush();
    expect(sent).toContain('repo');
    expect(api.info()).toMatchObject({ name: 'Gym roll-up', colour: '#2e8b57' });
  });
});
