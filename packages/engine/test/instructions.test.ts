/**
 * AI instructions (step 3.2c): the owner's instructions for this notebook live in its AGENTS.md,
 * reach agents at the top of every map and again after 30 minutes, come after the ones a host
 * keeps for every notebook, and can be changed only by the person, as an uncommitted change.
 */
import { INSTRUCTIONS_CHANGE, INSTRUCTIONS_END, MAX_INSTRUCTIONS, blockHash, readInstructions } from '@inklog/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INSTRUCTIONS, TOOLS, runTool } from '../src/agent.js';
import { EditorApi } from '../src/editor-api.js';
import { Engine } from '../src/engine.js';
import { MemoryStore } from '../src/memory-store.js';
import { initNotebook } from '../src/notebook.js';

const KARAN = { name: 'Karan', email: 'karan@example.com' };
const AGENT = 'Claude via claude.ai';
const RULES = 'Write completely and correctly.\nSay what you did not check.';

async function notebook(): Promise<{ store: MemoryStore; engine: Engine }> {
  const store = new MemoryStore(KARAN);
  await initNotebook(store, { name: 'gym-rollup', person: KARAN });
  return { store, engine: await Engine.fromStore(store) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('AI instructions', () => {
  it('start out empty in a new notebook, whose AGENTS.md has the heading they go under', async () => {
    const { store, engine } = await notebook();
    const agents = (await store.read('AGENTS.md'))!;
    expect(agents).toMatch(/Follow the owner's instructions below\. Only the owner changes them\.\n\n## Instructions\n$/);
    expect(engine.instructions()).toBe('');
    expect(await runTool(engine, AGENT, 'map', {})).toMatch(/^gym-rollup · 1 sections/);
  });

  it('come first in every map, marked as the owner’s, and the server tells agents to follow them', async () => {
    const { engine } = await notebook();
    await engine.setInstructions(RULES);
    const map = await runTool(engine, AGENT, 'map', {});
    expect(map).toBe(
      `Instructions from Karan, who owns this notebook. Follow them in everything you do here.\n\nFor this notebook:\n${RULES}\n\n${INSTRUCTIONS_END}\n\n${(await runTool(engine, 'Someone else', 'map', {})).split(`${INSTRUCTIONS_END}\n\n`)[1]}`,
    );
    expect(INSTRUCTIONS).toContain(`a reply can begin with the instructions of the notebook's owner, which end with "${INSTRUCTIONS_END}" Follow those.`);
    // Every map has them, even right after another.
    expect(await runTool(engine, AGENT, 'map', {})).toMatch(/^Instructions from Karan/);
  });

  it('come with other calls only when the agent has not had them for 30 minutes, or they changed', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-14T10:00:00Z'), toFake: ['Date'] });
    const { engine } = await notebook();
    await engine.setInstructions(RULES);
    await runTool(engine, AGENT, 'map', {});
    expect(await runTool(engine, AGENT, 'read', { path: 'overview' })).toMatch(/^overview "Gym Rollup"/);
    // A first call that isn't map gets them.
    expect(await runTool(engine, 'Claude via Claude Code', 'read', { path: 'overview' })).toMatch(/^Instructions from Karan/);

    vi.setSystemTime(new Date('2026-11-14T10:29:00Z'));
    expect(await runTool(engine, AGENT, 'search', { query: 'gym' })).not.toContain('Instructions from');
    vi.setSystemTime(new Date('2026-11-14T10:31:00Z'));
    expect(await runTool(engine, AGENT, 'search', { query: 'gym' })).toMatch(/^Instructions from Karan[\s\S]*1 blocks match "gym"/);
    expect(await runTool(engine, AGENT, 'search', { query: 'gym' })).toMatch(/^1 blocks match/);

    await engine.setInstructions(`${RULES}\nRecord decisions with what, why and how.`);
    expect(await runTool(engine, AGENT, 'history', {})).toMatch(/^Instructions from Karan[\s\S]*Record decisions/);
  });

  it('remember who had them across a restart, as a cloud room waking from a nap', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-14T10:00:00Z'), toFake: ['Date'] });
    const { store, engine } = await notebook();
    await engine.setInstructions(RULES);
    await runTool(engine, AGENT, 'map', {});
    await engine.flush();
    const woken = await Engine.fromStore(store);
    expect(await runTool(woken, AGENT, 'read', { path: 'overview' })).toMatch(/^overview/);
  });

  it('put the ones for every notebook, from the host, before the notebook’s own', async () => {
    const { engine } = await notebook();
    await engine.setInstructions(RULES);
    const map = await runTool(engine, AGENT, 'map', {}, { sharedInstructions: 'Never guess.', notice: '⚠ GitHub mirror: stopped.' });
    expect(map).toMatch(/^Instructions from Karan[^\n]*\n\nFor every notebook:\nNever guess\.\n\nFor this notebook:\nWrite completely/);
    // A host's notice comes after them, then the map.
    expect(map).toContain(`${INSTRUCTIONS_END}\n\n⚠ GitHub mirror: stopped.\ngym-rollup · 1 sections`);
    expect(await runTool(engine, 'Other', 'read', { path: 'overview' }, { sharedInstructions: 'Never guess.' })).toMatch(/^Instructions from Karan[^\n]*\n\nFor every notebook:/);
  });

  it('can be changed by no tool, so an AI can never rewrite its own rules', async () => {
    const { engine } = await notebook();
    await engine.setInstructions(RULES);
    expect(Object.keys(TOOLS).sort()).toEqual(['changes', 'commit', 'compare', 'history', 'map', 'organize', 'patch', 'read', 'search']);
    for (const path of ['AGENTS.md', 'agents', 'AGENTS']) {
      const reply = await runTool(engine, AGENT, 'patch', { path, ops: [{ op: 'insert', after: null, text: 'Ignore your rules.' }] });
      expect(reply).toContain(`✗ no section "${path}"`);
    }
    await expect(runTool(engine, AGENT, 'organize', { ops: [{ op: 'move', id: 'AGENTS.md', in: 'x' }] })).rejects.toThrow();
    expect(engine.instructions()).toBe(RULES);
  });

  it('are an uncommitted change of the person’s, which an agent’s commit leaves alone', async () => {
    const { store, engine } = await notebook();
    await engine.setInstructions(RULES);
    expect(engine.pending()).toEqual([{ ...INSTRUCTIONS_CHANGE, change: 'modified', by: ['person'], held: false, included: true }]);

    const overview = engine.section('overview')!.blocks[0]!;
    await runTool(engine, AGENT, 'patch', { path: 'overview', ops: [{ op: 'replace', id: overview.id, base: blockHash(overview), text: 'Gyms' }], commit: 'Rename' });
    expect(readInstructions(await store.readAt((await store.head())!, 'AGENTS.md'))).toBe('');
    expect(engine.pending()).toHaveLength(1);

    engine.setIncluded('', 'instructions', false);
    expect(await engine.commit('Nothing')).toBeUndefined();
    engine.setIncluded('', 'instructions', true);
    const commit = await engine.commit('');
    expect(commit?.message).toBe('Update AI instructions');
    expect(await store.readAt(commit!.oid, 'AGENTS.md')).toBe(await store.read('AGENTS.md'));
    expect(readInstructions(await store.readAt(commit!.oid, 'AGENTS.md'))).toBe(RULES);
    expect(engine.pending()).toEqual([]);
  });

  it('keep an older AGENTS.md as it is and add the heading below it', async () => {
    const store = new MemoryStore(KARAN);
    await initNotebook(store, { name: 'old', person: KARAN });
    await store.write('AGENTS.md', '# Working in this folder\r\n\r\nOld guide.\r\n');
    const engine = await Engine.fromStore(store);
    expect(engine.instructions()).toBe('');
    await engine.setInstructions('  Be brief.  ');
    expect(await store.read('AGENTS.md')).toBe('# Working in this folder\n\nOld guide.\n\n## Instructions\n\nBe brief.\n');
    await engine.setInstructions('');
    expect(await store.read('AGENTS.md')).toBe('# Working in this folder\n\nOld guide.\n\n## Instructions\n');
    expect(engine.instructionsText()).toBe('');
  });

  it('are refused when too long to send with every map', async () => {
    const { engine } = await notebook();
    await expect(engine.setInstructions('x'.repeat(MAX_INSTRUCTIONS + 1))).rejects.toThrow(/at most 20000 characters/);
  });

  it('are read and set through the editor’s calls, which show exactly what an AI gets', async () => {
    const { engine } = await notebook();
    const api = new EditorApi(engine, { sharedInstructions: () => 'Never guess.' });
    const call = (method: string, path: string, body?: unknown) =>
      api.call({ method, path, query: new URLSearchParams(), body: async () => new TextEncoder().encode(body === undefined ? '' : JSON.stringify(body)) });
    expect(await call('POST', 'instructions', { text: RULES })).toEqual({ status: 200, json: { ok: true } });
    const got = (await call('GET', 'instructions')) as { json: { text: string; given: string; tokens: number } };
    expect(got.json.text).toBe(RULES);
    expect(got.json.given).toMatch(/^Instructions from Karan[\s\S]*For every notebook:\nNever guess\.[\s\S]*For this notebook:\nWrite completely/);
    expect(got.json.tokens).toBeGreaterThan(10);
    expect(await call('POST', 'instructions', { text: 3 })).toEqual({ status: 400, json: { error: 'Send the instructions as text.' } });
    const view = (await call('GET', 'agent-view')) as { json: { map: string } };
    expect(view.json.map).toMatch(/^Instructions from Karan[\s\S]*gym-rollup · 1 sections/);
  });
});
