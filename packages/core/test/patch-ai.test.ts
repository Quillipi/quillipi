import { describe, expect, it } from 'vitest';
import { keyTerms, readBlockLines, relatedBlocks, renderHits, renderMap, renderRead, searchBlocks } from '../src/ai.js';
import { type Block, blockHash } from '../src/blocks.js';
import { applyCanvasOps, diffCanvas, renderCanvasSvg } from '../src/canvas.js';
import { applyPatch, reviewReasons } from '../src/patch.js';

const blocks: Block[] = [
  { id: 'aaaaaaaa', type: 'h1', text: 'Sound intelligence' },
  { id: 'bbbbbbbb', type: 'p', text: '**Sound Intelligence** matches every meme with the right sound in under a second.' },
  { id: 'cccccccc', type: 'task', text: 'Ship the matcher', attrs: { done: false } },
];

describe('applyPatch', () => {
  it('applies edits addressed by ID and version', () => {
    const taken = new Set(blocks.map((block) => block.id));
    const result = applyPatch(
      blocks,
      [
        { op: 'replace', id: 'bbbbbbbb', base: blockHash(blocks[1]), find: 'under a second', with: 'about 200 ms' },
        { op: 'replace', id: 'cccccccc', base: blockHash(blocks[2]), done: true },
        { op: 'insert', after: 'aaaaaaaa', type: 'h2', text: 'How it works' },
      ],
      taken,
    );
    expect(result.ok).toBe(true);
    expect(result.blocks[2].text).toContain('about 200 ms');
    expect(result.blocks[3].attrs?.done).toBe(true);
    expect(result.blocks[1]).toMatchObject({ type: 'h2', text: 'How it works' });
    expect(taken.has(result.blocks[1].id)).toBe(true);
  });

  it('keeps several inserts after the same block in the order given', () => {
    const insert = (after: string | null, text: string) => ({ op: 'insert' as const, after, type: 'li' as const, text });
    const result = applyPatch(blocks, [insert('aaaaaaaa', 'One'), insert('aaaaaaaa', 'Two'), insert('aaaaaaaa', 'Three'), insert(null, 'Top 1'), insert(null, 'Top 2')], new Set());
    expect(result.ok).toBe(true);
    expect(result.blocks.map((block) => block.text)).toEqual(['Top 1', 'Top 2', blocks[0].text, 'One', 'Two', 'Three', blocks[1].text, blocks[2].text]);
  });

  it('inserts after a block that moved at its new place', () => {
    const insert = (text: string) => ({ op: 'insert' as const, after: 'aaaaaaaa', type: 'p' as const, text });
    const result = applyPatch(blocks, [insert('One'), { op: 'move', id: 'aaaaaaaa', after: 'cccccccc' }, insert('Two')], new Set());
    expect(result.blocks.map((block) => block.text)).toEqual(['One', blocks[1].text, blocks[2].text, blocks[0].text, 'Two']);
  });

  it('applies nothing when any op is stale, and shows the current text', () => {
    const result = applyPatch(
      blocks,
      [
        { op: 'delete', id: 'aaaaaaaa', base: blockHash(blocks[0]) },
        { op: 'replace', id: 'bbbbbbbb', base: '000000', text: 'x' },
      ],
      new Set(),
    );
    expect(result.ok).toBe(false);
    expect(result.blocks).toEqual(blocks);
    expect(result.lines.join('\n')).toContain('changed since you read it');
    expect(result.lines.join('\n')).toContain('now: ^bbbbbbbb p');
  });

  it('refuses multi-line text and impossible type changes', () => {
    const one = applyPatch(blocks, [{ op: 'replace', id: 'bbbbbbbb', base: blockHash(blocks[1]), text: 'a\nb' }], new Set());
    expect(one.lines[0]).toContain('one line');
    const two = applyPatch(blocks, [{ op: 'insert', after: null, type: 'image' }], new Set());
    expect(two.lines[0]).toContain('images are added by people');
  });

  it('builds canvases from shapes and links', () => {
    const result = applyPatch(
      [],
      [{ op: 'insert', after: null, type: 'canvas', text: 'Flow', canvas: { add: [{ label: 'Upload' }, { label: 'Match', kind: 'diamond' }], link: [{ from: 'Upload', to: 'Match' }] } }],
      new Set(),
    );
    expect(result.ok).toBe(true);
    expect(result.blocks[0].attrs?.elements?.map((element) => element.kind)).toEqual(['box', 'diamond', 'arrow']);
  });
});

