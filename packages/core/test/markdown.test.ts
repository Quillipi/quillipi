import { describe, expect, it } from 'vitest';
import type { Block } from '../src/blocks.js';
import { parseSection, restoreIds, serializeSection } from '../src/markdown.js';
import { normalizeRuns, serializeInline } from '../src/inline.js';
import { seeded } from './random.js';

const sample: Block[] = [
  { id: 'g2h7a3k9', type: 'h1', text: 'Marketing plan' },
  { id: 'k3f9b2m4', type: 'p', text: 'Goal: earn **organic installs** first.' },
  { id: 'c4xnf6p2', type: 'task', text: 'New screenshots are live.', attrs: { done: false } },
  { id: 'h7t2m9q4', type: 'task', text: 'Store listing rewritten.', attrs: { done: true } },
  { id: 'u3x5q8r2', type: 'callout', text: 'Give it time.' },
  { id: 'w4e8r2t6', type: 'table', text: '', attrs: { rows: [['Channel', 'Cost'], ['Store', 'a | b']] } },
  { id: 'z9x8c7v6', type: 'code', text: 'npm run build\n```inner```', attrs: { language: 'sh' } },
  { id: 'b5n6m7k8', type: 'hr', text: '' },
  { id: 'k3m9pq2a', type: 'canvas', text: 'How a sound travels', attrs: { wrap: 'right', width: 46, aspect: 1.6 } },
  { id: 'q2w3e4r5', type: 'image', text: 'Store [new]', attrs: { src: 'assets/9f2c 1.png', wrap: 'left', width: 40 } },
  { id: 'p8d6k2xa', type: 'p', text: '' },
];

describe('serializeSection', () => {
  it('writes readable Markdown with one block per line', () => {
    expect(serializeSection({ blocks: sample })).toBe(
      [
        '# Marketing plan ^g2h7a3k9',
        '',
        'Goal: earn **organic installs** first. ^k3f9b2m4',
        '',
        '- [ ] New screenshots are live. ^c4xnf6p2',
        '- [x] Store listing rewritten. ^h7t2m9q4',
        '',
        '> [!NOTE]',
        '> Give it time. ^u3x5q8r2',
        '',
        '| Channel | Cost |',
        '| --- | --- |',
        '| Store | a \\| b |',
        '^w4e8r2t6',
        '',
        '````sh ^z9x8c7v6',
        'npm run build',
        '```inner```',
        '````',
        '',
        '---',
        '^b5n6m7k8',
        '',
        '![How a sound travels](canvas/k3m9pq2a.svg "canvas right 46% 1.6") ^k3m9pq2a',
        '',
        '![Store \\[new\\]](assets/9f2c%201.png "left 40%") ^q2w3e4r5',
        '',
        '^p8d6k2xa',
        '',
      ].join('\n'),
    );
  });

  it('reads back exactly what it wrote', () => {
    const back = parseSection(serializeSection({ blocks: sample })).blocks;
    const canvas = back.find((block) => block.type === 'canvas')!;
    expect(canvas.attrs?.src).toBe('canvas/k3m9pq2a.svg');
    delete canvas.attrs!.src; // the loader swaps this for the canvas's elements
    expect(back).toEqual(sample);
  });

  it('keeps paragraphs that look like other blocks as paragraphs', () => {
    const tricky = ['# not a heading', '- not a list', '1. not numbered', '> not a quote', '| not a table', '![not](an image)', '---', '  - indented'];
    const blocks: Block[] = tricky.map((text, i) => ({ id: `aaaaaaa${'bcdefghi'[i]}`, type: 'p', text }));
    expect(parseSection(serializeSection({ blocks })).blocks).toEqual(blocks);
  });

  it('round-trips thousands of random sections', () => {
    const random = seeded(7);
    const words = ['plan', 'Sound', '*', '_', '#', '-', '1.', '>', '|', '`', '[x]', '^abcdefgh', '==', '~~', '\\', '!', '[', ']'];
    const text = () =>
      serializeInline(
        normalizeRuns(
          Array.from({ length: 1 + random.int(4) }, () => ({
            text: Array.from({ length: 1 + random.int(4) }, () => random.pick(words)).join(' '),
            marks: random.pick([[], [], ['bold'], ['italic'], ['code']] as const).slice(),
          })),
        ),
      );
    const ids = new Set<string>();
    const id = () => {
      let next: string;
      do next = Array.from({ length: 8 }, () => random.pick([...'abcdefghijkmnpqrstuvwxyz23456789'])).join('');
      while (ids.has(next));
      ids.add(next);
      return next;
    };
    const makers: (() => Block)[] = [
      () => ({ id: id(), type: 'p', text: text() }),
      () => ({ id: id(), type: random.pick(['h1', 'h2', 'h3'] as const), text: text() }),
      () => ({ id: id(), type: random.pick(['li', 'ol', 'quote', 'callout'] as const), text: text() }),
      () => ({ id: id(), type: 'task', text: text(), attrs: { done: random.next() < 0.5 } }),
      () => ({ id: id(), type: 'code', text: random.pick(['', 'a\nb', '```', '  x']), attrs: { language: 'ts' } }),
      () => ({ id: id(), type: 'hr', text: '' }),
      () => ({ id: id(), type: 'table', text: '', attrs: { rows: [[text(), 'x|y'], ['', text()]] } }),
    ];
    for (let i = 0; i < 1500; i++) {
      const blocks = Array.from({ length: 1 + random.int(8) }, () => random.pick(makers)());
      const markdown = serializeSection({ blocks });
      expect(parseSection(markdown).blocks, markdown).toEqual(blocks);
    }
  });
});

