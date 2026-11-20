import type { CanvasElement } from './canvas.js';
import { inlineToPlain } from './inline.js';
import { shortHash, stableStringify } from './stable.js';

export const TEXT_TYPES = ['p', 'h1', 'h2', 'h3', 'li', 'ol', 'task', 'quote', 'callout'] as const;
export type TextBlockType = (typeof TEXT_TYPES)[number];
export type BlockType = TextBlockType | 'code' | 'hr' | 'table' | 'image' | 'canvas';
export type Wrap = 'left' | 'right' | 'inline';

/** Type-specific data. Only the fields for the block's type are set. */
export interface BlockAttrs {
  /** task: ticked or not. Always set on tasks. */
  done?: boolean;
  /** code: language from the fence info string. */
  language?: string;
  /** callout: GitHub alert kind when it isn't NOTE, such as `TIP` or `WARNING`. */
  kind?: string;
  /** table: cells as inline Markdown. The first row is the header. */
  rows?: string[][];
  /** image: file inside the repo, such as `assets/9f2c41d0.png`. */
  src?: string;
  /** image, canvas: placement on the page. */
  wrap?: Wrap;
  /** image, canvas: width as a percentage of the page. */
  width?: number;
  /** canvas: board width divided by board height. */
  aspect?: number;
  /** canvas: shapes, text, images and arrows. */
  elements?: CanvasElement[];
}

export interface Block {
  /** Permanent, unique within the repo. See ids.ts. */
  id: string;
  type: BlockType;
  /** Inline Markdown for text blocks, raw code for code, the caption for images and canvases. */
  text: string;
  attrs?: BlockAttrs;
}

export function isTextBlock(block: Pick<Block, 'type'>): boolean {
  return (TEXT_TYPES as readonly string[]).includes(block.type);
}

export function sameContent(a: Block, b: Block): boolean {
  return a.type === b.type && a.text === b.text && stableStringify(a.attrs ?? {}) === stableStringify(b.attrs ?? {});
}

export function sameBlocks(a: readonly Block[], b: readonly Block[]): boolean {
  return a.length === b.length && a.every((block, i) => block.id === b[i].id && sameContent(block, b[i]));
}

/** Version tag of a block's content. AI agents send it back with edits to prove what they read. */
export function blockHash(block: Block): string {
  return shortHash(`${block.type}\u0000${block.text}\u0000${stableStringify(block.attrs ?? {})}`);
}

export function byId(blocks: readonly Block[]): Map<string, Block> {
  return new Map(blocks.map((block) => [block.id, block]));
}

/** The words a reader sees, used for search, word diffs and key terms. */
export function plainText(block: Block): string {
  switch (block.type) {
    case 'code':
      return block.text;
    case 'table':
      return (block.attrs?.rows ?? []).map((row) => row.map(inlineToPlain).join(' | ')).join('\n');
    case 'canvas':
      return [block.text, ...(block.attrs?.elements ?? []).map((element) => element.label ?? '')].filter(Boolean).join(' · ');
    case 'hr':
      return '';
    default:
      return inlineToPlain(block.text);
  }
}

/** A section's title is its first top-level heading. */
export function sectionTitle(blocks: readonly Block[]): string {
  const heading = blocks.find((block) => block.type === 'h1');
  return heading ? inlineToPlain(heading.text) : '';
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}
