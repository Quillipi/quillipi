/**
 * Edits from AI agents. An agent names every block it changes by ID and by the version hash
 * it read (`base`), so it can never overwrite text it hasn't seen.
 */
import { type Block, type BlockType, TEXT_TYPES, type TextBlockType, blockHash, byId, isTextBlock, plainText, wordCount } from './blocks.js';
import { readBlockLines } from './ai.js';
import { type CanvasOps, DEFAULT_ASPECT, applyCanvasOps } from './canvas.js';
import { newId } from './ids.js';
import { agentMarkdown, editorInline } from './inline.js';

interface ContentFields {
  text?: string;
  done?: boolean;
  rows?: string[][];
  language?: string;
}

export type PatchOp =
  | ({ op: 'replace'; id: string; base: string; find?: string; with?: string; type?: TextBlockType } & ContentFields)
  | ({ op: 'insert'; after: string | null; type?: BlockType; canvas?: CanvasOps } & ContentFields)
  | { op: 'delete'; id: string; base: string }
  | { op: 'move'; id: string; after: string | null }
  | ({ op: 'canvas'; id: string; base: string } & CanvasOps);

export interface PatchResult {
  ok: boolean;
  /** The section after the patch, or the section unchanged if any op failed. */
  blocks: Block[];
  /** One line per op: ✓ or ✗ with the reason. */
  lines: string[];
  /** Blocks that were added, edited, moved or deleted. */
  touched: string[];
}

const INSERTABLE: readonly BlockType[] = [...TEXT_TYPES, 'code', 'hr', 'table', 'canvas'];

/**
 * Applies an agent's edits to a section. Either every op applies or none does: if one fails,
 * usually because a block changed since the agent read it, the section stays as it was and
 * the reply shows the block's current version so the agent can try again.
 */
export function applyPatch(blocks: readonly Block[], ops: readonly PatchOp[], taken: Set<string>): PatchResult {
  const next = [...blocks];
  const lines: string[] = [];
  const touched = new Set<string>();
  let ok = true;

  const indexOf = (id: string) => next.findIndex((block) => block.id === id);
  const fail = (line: string, block?: Block) => {
    ok = false;
    lines.push(`✗ ${line}`, ...(block ? readBlockLines(block).map((current) => `  now: ${current}`) : []));
  };
  /** The block an op may change, or undefined after reporting why not. */
  const target = (id: string, base: string): number | undefined => {
    const index = indexOf(id);
    if (index < 0) fail(`^${id}: no such block in this section`);
    else if (next[index] && blockHash(next[index]) !== base) fail(`^${id} changed since you read it`, next[index]);
    else return index;
    return undefined;
  };
  // Several inserts after the same block land in the order given, as an agent writing a list expects.
  // This remembers, for each place an agent named, the block it last inserted there.
  const lastInserted = new Map<string | null, string>();
  const insertionPoint = (after: string | null): number | undefined => {
    if (after === null) return 0;
    const index = indexOf(after);
    if (index >= 0) return index + 1;
    fail(`no block ^${after} to insert after`);
    return undefined;
  };

  for (const op of ops) {
    switch (op.op) {
      case 'replace': {
        const index = target(op.id, op.base);
        if (index === undefined) break;
        const edited = editBlock(next[index], op);
        if (typeof edited === 'string') {
          fail(`^${op.id}: ${edited}`);
          break;
        }
        next[index] = edited;
        touched.add(op.id);
        lines.push(`✓ edited ^${op.id}`);
        break;
      }
      case 'insert': {
        const previous = lastInserted.get(op.after);
        const at = previous !== undefined && indexOf(previous) >= 0 ? indexOf(previous) + 1 : insertionPoint(op.after);
        if (at === undefined) break;
        const created = createBlock(op, taken);
        if (typeof created === 'string') {
          fail(`insert: ${created}`);
          break;
        }
        next.splice(at, 0, created.block);
        lastInserted.set(op.after, created.block.id);
        touched.add(created.block.id);
        lines.push(`✓ inserted ^${created.block.id} (${created.block.type})`, ...created.notes.map((note) => `  ${note}`));
        break;
      }
      case 'delete': {
        const index = target(op.id, op.base);
        if (index === undefined) break;
        next.splice(index, 1);
        touched.add(op.id);
        lines.push(`✓ deleted ^${op.id}`);
        break;
      }
      case 'move': {
        const index = indexOf(op.id);
        if (index < 0 || op.after === op.id) {
          fail(`^${op.id}: no such block in this section`);
          break;
        }
        // A block that moves takes its place with it, so later inserts after it follow it again.
        lastInserted.delete(op.id);
        const [moved] = next.splice(index, 1);
        const at = insertionPoint(op.after);
        if (at === undefined) break;
        next.splice(at, 0, moved);
        touched.add(op.id);
        lines.push(`✓ moved ^${op.id}`);
        break;
      }
      case 'canvas': {
        const index = target(op.id, op.base);
        if (index === undefined) break;
        const block = next[index];
        if (block.type !== 'canvas') {
          fail(`^${op.id} is a ${block.type}, not a canvas`);
          break;
        }
        const result = applyCanvasOps(block.attrs?.elements ?? [], block.attrs?.aspect ?? DEFAULT_ASPECT, op);
        if (!result.ok) {
          fail(`canvas ^${op.id}:`);
          lines.push(...result.lines.map((line) => `  ${line}`));
          break;
        }
        next[index] = { ...block, attrs: { ...block.attrs, elements: result.elements, aspect: result.aspect } };
        touched.add(op.id);
        lines.push(`✓ canvas ^${op.id}`, ...result.lines.map((line) => `  ${line}`));
        break;
      }
    }
  }

  return ok ? { ok, blocks: next, lines, touched: [...touched] } : { ok, blocks: [...blocks], lines, touched: [] };
}

