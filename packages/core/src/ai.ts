/**
 * The text AI agents read. It is compact, one line per block, and every block carries its ID
 * and version hash, which the agent sends back with edits:
 *
 *   ^k3f9b2m4 p @1f0c9a Goal: earn **organic installs** first.
 *   ^c1xnf6p2 task[ ] @7d21e4 New screenshots are live.
 *
 * Everything here is generated from the files by code, never written by an AI, so it can't
 * drift from what the files say.
 */
import { type Block, blockHash, plainText, sectionTitle } from './blocks.js';
import { canvasLines } from './canvas.js';
import { parseInline } from './inline.js';

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** The start of a block's first line: `^id type @hash`. */
function blockHead(block: Block): string {
  const attrs = block.attrs ?? {};
  const label =
    block.type === 'task' ? `task[${attrs.done ? 'x' : ' '}]` : block.type === 'code' && attrs.language ? `code:${attrs.language}` : block.type;
  return `^${block.id} ${label} @${blockHash(block)}`;
}

export function readBlockLines(block: Block): string[] {
  const attrs = block.attrs ?? {};
  const head = blockHead(block);
  const placement = `${attrs.wrap ?? 'inline'} ${attrs.width ?? 100}%`;

  switch (block.type) {
    case 'hr':
      return [head];
    case 'code':
      return [head, ...block.text.split('\n').map((line) => `  ${line}`)];
    case 'table':
      return [head, ...(attrs.rows ?? []).map((row) => `  | ${row.join(' | ')} |`)];
    case 'image':
      return [`${head} "${block.text}" ${attrs.src ?? ''} ${placement}`];
    case 'canvas':
      return [`${head} "${block.text}" ${placement}`, ...canvasLines(attrs.elements ?? []).map((line) => `  ${line}`)];
    default:
      return [block.text ? `${head} ${block.text}` : head];
  }
}

export interface SectionText {
  id: string;
  blocks: readonly Block[];
}

export function renderRead(section: SectionText, ids?: readonly string[]): string {
  const chosen = ids?.length ? section.blocks.filter((block) => ids.includes(block.id)) : section.blocks;
  const missing = (ids ?? []).filter((id) => !section.blocks.some((block) => block.id === id));
  const body = chosen.flatMap(readBlockLines);
  const title = sectionTitle(section.blocks);
  const scope = ids?.length ? `${chosen.length} of ${section.blocks.length} blocks` : `${section.blocks.length} blocks`;
  const header = `${section.id}${title ? ` "${title}"` : ''} · ${scope} · ~${formatCount(estimateTokens(body.join('\n')))} tokens`;
  return [header, ...body, ...missing.map((id) => `✗ no block ^${id} in ${section.id}`)].join('\n');
}

// ---------------------------------------------------------------------------
// Map

export interface MapSection extends SectionText {
  /** How many folders deep it is: 0 at the top. */
  depth: number;
  uncommitted: number;
  /** When the section last changed in history, in milliseconds. */
  editedAt?: number;
}

export interface MapFolder {
  /** The folder's path, such as `product/research`. */
  folder: string;
  name: string;
  depth: number;
  /** Sections anywhere inside it. */
  sections: number;
}

export interface MapInput {
  name: string;
  /** Folders and sections, top to bottom, as the tree lists them. */
  entries: readonly (MapSection | MapFolder)[];
  head?: { number: number; author: string; at: number };
  /** All uncommitted changes, when there are more than the sections' own, such as the arrangement. */
  uncommitted?: number;
  /** Changes held for the person to review. */
  held: number;
  /** What changed since this agent last visited, already summarised per section. */
  sinceVisit: readonly string[];
  now: number;
}

