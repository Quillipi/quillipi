import { type Block, sameBlocks } from './blocks.js';
import { mergeBlocks } from './merge.js';
import type { SaveReply } from './protocol.js';

export interface AfterSave {
  /** What the engine has now, and its version: the base for the editor's next save. */
  synced: { version: string; blocks: Block[] };
  /** The text the editor should show, when it should change. */
  show?: Block[];
}

/**
 * What the editor does when the engine answers a save. Kept pure, so every case is tested without
 * a browser.
 *
 * - `sent` is what the editor saved, `synced` the last text the engine confirmed before that, and
 *   `current` what the editor holds now (the person may have typed on while the save was out).
 * - A normal reply already holds the person's save, merged with changes made elsewhere, so it is
 *   merged against what was sent.
 * - A stale reply holds none of it: the engine didn't know the save's base and changed nothing.
 *   It is merged against the last text the engine confirmed, the way changes from elsewhere are,
 *   so everything the person wrote since then wins and an agent's edits to other blocks stay.
 *
 * Either way, when the result differs from what the engine has, the editor saves it again, now
 * based on the reply's version.
 */
export function afterSave(sent: readonly Block[], synced: readonly Block[], reply: SaveReply, current: readonly Block[]): AfterSave {
  if (!reply.blocks) return { synced: { version: reply.version, blocks: [...sent] } };
  const merged = mergeBlocks(reply.stale ? synced : sent, reply.blocks, current).blocks;
  return { synced: { version: reply.version, blocks: reply.blocks }, ...(sameBlocks(merged, current) ? {} : { show: merged }) };
}