describe('parseSection with Markdown from other tools', () => {
  it('folds wrapped lines, nested lists, deep headings and Windows line endings', () => {
    const source = '#### Deep\r\n\r\nA paragraph\r\nwrapped here.\r\n\r\n- one\r\n  continued\r\n  - nested\r\n2) two\r\n';
    expect(parseSection(source).blocks).toEqual([
      { id: '', type: 'h3', text: 'Deep' },
      { id: '', type: 'p', text: 'A paragraph wrapped here.' },
      { id: '', type: 'li', text: 'one continued' },
      { id: '', type: 'li', text: 'nested' },
      { id: '', type: 'ol', text: 'two' },
    ]);
  });

  it('keeps front matter and alert kinds', () => {
    const source = '---\ntitle: Plan\ntags: [a]\n---\n\n> [!WARNING]\n> Careful ^u3x5q8r2\n';
    const section = parseSection(source);
    expect(section.frontMatter).toBe('title: Plan\ntags: [a]');
    expect(section.blocks).toEqual([{ id: 'u3x5q8r2', type: 'callout', text: 'Careful', attrs: { kind: 'WARNING' } }]);
    expect(serializeSection(section)).toBe(source);
  });

  it('reads tables without outer pipes on the separator', () => {
    expect(parseSection('| a | b |\n| --- | ---\n| 1 | 2 |\n').blocks[0].attrs?.rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('restoreIds', () => {
  it('matches blocks that lost their IDs to the previous version by content', () => {
    const previous: Block[] = [
      { id: 'aaaaaaaa', type: 'h1', text: 'Plan' },
      { id: 'bbbbbbbb', type: 'p', text: 'We launch in May with the new store page.' },
    ];
    const stripped: Block[] = [
      { id: '', type: 'h1', text: 'Plan' },
      { id: '', type: 'p', text: 'We launch in June with the new store page.' },
      { id: '', type: 'p', text: 'Something new.' },
    ];
    const taken = new Set(['aaaaaaaa', 'bbbbbbbb']);
    const restored = restoreIds(stripped, previous, taken);
    expect(restored.map((block) => block.id).slice(0, 2)).toEqual(['aaaaaaaa', 'bbbbbbbb']);
    expect(restored[2].id).toMatch(/^[a-z2-9]{8}$/);
    expect(taken.has(restored[2].id)).toBe(true);
  });

  it('gives a duplicated ID to the first block only', () => {
    const blocks: Block[] = [
      { id: 'aaaaaaaa', type: 'p', text: 'One' },
      { id: 'aaaaaaaa', type: 'p', text: 'Copy' },
    ];
    const restored = restoreIds(blocks, [], new Set(['aaaaaaaa']));
    expect(restored[0].id).toBe('aaaaaaaa');
    expect(restored[1].id).not.toBe('aaaaaaaa');
  });
});
