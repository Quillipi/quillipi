/**
 * The tests every notebook store must pass, so the engine behaves the same on any of them.
 * Each store's own test file calls testNotebookStore with a way to make a fresh, empty store.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { NotebookStore } from '../src/store.js';

export const KARAN = { name: 'Karan', email: 'karan@example.com' };

/** Git's ID for a file's content. */
function gitBlobId(text: string): string {
  return createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0${text}`).digest('hex');
}

export function testNotebookStore(name: string, make: () => Promise<NotebookStore>): void {
  describe(`a notebook store: ${name}`, () => {
    it('reads, writes, appends, removes and lists working files', async () => {
      const store = await make();
      expect(await store.read('sections/missing.md')).toBeUndefined();
      await store.write('sections/b.md', 'B');
      await store.write('sections/deep/a.md', 'A');
      await store.write('sections/notes.txt', 'not Markdown');
      await store.write('assets/x.png', new Uint8Array([1, 2, 3]));
      expect(await store.list('sections', '.md')).toEqual(['sections/b.md', 'sections/deep/a.md']);
      expect(await store.list('nowhere', '.md')).toEqual([]);
      expect([...((await store.readBytes('assets/x.png')) ?? [])]).toEqual([1, 2, 3]);

      await store.append('.inklog/log.jsonl', 'one\n');
      await store.append('.inklog/log.jsonl', 'two\n');
      expect(await store.read('.inklog/log.jsonl')).toBe('one\ntwo\n');

      await store.write('sections/b.md', 'B again');
      expect(await store.read('sections/b.md')).toBe('B again');
      await store.remove('sections/b.md');
      expect(await store.read('sections/b.md')).toBeUndefined();
    });

    it('refuses paths that reach outside the notebook', async () => {
      const store = await make();
      for (const bad of ['../secret', 'sections/../../secret', '/etc/passwd', 'C:\\Windows\\x', 'sections\\..\\..\\x', '']) {
        await expect(store.read(bad), bad).rejects.toThrow('not a path inside the notebook');
        await expect(store.write(bad, 'x'), bad).rejects.toThrow('not a path inside the notebook');
      }
    });

    it('keeps history as a chain of snapshots, apart from the working files', async () => {
      const store = await make();
      expect(await store.head()).toBeUndefined();
      expect(await store.log()).toEqual([]);
      expect(await store.person()).toEqual(KARAN);

      const c1 = await store.commit(new Map([['sections/a.md', 'one'], ['sections/deep/b.md', 'two']]), 'First', KARAN);
      const c2 = await store.commit(new Map([['sections/a.md', 'one, changed']]), 'Second', KARAN);
      const c3 = await store.commit(new Map([['sections/deep/b.md', null]]), 'Third', KARAN);

      // A commit never touches the working files.
      expect(await store.read('sections/a.md')).toBeUndefined();

      expect(await store.head()).toBe(c3);
      const log = await store.log();
      expect(log.map((commit) => [commit.oid, commit.message, commit.author, commit.parent])).toEqual([
        [c3, 'Third', 'Karan', c2],
        [c2, 'Second', 'Karan', c1],
        [c1, 'First', 'Karan', undefined],
      ]);
      expect(log.every((commit) => Math.abs(commit.at - Date.now()) < 60_000)).toBe(true);
      expect(await store.log(2)).toHaveLength(2);

      expect(await store.readAt(c1, 'sections/a.md')).toBe('one');
      expect(await store.readAt(c2, 'sections/a.md')).toBe('one, changed');
      expect(await store.readAt(c2, 'sections/deep/b.md')).toBe('two');
      expect(await store.readAt(c3, 'sections/deep/b.md')).toBeUndefined();

      const [one, two, three] = [await store.filesAt(c1), await store.filesAt(c2), await store.filesAt(c3)];
      expect([...one.keys()].sort()).toEqual(['sections/a.md', 'sections/deep/b.md']);
      expect(one.get('sections/a.md')).toBe(gitBlobId('one'));
      expect(two.get('sections/deep/b.md')).toBe(one.get('sections/deep/b.md'));
      expect(two.get('sections/a.md')).not.toBe(one.get('sections/a.md'));
      expect(three.has('sections/deep/b.md')).toBe(false);
    });
  });
}
