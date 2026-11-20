/** AI instructions and undo this commit on a real folder with Git (step 3.2c). */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { INSTRUCTIONS_CHANGE } from '@inklog/core';
import { runTool } from '@inklog/engine';
import { describe, expect, it } from 'vitest';
import { initFolder, openFolder } from '../src/setup.js';
import { watchSections } from '../src/watch.js';
import { tempFolder } from './helpers.js';

const KARAN = { name: 'Karan', email: 'karan@example.com' };

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

describe('AI instructions on a laptop', () => {
  it('picks up AGENTS.md edited by hand, and commits it so Git is clean', async () => {
    const dir = path.join(tempFolder(), 'gyms');
    await initFolder(dir, KARAN);
    expect(fs.readFileSync(path.join(dir, '.gitattributes'), 'utf8')).toContain('* text=auto eol=lf');
    const engine = await openFolder(dir);
    const stop = watchSections(engine, dir);
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const file = path.join(dir, 'AGENTS.md');
      fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8')}\nWrite completely and correctly.\n`);
      for (let waited = 0; !engine.instructions() && waited < 5000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(engine.instructions()).toBe('Write completely and correctly.');
      expect(engine.pending()).toEqual([{ ...INSTRUCTIONS_CHANGE, change: 'modified', by: ['person'], held: false, included: true }]);
      expect(await runTool(engine, 'Claude via Claude Code', 'map', {})).toMatch(/^Instructions from Karan[\s\S]*Write completely and correctly\./);
    } finally {
      await stop();
    }
    await engine.commit('');
    await engine.flush();
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('Update AI instructions');
    expect(git(dir, 'status', '--porcelain')).toBe('');

    expect(await engine.undoCommit('#2')).toEqual(['Put the AI instructions back as they were before #2.']);
    await engine.commit('Undo #2');
    await engine.flush();
    expect(git(dir, 'diff', 'HEAD~2', 'HEAD', '--stat')).toBe('');
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });
});
