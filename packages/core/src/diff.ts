import { type Block, byId, sameContent } from './blocks.js';

export type Change = 'added' | 'modified' | 'moved';

/** Removed blocks, grouped by the surviving block they used to follow (`null`: the top). */
export interface Removal {
  after: string | null;
  blocks: Block[];
}

export interface SectionDiff {
  /** Changed blocks of the newer version, by ID. A block that moved and changed is `modified`. */
  changes: Map<string, Change>;
  removed: Removal[];
}

export function diffBlocks(base: readonly Block[], current: readonly Block[]): SectionDiff {
  const baseById = byId(base);
  const unmoved = unmovedIds(base, current);
  const changes = new Map<string, Change>();
  for (const block of current) {
    const old = baseById.get(block.id);
    if (!old) changes.set(block.id, 'added');
    else if (!sameContent(old, block)) changes.set(block.id, 'modified');
    else if (!unmoved.has(block.id)) changes.set(block.id, 'moved');
  }

  const currentIds = new Set(current.map((block) => block.id));
  const removed: Removal[] = [];
  let after: string | null = null;
  for (const block of base) {
    if (currentIds.has(block.id)) {
      after = block.id;
      continue;
    }
    const last = removed.at(-1);
    if (last && last.after === after) last.blocks.push(block);
    else removed.push({ after, blocks: [block] });
  }
  return { changes, removed };
}

/**
 * IDs present in both versions whose order relative to each other is unchanged: the longest
 * increasing run of their old positions. Every other shared block counts as moved, which
 * gives the fewest possible moves.
 */
export function unmovedIds(base: readonly Block[], current: readonly Block[]): Set<string> {
  const oldIndex = new Map(base.map((block, index) => [block.id, index]));
  const positions = current.filter((block) => oldIndex.has(block.id)).map((block) => ({ id: block.id, at: oldIndex.get(block.id)! }));

  // Patience sorting: tails[k] is the end of the best increasing run of length k + 1.
  const tails: number[] = [];
  const previous: number[] = [];
  positions.forEach(({ at }, i) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (positions[tails[mid]].at < at) lo = mid + 1;
      else hi = mid;
    }
    previous[i] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = i;
  });

  const unmoved = new Set<string>();
  for (let i = tails.at(-1) ?? -1; i >= 0; i = previous[i]) unmoved.add(positions[i].id);
  return unmoved;
}

export interface ChangeCounts {
  added: number;
  modified: number;
  moved: number;
  removed: number;
}

export function countChanges({ changes, removed }: SectionDiff): ChangeCounts {
  const counts: ChangeCounts = { added: 0, modified: 0, moved: 0, removed: 0 };
  for (const change of changes.values()) counts[change]++;
  for (const removal of removed) counts.removed += removal.blocks.length;
  return counts;
}

export interface DiffPart {
  kind: 'same' | 'added' | 'removed';
  text: string;
}

/** Word-level diff of two texts, for showing what changed inside a paragraph. */
export function wordDiff(before: string, after: string): DiffPart[] {
  const a = tokenize(before);
  const b = tokenize(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const parts: DiffPart[] = [];
  push(parts, 'same', a.slice(0, start).join(''));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  // A full word-level comparison of two huge texts is slow and unreadable anyway.
  if (midA.length * midB.length > 250_000) {
    push(parts, 'removed', midA.join(''));
    push(parts, 'added', midB.join(''));
  } else {
    pushCommonSubsequence(midA, midB, parts);
  }
  push(parts, 'same', a.slice(endA).join(''));
  return parts;
}

function tokenize(text: string): string[] {
  return text.match(/\s+|[\p{L}\p{N}_'’]+|[^\s\p{L}\p{N}_'’]/gu) ?? [];
}

function pushCommonSubsequence(a: string[], b: string[], parts: DiffPart[]): void {
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push(parts, 'same', a[i]);
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      push(parts, 'removed', a[i++]);
    } else {
      push(parts, 'added', b[j++]);
    }
  }
  while (i < a.length) push(parts, 'removed', a[i++]);
  while (j < b.length) push(parts, 'added', b[j++]);
}

function push(parts: DiffPart[], kind: DiffPart['kind'], text: string): void {
  if (!text) return;
  const last = parts.at(-1);
  if (last?.kind === kind) last.text += text;
  else parts.push({ kind, text });
}
