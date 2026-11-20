/**
 * Converting between Quillipi blocks and TipTap documents. One top-level node is one block,
 * so the conversion is direct; inline formatting goes through core's inline Markdown.
 */
import { type Block, type Mark, type Run, newId, parseInline, sameBlocks, serializeInline } from '@inklog/core';
import type { Editor, JSONContent } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';

const MARKS: readonly Mark[] = ['bold', 'italic', 'strike', 'highlight', 'code'];
/** Transactions carrying this meta come from elsewhere, so they are not saved back. */
export const FROM_ELSEWHERE = 'inklog:fromElsewhere';

export function blocksToDoc(blocks: readonly Block[]): JSONContent {
  // The document schema needs at least one block.
  const content = blocks.length ? blocks.map(blockToNode) : [blockToNode({ id: newId(), type: 'p', text: '' })];
  return { type: 'doc', content };
}

export function blockToNode(block: Block): JSONContent {
  const id = block.id;
  const attrs = block.attrs ?? {};
  const text = inlineContent(block.text);
  switch (block.type) {
    case 'p':
      return { type: 'paragraph', attrs: { id }, content: text };
    case 'h1':
    case 'h2':
    case 'h3':
      return { type: 'heading', attrs: { id, level: Number(block.type[1]) }, content: text };
    case 'li':
      return { type: 'bulletItem', attrs: { id }, content: text };
    case 'ol':
      return { type: 'orderedItem', attrs: { id }, content: text };
    case 'task':
      return { type: 'taskItem', attrs: { id, checked: Boolean(attrs.done) }, content: text };
    case 'quote':
      return { type: 'quote', attrs: { id }, content: text };
    case 'callout':
      return { type: 'callout', attrs: { id, kind: attrs.kind ?? null }, content: text };
    case 'code':
      return { type: 'codeBlock', attrs: { id, language: attrs.language ?? null }, content: block.text ? [{ type: 'text', text: block.text }] : [] };
    case 'hr':
      return { type: 'horizontalRule', attrs: { id } };
    case 'table':
      return {
        type: 'table',
        attrs: { id },
        content: (attrs.rows ?? [['']]).map((row, index) => ({
          type: 'tableRow',
          content: row.map((cell) => ({ type: index === 0 ? 'tableHeader' : 'tableCell', content: [{ type: 'paragraph', content: inlineContent(cell) }] })),
        })),
      };
    case 'image':
      return { type: 'image', attrs: { id, src: attrs.src ?? '', caption: block.text, wrap: attrs.wrap ?? 'inline', width: attrs.width ?? 100 } };
    case 'canvas':
      return { type: 'canvas', attrs: { id, title: block.text, wrap: attrs.wrap ?? 'inline', width: attrs.width ?? 100, aspect: attrs.aspect, elements: attrs.elements ?? [] } };
  }
}

function inlineContent(markdown: string): JSONContent[] {
  return parseInline(markdown).map((run) => {
    const marks = [...run.marks.map((type) => ({ type })), ...(run.href ? [{ type: 'link', attrs: { href: run.href } }] : [])];
    return marks.length ? { type: 'text', text: run.text, marks } : { type: 'text', text: run.text };
  });
}

export function docToBlocks(doc: PMNode): Block[] {
  const blocks: Block[] = [];
  doc.forEach((node) => blocks.push(nodeToBlock(node)));
  return blocks;
}

function nodeToBlock(node: PMNode): Block {
  const id: string = node.attrs.id ?? '';
  const a = node.attrs;
  switch (node.type.name) {
    case 'heading':
      return { id, type: `h${Math.min(3, a.level)}` as 'h1', text: inlineMarkdown(node) };
    case 'bulletItem':
      return { id, type: 'li', text: inlineMarkdown(node) };
    case 'orderedItem':
      return { id, type: 'ol', text: inlineMarkdown(node) };
    case 'taskItem':
      return { id, type: 'task', text: inlineMarkdown(node), attrs: { done: Boolean(a.checked) } };
    case 'quote':
      return { id, type: 'quote', text: inlineMarkdown(node) };
    case 'callout':
      return a.kind ? { id, type: 'callout', text: inlineMarkdown(node), attrs: { kind: a.kind } } : { id, type: 'callout', text: inlineMarkdown(node) };
    case 'codeBlock':
      return a.language ? { id, type: 'code', text: node.textContent, attrs: { language: a.language } } : { id, type: 'code', text: node.textContent };
    case 'horizontalRule':
      return { id, type: 'hr', text: '' };
    case 'table': {
      const rows: string[][] = [];
      node.forEach((row) => {
        const cells: string[] = [];
        row.forEach((cell) => cells.push(cell.firstChild ? inlineMarkdown(cell.firstChild).trim() : ''));
        rows.push(cells);
      });
      return { id, type: 'table', text: '', attrs: { rows } };
    }
    case 'image':
      return { id, type: 'image', text: a.caption ?? '', attrs: { src: a.src, wrap: a.wrap, width: a.width } };
    case 'canvas':
      return { id, type: 'canvas', text: a.title ?? '', attrs: { wrap: a.wrap, width: a.width, aspect: a.aspect, elements: a.elements } };
    default: // paragraph, the only other top-level node in the schema
      return { id, type: 'p', text: inlineMarkdown(node) };
  }
}

function inlineMarkdown(node: PMNode): string {
  const runs: Run[] = [];
  node.forEach((child) => {
    if (!child.isText) return;
    const marks = child.marks.map((mark) => mark.type.name).filter((name): name is Mark => (MARKS as readonly string[]).includes(name));
    const href = child.marks.find((mark) => mark.type.name === 'link')?.attrs.href;
    runs.push(href ? { text: child.text!, marks, href } : { text: child.text!, marks });
  });
  return serializeInline(runs);
}

/**
 * Makes the editor show `target`, replacing only the blocks that differ, so the cursor and
 * scroll position stay put. `fromElsewhere` changes stay out of the person's undo history.
 */
export function showBlocks(editor: Editor, target: readonly Block[], { fromElsewhere }: { fromElsewhere: boolean }): void {
  const current = docToBlocks(editor.state.doc);
  if (sameBlocks(current, target)) return;
  const same = (a: Block | undefined, b: Block | undefined) => !!a && !!b && sameBlocks([a], [b]);

  let start = 0;
  while (same(current[start], target[start])) start++;
  let endCurrent = current.length;
  let endTarget = target.length;
  while (endCurrent > start && endTarget > start && same(current[endCurrent - 1], target[endTarget - 1])) {
    endCurrent--;
    endTarget--;
  }

  const positions: number[] = [];
  editor.state.doc.forEach((_node, offset) => positions.push(offset));
  const size = editor.state.doc.content.size;
  const from = positions[start] ?? size;
  const to = positions[endCurrent] ?? size;
  const replacement = target.slice(start, endTarget).map((block) => editor.schema.nodeFromJSON(blockToNode(block)));
  if (!target.length) replacement.push(editor.schema.nodeFromJSON(blockToNode({ id: newId(), type: 'p', text: '' })));

  const transaction = editor.state.tr.replaceWith(from, to, replacement);
  if (fromElsewhere) transaction.setMeta('addToHistory', false).setMeta(FROM_ELSEWHERE, true);
  editor.view.dispatch(transaction);
}
