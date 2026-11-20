/** Folders on a real folder with Git: the one-time upgrade, moves, and moves made outside Quillipi. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { LAYOUT_CHANGE } from '@inklog/core';
import { runTool } from '@inklog/engine';
import { describe, expect, it } from 'vitest';
import { RepoFiles } from '../src/repo.js';
import { initFolder, openFolder } from '../src/setup.js';
import { watchSections } from '../src/watch.js';
import { tempFolder } from './helpers.js';

const KARAN = { name: 'Karan', email: 'karan@example.com' };
const AGENT = 'Claude via Claude Code';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

/** A notebook folder as the code before folders left it, with its sections in a subfolder. */
async function legacyFolder(): Promise<string> {
  const dir = path.join(tempFolder(), 'inklog');
  fs.mkdirSync(dir, { recursive: true });
  const repo = new RepoFiles(dir);
  await repo.init(KARAN);
  const files = new Map<string, string>([
    ['inklog.json', `${JSON.stringify({ name: 'inklog', sections: ['inklog-notebook/about', 'start-here', 'plan', 'plan/steps'] }, null, 2)}\n`],
    ['AGENTS.md', 'A guide.\n'],
    ['.gitignore', '.inklog/\n'],
    ['sections/inklog-notebook/about.md', '# Quillipi ^aaaaaaaa\n\nCommits for documents. ^bbbbbbbb\n'],
    ['sections/start-here.md', '# Start here ^cccccccc\n'],
    ['sections/plan.md', '# The plan ^dddddddd\n'],
    ['sections/plan/steps.md', '# Steps ^eeeeeeee\n'],
  ]);
  for (const [rel, text] of files) await repo.write(rel, text);
  await repo.commit(files, 'Start inklog', KARAN);
  return dir;
}

describe('folders on the laptop', () => {
  it('upgrades a notebook from before folders in one commit, leaving Git clean', async () => {
    const dir = await legacyFolder();
    const engine = await openFolder(dir);
    await engine.flush();
    expect(git(dir, 'log', '--format=%s')).toBe('Upgrade to folders: a permanent ID in every section, and the folders in inklog.json\nStart inklog');
    expect(git(dir, 'status', '--porcelain')).toBe('');
    expect(git(dir, 'ls-files', 'sections').split('\n')).toEqual(['sections/inklog-notebook/about.md', 'sections/plan/plan.md', 'sections/plan/steps.md', 'sections/start-here.md']);
    expect(git(dir, 'show', 'HEAD:sections/plan/plan.md')).toBe('---\nid: plan\n---\n\n# The plan ^dddddddd');
    expect(engine.info().tree).toEqual([
      { folder: 'inklog-notebook', name: 'Inklog Notebook', items: ['about'] },
      'start-here',
      { folder: 'plan', name: 'The plan', items: ['plan', 'steps'] },
    ]);
    expect(engine.pending()).toEqual([]);
    expect(await runTool(engine, AGENT, 'history', { path: 'plan' })).toMatch(/^#2 .*Upgrade to folders.*\n#1 .*Start inklog$/);

    const again = await openFolder(dir);
    expect(again.commitList()).toHaveLength(2);
    await again.flush();
  });

  it('moves files when sections move, and commits the move with Git clean afterwards', async () => {
    const dir = path.join(tempFolder(), 'gyms');
    await initFolder(dir, KARAN);
    const engine = await openFolder(dir);
    await runTool(engine, AGENT, 'organize', { ops: [{ op: 'folder', name: 'Research' }, { op: 'section', name: 'Pricing', in: 'research' }], commit: 'Add research' });
    await engine.flush();
    expect(git(dir, 'status', '--porcelain')).toBe('');

    await engine.organize([{ op: 'rename', folder: 'research', name: 'Market research' }, { op: 'move', id: 'overview', to: 'market-research' }], { kind: 'person' });
    await engine.flush();
    expect(fs.existsSync(path.join(dir, 'sections/research'))).toBe(false);
    expect(fs.readdirSync(path.join(dir, 'sections/market-research')).sort()).toEqual(['overview.md', 'pricing.md']);
    await engine.commit('');
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('Organize folders');
    expect(git(dir, 'status', '--porcelain')).toBe('');
    expect(git(dir, 'ls-files', 'sections').split('\n')).toEqual(['sections/market-research/overview.md', 'sections/market-research/pricing.md']);
    expect(await runTool(engine, AGENT, 'history', { path: 'pricing' })).toMatch(/^#3 .*Organize folders\n#2 .*Add research/);
  });

  it('sees a `git mv` made outside Quillipi as a move, through the file watcher', async () => {
    const dir = path.join(tempFolder(), 'gyms');
    await initFolder(dir, KARAN);
    const engine = await openFolder(dir);
    await engine.organize([{ op: 'folder', name: 'Archive' }], { kind: 'person' });
    await engine.commit('Add a folder');
    await engine.flush();
    const stop = watchSections(engine, dir);
    try {
      // chokidar needs a moment to start watching before it reports changes.
      await new Promise((resolve) => setTimeout(resolve, 300));
      fs.mkdirSync(path.join(dir, 'sections/archive'), { recursive: true });
      git(dir, 'mv', 'sections/overview.md', 'sections/archive/overview.md');
      for (let waited = 0; engine.info().sections[0]?.folder !== 'archive' && waited < 5000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(engine.info().sections).toMatchObject([{ id: 'overview', folder: 'archive' }]);
      expect(engine.pending()).toEqual([{ ...LAYOUT_CHANGE, change: 'moved', by: ['person'], held: false, included: true }]);
    } finally {
      await stop();
    }
    await engine.commit('Archive the overview');
    await engine.flush();
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });
});
