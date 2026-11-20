/**
 * The editor's own conversion, run without a browser: what the editor does to text when it opens
 * a section. Agents' text is stored in the form the editor writes (core's inEditorForm), so opening
 * a section an agent wrote changes nothing, and no change is credited to the person.
 */
import { type Block, type PatchOp, applyPatch, blockHash, inEditorForm } from '@inklog/core';
import { getSchema } from '@tiptap/core';
import { Node } from '@tiptap/pm/model';
import { describe, expect, it, vi } from 'vitest';

// The schema's image and drawing views import the editor's API module, which reads the page's address.
vi.stubGlobal('location', new URL('http://127.0.0.1/n/test'));
const { blocksToDoc, docToBlocks } = await import('../src/editor/convert');
const { editorExtensions } = await import('../src/editor/schema');

const schema = getSchema(editorExtensions());

/** What the editor saves after opening these blocks and changing nothing. */
function throughEditor(blocks: readonly Block[]): Block[] {
  return docToBlocks(Node.fromJSON(schema, blocksToDoc(blocks)));
}

const AGENT_TEXT = [
  'Built `create_section`, then organize replaced create_section.',
  'snake_case_names and a_b_c',
  'Uses create_section and *stars* in snake_case_names.',
  '*italic with stars* and __bold with underscores__',
  'A [link](https://example.com/a_b?x=1) and ==highlight== and ~~strike~~',
  'Stars * alone, a [bracket] and a back\\slash',
  '**bold _and italic_** then `code with _ and *`',
  '  spaces at the ends  ',
  'Price: 5 * 3 = 15 [approx]',
];

describe("agents' text in the editor's form", () => {
  it('comes back from the editor unchanged, for every kind of text block', () => {
    const types = ['p', 'h1', 'h2', 'h3', 'li', 'ol', 'quote', 'callout'] as const;
    const blocks: Block[] = AGENT_TEXT.flatMap((text, i) => types.map((type, j) => inEditorForm({ id: `b${i}x${j}aaa`.slice(0, 8), type, text })));
    blocks.push(inEditorForm({ id: 'taskaaaa', type: 'task', text: 'Ship create_section', attrs: { done: false } }));
    blocks.push(inEditorForm({ id: 'tableaaa', type: 'table', text: '', attrs: { rows: [[' Name ', 'snake_case'], ['*a*', ' b ']] } }));
    expect(throughEditor(blocks)).toEqual(blocks);
  });

  it('is what a patch stores, so a section an agent wrote opens with nothing to save', () => {
    const start: Block[] = [{ id: 'aaaaaaaa', type: 'p', text: 'Old' }];
    const ops: PatchOp[] = [
      { op: 'replace', id: 'aaaaaaaa', base: blockHash(start[0]!), text: 'Uses create_section and *stars*' },
      { op: 'insert', after: 'aaaaaaaa', type: 'table', rows: [['a_b', ' c ']] },
      ...AGENT_TEXT.map((text): PatchOp => ({ op: 'insert', after: null, type: 'p', text })),
    ];
    const result = applyPatch(start, ops, new Set());
    expect(result.ok).toBe(true);
    expect(throughEditor(result.blocks)).toEqual(result.blocks);
  });
});

