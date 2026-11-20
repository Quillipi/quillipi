/**
 * Inline formatting, stored as a small subset of Markdown:
 *
 *   **bold**   _italic_   ~~strike~~   ==highlight==   `code`   [label](https://…)
 *
 * Editors work with runs: pieces of text that share the same marks. `parseInline` and
 * `serializeInline` convert between the two, and the round trip is exact for any runs
 * (see test/inline.test.ts).
 *
 * Italic is written with `_`, so it can never merge with the `**` of bold into an
 * ambiguous `***`. `*italic*` and `__bold__` are still read, for files from other tools.
 */

export type Mark = 'bold' | 'italic' | 'strike' | 'highlight' | 'code';

export interface Run {
  text: string;
  /** Always in MARK_ORDER, without duplicates. */
  marks: Mark[];
  href?: string;
}

type PairedMark = Exclude<Mark, 'code'>;

const MARK_ORDER: Mark[] = ['bold', 'italic', 'strike', 'highlight', 'code'];

const DELIMITER: Record<PairedMark, string> = { bold: '**', italic: '_', strike: '~~', highlight: '==' };

/** Longer delimiters first, so `**` is not read as two `*`. */
const OPENERS: [string, PairedMark][] = [
  ['**', 'bold'],
  ['__', 'bold'],
  ['~~', 'strike'],
  ['==', 'highlight'],
  ['_', 'italic'],
  ['*', 'italic'],
];

/** Markdown lets a backslash escape any ASCII punctuation character. */
const ESCAPABLE = /[!-/:-@[-`{-~]/;

export function parseInline(source: string): Run[] {
  const runs: Run[] = [];
  parseSpan(source, [], undefined, runs);
  return normalizeRuns(runs);
}

export function serializeInline(runs: Run[]): string {
  const tidy = tidyWhitespace(normalizeRuns(runs));
  let out = '';
  for (let start = 0; start < tidy.length; ) {
    const href = tidy[start].href;
    let end = start;
    while (end < tidy.length && tidy[end].href === href) end++;
    const body = serializeMarks(tidy.slice(start, end));
    out += href === undefined ? body : `[${body}](${encodeHref(href)})`;
    start = end;
  }
  return out;
}

/**
 * Inline Markdown in the form the editor writes it: what a block's text becomes after one trip
 * through the editor, such as `_a_` for `*a*`. Text in this form comes back from the editor unchanged.
 */
export function editorInline(source: string): string {
  return serializeInline(parseInline(source));
}

/**
 * Markdown an agent wrote, read as GitHub reads it: an underscore inside a word is just an
 * underscore, so `create_section` and `snake_case_names` keep theirs instead of turning the text
 * between two of them into italics. Escapes them, outside code spans and link addresses. Only for
 * what an agent sent: text already stored may hold italics that start inside a word, written by
 * the editor, which this would undo.
 */
export function agentMarkdown(source: string): string {
  return escapeWordUnderscores(source);
}

/** A whole text an agent wrote, in the form the editor writes it. */
export function agentInline(source: string): string {
  return editorInline(agentMarkdown(source));
}

/** Plain text as inline Markdown that shows exactly that text, such as a title someone typed. */
export function plainInline(text: string): string {
  return serializeInline([{ text, marks: [] }]);
}

/** Escapes underscores between two letters or digits, outside code spans and link addresses. */
function escapeWordUnderscores(source: string): string {
  let out = '';
  let plain = '';
  const flush = () => {
    out += plain.replace(/(?<=[\p{L}\p{N}])_+(?=[\p{L}\p{N}])/gu, (run) => '\\_'.repeat(run.length));
    plain = '';
  };
  for (let i = 0; i < source.length; ) {
    if (source[i] === '\\') {
      plain += source.slice(i, i + 2);
      i += 2;
      continue;
    }
    const code = source[i] === '`' ? readCodeSpan(source, i) : null;
    const target = source.startsWith('](', i) ? source.indexOf(')', i + 2) : -1;
    const end = code ? code.end : target >= 0 ? target + 1 : -1;
    if (end < 0) {
      plain += source[i++];
      continue;
    }
    flush();
    out += source.slice(i, end);
    i = end;
  }
  flush();
  return out;
}

