import { type Block, byId, sameContent } from './blocks.js';
import { unmovedIds } from './diff.js';

export interface MergeResult {
  blocks: Block[];
  /** Blocks both sides changed differently. The version from `theirs` was kept. */
  conflicts: string[];
}

/**
 * Three-way merge of a section, block by block. `ours` and `theirs` are two edits of `base`.
 *
 * - Changes to different blocks combine.
 * - When both sides changed the same block differently, `theirs` wins and the ID is reported.
 * - An edit beats a delete, so a merge never loses words someone just wrote.
 * - Order follows `theirs`, except for blocks that only `ours` added or moved: those keep
 *   their place after the block they follow in `ours`.
 */
export function mergeBlocks(base: readonly Block[], ours: readonly Block[], theirs: readonly Block[]): MergeResult {
  const baseById = byId(base);
  const oursById = byId(ours);
  const theirsById = byId(theirs);
  const changed = (block: Block) => {
    const old = baseById.get(block.id);
    return !old || !sameContent(old, block);
  };

  const merged = new Map<string, Block>();
  const conflicts: string[] = [];
  for (const id of new Set([...base, ...ours, ...theirs].map((block) => block.id))) {
    const mine = oursById.get(id);
    const other = theirsById.get(id);
    if (mine && other) {
      if (changed(mine) && changed(other) && !sameContent(mine, other)) conflicts.push(id);
      merged.set(id, changed(mine) && !changed(other) ? mine : other);
    } else if (other && changed(other)) {
      merged.set(id, other);
    } else if (mine && changed(mine)) {
      merged.set(id, mine);
    }
  }

  const order = theirs.map((block) => block.id).filter((id) => merged.has(id));
  const oursUnmoved = unmovedIds(base, ours);
  const theirsUnmoved = unmovedIds(base, theirs);
  ours.forEach((block, index) => {
    if (!merged.has(block.id)) return;
    const theirsHasIt = theirsById.has(block.id);
    const oursMovedIt = !oursUnmoved.has(block.id); // also true for blocks only `ours` added
    const theirsMovedIt = theirsHasIt && !theirsUnmoved.has(block.id);
    if (theirsHasIt && (!oursMovedIt || theirsMovedIt)) return;

    if (theirsHasIt) order.splice(order.indexOf(block.id), 1);
    order.splice(positionAfterPredecessor(order, ours, index), 0, block.id);
  });

  return { blocks: order.map((id) => merged.get(id)!), conflicts };
}

/** Where to insert `list[index]` so it follows the nearest earlier block of `list` already in `order`. */
function positionAfterPredecessor(order: readonly string[], list: readonly Block[], index: number): number {
  for (let k = index - 1; k >= 0; k--) {
    const at = order.indexOf(list[k].id);
    if (at >= 0) return at + 1;
  }
  return 0;
}