/** Applies a replace op's fields to a block, or explains why they don't fit it. */
function editBlock(block: Block, op: Extract<PatchOp, { op: 'replace' }>): Block | string {
  let text = block.text;
  if (op.find !== undefined) {
    // Text is stored as the editor writes it, so `create_section` is kept as `create\_section`; an
    // agent that writes the plain form still finds it.
    const occurrences = (find: string) => (find ? block.text.split(find).length - 1 : 0);
    const find = occurrences(op.find) === 0 && occurrences(agentMarkdown(op.find)) > 0 ? agentMarkdown(op.find) : op.find;
    const count = occurrences(find);
    if (count !== 1) return `"${op.find}" appears ${count} times; it must appear exactly once`;
    text = block.text.replace(find, () => agentMarkdown(op.with ?? ''));
  } else if (op.text !== undefined) {
    text = agentMarkdown(op.text);
  }

  const type = op.type ?? block.type;
  if (op.type && !(isTextBlock(block) && TEXT_TYPES.includes(op.type))) return `can't turn a ${block.type} into a ${op.type}`;
  if (op.done !== undefined && type !== 'task') return 'only tasks can be ticked';
  if (op.rows && block.type !== 'table') return 'only tables have rows';
  if (op.language !== undefined && block.type !== 'code') return 'only code blocks have a language';
  const problem = checkText(type, text);
  if (problem) return problem;

  const attrs = { ...block.attrs };
  if (type === 'task') attrs.done = op.done ?? attrs.done ?? false;
  else delete attrs.done;
  if (op.rows) attrs.rows = agentRows(op.rows);
  if (op.language !== undefined) attrs.language = op.language || undefined;
  return inEditorForm(withAttrs({ id: block.id, type, text }, attrs));
}

function createBlock(op: Extract<PatchOp, { op: 'insert' }>, taken: Set<string>): { block: Block; notes: string[] } | string {
  const type = op.type ?? 'p';
  if (!INSERTABLE.includes(type)) return `can't insert a ${type}; images are added by people`;
  const text = agentMarkdown(op.text ?? '');
  const problem = checkText(type, text);
  if (problem) return problem;

  const id = newId(taken);
  taken.add(id);
  const block = createdBlock(op, type, id, text);
  return typeof block === 'string' ? block : { block: inEditorForm(block.block), notes: block.notes };
}

function createdBlock(op: Extract<PatchOp, { op: 'insert' }>, type: BlockType, id: string, text: string): { block: Block; notes: string[] } | string {
  if (type === 'task') return { block: { id, type, text, attrs: { done: op.done ?? false } }, notes: [] };
  if (type === 'table') return { block: { id, type, text: '', attrs: { rows: op.rows ? agentRows(op.rows) : [['', '']] } }, notes: [] };
  if (type === 'code') return { block: withAttrs({ id, type, text }, { language: op.language || undefined }), notes: [] };
  if (type === 'canvas') {
    const result = applyCanvasOps([], DEFAULT_ASPECT, op.canvas ?? {});
    if (!result.ok) return result.lines.join('; ');
    return { block: { id, type, text, attrs: { wrap: 'inline', width: 100, aspect: result.aspect, elements: result.elements } }, notes: result.lines };
  }
  return { block: { id, type, text: type === 'hr' ? '' : text }, notes: [] };
}

/**
 * A block in the form the editor writes it: inline Markdown through the editor's own rule, and
 * table cells trimmed, as the editor keeps them. Agents' edits are stored this way, so the first
 * time a person opens a section an agent wrote, the editor finds nothing to rewrite and no change
 * is credited to the person. Code, drawings and image captions are kept as they are, as the editor keeps them.
 */
export function inEditorForm(block: Block): Block {
  if (isTextBlock(block)) {
    const text = editorInline(block.text);
    return text === block.text ? block : { ...block, text };
  }
  const rows = block.type === 'table' ? block.attrs?.rows : undefined;
  if (!rows) return block;
  const tidy = rows.map((row) => row.map((cell) => editorInline(cell).trim()));
  return tidy.every((row, r) => row.every((cell, c) => cell === rows[r]![c])) ? block : { ...block, attrs: { ...block.attrs, rows: tidy } };
}

function agentRows(rows: string[][]): string[][] {
  return rows.map((row) => row.map(agentMarkdown));
}

function checkText(type: BlockType, text: string): string | undefined {
  if (type !== 'code' && text.includes('\n')) return 'text blocks are one line; insert one block per paragraph';
  return undefined;
}

function withAttrs(block: Block, attrs: Block['attrs'] & object): Block {
  const kept = Object.fromEntries(Object.entries(attrs).filter(([, value]) => value !== undefined));
  return Object.keys(kept).length ? { ...block, attrs: kept } : block;
}

/**
 * Why an agent's changes should wait for a person before being committed: deleting a long
 * block, or cutting one to under 60% of its length. Small edits never wait.
 */
export function reviewReasons(base: readonly Block[], work: readonly Block[], agentTouched: ReadonlySet<string>): string[] {
  const workById = byId(work);
  const reasons: string[] = [];
  for (const block of base) {
    if (!agentTouched.has(block.id)) continue;
    const before = plainText(block);
    if (before.length < 60) continue;
    const after = workById.get(block.id);
    if (!after) reasons.push(`deletes ^${block.id} (${wordCount(before)} words)`);
    else if (plainText(after).length < before.length * 0.6) {
      reasons.push(`cuts ^${block.id} from ${wordCount(before)} to ${wordCount(plainText(after))} words`);
    }
  }
  return reasons;
}
