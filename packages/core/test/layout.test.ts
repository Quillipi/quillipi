import { describe, expect, it } from 'vitest';
import {
  NOTEBOOK_COLOURS,
  type TreeItem,
  aboutLine,
  colourFor,
  detailsOf,
  folderNames,
  isFolderName,
  isSectionId,
  metaFile,
  notebookId,
  outline,
  parseMeta,
  placeTree,
  pruneTree,
  sectionPlaces,
  slugify,
  uniqueName,
  upgradeIds,
  upgradeTree,
} from '../src/layout.js';
import { addFrontMatterId, frontMatterId, parseSection, serializeSection, withFrontMatterId } from '../src/markdown.js';

const tree: TreeItem[] = ['start', { folder: 'research', name: 'Research', items: ['interviews', { folder: 'raw', name: 'Raw notes', items: ['call-1'] }] }, 'plan'];

describe('the tree', () => {
  it('lists folders and sections top to bottom, with where each is', () => {
    expect(outline(tree).map((entry) => `${'  '.repeat(entry.depth)}${entry.kind === 'folder' ? `${entry.key}/` : entry.key}`)).toEqual([
      'start',
      'research/',
      '  interviews',
      '  research/raw/',
      '    call-1',
      'plan',
    ]);
    expect([...sectionPlaces(tree)]).toEqual([
      ['start', ''],
      ['interviews', 'research'],
      ['call-1', 'research/raw'],
      ['plan', ''],
    ]);
    expect(folderNames(tree).get('research/raw')).toBe('Raw notes');
  });

  it('keeps the order the tree gives, for sections whose files are where it says', () => {
    const where = new Map([
      ['plan', ''],
      ['start', ''],
      ['call-1', 'research/raw'],
      ['interviews', 'research'],
    ]);
    expect(placeTree(tree, where)).toEqual(tree);
  });

  it('follows the files: a section moved on disk, a new file, a missing file and a new directory', () => {
    const where = new Map([
      ['start', ''],
      ['plan', 'research'], // moved into research by hand
      ['interviews', 'research'],
      ['found', 'archive/2025'], // a new file in a new directory
      // call-1 is gone
    ]);
    expect(placeTree(tree, where, new Map([['archive', 'Old work']]))).toEqual([
      'start',
      { folder: 'research', name: 'Research', items: ['interviews', { folder: 'raw', name: 'Raw notes', items: [] }, 'plan'] },
      { folder: 'archive', name: 'Old work', items: [{ folder: '2025', name: '2025', items: ['found'] }] },
    ]);
  });

  it('keeps a section once, and a folder once per parent, when a hand-edited tree repeats them', () => {
    const repeated: TreeItem[] = ['a', 'a', { folder: 'f', name: 'F', items: ['b'] }, { folder: 'f', name: 'Again', items: ['c'] }];
    const where = new Map([
      ['a', ''],
      ['b', 'f'],
      ['c', 'f'],
    ]);
    expect(placeTree(repeated, where)).toEqual(['a', { folder: 'f', name: 'F', items: ['b', 'c'] }]);
  });

  it('reads inklog.json leniently, dropping what is malformed, and writes it back', () => {
    const meta = parseMeta(JSON.stringify({ name: 'n', tree: ['ok', 'Not An ID', 7, { folder: '../up', items: [] }, { folder: 'f', items: ['x'] }, { folder: 'g', name: ' G ' }] }));
    expect(meta).toEqual({ name: 'n', tree: ['ok', { folder: 'f', name: 'F', items: ['x'] }, { folder: 'g', name: 'G', items: [] }] });
    expect(parseMeta(metaFile({ name: 'n' }, tree))).toEqual({ name: 'n', tree });
    expect(parseMeta('{not json')).toEqual({});
    expect(parseMeta(JSON.stringify({ name: 'old', sections: ['a', 'a/b', 3] }))).toEqual({ name: 'old', sections: ['a', 'a/b'] });
  });

  it("keeps a notebook's line and colour in inklog.json, and drops them when malformed", () => {
    const text = metaFile({ name: 'Gym rollup', about: 'Take over struggling gyms', colour: '#0f8b8d' }, ['about']);
    expect(Object.keys(JSON.parse(text))).toEqual(['name', 'about', 'colour', 'tree']);
    expect(detailsOf(parseMeta(text), 'x')).toEqual({ name: 'Gym rollup', about: 'Take over struggling gyms', colour: '#0f8b8d' });
    expect(parseMeta(JSON.stringify({ name: 'n', about: '  two\n lines  ', colour: '#0F8B8D' }))).toEqual({ name: 'n', about: 'two lines', colour: '#0f8b8d' });
    expect(parseMeta(JSON.stringify({ name: 'n', about: '   ', colour: 'teal' }))).toEqual({ name: 'n' });
    expect(Object.keys(JSON.parse(metaFile(detailsOf({}, 'fallback'), [])))).toEqual(['name', 'tree']);
    expect(aboutLine('x'.repeat(400))).toHaveLength(300);
  });

  it('gives every notebook a colour from the palette, the same for the same ID, and never violet', () => {
    expect(colourFor('gym-rollup')).toBe(colourFor('gym-rollup'));
    expect(NOTEBOOK_COLOURS).toContain(colourFor('gym-rollup'));
    expect(new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'].map(colourFor)).size).toBeGreaterThan(4);
    for (const colour of NOTEBOOK_COLOURS) {
      const [r, g, b] = [1, 3, 5].map((at) => parseInt(colour.slice(at, at + 2), 16));
      expect(b! > r! + 30 && b! > g! + 30 && r! > g!).toBe(false); // no violet: blue and red both well above green
    }
  });

  it('prunes to some sections and keeps the folders', () => {
    expect(pruneTree(tree, new Set(['plan']))).toEqual([{ folder: 'research', name: 'Research', items: [{ folder: 'raw', name: 'Raw notes', items: [] }] }, 'plan']);
  });
});

describe('names', () => {
  it('makes IDs from titles, and unique ones', () => {
    expect(slugify('Sound Intelligence: v2!')).toBe('sound-intelligence-v2');
    expect(slugify('Café déjà vu')).toBe('cafe-deja-vu');
    expect(slugify('---')).toBe('');
    expect(slugify(`${'a'.repeat(59)} b`)).toBe('a'.repeat(59)); // never ends in a hyphen after cutting
    expect(uniqueName('plan', (name) => ['plan', 'plan-2'].includes(name))).toBe('plan-3');
    expect(uniqueName('a'.repeat(60), (name) => name === 'a'.repeat(60))).toBe(`${'a'.repeat(58)}-2`);
  });

  it('accepts only safe IDs and directory names', () => {
    expect(['plan', 'call-1', 'a1'].every(isSectionId)).toBe(true);
    expect(['Plan', 'a/b', '-a', 'a--b', '', 'a.b', 'x'.repeat(61)].some(isSectionId)).toBe(false);
    expect(['research', 'My notes', 'v1.2'].every(isFolderName)).toBe(true);
    expect(['', '.git', '..', 'a/b', 'a\\b', 'c:', ' padded', 'tab\there'].some(isFolderName)).toBe(false);
  });
});

describe('IDs in front matter', () => {
  it('reads, sets and adds a section ID, keeping other front matter', () => {
    expect(frontMatterId('title: Plan\nid: plan')).toBe('plan');
    expect(frontMatterId('id: Not Valid')).toBeUndefined();
    expect(frontMatterId('id: ../../etc')).toBeUndefined();
    expect(frontMatterId('id: Plan')).toBeUndefined();
    expect(frontMatterId(undefined)).toBeUndefined();
    expect(withFrontMatterId('title: Plan\nid: old', 'plan')).toBe('id: plan\ntitle: Plan');
    expect(withFrontMatterId(undefined, 'plan')).toBe('id: plan');

    const plain = serializeSection({ blocks: [{ id: 'aaaaaaaa', type: 'h1', text: 'Plan' }] });
    const added = addFrontMatterId(plain, 'plan');
    // Exactly what Quillipi writes for the same section with its ID, so the upgrade's commit and the working file agree.
    expect(added).toBe(serializeSection({ blocks: [{ id: 'aaaaaaaa', type: 'h1', text: 'Plan' }], frontMatter: 'id: plan' }));
    expect(parseSection(added)).toEqual({ blocks: [{ id: 'aaaaaaaa', type: 'h1', text: 'Plan' }], frontMatter: 'id: plan' });
    expect(addFrontMatterId(added, 'plan')).toBe(added);
    expect(addFrontMatterId('---\r\nowner: Karan\r\n---\r\n\r\n# Plan ^aaaaaaaa\r\n', 'plan')).toBe('---\nid: plan\nowner: Karan\n---\n\n# Plan ^aaaaaaaa\n');
  });
});

describe('upgrading nested sections to folders', () => {
  it('gives sections IDs from their file names and keeps directories as folders', () => {
    const upgraded = upgradeIds(['inklog-notebook/about', 'inklog-notebook/roadmap', 'start-here', 'architecture']);
    expect(Object.fromEntries(upgraded)).toEqual({
      architecture: { id: 'architecture', folder: '' },
      'inklog-notebook/about': { id: 'about', folder: 'inklog-notebook' },
      'inklog-notebook/roadmap': { id: 'roadmap', folder: 'inklog-notebook' },
      'start-here': { id: 'start-here', folder: '' },
    });
    const order = ['inklog-notebook/about', 'inklog-notebook/roadmap', 'start-here', 'architecture'];
    expect(upgradeTree(order, upgraded, new Map())).toEqual([
      { folder: 'inklog-notebook', name: 'Inklog Notebook', items: ['about', 'roadmap'] },
      'start-here',
      'architecture',
    ]);
  });

  it('moves a section with sections under it into their folder, named after it, and makes clashing IDs unique', () => {
    const upgraded = upgradeIds(['product', 'product/pricing', 'product/deep/pricing', 'notes/My_Ideas.v2']);
    expect(Object.fromEntries(upgraded)).toEqual({
      'notes/My_Ideas.v2': { id: 'my-ideas-v2', folder: 'notes' },
      product: { id: 'product', folder: 'product' },
      'product/deep/pricing': { id: 'pricing', folder: 'product/deep' },
      'product/pricing': { id: 'pricing-2', folder: 'product' },
    });
    const order = ['product', 'product/pricing', 'product/deep/pricing'];
    expect(upgradeTree(order, upgraded, new Map([['product', 'Our product']]))).toEqual([
      { folder: 'product', name: 'Our product', items: ['product', 'pricing-2', { folder: 'deep', name: 'Deep', items: ['pricing'] }] },
      { folder: 'notes', name: 'Notes', items: ['my-ideas-v2'] },
    ]);
  });

  it('gives the same IDs for the same old IDs, in any order', () => {
    const ids = ['b/x', 'a/x', 'x', 'c'];
    expect([...upgradeIds(ids)].sort()).toEqual([...upgradeIds([...ids].reverse())].sort());
  });
});

describe('a new notebook\'s ID', () => {
  it('comes from its title, then -2, -3 while taken, within 60 characters', () => {
    const none = () => false;
    expect(notebookId('  Gym   Rollup! ', none)).toBe('gym-rollup');
    expect(notebookId('Gym rollup', (id) => ['gym-rollup', 'gym-rollup-2'].includes(id))).toBe('gym-rollup-3');
    expect(notebookId('शोध', none)).toBe('notebook');
    const long = notebookId('a'.repeat(80), (id) => id === 'a'.repeat(60));
    expect(long).toBe(`${'a'.repeat(58)}-2`);
    expect(long.length).toBe(60);
    // Cut at 60 characters, an ID never ends in a hyphen.
    expect(notebookId(`${'a'.repeat(59)} b`, none)).toBe('a'.repeat(59));
    expect(notebookId(`${'a'.repeat(57)} b`, (id) => id === `${'a'.repeat(57)}-b`)).toBe(`${'a'.repeat(57)}-2`);
  });
});

