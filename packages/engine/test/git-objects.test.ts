import { describe, expect, it } from 'vitest';
import { EMPTY_TREE, blobId, commitId, commitMessage, commitText, gitTimezone, treeId } from '../src/git-objects.js';

const text = (value: string) => new TextEncoder().encode(value);
const KARAN = { name: 'Karan', email: 'karan@example.com' };

describe('Git object IDs', () => {
  it('match the IDs Git gives well-known objects', async () => {
    expect(await blobId(text(''))).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
    expect(await blobId(text('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
    expect(await treeId(new Map())).toBe(EMPTY_TREE);
  });

  it('write time zones as Git does', () => {
    expect([gitTimezone(-330), gitTimezone(0), gitTimezone(420), gitTimezone(-345), gitTimezone(60)]).toEqual(['+0530', '+0000', '-0700', '+0545', '-0100']);
  });

  it('keep commit messages as Git does', () => {
    expect(commitMessage('Add the plan')).toBe('Add the plan\n');
    expect(commitMessage('\n\nTitle\r\n\r\nBody\n\n\n')).toBe('Title\n\nBody\n');
  });

  it('write a commit exactly as Git stores it', async () => {
    const commit = { tree: EMPTY_TREE, parents: ['a'.repeat(40)], author: KARAN, timestamp: 1_793_900_000, timezoneOffset: -330, message: 'First' };
    expect(commitText(commit)).toBe(
      `tree ${EMPTY_TREE}\nparent ${'a'.repeat(40)}\nauthor Karan <karan@example.com> 1793900000 +0530\ncommitter Karan <karan@example.com> 1793900000 +0530\n\nFirst\n`,
    );
    expect(await commitId(commit)).toMatch(/^[0-9a-f]{40}$/);
    expect(await commitId({ ...commit, message: 'First\n\n' })).toBe(await commitId(commit));
  });
});