describe('reviewReasons', () => {
  it('holds long deletions and big cuts, not small edits', () => {
    const long: Block = { id: 'dddddddd', type: 'p', text: 'A long paragraph that explains the decision and the reasons behind it.' };
    const cut: Block = { ...long, text: 'A long paragraph.' };
    expect(reviewReasons([long], [], new Set(['dddddddd']))[0]).toMatch(/^deletes \^dddddddd/);
    expect(reviewReasons([long], [cut], new Set(['dddddddd']))[0]).toMatch(/^cuts \^dddddddd/);
    expect(reviewReasons(blocks, [], new Set(['aaaaaaaa']))).toEqual([]);
  });
});

describe('AI text', () => {
  it('reads one line per block with ID, type and version', () => {
    expect(readBlockLines(blocks[2])).toEqual([`^cccccccc task[ ] @${blockHash(blocks[2])} Ship the matcher`]);
    expect(renderRead({ id: 'product/sound', blocks }, ['cccccccc', 'zzzzzzzz'])).toMatch(/^product\/sound "Sound intelligence" · 1 of 3 blocks.*\n.*\n✗ no block \^zzzzzzzz/);
  });

  it('maps sections with headings, terms and figures', () => {
    const map = renderMap({
      name: 'memedeck',
      entries: [
        { folder: 'product', name: 'Product', depth: 0, sections: 1 },
        { id: 'sound', blocks, depth: 1, uncommitted: 2 },
      ],
      held: 1,
      sinceVisit: [],
      now: Date.now(),
    });
    expect(map).toContain('memedeck · 1 sections · 1 folder · 3 blocks');
    expect(map).toContain('no commits yet · 2 uncommitted · 1 held for review');
    expect(map).toContain('\nproduct/ "Product" · 1 section\n');
    expect(map).toContain('\n  sound "Sound intelligence" · 3 blocks');
    expect(map).toContain('terms: Sound Intelligence');
  });

  it('puts bold phrases first in key terms', () => {
    expect(keyTerms(blocks)[0]).toBe('Sound Intelligence');
  });

  it('shortens long search hits without garbling their heads', () => {
    const long: Block = { id: 'ffffffff', type: 'task', text: `Fix the sign-in cookie ${'so that two notebooks can stay open at once '.repeat(4)}`, attrs: { done: false } };
    const output = renderHits('hits', searchBlocks([{ id: 'roadmap', blocks: [long] }], 'cookie'), 'cookie');
    expect(output).toContain(`roadmap ^ffffffff task[ ] @${blockHash(long)} Fix the sign-in cookie`);
  });

  it('finds blocks by phrase and words, and related blocks elsewhere', () => {
    const other = { id: 'overview', blocks: [{ id: 'eeeeeeee', type: 'p', text: 'MemeDeck relies on Sound Intelligence for discovery.' } as Block] };
    const sections = [{ id: 'product/sound', blocks }, other];
    expect(searchBlocks(sections, 'right sound')[0].block.id).toBe('bbbbbbbb');
    expect(relatedBlocks([blocks[1]], [other])[0].block.id).toBe('eeeeeeee');
  });
});

describe('canvas', () => {
  it('adds shapes without overlap, links by label and removes arrows with their shapes', () => {
    const added = applyCanvasOps([], 1.6, { add: [{ label: 'A' }, { label: 'B' }, { label: 'C' }, { label: 'D' }, { label: 'E' }], link: [{ from: 'A', to: 'k2' }] });
    const shapes = added.elements.filter((element) => element.kind !== 'arrow');
    for (const a of shapes) {
      for (const b of shapes) {
        if (a === b || a.kind === 'arrow' || b.kind === 'arrow') continue;
        expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true);
      }
    }
    const removed = applyCanvasOps(added.elements, added.aspect, { remove: ['k1'] });
    expect(removed.elements.some((element) => element.kind === 'arrow')).toBe(false);
    expect(diffCanvas(added.elements, removed.elements)).toEqual(['removed box "A"', 'removed arrow "A" → "B"']);
  });

  it('grows the board when it runs out of room', () => {
    const many = applyCanvasOps([], 3, { add: Array.from({ length: 12 }, (_, i) => ({ label: `S${i}` })) });
    expect(many.ok).toBe(true);
    expect(many.aspect).toBeLessThan(3);
  });

  it('draws every element with an ID the editor can find', () => {
    const { elements } = applyCanvasOps([], 1.6, { add: [{ label: 'A & <B>' }, { label: 'C' }], link: [{ from: 'k1', to: 'k2' }] });
    const svg = renderCanvasSvg(elements, { aspect: 1.6, selected: new Set(['k1']) });
    expect(svg).toContain('data-el="k1"');
    expect(svg).toContain('data-el="k3"');
    expect(svg).toContain('data-handle="k1"');
    expect(svg).toContain('A &amp; &lt;B&gt;');
  });
});
