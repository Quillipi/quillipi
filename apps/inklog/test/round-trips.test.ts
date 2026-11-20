import path from 'node:path';
import { blockHash } from '@inklog/core';
import { describe, expect, it } from 'vitest';
import { runTool } from '@inklog/engine';
import { readCalls } from '@inklog/engine';
import { Engine } from '@inklog/engine';
import { MemoryStore } from '@inklog/engine';
import { initNotebook } from '@inklog/engine';
import { initFolder, openFolder } from '../src/setup.js';
import { tempFolder } from './helpers.js';

const AGENT = 'Claude via claude.ai';
const KARAN = { name: 'Karan', email: 'karan@example.com' };

/** The same engine, on a folder with Git and on a store in memory. */
const openers: [string, () => Promise<Engine>][] = [
  [
    'on a folder',
    async () => {
      const dir = path.join(tempFolder(), 'notebook');
      await initFolder(dir, KARAN);
      return openFolder(dir);
    },
  ],
  [
    'in memory',
    async () => {
      const store = new MemoryStore(KARAN);
      await initNotebook(store, { name: 'notebook', person: KARAN });
      return Engine.fromStore(store);
    },
  ],
];

function heading(engine: Engine, id: string) {
  const block = engine.section(id)!.blocks[0]!;
  return { id: block.id, base: blockHash(block) };
}

function texts(engine: Engine, id: string): string[] {
  return engine.section(id)!.blocks.map((block) => block.text ?? '');
}

