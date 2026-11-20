import { execFileSync } from 'node:child_process';
import { MemoryStore, type NotebookStore, gitTimezone, treeId } from '@inklog/engine';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RepoFiles } from '../src/repo.js';
import { KARAN, testNotebookStore } from '../../../packages/engine/test/store-contract.js';
import { tempFolder } from './helpers.js';

async function gitFolder(): Promise<RepoFiles> {
  const repo = new RepoFiles(tempFolder());
  await repo.init(KARAN);
  return repo;
}

testNotebookStore('a folder with Git', gitFolder);

/** The same three commits, with names that test how Git sorts a folder's entries. */
async function makeHistory(store: NotebookStore): Promise<string[]> {
  const oids: string[] = [];
  oids.push(
    await store.commit(
      new Map<string, string | Uint8Array>([
        ['inklog.json', '{"name":"test"}\n'],
        ['sections/a.md', '# A\n'],
        ['sections/a/inside.md', '# Inside\n'],
        ['sections/a-b.md', '# A-B\n'],
        ['sections/ab.md', '# AB\n'],
        ['sections/é.md', '# É\n'],
        ['assets/x.png', new Uint8Array([137, 80, 78, 71, 0, 255])],
      ]),
      'Start test',
      KARAN,
    ),
  );
  vi.setSystemTime(Date.now() + 61_000);
  oids.push(await store.commit(new Map([['sections/a.md', '# A, changed\n']]), 'Change A\r\n\n', KARAN));
  vi.setSystemTime(Date.now() + 61_000);
  oids.push(await store.commit(new Map([['sections/a/inside.md', null]]), 'Remove the folder', KARAN));
  return oids;
}

describe('IDs in every store are Git\'s', () => {
  const zone = process.env.TZ;
  afterEach(() => {
    vi.useRealTimers();
    process.env.TZ = zone;
  });

  for (const tz of ['UTC', 'Asia/Kolkata', 'America/Los_Angeles']) {
    it(`gives the same commit IDs as Git for the same commits (time zone ${tz})`, async () => {
      process.env.TZ = tz;
      const folder = await gitFolder();
      const memory = new MemoryStore(KARAN);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-06T10:00:00Z'));
      const fromGit = await makeHistory(folder);
      vi.setSystemTime(new Date('2026-11-06T10:00:00Z'));
      const fromMemory = await makeHistory(memory);

      expect(fromMemory).toEqual(fromGit);
      expect(await memory.log()).toEqual(await folder.log());
      // Git itself agrees: the commits and the tree are the ones the real git program sees.
      const git = (...args: string[]) => execFileSync('git', args, { cwd: folder.dir, encoding: 'utf8' }).trim();
      expect(git('log', '--format=%H').split('\n')).toEqual([...fromGit].reverse());
      expect(git('rev-parse', 'HEAD^{tree}')).toBe(await treeId(await memory.filesAt(fromMemory[2]!)));
      // The commit records the time zone this computer was in.
      expect(git('log', '-1', '--format=%ai')).toContain(gitTimezone(new Date('2026-11-06T10:00:00Z').getTimezoneOffset()));
    });
  }
});
