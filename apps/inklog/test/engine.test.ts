import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { type Block, blockHash } from '@inklog/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runTool } from '@inklog/engine';
import { Engine } from '@inklog/engine';
import { importMarkdown, initFolder, openFolder } from '../src/setup.js';
import { tempFolder } from './helpers.js';

const AGENT = 'Claude via Claude Code';

async function openNew(): Promise<{ dir: string; engine: Engine }> {
  const dir = path.join(tempFolder(), 'memedeck');
  await initFolder(dir, { name: 'Karan', email: 'karan@example.com' });
  return { dir, engine: await openFolder(dir) };
}

function p(id: string, text: string): Block {
  return { id, type: 'p', text };
}

/** Saves the overview section from the editor, the way the web app does. */
function save(engine: Engine, blocks: Block[]) {
  const section = engine.section('overview')!;
  return engine.save('overview', section.version, blocks);
}

/** Moves the clock past the few seconds in which agents must leave a person's blocks alone. */
function afterTypingPause(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 10_000);
}
afterEach(() => vi.useRealTimers());

const LONG = 'MemeDeck pairs every meme with the right sound, so sharing feels alive instead of silent.';

describe('engine', () => {
  it('starts a folder with a first commit', async () => {
    const { dir, engine } = await openNew();
    expect(engine.info().sections).toEqual([{ id: 'overview', title: 'Memedeck', folder: '', depth: 0 }]);
    expect(fs.readFileSync(path.join(dir, 'sections/overview.md'), 'utf8')).toMatch(/^---\nid: overview\n---\n\n# Memedeck \^/);
    expect(engine.commitList()).toMatchObject([{ number: 1, message: 'Start memedeck', author: 'Karan' }]);
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe('.inklog/\n');
    await engine.flush();
  });

  it('saves edits to disk and commits them', async () => {
    const { dir, engine } = await openNew();
    const [title] = engine.section('overview')!.blocks;
    save(engine, [title, p('aaaaaaaa', LONG)]);
    await engine.flush();
    expect(fs.readFileSync(path.join(dir, 'sections/overview.md'), 'utf8')).toContain(`${LONG} ^aaaaaaaa`);

    const commit = await engine.commit('Describe the product');
    expect(commit).toMatchObject({ number: 2, message: 'Describe the product' });
    expect(engine.pending()).toEqual([]);
    expect(git(dir, 'log', '--format=%s')).toBe('Describe the product\nStart memedeck');
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });

  it('leaves excluded changes out of a commit, and keeps them as unstaged edits in Git', async () => {
    const { dir, engine } = await openNew();
    const [title] = engine.section('overview')!.blocks;
    save(engine, [title, p('aaaaaaaa', 'Keep this.'), p('bbbbbbbb', 'Not yet.')]);
    engine.setIncluded('overview', 'bbbbbbbb', false);
    await engine.commit('First half');
    await engine.flush();

    expect(engine.pending()).toMatchObject([{ key: 'bbbbbbbb', change: 'added', included: false }]);
    const committed = git(dir, 'show', 'HEAD:sections/overview.md');
    expect(committed).toContain('Keep this.');
    expect(committed).not.toContain('Not yet.');
    expect(git(dir, 'status', '--porcelain')).toBe('M sections/overview.md');
  });

  it('merges a save based on an older version with changes made since', async () => {
    const { engine } = await openNew();
    const [title] = engine.section('overview')!.blocks;
    save(engine, [title, p('aaaaaaaa', 'One.'), p('bbbbbbbb', 'Two.')]);
    const stale = engine.section('overview')!.version;
    afterTypingPause();
    engine.agentPatch('overview', [{ op: 'replace', id: 'bbbbbbbb', base: blockHash(p('bbbbbbbb', 'Two.')), text: 'Two, by Claude.' }], AGENT);

    const result = engine.save('overview', stale, [title, p('aaaaaaaa', 'One, edited.'), p('bbbbbbbb', 'Two.')]);
    expect(result.blocks?.map((block) => block.text)).toEqual(['Memedeck', 'One, edited.', 'Two, by Claude.']);
    await engine.flush();
  });

  it('keeps agents out of blocks a person is typing in', async () => {
    const { engine } = await openNew();
    const [title] = engine.section('overview')!.blocks;
    save(engine, [title, p('aaaaaaaa', 'Typing here')]);
    const reply = engine.agentPatch('overview', [{ op: 'replace', id: 'aaaaaaaa', base: blockHash(p('aaaaaaaa', 'Typing here')), text: 'x' }], AGENT);
    expect(reply).toContain('is typing in ^aaaaaaaa');
    expect(engine.section('overview')!.blocks[1].text).toBe('Typing here');
    await engine.flush();
  });

  it("commits only an agent's own changes, and holds big deletions for review", async () => {
    const { dir, engine } = await openNew();
    const [title] = engine.section('overview')!.blocks;
    save(engine, [title, p('aaaaaaaa', LONG), p('bbbbbbbb', 'Short note.')]);
    await engine.commit('Base');
    save(engine, [title, p('aaaaaaaa', LONG), p('bbbbbbbb', 'Short note, edited by Karan.')]);
    afterTypingPause();

    const [, long] = engine.section('overview')!.blocks;
    const patch = await runTool(engine, AGENT, 'patch', {
      path: 'overview',
      ops: [
        { op: 'insert', after: 'aaaaaaaa', type: 'task', text: 'Record the launch video' },
        { op: 'delete', id: '^aaaaaaaa', base: `@${blockHash(long)}` },
      ],
    });
    expect(patch).toContain('✓ inserted');
    expect(patch).toContain('✓ deleted ^aaaaaaaa');

    const reply = await runTool(engine, AGENT, 'commit', { message: 'Plan the launch video' });
    expect(reply).toContain('⏸ held the changes to overview');
    expect(reply).not.toContain('committed');
    expect(engine.info().held).toHaveLength(1);
    expect(engine.pending().find((change) => change.key === 'bbbbbbbb')).toMatchObject({ by: ['person'], included: true, held: false });

    engine.rejectHeld(0);
    expect(engine.section('overview')!.blocks.map((block) => block.text)).toEqual(['Memedeck', LONG, 'Short note, edited by Karan.']);
    await engine.flush();
    expect(git(dir, 'log', '--format=%s')).toBe('Base\nStart memedeck');
  });

  it('marks agent commits with a trailer and reports them in history', async () => {
    const { dir, engine } = await openNew();
    await runTool(engine, AGENT, 'patch', { path: 'overview', ops: [{ op: 'insert', after: null, type: 'p', text: 'From Claude.' }] });
    expect(await runTool(engine, AGENT, 'commit', { message: 'Add an intro' })).toContain('✓ committed #2: Add an intro');
    expect(git(dir, 'log', '-1', '--format=%B')).toBe('Add an intro\n\nInkLog-Agent: Claude via Claude Code');
    expect(await runTool(engine, AGENT, 'history', {})).toMatch(/^#2 · just now · Karan \(Claude via Claude Code\): Add an intro/);
    await engine.flush();
  });

  it('merges edits other programs make to the files', async () => {
    const { dir, engine } = await openNew();
    const [title] = engine.section('overview')!.blocks;
    save(engine, [title, p('aaaaaaaa', 'One.'), p('bbbbbbbb', 'Two.')]);
    await engine.flush();
    const file = path.join(dir, 'sections/overview.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Two.', 'Two, from VS Code.') + '\nA new paragraph without an ID.\n');
    await engine.fileChanged('sections/overview.md');
    const blocks = engine.section('overview')!.blocks;
    expect(blocks.map((block) => block.text)).toEqual(['Memedeck', 'One.', 'Two, from VS Code.', 'A new paragraph without an ID.']);
    expect(blocks[3].id).toMatch(/^[a-z2-9]{8}$/);
    await engine.flush();
    expect(fs.readFileSync(file, 'utf8')).toContain(`A new paragraph without an ID. ^${blocks[3].id}`);
  });

  it('answers agent tools with compact text', async () => {
    const { engine } = await openNew();
    const [title] = engine.section('overview')!.blocks;
    save(engine, [title, p('aaaaaaaa', 'We match memes with **Sound Intelligence**.')]);
    await engine.commit('Intro');

    const map = await runTool(engine, AGENT, 'map', {});
    expect(map).toContain('memedeck · 1 sections · 2 blocks');
    expect(map).toContain('terms: Sound Intelligence');
    expect(await runTool(engine, AGENT, 'search', { query: 'sound intelligence' })).toContain('overview ^aaaaaaaa p @');
    expect(await runTool(engine, AGENT, 'read', { path: 'overview', ids: ['^aaaaaaaa'] })).toContain('1 of 2 blocks');
    await expect(runTool(engine, AGENT, 'read', { path: 'nope' })).rejects.toThrow('No section "nope"');
    await expect(runTool(engine, AGENT, 'patch', { path: 'overview', ops: [] })).rejects.toThrow();

    const created = await runTool(engine, AGENT, 'organize', { ops: [{ op: 'folder', name: 'Product' }, { op: 'section', name: 'Sound Intelligence', in: 'product' }] });
    expect(created).toContain('✓ folder product/ "Product"\n✓ section sound-intelligence in product/\nsound-intelligence "Sound Intelligence"');
    expect(await runTool(engine, AGENT, 'compare', { from: '#2' })).toContain('sound-intelligence:\n  + ^');
    await engine.flush();
  });
});

describe('import', () => {
  it('brings in Markdown from other tools with IDs and one commit', async () => {
    const from = tempFolder();
    fs.mkdirSync(path.join(from, 'Product'), { recursive: true });
    fs.writeFileSync(path.join(from, 'README.md'), '# Read me\n\nA paragraph that is\nhard-wrapped.\n');
    fs.writeFileSync(path.join(from, 'Product', 'Sound Intelligence.md'), '## How it works\n\n- one\n- two\n');
    const dir = path.join(tempFolder(), 'docs');

    expect(await importMarkdown(from, dir)).toEqual({ imported: ['product/sound-intelligence', 'readme'], skipped: [] });
    const readme = fs.readFileSync(path.join(dir, 'sections/readme.md'), 'utf8');
    expect(readme).toMatch(/^---\nid: readme\n---\n\n# Read me \^[a-z2-9]{8}\n\nA paragraph that is hard-wrapped\. \^[a-z2-9]{8}\n$/);
    expect(fs.readFileSync(path.join(dir, 'sections/product/sound-intelligence.md'), 'utf8')).toMatch(/^---\nid: sound-intelligence\n---\n\n## How it works/);
    const engine = await openFolder(dir);
    expect(engine.info().tree).toEqual([{ folder: 'product', name: 'Product', items: ['sound-intelligence'] }, 'readme']);
    await engine.flush();
    // Importing the same folder again finds every file in its place.
    expect(await importMarkdown(from, dir)).toEqual({ imported: [], skipped: ['product/sound-intelligence', 'readme'] });
    expect(git(dir, 'log', '--format=%s')).toBe('Import 2 documents\nStart docs');
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });
});

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}
