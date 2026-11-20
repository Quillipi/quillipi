/**
 * Quillipi Markdown: how a section is stored on disk.
 *
 * Every block is one line (callouts, tables and code blocks take a few) and ends with its ID:
 *
 *   # Marketing plan ^g2h7a3k9
 *
 *   Goal: earn **organic installs** first. ^k3f9b2m4
 *
 *   - [ ] New screenshots are live. ^c4xnf6p2
 *   - [x] Store listing rewritten. ^h7t2m9q4
 *
 * Blocks are separated by a blank line, except items of the same list. Tables and dividers
 * carry their ID on the line after them, code blocks in the fence's info string. The result
 * is ordinary Markdown that GitHub and other tools render.
 *
 * `parseSection` also reads Markdown written by other tools: hard-wrapped paragraphs,
 * nested lists and deeper headings fold into Quillipi's blocks, and blocks without an ID come
 * back with an empty `id` for the caller to fill in with `restoreIds`.
 */
import { type Block, type BlockAttrs, type BlockType, type Wrap, plainText } from './blocks.js';
import { DEFAULT_ASPECT } from './canvas.js';
import { newId } from './ids.js';
import { isSectionId } from './layout.js';

export interface Section {
  blocks: Block[];
  /** YAML front matter from other tools, kept as written so it survives a save. */
  frontMatter?: string;
}

// Reading accepts any 8 lowercase letters and digits, so hand-written IDs work too.
const ID_CHARS = '[a-z0-9]{8}';
const ID_AT_END = new RegExp(`(?:^|\\s)\\^(${ID_CHARS})\\s*$`);
const ID_LINE = new RegExp(`^\\^(${ID_CHARS})\\s*$`);
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?(\s*:?-+:?\s*\|)+\s*(:?-+:?\s*)?$/;
const FIGURE = new RegExp(`^!\\[((?:\\\\.|[^\\\\\\]])*)\\]\\(([^\\s)]+)(?:\\s+"([^"]*)")?\\)(?:\\s+\\^(${ID_CHARS}))?\\s*$`);
const LIST_KIND: Partial<Record<BlockType, string>> = { li: 'bullet', task: 'bullet', ol: 'ordered' };

function canvasPreviewPath(id: string): string {
  return `canvas/${id}.svg`;
}

// ---------------------------------------------------------------------------
// Writing

export function serializeSection({ blocks, frontMatter }: Section): string {
  let out = frontMatter === undefined ? '' : `---\n${frontMatter}\n---\n\n`;
  blocks.forEach((block, index) => {
    if (index > 0) out += sameList(blocks[index - 1], block) ? '\n' : '\n\n';
    out += serializeBlock(block);
  });
  return `${out}\n`;
}

function sameList(previous: Block, next: Block): boolean {
  const kind = LIST_KIND[previous.type];
  return kind !== undefined && kind === LIST_KIND[next.type];
}

function serializeBlock(block: Block): string {
  const id = `^${block.id}`;
  const line = (prefix: string, text: string) => (text ? `${prefix}${text} ${id}` : `${prefix}${id}`);
  const attrs = block.attrs ?? {};

  switch (block.type) {
    case 'p':
      return line('', escapeLineStart(block.text));
    case 'h1':
      return line('# ', block.text);
    case 'h2':
      return line('## ', block.text);
    case 'h3':
      return line('### ', block.text);
    case 'li':
      return line('- ', block.text);
    case 'ol':
      return line('1. ', block.text);
    case 'task':
      return line(attrs.done ? '- [x] ' : '- [ ] ', block.text);
    case 'quote':
      return line('> ', block.text);
    case 'callout':
      return `> [!${attrs.kind ?? 'NOTE'}]\n${line('> ', block.text)}`;
    case 'code': {
      const fence = '`'.repeat(Math.max(3, longestRun(block.text, '`') + 1));
      return `${fence}${[attrs.language, id].filter(Boolean).join(' ')}\n${block.text}\n${fence}`;
    }
    case 'hr':
      return `---\n${id}`;
    case 'table':
      return `${serializeTable(attrs.rows ?? [['']])}\n${id}`;
    case 'image':
      return `![${escapeCaption(block.text)}](${encodePath(attrs.src ?? '')}${placementTitle(block)}) ${id}`;
    case 'canvas':
      return `![${escapeCaption(block.text)}](${canvasPreviewPath(block.id)}${placementTitle(block)}) ${id}`;
  }
}