export function inlineToPlain(source: string): string {
  return parseInline(source)
    .map((run) => run.text)
    .join('');
}

/** Drops empty runs, sorts marks, and joins neighbours that look the same. */
export function normalizeRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const next = makeRun(run.text, run.marks, run.href);
    const last = out[out.length - 1];
    if (last && last.href === next.href && last.marks.join() === next.marks.join()) last.text += next.text;
    else out.push(next);
  }
  return out;
}

function makeRun(text: string, marks: readonly Mark[], href: string | undefined): Run {
  const sorted = MARK_ORDER.filter((mark) => marks.includes(mark));
  return href === undefined ? { text, marks: sorted } : { text, marks: sorted, href };
}

// ---------------------------------------------------------------------------
// Reading

function parseSpan(source: string, marks: Mark[], href: string | undefined, out: Run[]): void {
  let text = '';
  const flush = () => {
    if (text) out.push(makeRun(text, marks, href));
    text = '';
  };

  let i = 0;
  while (i < source.length) {
    const ch = source[i];

    if (ch === '\\' && ESCAPABLE.test(source[i + 1] ?? '')) {
      text += source[i + 1];
      i += 2;
      continue;
    }

    if (ch === '`') {
      const code = readCodeSpan(source, i);
      if (code) {
        flush();
        out.push(makeRun(code.text, [...marks, 'code'], href));
        i = code.end;
        continue;
      }
    }

    if (ch === '[' && href === undefined) {
      const link = readLink(source, i);
      if (link) {
        flush();
        parseSpan(link.label, marks, link.href, out);
        i = link.end;
        continue;
      }
    }

    const opener = OPENERS.find(([delimiter]) => source.startsWith(delimiter, i));
    if (opener && !marks.includes(opener[1])) {
      const [delimiter, mark] = opener;
      const start = i + delimiter.length;
      const close = findCloser(source, delimiter, start);
      if (close > start) {
        flush();
        parseSpan(source.slice(start, close), [...marks, mark], href, out);
        i = close + delimiter.length;
        continue;
      }
    }

    text += ch;
    i++;
  }
  flush();
}

/**
 * Position of the delimiter that closes a span starting at `from`, or -1.
 * Runs of stars need care: in `**a *b***` bold closes with the last two of the three stars.
 */
function findCloser(source: string, delimiter: string, from: number): number {
  for (let i = from; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '`') {
      const code = readCodeSpan(source, i);
      if (code) i = code.end - 1;
      continue;
    }
    if (delimiter.startsWith('*') && ch === '*') {
      let run = 1;
      while (source[i + run] === '*') run++;
      if (delimiter === '**' && run >= 2) return i + run - 2;
      if (delimiter === '*' && run % 2 === 1) return i + run - 1;
      i += run - 1;
      continue;
    }
    if (source.startsWith(delimiter, i)) return i;
  }
  return -1;
}

/** Code spans follow CommonMark: the closing fence has the same number of backticks. */
function readCodeSpan(source: string, start: number): { text: string; end: number } | null {
  let ticks = 0;
  while (source[start + ticks] === '`') ticks++;
  let search = start + ticks;
  for (;;) {
    const close = source.indexOf('`'.repeat(ticks), search);
    if (close < 0) return null;
    let after = close + ticks;
    if (source[after] === '`') {
      while (source[after] === '`') after++;
      search = after;
      continue;
    }
    let text = source.slice(start + ticks, close);
    if (text.length > 1 && text.startsWith(' ') && text.endsWith(' ') && text.trim()) text = text.slice(1, -1);
    return { text, end: after };
  }
}

