/** The tree's moves and the tabs' order (step 3.4b), which need no browser. */
import type { TreeItem } from '@inklog/core';
import { describe, expect, it } from 'vitest';
import { dropOp, findSections, folderOfSection, foldersTo, itemsOf, moveTab, moveTargets, parentOf } from '../src/tree/model';

// about, research/ (pricing, competitors, research/deep/ (notes)), plan, operations/ (empty)
const tree: TreeItem[] = [
  'about',
  { folder: 'research', name: 'Research', items: ['pricing', 'competitors', { folder: 'deep', name: 'Deep dives', items: ['notes'] }] },
  'plan',
  { folder: 'operations', name: 'Operations', items: [] },
];

describe('finding things in the tree', () => {
  it('knows which folder a section is in, and the folders that lead to it', () => {
    expect(folderOfSection(tree, 'about')).toBe('');
    expect(folderOfSection(tree, 'notes')).toBe('research/deep');
    expect(folderOfSection(tree, 'nope')).toBeUndefined();
    expect(foldersTo('research/deep')).toEqual(['research', 'research/deep']);
    expect(foldersTo('')).toEqual([]);
    expect(parentOf('research/deep')).toBe('research');
    expect(parentOf('research')).toBe('');
    expect(itemsOf(tree, 'research/deep')).toEqual(['notes']);
    expect(itemsOf(tree, 'research/nope')).toBeUndefined();
  });

  it('finds sections whose title has every word typed', () => {
    const sections = [
      { id: 'pricing', title: 'Pricing model', folder: 'research' },
      { id: 'plan', title: 'Plan', folder: '' },
    ];
    expect(findSections(sections, 'pri MOD').map((section) => section.id)).toEqual(['pricing']);
    expect(findSections(sections, 'p').map((section) => section.id)).toEqual(['pricing', 'plan']);
    expect(findSections(sections, 'plan model')).toEqual([]);
    expect(findSections(sections, '   ')).toEqual([]);
  });
});

describe('dropping a row', () => {
  const section = (id: string) => ({ kind: 'section', id }) as const;
  const folder = (path: string) => ({ kind: 'folder', path }) as const;

  it('puts a section before or after another, in that section\'s folder', () => {
    expect(dropOp(tree, section('about'), section('plan'), 'after')).toEqual({ op: 'move', id: 'about', in: '', after: 'plan' });
    expect(dropOp(tree, section('plan'), section('about'), 'before')).toEqual({ op: 'move', id: 'plan', in: '', after: null });
    expect(dropOp(tree, section('plan'), section('competitors'), 'before')).toEqual({ op: 'move', id: 'plan', in: 'research', after: 'pricing' });
    // After a folder is named by its path ending in /.
    expect(dropOp(tree, section('about'), section('plan'), 'before')).toEqual({ op: 'move', id: 'about', in: '', after: 'research/' });
  });

  it('puts a row inside a folder, last', () => {
    expect(dropOp(tree, section('plan'), folder('operations'), 'inside')).toEqual({ op: 'move', id: 'plan', in: 'operations' });
    expect(dropOp(tree, folder('operations'), folder('research/deep'), 'inside')).toEqual({ op: 'move', id: 'operations/', in: 'research/deep' });
    // Only folders take rows inside them.
    expect(dropOp(tree, section('plan'), section('about'), 'inside')).toBeUndefined();
  });

  it('moves a folder by its path', () => {
    expect(dropOp(tree, folder('operations'), section('about'), 'before')).toEqual({ op: 'move', id: 'operations/', in: '', after: null });
    expect(dropOp(tree, folder('research/deep'), section('plan'), 'after')).toEqual({ op: 'move', id: 'research/deep/', in: '', after: 'plan' });
  });

  it('does nothing when the row would land where it is', () => {
    expect(dropOp(tree, section('about'), section('about'), 'after')).toBeUndefined();
    expect(dropOp(tree, section('about'), section('research'), 'before')).toBeUndefined(); // no such section
    expect(dropOp(tree, section('about'), folder('research'), 'before')).toBeUndefined();
    expect(dropOp(tree, section('pricing'), section('competitors'), 'before')).toBeUndefined();
    expect(dropOp(tree, section('notes'), folder('research/deep'), 'inside')).toBeUndefined();
  });

  it('never puts a folder inside itself or inside a folder within it', () => {
    expect(dropOp(tree, folder('research'), folder('research'), 'inside')).toBeUndefined();
    expect(dropOp(tree, folder('research'), folder('research/deep'), 'inside')).toBeUndefined();
    expect(dropOp(tree, folder('research'), section('notes'), 'after')).toBeUndefined();
    expect(dropOp(tree, folder('research'), section('pricing'), 'before')).toBeUndefined();
  });
});

describe('Move to…', () => {
  it('offers the top and every folder except where the row is', () => {
    expect(moveTargets(tree, { kind: 'section', id: 'notes' }).map((target) => target.path)).toEqual(['', 'research', 'operations']);
    expect(moveTargets(tree, { kind: 'section', id: 'plan' }).map((target) => target.path)).toEqual(['research', 'research/deep', 'operations']);
  });

  it('never offers a folder itself or what is inside it', () => {
    expect(moveTargets(tree, { kind: 'folder', path: 'research' }).map((target) => target.path)).toEqual(['operations']);
    expect(moveTargets(tree, { kind: 'folder', path: 'research/deep' }).map((target) => [target.path, target.depth])).toEqual([
      ['', 0],
      ['operations', 1],
    ]);
  });
});

describe('tabs', () => {
  it('move to where they are dropped', () => {
    const tabs = ['a', 'b', 'c', 'd'];
    expect(moveTab(tabs, 'a', 3)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveTab(tabs, 'd', 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveTab(tabs, 'b', 4)).toEqual(['a', 'c', 'd', 'b']);
    expect(moveTab(tabs, 'b', 1)).toEqual(tabs);
    expect(moveTab(tabs, 'b', 2)).toEqual(tabs);
    expect(moveTab(tabs, 'x', 0)).toEqual(tabs);
  });
});