/**
 * A paragraph that starts like another block (`# `, `- `, `1. `, `> `…) gets a backslash so
 * it reads back as a paragraph. Inline escapes already cover `*`, `_`, backticks and brackets.
 */
function escapeLineStart(text: string): string {
  const lead = /^\s*/.exec(text)![0];
  const rest = text.slice(lead.length);
  if (/^\d+[.)](\s|$)/.test(rest)) return lead + rest.replace(/^(\d+)/, '$1\\');
  if (/^[-+#>|!]/.test(rest)) return `${lead}\\${rest}`;
  return text;
}

function unescapeLineStart(text: string): string {
  return text.replace(/^(\s*)\\([-+#>|!])/, '$1$2').replace(/^(\s*\d+)\\([.)])/, '$1$2');
}

function serializeTable(rows: string[][]): string {
  const width = Math.max(1, ...rows.map((row) => row.length));
  const line = (cells: readonly string[]) =>
    `| ${Array.from({ length: width }, (_, i) => (cells[i] ?? '').replace(/\|/g, '\\|')).join(' | ')} |`;
  const [header = [], ...body] = rows;
  return [line(header), `|${' --- |'.repeat(width)}`, ...body.map(line)].join('\n');
}

/** Figure placement goes in the image title, which keeps the line valid Markdown. */
function placementTitle(block: Block): string {
  const words = block.type === 'canvas' ? ['canvas'] : [];
  words.push(block.attrs?.wrap ?? 'inline', `${Math.round(block.attrs?.width ?? 100)}%`);
  if (block.type === 'canvas') words.push(String(roundAspect(block.attrs?.aspect ?? DEFAULT_ASPECT)));
  return ` "${words.join(' ')}"`;
}

function roundAspect(aspect: number): number {
  return Math.round(aspect * 100) / 100;
}

function escapeCaption(text: string): string {
  return text.replace(/[\\[\]]/g, '\\$&');
}

function encodePath(path: string): string {
  return path.replace(/[ ()]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function longestRun(text: string, ch: string): number {
  let longest = 0;
  let run = 0;
  for (const c of text) {
    run = c === ch ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest;
}

// ---------------------------------------------------------------------------
// Reading

interface Read {
  block: Block;
  next: number;
}

export function parseSection(source: string): Section {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const { frontMatter, start } = readFrontMatter(lines);
  const blocks: Block[] = [];
  let i = start;
  while (i < lines.length) {
    if (!lines[i].trim()) {
      i++;
      continue;
    }
    const read = readFence(lines, i) ?? readTable(lines, i) ?? readQuote(lines, i) ?? readLineBlock(lines, i) ?? readParagraph(lines, i);
    blocks.push(read.block);
    i = read.next;
  }
  return frontMatter === undefined ? { blocks } : { blocks, frontMatter };
}

// ---------------------------------------------------------------------------
// A section's permanent ID, kept in its front matter as `id: pricing`

/** The section ID in front matter, when it has a valid one. */
export function frontMatterId(frontMatter: string | undefined): string | undefined {
  const id = /^id:[ \t]*(\S+)[ \t]*$/m.exec(frontMatter ?? '')?.[1];
  return id !== undefined && isSectionId(id) ? id : undefined;
}

/** Front matter with `id: <id>` as its first line. Any other lines stay as they were. */
export function withFrontMatterId(frontMatter: string | undefined, id: string): string {
  const others = (frontMatter ?? '').split('\n').filter((line) => line.trim() && !/^id\s*:/.test(line));
  return [`id: ${id}`, ...others].join('\n');
}

/**
 * A section file's text with `id: <id>` in its front matter, and nothing else changed except line
 * endings. Used for the upgrade to folders, which must not rewrite a committed file in any other way.
 */
export function addFrontMatterId(text: string, id: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const { frontMatter, start } = readFrontMatter(lines);
  const body = lines.slice(start).join('\n').replace(/^\n+/, '');
  return `---\n${withFrontMatterId(frontMatter, id)}\n---\n\n${body}`;
}

function readFrontMatter(lines: string[]): { frontMatter?: string; start: number } {
  if (lines[0] !== '---') return { start: 0 };
  const end = lines.indexOf('---', 1);
  const body = lines.slice(1, end);
  const looksLikeYaml = end > 1 && body.every((line) => !line.trim() || /^[\w-]+\s*:|^\s+\S|^-\s/.test(line));
  return looksLikeYaml ? { frontMatter: body.join('\n'), start: end + 1 } : { start: 0 };
}

function readFence(lines: string[], start: number): Read | null {
  const open = FENCE.exec(lines[start]);
  if (!open) return null;
  const [, fence, info] = open;
  if (fence[0] === '`' && info.includes('`')) return null; // CommonMark: not a fence
  const closing = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`);
  const body: string[] = [];
  let i = start + 1;
  while (i < lines.length && !closing.test(lines[i])) body.push(lines[i++]);
  const { text: infoText, id } = takeId(info.trim());
  const language = infoText.split(/\s+/)[0];
  return { block: makeBlock(id, 'code', body.join('\n'), language ? { language } : undefined), next: Math.min(i + 1, lines.length) };
}

function readTable(lines: string[], start: number): Read | null {
  if (!lines[start].trimStart().startsWith('|') || !TABLE_SEPARATOR.test(lines[start + 1] ?? '')) return null;
  const rows = [splitRow(lines[start])];
  let i = start + 2;
  while (i < lines.length && lines[i].trimStart().startsWith('|')) rows.push(splitRow(lines[i++]));
  const width = Math.max(...rows.map((row) => row.length));
  const padded = rows.map((row) => [...row, ...Array<string>(width - row.length).fill('')]);
  const id = ID_LINE.exec(lines[i] ?? '')?.[1];
  return { block: makeBlock(id ?? '', 'table', '', { rows: padded }), next: id ? i + 1 : i };
}

function splitRow(line: string): string[] {
  let text = line.trim().replace(/^\|/, '');
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && text[i + 1] === '|') {
      cell += '|';
      i++;
    } else if (ch === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function readQuote(lines: string[], start: number): Read | null {
  if (!/^\s*>/.test(lines[start])) return null;
  const body: string[] = [];
  let i = start;
  while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*> ?/, ''));
  const alert = /^\[!(\w+)\]\s*(.*)$/.exec(body[0]);
  const parts = alert ? [alert[2], ...body.slice(1)].filter((part, index) => index > 0 || part) : body;
  const { text, id } = takeId(joinLines(parts));
  if (!alert) return { block: makeBlock(id, 'quote', text), next: i };
  const kind = alert[1].toUpperCase();
  return { block: makeBlock(id, 'callout', text, kind === 'NOTE' ? undefined : { kind }), next: i };
}

/** Headings, dividers, list items, figures, and the bare `^id` line of an empty paragraph. */
function readLineBlock(lines: string[], start: number): Read | null {
  const line = lines[start];
  let match: RegExpExecArray | null;

  if ((match = /^ {0,3}(#{1,6})(?:\s+(.*))?$/.exec(line))) {
    const level = Math.min(3, match[1].length);
    const { text, id } = takeId(match[2] ?? '');
    return { block: makeBlock(id, `h${level}` as BlockType, text), next: start + 1 };
  }
  if (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
    const id = ID_LINE.exec(lines[start + 1] ?? '')?.[1];
    return { block: makeBlock(id ?? '', 'hr', ''), next: id ? start + 2 : start + 1 };
  }
  if ((match = /^\s*[-*+]\s+\[([ xX])\](?:\s+(.*))?$/.exec(line))) {
    return readListItem(lines, start, 'task', match[2] ?? '', { done: match[1] !== ' ' });
  }
  if ((match = /^\s*[-*+]\s+(.*)$/.exec(line))) return readListItem(lines, start, 'li', match[1]);
  if ((match = /^\s*\d+[.)]\s+(.*)$/.exec(line))) return readListItem(lines, start, 'ol', match[1]);
  if ((match = FIGURE.exec(line))) return { block: readFigure(match), next: start + 1 };
  if ((match = ID_LINE.exec(line))) return { block: makeBlock(match[1], 'p', ''), next: start + 1 };
  return null;
}

/** List items may continue on indented lines below them. */
function readListItem(lines: string[], start: number, type: BlockType, first: string, attrs?: BlockAttrs): Read {
  const parts = [first];
  let i = start + 1;
  while (i < lines.length && /^\s+\S/.test(lines[i]) && !startsBlock(lines, i)) parts.push(lines[i++]);
  const { text, id } = takeId(joinLines(parts));
  return { block: makeBlock(id, type, text, attrs), next: i };
}

function readFigure([, caption, rawPath, title = '', id = '']: RegExpExecArray): Block {
  const words = title.split(/\s+/);
  const wrap = (words.find((word) => word === 'left' || word === 'right' || word === 'inline') ?? 'inline') as Wrap;
  const width = Number(words.find((word) => /^\d+%$/.test(word))?.slice(0, -1) ?? 100);
  const text = caption.replace(/\\([\\[\]])/g, '$1');
  const src = rawPath.replace(/%2[089]/gi, (code) => String.fromCharCode(parseInt(code.slice(1), 16)));
  if (!words.includes('canvas')) return makeBlock(id, 'image', text, { src, wrap, width });
  const aspect = Number(words.find((word) => /^\d+(\.\d+)?$/.test(word)) ?? DEFAULT_ASPECT);
  // `src` tells the caller which canvas file to load. It is replaced by `elements` once loaded.
  return makeBlock(id, 'canvas', text, { src, wrap, width, aspect });
}

function readParagraph(lines: string[], start: number): Read {
  const parts = [lines[start]];
  let i = start + 1;
  while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) parts.push(lines[i++]);
  const { text, id } = takeId(joinLines(parts));
  return { block: makeBlock(id, 'p', unescapeLineStart(text)), next: i };
}

function startsBlock(lines: string[], i: number): boolean {
  return FENCE.test(lines[i]) || readTable(lines, i) !== null || /^\s*>/.test(lines[i]) || readLineBlock(lines, i) !== null;
}

/** One line is kept exactly. Several lines (hard-wrapped text from other tools) join with spaces. */
function joinLines(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ');
}

function takeId(text: string): { text: string; id: string } {
  const match = ID_AT_END.exec(text);
  return match ? { text: text.slice(0, match.index), id: match[1] } : { text, id: '' };
}

function makeBlock(id: string, type: BlockType, text: string, attrs?: BlockAttrs): Block {
  return attrs ? { id, type, text, attrs } : { id, type, text };
}

// ---------------------------------------------------------------------------
// IDs for blocks that arrived without one

/**
 * Fills in missing and duplicated IDs. A block without an ID takes the ID of the most similar
 * unused block of the same type in `previous`, so a tool that strips IDs doesn't turn every
 * edit into delete-and-add. Anything without a match gets a new ID, which is added to `taken`.
 */
export function restoreIds(blocks: readonly Block[], previous: readonly Block[], taken: Set<string>): Block[] {
  const present = new Set(blocks.map((block) => block.id));
  const unused = previous.filter((block) => !present.has(block.id));
  const used = new Set<string>();

  return blocks.map((block) => {
    if (block.id && !used.has(block.id)) {
      used.add(block.id);
      return block;
    }
    const match = mostSimilar(block, unused);
    const id = match?.id ?? newId(taken);
    if (match) unused.splice(unused.indexOf(match), 1);
    used.add(id);
    taken.add(id);
    return { ...block, id };
  });
}

function mostSimilar(block: Block, candidates: readonly Block[]): Block | undefined {
  let best: Block | undefined;
  let bestScore = 0.5; // below this, a new block is the more honest reading
  for (const candidate of candidates) {
    if (candidate.type !== block.type) continue;
    const score = similarity(plainText(candidate), plainText(block));
    if (score > bestScore || (score === 1 && !best)) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const words = (text: string) => new Set(text.toLowerCase().split(/\W+/).filter(Boolean));
  const x = words(a);
  const y = words(b);
  const shared = [...x].filter((word) => y.has(word)).length;
  return shared / (x.size + y.size - shared || 1);
}