export function renderMap(input: MapInput): string {
  const { now } = input;
  const sections = input.entries.filter((entry): entry is MapSection => !('folder' in entry));
  const folders = input.entries.length - sections.length;
  const blockCount = sections.reduce((sum, section) => sum + section.blocks.length, 0);
  const tokens = sections.reduce((sum, section) => sum + sectionTokens(section.blocks), 0);
  const uncommitted = input.uncommitted ?? sections.reduce((sum, section) => sum + section.uncommitted, 0);

  const status = [input.head ? `head #${input.head.number} by ${input.head.author} ${formatAgo(input.head.at, now)}` : 'no commits yet'];
  status.push(`${uncommitted} uncommitted`);
  if (input.held) status.push(`${input.held} held for review`);

  const counts = [`${sections.length} sections`, ...(folders ? [`${folders} folder${folders === 1 ? '' : 's'}`] : []), `${blockCount} blocks`];
  const lines = [`${input.name} · ${counts.join(' · ')} · ~${formatCount(tokens)} tokens`, status.join(' · ')];
  if (input.sinceVisit.length) lines.push(`since your last visit: ${input.sinceVisit.join(' · ')}`);

  for (const entry of input.entries) {
    if ('folder' in entry) {
      lines.push('', `${'  '.repeat(entry.depth)}${entry.folder}/ "${entry.name}" · ${entry.sections} section${entry.sections === 1 ? '' : 's'}`);
      continue;
    }
    const section = entry;
    const indent = '  '.repeat(section.depth);
    const others = sections.filter((other) => other !== section).flatMap((other) => other.blocks);
    const title = sectionTitle(section.blocks);
    const facts = [`${section.blocks.length} blocks`, `~${formatCount(sectionTokens(section.blocks))} tokens`];
    if (section.editedAt) facts.push(`edited ${formatAgo(section.editedAt, now)}`);
    if (section.uncommitted) facts.push(`${section.uncommitted} uncommitted`);

    lines.push('', `${indent}${section.id}${title ? ` "${title}"` : ''} · ${facts.join(' · ')}`);
    const headings = section.blocks.filter((block) => block.type === 'h2' || block.type === 'h3').map((block) => plainText(block));
    if (headings.length) lines.push(`${indent}  headings: ${headings.slice(0, 10).join(' · ')}${headings.length > 10 ? ' …' : ''}`);
    const terms = keyTerms(section.blocks, others);
    if (terms.length) lines.push(`${indent}  terms: ${terms.join(', ')}`);
    const figures = section.blocks.flatMap(describeFigure);
    if (figures.length) lines.push(`${indent}  contains: ${figures.join(', ')}`);
  }
  return lines.join('\n');
}

function sectionTokens(blocks: readonly Block[]): number {
  return estimateTokens(blocks.flatMap(readBlockLines).join('\n'));
}

function describeFigure(block: Block): string[] {
  const attrs = block.attrs ?? {};
  if (block.type === 'canvas') return [`canvas "${block.text}" (${(attrs.elements ?? []).length} elements)`];
  if (block.type === 'image') return [`image "${block.text}"`];
  if (block.type === 'table') return [`table ${(attrs.rows ?? []).length}×${attrs.rows?.[0]?.length ?? 0}`];
  return [];
}

// ---------------------------------------------------------------------------
// Key terms, search and related blocks

const STOPWORDS = new Set(
  'about above after again against also because been before being below between both could does doing down during each from further have having here into just more most must only other over same should some such than that their them then there these they this those through under until very were what when where which while will with would your'.split(
    ' ',
  ),
);

/** Terms that describe a section: bold phrases first, then words common here but rare elsewhere. */
export function keyTerms(blocks: readonly Block[], elsewhere: readonly Block[] = [], max = 6): string[] {
  const terms: string[] = [];
  for (const run of blocks.flatMap((block) => parseInline(inlineSource(block)))) {
    if (run.marks.includes('bold')) addTerm(terms, run.text.trim());
  }

  const here = countWords(blocks);
  const there = countWords(elsewhere);
  const ranked = [...here.entries()]
    .filter(([, { count }]) => count >= 2)
    .map(([word, { count, shown }]) => ({ shown, score: count / (1 + (there.get(word)?.count ?? 0)) }))
    .sort((a, b) => b.score - a.score || a.shown.localeCompare(b.shown));
  for (const { shown } of ranked) addTerm(terms, shown);
  return terms.slice(0, max);
}