describe.each(openers)('the engine %s', (_where, open) => {
  /** A notebook with two sections, overview and roadmap, each holding just its heading. */
  async function twoSections(): Promise<Engine> {
    const engine = await open();
    await engine.createSection('Roadmap');
    return engine;
  }

  it('commits, and shows history and changes', async () => {
    const engine = await twoSections();
    await engine.commit('Add the roadmap');
    await runTool(engine, AGENT, 'patch', {
      path: 'roadmap',
      ops: [{ op: 'insert', after: heading(engine, 'roadmap').id, type: 'p', text: 'Launch in June.' }],
      commit: 'Plan the launch',
    });
    expect(await runTool(engine, AGENT, 'history', {})).toMatch(/#3 .*Plan the launch[\s\S]*#2 .*Add the roadmap[\s\S]*#1 /);
    expect(await runTool(engine, AGENT, 'history', { path: 'roadmap' })).not.toContain('#1 ');
    const compare = await runTool(engine, AGENT, 'compare', { from: '#2', path: 'roadmap' });
    expect(compare).toContain('Launch in June.');
    expect(texts(engine, 'roadmap')).toEqual(['Roadmap', 'Launch in June.']);
  });

  it('reads several sections in one call', async () => {
    const engine = await twoSections();
    const reply = await runTool(engine, AGENT, 'read', { path: ['overview', 'roadmap', 'nope'] });
    expect(reply).toContain('overview "');
    expect(reply).toContain('roadmap "Roadmap"');
    expect(reply).toContain('✗ no section "nope"');
    await expect(runTool(engine, AGENT, 'read', { path: ['overview', 'roadmap'], ids: ['^x'] })).rejects.toThrow('only when reading one section');
    await expect(runTool(engine, AGENT, 'read', { path: 'nope' })).rejects.toThrow('No section "nope"');
  });

  it('reads sections in the same call as the map', async () => {
    const engine = await twoSections();
    const reply = await runTool(engine, AGENT, 'map', { read: ['roadmap'] });
    expect(reply).toContain('roadmap "Roadmap" · 1 blocks');
    expect(reply).toMatch(/\^[a-z0-9]{8} h1 @[0-9a-f]{6} Roadmap/);
  });

  it('edits several sections in one patch, with an op naming its own section', async () => {
    const engine = await twoSections();
    const reply = await runTool(engine, AGENT, 'patch', {
      path: 'overview',
      ops: [
        { op: 'insert', after: heading(engine, 'overview').id, type: 'p', text: 'Intro.' },
        { op: 'insert', after: `^${heading(engine, 'roadmap').id}`, type: 'li', text: 'Phase 1', path: 'roadmap' },
        { op: 'insert', after: heading(engine, 'roadmap').id, type: 'li', text: 'Phase 2', path: 'roadmap' },
      ],
    });
    expect(reply).toMatch(/^overview:\n {2}✓ inserted/);
    expect(reply).toContain('roadmap:');
    expect(texts(engine, 'overview').slice(1)).toEqual(['Intro.']);
    expect(texts(engine, 'roadmap')).toEqual(['Roadmap', 'Phase 1', 'Phase 2']);
  });

  it('changes no section when any op in the call fails', async () => {
    const engine = await twoSections();
    const reply = await runTool(engine, AGENT, 'patch', {
      ops: [
        { op: 'insert', after: null, type: 'p', text: 'Fine.', path: 'overview' },
        { op: 'replace', id: heading(engine, 'roadmap').id, base: '000000', text: 'Stale', path: 'roadmap' },
      ],
    });
    expect(reply).toContain('Nothing changed in any section');
    expect(texts(engine, 'overview')).not.toContain('Fine.');
    expect(texts(engine, 'roadmap')).toEqual(['Roadmap']);
  });

  it('commits in the same call, and commits nothing when the edits fail', async () => {
    const engine = await twoSections();
    const failed = await runTool(engine, AGENT, 'patch', {
      path: 'roadmap',
      ops: [{ op: 'replace', id: heading(engine, 'roadmap').id, base: '000000', text: 'x' }],
      commit: 'Never happens',
    });
    expect(failed).toContain('Nothing was committed.');
    expect(engine.commitList()[0]?.message).not.toBe('Never happens');

    const done = await runTool(engine, AGENT, 'patch', {
      path: 'roadmap',
      ops: [{ op: 'insert', after: heading(engine, 'roadmap').id, type: 'p', text: 'Plan.' }],
      commit: 'Add the plan',
    });
    expect(done).toMatch(/✓ committed #\d+: Add the plan/);
  });

  it('asks which section when neither the call nor an op names one', async () => {
    const engine = await twoSections();
    await expect(runTool(engine, AGENT, 'patch', { ops: [{ op: 'insert', after: null, type: 'p', text: 'x' }] })).rejects.toThrow('Say which section');
  });

  it('commits a section an agent made, title included, and credits a section the person made to the person', async () => {
    const engine = await twoSections();
    expect(await runTool(engine, AGENT, 'organize', { ops: [{ op: 'section', name: 'Pricing' }] })).toContain('✓ section pricing in the top');
    await runTool(engine, AGENT, 'patch', {
      path: 'pricing',
      ops: [{ op: 'insert', after: heading(engine, 'pricing').id, type: 'p', text: 'Free for one person.' }],
      commit: 'Add pricing',
    });
    expect(engine.commitList()[0]).toMatchObject({ message: 'Add pricing', agent: AGENT });
    expect(engine.pending().filter((change) => change.section === 'pricing')).toEqual([]);
    expect(engine.pending().filter((change) => change.section === 'roadmap').map((change) => change.by)).toEqual([['person']]);
    expect(await runTool(engine, AGENT, 'compare', { from: '#1', path: 'pricing' })).toContain('Free for one person.');
  });

  it('keeps the commit it opened at as it was, after later commits', async () => {
    const engine = await open();
    await runTool(engine, AGENT, 'patch', { path: 'overview', ops: [{ op: 'insert', after: heading(engine, 'overview').id, type: 'p', text: 'Later.' }], commit: 'Add a line' });
    const atFirst = (await engine.snapshot(engine.resolveCommit('#1')!)).get('overview')!;
    expect(atFirst.map((block) => block.text)).not.toContain('Later.');
    expect(await runTool(engine, AGENT, 'compare', { from: '#1' })).toContain('Later.');
  });

  it('logs every section a call named, and a ✗ reply as failed', async () => {
    const engine = await twoSections();
    await runTool(engine, AGENT, 'read', { path: ['overview', 'roadmap'] });
    await runTool(engine, AGENT, 'patch', { path: 'roadmap', ops: [{ op: 'delete', id: heading(engine, 'overview').id, base: '000000', path: 'overview' }] });
    const [read, patch] = await readCalls(engine.repo, 0);
    expect(read).toMatchObject({ tool: 'read', target: 'overview, roadmap', ok: true });
    expect(patch).toMatchObject({ tool: 'patch', target: 'roadmap, overview', ok: false });
  });
});
