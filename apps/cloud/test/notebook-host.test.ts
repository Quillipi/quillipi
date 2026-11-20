import { type Block, type ServerMessage, blockHash } from '@inklog/core';
import { describe, expect, it } from 'vitest';
import { DurableStore } from '../src/durable-store.js';
import { NotebookHost } from '../src/notebook-host.js';
import { nodeSql } from './node-sql.js';

const OWNER = { name: 'The Octocat', email: 'karan@example.com' };
const AGENT = 'Claude via claude.ai';

function host(sql = nodeSql()): NotebookHost {
  return new NotebookHost(new DurableStore(sql, OWNER), 'inklog-notebook-test', OWNER);
}

describe('a notebook in the cloud', () => {
  it("gives agents the owner's instructions from its AGENTS.md, and remembers who had them across a nap", async () => {
    const sql = nodeSql();
    const first = host(sql);
    await (await first.open()).setInstructions('Write completely and correctly.');
    expect(await first.runTool(AGENT, 'map', {})).toMatch(/^Instructions from The Octocat, who owns this notebook\.[\s\S]*Write completely and correctly\.[\s\S]*inklog-notebook-test · 1 sections/);
    // The room sleeps and wakes; the agent had them a moment ago, so a read doesn't repeat them.
    expect(await host(sql).runTool(AGENT, 'read', { path: 'overview' })).toMatch(/^overview "Inklog Notebook Test"/);
  });

  it('starts empty on first use, without being started by a status check', async () => {
    const notebook = host();
    expect(await notebook.status()).toEqual({ exists: false });
    expect(await notebook.runTool(AGENT, 'map', {})).toContain('inklog-notebook-test · 1 sections');
    expect(await notebook.status()).toEqual({ exists: true, sections: 1, commits: 1, uncommitted: 0 });
  });

  it('runs the agent tools, and keeps work and history when the object restarts', async () => {
    const sql = nodeSql();
    const first = host(sql);
    await first.runTool(AGENT, 'map', {});
    const heading = (await first.open()).section('overview')!.blocks[0]!;
    const reply = await first.runTool(AGENT, 'patch', {
      path: 'overview',
      ops: [
        { op: 'insert', after: heading.id, type: 'p', text: 'Written in the cloud.' },
        { op: 'insert', after: heading.id, type: 'p', text: 'Committed in the same call.' },
      ],
      commit: 'First words from the cloud',
    });
    expect(reply).toMatch(/✓ committed #2: First words from the cloud/);
    await first.runTool(AGENT, 'patch', { path: 'overview', ops: [{ op: 'insert', after: null, type: 'p', text: 'Not committed yet.' }] });

    // A Durable Object can be stopped at any time and started again; nothing may be lost.
    const again = host(sql);
    const history = await again.runTool(AGENT, 'history', {});
    expect(history).toMatch(/#2 .*First words from the cloud[\s\S]*#1 /);
    const texts = (await again.open()).section('overview')!.blocks.map((block) => block.text);
    expect(texts).toEqual(['Not committed yet.', 'Inklog Notebook Test', 'Written in the cloud.', 'Committed in the same call.']);
    expect(await again.status()).toMatchObject({ commits: 2, uncommitted: 1 });

    const calls = await again.store.read('.inklog/calls/' + new Date().toISOString().slice(0, 7) + '.jsonl');
    expect(calls?.trim().split('\n')).toHaveLength(4);
    expect(blockHash(heading)).toMatch(/^[0-9a-f]{6}$/);
  });

  it('passes a mistake back as an error, and keeps working', async () => {
    const notebook = host();
    await expect(notebook.runTool(AGENT, 'read', { path: 'nope' })).rejects.toThrow('No section "nope"');
    expect(await notebook.runTool(AGENT, 'read', { path: 'overview' })).toContain('overview');
  });
});

describe("the editor in a notebook's room (step 3.4a)", () => {
  function room(sql = nodeSql()) {
    const sent: { message: ServerMessage; except?: unknown }[] = [];
    const notebook = new NotebookHost(new DurableStore(sql, OWNER), 'inklog-notebook-test', OWNER, undefined, { broadcast: (message, except) => void sent.push({ message, except }) });
    return { notebook, sent };
  }
  const save = (section: string, base: string, blocks: Block[], request = 1) => JSON.stringify({ type: 'save', request, section, base, blocks });

  it('answers a save on its live connection, and tells every other editor, not the one that saved', async () => {
    const { notebook, sent } = room();
    const engine = await notebook.open();
    const before = engine.section('overview')!;
    const blocks = [...before.blocks, { id: 'k1k1k1k1', type: 'p' as const, text: 'Typed on the phone' }];
    const reply = await notebook.editorMessage(save('overview', before.version, blocks), 'phone');
    expect(reply).toMatchObject({ type: 'saved', request: 1, section: 'overview' });
    const update = sent.find((entry) => entry.message.type === 'section');
    expect(update).toMatchObject({ except: 'phone', message: { section: 'overview', blocks, actor: { kind: 'person' } } });
    // An agent's edit reaches every open editor.
    sent.length = 0;
    await notebook.runTool(AGENT, 'patch', { path: 'overview', ops: [{ op: 'insert', after: 'k1k1k1k1', type: 'p', text: 'Claude replies' }] });
    expect(sent.find((entry) => entry.message.type === 'section')).toMatchObject({ except: undefined, message: { actor: { kind: 'agent', agent: AGENT } } });
    // After the call the room flushed, and open editors heard about the notebook too.
    expect(sent.some((entry) => entry.message.type === 'repo')).toBe(true);
  });

  it('keeps the words typed before a nap: a save based on a version from before is answered as stale, and changes nothing', async () => {
    const sql = nodeSql();
    const first = room(sql).notebook;
    const engine = await first.open();
    const before = engine.section('overview')!;
    await first.editorMessage(save('overview', before.version, [...before.blocks, { id: 'k1k1k1k1', type: 'p', text: 'Before the nap' }]), 'laptop');
    await engine.flush();

    // The room naps: its memory goes, the editor's connection stays, and the next message wakes it.
    const woken = room(sql).notebook;
    const stale = await woken.editorMessage(save('overview', before.version, [...before.blocks, { id: 'k1k1k1k1', type: 'p', text: 'Before the nap' }, { id: 'k2k2k2k2', type: 'p', text: 'After' }], 2), 'laptop');
    expect(stale).toMatchObject({ type: 'saved', request: 2, stale: true });
    expect((await woken.open()).section('overview')!.blocks.map((block) => block.text)).toEqual([before.blocks[0]!.text, 'Before the nap']);
  });

  it('answers editor calls, saves before replying, and shows how the backup stands', async () => {
    const sql = nodeSql();
    const { notebook } = room(sql);
    const call = (method: string, path: string, body = '') =>
      notebook.editorCall({ method, path, query: new URLSearchParams(), body: async () => new TextEncoder().encode(body) });
    expect(await call('GET', 'repo')).toMatchObject({ status: 200, json: { backup: { state: 'off', text: 'Not backed up: the GitHub App is not set up here.' } } });
    expect(await call('POST', 'details', JSON.stringify({ name: 'Renamed' }))).toMatchObject({ status: 200, json: { commit: { number: 2 } } });
    expect(await call('POST', 'sections', JSON.stringify({ title: 'Plan' }))).toMatchObject({ status: 200, json: { id: 'plan' } });
    // Saved before the reply, not 300 ms later: a room opened on the same database at once has both.
    const woken = await room(sql).notebook.open();
    expect(woken.name).toBe('Renamed');
    expect(woken.sectionIds()).toEqual(['overview', 'plan']);
  });
});