function inlineSource(block: Block): string {
  if (block.type === 'table') return (block.attrs?.rows ?? []).flat().join(' ');
  return block.type === 'code' || block.type === 'hr' ? '' : block.text;
}

function addTerm(terms: string[], term: string): void {
  if (term.length < 3 || term.length > 40) return;
  const lower = term.toLowerCase();
  if (terms.some((existing) => existing.toLowerCase().includes(lower) || lower.includes(existing.toLowerCase()))) return;
  terms.push(term);
}

/** Word counts, keyed by lower case. `shown` keeps the first spelling seen, so names keep their capitals. */
function countWords(blocks: readonly Block[]): Map<string, { count: number; shown: string }> {
  const counts = new Map<string, { count: number; shown: string }>();
  for (const block of blocks) {
    for (const word of plainText(block).match(/[\p{L}][\p{L}\p{N}'-]{3,}/gu) ?? []) {
      const key = word.toLowerCase();
      if (STOPWORDS.has(key)) continue;
      const entry = counts.get(key);
      if (entry) entry.count++;
      else counts.set(key, { count: 1, shown: word });
    }
  }
  return counts;
}

export interface BlockHit {
  section: string;
  block: Block;
}

/** Blocks containing the query, best first: the exact phrase, then all words, then some words. */
export function searchBlocks(sections: readonly SectionText[], query: string, limit = 12): BlockHit[] {
  const phrase = query.trim().toLowerCase();
  const words = phrase.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const scored: (BlockHit & { score: number })[] = [];
  for (const section of sections) {
    for (const block of section.blocks) {
      const text = plainText(block).toLowerCase();
      const found = words.filter((word) => text.includes(word)).length;
      if (!found) continue;
      const score = found / words.length + (text.includes(phrase) ? 1 : 0) + (block.type.startsWith('h') ? 0.25 : 0);
      scored.push({ section: section.id, block, score });
    }
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ section, block }) => ({ section, block }));
}

export function renderHits(heading: string, hits: readonly BlockHit[], focus = ''): string {
  return [heading, ...hits.map(({ section, block }) => `${section} ${hitLine(block, focus)}`)].join('\n');
}

/** A block's first read line, shortened around `focus` when the block is long. */
function hitLine(block: Block, focus: string): string {
  const [line] = readBlockLines(block);
  const head = blockHead(block);
  const text = line.slice(head.length + 1);
  if (text.length <= 160) return line;
  const at = Math.max(0, text.toLowerCase().indexOf(focus.toLowerCase()) - 60);
  return `${head} ${at > 0 ? '…' : ''}${text.slice(at, at + 160)}…`;
}

/**
 * Blocks in `sections` (normally the other sections) that mention the important words of
 * `changed`: places that may need the same edit. Important words are bold phrases,
 * capitalised names and long words.
 */
export function relatedBlocks(changed: readonly Block[], sections: readonly SectionText[], limit = 5): BlockHit[] {
  const terms = new Set<string>();
  for (const block of changed) {
    for (const run of parseInline(inlineSource(block))) if (run.marks.includes('bold')) terms.add(run.text.trim().toLowerCase());
    for (const word of plainText(block).match(/\b[\p{Lu}][\p{L}\p{N}-]{2,}|\b[\p{L}]{8,}/gu) ?? []) {
      if (!STOPWORDS.has(word.toLowerCase())) terms.add(word.toLowerCase());
    }
  }
  if (!terms.size) return [];

  const hits: (BlockHit & { score: number })[] = [];
  for (const section of sections) {
    for (const block of section.blocks) {
      const text = plainText(block).toLowerCase();
      const score = [...terms].filter((term) => text.includes(term)).length;
      if (score) hits.push({ section: section.id, block, score });
    }
  }
  return hits
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ section, block }) => ({ section, block }));
}

// ---------------------------------------------------------------------------
// Small formatters

export function formatAgo(at: number, now: number): string {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 45) return `${days}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}

function formatCount(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}