function readLink(source: string, start: number): { label: string; href: string; end: number } | null {
  let i = start + 1;
  while (i < source.length && source[i] !== ']') {
    if (source[i] === '\\') i += 2;
    else if (source[i] === '`') i = readCodeSpan(source, i)?.end ?? i + 1;
    else i++;
  }
  if (source[i] !== ']' || source[i + 1] !== '(') return null;
  const close = source.indexOf(')', i + 2);
  if (close < 0) return null;
  const href = source.slice(i + 2, close);
  if (!href || /\s/.test(href)) return null;
  return { label: source.slice(start + 1, i), href: decodeHref(href), end: close + 1 };
}

// ---------------------------------------------------------------------------
// Writing

function serializeMarks(runs: Run[]): string {
  let out = '';
  const open: PairedMark[] = [];
  for (const run of runs) {
    const wanted = run.marks.filter((mark): mark is PairedMark => mark !== 'code');
    // Keep the marks that are still wanted and were opened first; close the rest, innermost first.
    let keep = 0;
    while (keep < open.length && wanted.includes(open[keep])) keep++;
    while (open.length > keep) out += DELIMITER[open.pop()!];
    for (const mark of wanted) {
      if (!open.includes(mark)) {
        out += DELIMITER[mark];
        open.push(mark);
      }
    }
    out += run.marks.includes('code') ? codeSpan(run.text) : escapeText(run.text);
  }
  while (open.length) out += DELIMITER[open.pop()!];
  return out;
}

function escapeText(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    // `~` and `=` only need escaping where they could join a `~~` or `==` delimiter.
    const couldJoinDelimiter =
      (ch === '~' || ch === '=') && (i === 0 || i === text.length - 1 || text[i - 1] === ch || text[i + 1] === ch);
    if ('\\*_`[]'.includes(ch) || couldJoinDelimiter) out += '\\';
    out += ch;
  }
  return out;
}

function codeSpan(text: string): string {
  const longestTicks = Math.max(0, ...(text.match(/`+/g) ?? []).map((ticks) => ticks.length));
  const fence = '`'.repeat(longestTicks + 1);
  // The reader strips one space from each side when both are present, so pad in exactly the
  // cases where that would otherwise eat real spaces, or where a backtick touches the fence.
  const needsPad =
    text.startsWith('`') || text.endsWith('`') || (text.length > 1 && text.startsWith(' ') && text.endsWith(' ') && text.trim() !== '');
  const pad = needsPad ? ' ' : '';
  return fence + pad + text + pad + fence;
}

/**
 * Moves spaces at the edges of formatted text outside the formatting, so `**word **`
 * becomes `**word** `. Other Markdown readers only recognise delimiters next to text.
 */
function tidyWhitespace(runs: Run[]): Run[] {
  const parts: { run: Run; space: boolean }[] = [];
  for (const run of runs) {
    const formatted = run.marks.length > 0 || run.href !== undefined;
    if (!formatted || run.marks.includes('code')) {
      parts.push({ run, space: false });
      continue;
    }
    const [, lead, core, trail] = /^(\s*)(.*?)(\s*)$/s.exec(run.text)!;
    if (lead) parts.push({ run: { ...run, text: lead }, space: true });
    if (core) parts.push({ run: { ...run, text: core }, space: false });
    if (trail) parts.push({ run: { ...run, text: trail }, space: true });
  }

  const neighbour = (index: number, step: 1 | -1): Run | undefined => {
    for (let i = index + step; i >= 0 && i < parts.length; i += step) if (!parts[i].space) return parts[i].run;
    return undefined;
  };

  return normalizeRuns(
    parts.map(({ run, space }, index) => {
      if (!space) return run;
      const before = neighbour(index, -1);
      const after = neighbour(index, 1);
      const marks = run.marks.filter((mark) => before?.marks.includes(mark) && after?.marks.includes(mark));
      const keepLink = run.href !== undefined && before?.href === run.href && after?.href === run.href;
      return makeRun(run.text, marks, keepLink ? run.href : undefined);
    }),
  );
}

function encodeHref(href: string): string {
  return href.replace(/[ ()]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function decodeHref(href: string): string {
  return href.replace(/%2[089]/gi, (code) => String.fromCharCode(parseInt(code.slice(1), 16)));
}
