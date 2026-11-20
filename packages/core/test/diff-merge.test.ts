import { describe, expect, it } from 'vitest';
import type { Block } from '../src/blocks.js';
import { countChanges, diffBlocks, wordDiff } from '../src/diff.js';
import { mergeBlocks } from '../src/merge.js';
import { removalKey, stagedBlocks } from '../src/partial.js';
import { seeded } from './random.js';

const p = (id: string, text = id): Block => ({ id, type: 'p', text });
const ids = (blocks: Block[]) => blocks.map((block) => block.id).join(' ');

describe('diffBlocks', () => {
  it('finds added, modified, moved and removed blocks', () => {
    const base = [p('a'), p('b'), p('c'), p('d')];
    const current = [p('a'), p('c'), p('b', 'B!'), p('e')];
    const diff = diffBlocks(base, current);
    expect([...diff.changes]).toEqual([
      ['c', 'moved'],
      ['b', 'modified'],
      ['e', 'added'],
    ]);
    expect(diff.removed).toEqual([{ after: 'c', blocks: [p('d')] }]);
    expect(countChanges(diff)).toEqual({ added: 1, modified: 1, moved: 1, removed: 1 });
  });

  it('reports the fewest moves', () => {
    const base = 'abcdef'.split('').map((id) => p(id));
    const current = 'bcdefa'.split('').map((id) => p(id));
    expect([...diffBlocks(base, current).changes]).toEqual([['a', 'moved']]);
  });
});

describe('wordDiff', () => {
  it('marks changed words only', () => {
    expect(wordDiff('Launch in May with ads.', 'Launch in June with ads.')).toEqual([
      { kind: 'same', text: 'Launch in ' },
      { kind: 'removed', text: 'May' },
      { kind: 'added', text: 'June' },
      { kind: 'same', text: ' with ads.' },
    ]);
  });
});

describe('mergeBlocks', () => {
  const base = [p('a'), p('b'), p('c')];

  it('combines edits to different blocks', () => {
    const { blocks, conflicts } = mergeBlocks(base, [p('a', 'A1'), p('b'), p('c')], [p('a'), p('b'), p('c', 'C2')]);
    expect(blocks).toEqual([p('a', 'A1'), p('b'), p('c', 'C2')]);
    expect(conflicts).toEqual([]);
  });

  it('keeps theirs when both sides changed a block, and says so', () => {
    const { blocks, conflicts } = mergeBlocks(base, [p('a', 'mine'), p('b'), p('c')], [p('a', 'theirs'), p('b'), p('c')]);
    expect(blocks[0]).toEqual(p('a', 'theirs'));
    expect(conflicts).toEqual(['a']);
  });

  it('lets an edit beat a delete, on either side', () => {
    expect(ids(mergeBlocks(base, [p('a'), p('c')], [p('a'), p('b', 'edited'), p('c')]).blocks)).toBe('a b c');
    expect(ids(mergeBlocks(base, [p('a'), p('b', 'edited'), p('c')], [p('a'), p('c')]).blocks)).toBe('a b c');
    expect(ids(mergeBlocks(base, [p('a'), p('c')], [p('a'), p('b'), p('c')]).blocks)).toBe('a c');
  });

  it('places blocks only ours added or moved after their predecessor in ours', () => {
    const ours = [p('a'), p('x'), p('c'), p('b')];
    const theirs = [p('y'), p('a'), p('b'), p('c')];
    expect(ids(mergeBlocks(base, ours, theirs).blocks)).toBe('y a x c b');
  });

  it('with nothing on one side, the result is the other side', () => {
    const random = seeded(11);
    for (let i = 0; i < 500; i++) {
      const edited = base.filter(() => random.next() < 0.8).map((block) => (random.next() < 0.3 ? p(block.id, 'edit') : block));
      if (random.next() < 0.5) edited.push(p(`n${i}`));
      expect(mergeBlocks(base, base, edited).blocks).toEqual(edited);
      expect(mergeBlocks(base, edited, base).blocks).toEqual(edited);
    }
  });
});

describe('stagedBlocks', () => {
  const base = [p('a'), p('b'), p('c'), p('d'), p('e')];
  // a edited, x added, b moved below d, e removed, y added at the end.
  const work = [p('a', 'A!'), p('x'), p('c'), p('d'), p('b'), p('y')];

  it('applies only the included changes', () => {
    const include = new Set(['a', 'y', removalKey('e')]);
    expect(stagedBlocks(base, work, (key) => include.has(key))).toEqual([p('a', 'A!'), p('b'), p('c'), p('d'), p('y')]);
  });

  it('includes moves on their own', () => {
    expect(ids(stagedBlocks(base, work, (key) => key === 'b'))).toBe('a c d b e');
  });

  it('equals work when everything is included, and base when nothing is', () => {
    const random = seeded(5);
    for (let i = 0; i < 500; i++) {
      const shuffled = [...base].sort(() => random.next() - 0.5).filter(() => random.next() < 0.8);
      const next = shuffled.map((block) => (random.next() < 0.3 ? p(block.id, 'edit') : block));
      next.splice(random.int(next.length + 1), 0, p(`n${i}`));
      expect(stagedBlocks(base, next, () => true)).toEqual(next);
      expect(stagedBlocks(base, next, () => false)).toEqual(base);
    }
  });
});
