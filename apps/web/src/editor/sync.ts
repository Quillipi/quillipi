import { type Block, type SectionData, afterSave, mergeBlocks, sameBlocks } from '@inklog/core';
import type { Editor } from '@tiptap/core';
import type { Live } from '../api';
import { docToBlocks, showBlocks } from './convert';

const SAVE_DELAY_MS = 250;

export type SaveState = 'saved' | 'saving' | 'offline';

/** Every section open in an editor now, so the app can save them all before it reloads. */
const openSections = new Set<SectionSync>();

/** Saves every open section now. False if one couldn't be saved, such as while Quillipi can't be reached. */
export async function saveOpenSections(): Promise<boolean> {
  const saved = await Promise.all([...openSections].map((section) => section.settle()));
  return saved.every(Boolean);
}

/**
 * Keeps one open section in step with Quillipi. Local edits are saved shortly after typing
 * stops. Changes from elsewhere (agents, other windows, other programs) are merged in block by
 * block, and where both touched the same block the person's unsaved edit wins.
 */
export class SectionSync {
  /** The last version Quillipi confirmed, and its blocks. */
  private synced: { version: string; blocks: Block[] };
  private timer?: ReturnType<typeof setTimeout>;
  /** The save on its way to Quillipi, if one is. */
  private saving?: Promise<void>;

  constructor(
    private readonly section: string,
    private readonly editor: Editor,
    initial: SectionData,
    private readonly live: Live,
    private readonly onState: (state: SaveState) => void,
  ) {
    this.synced = { version: initial.version, blocks: initial.blocks };
    openSections.add(this);
  }

  /** The section closed: saves what is left, and it is no longer open. */
  close(): void {
    openSections.delete(this);
    void this.save();
  }

  /** Call after every local edit. */
  edited(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.save(), SAVE_DELAY_MS);
  }

  /** Saves now; while a save is on its way, waits for that one, which saves again if needed. */
  save(): Promise<void> {
    clearTimeout(this.timer);
    this.saving ??= this.send().finally(() => (this.saving = undefined));
    return this.saving;
  }

  /** Saves until Quillipi has everything shown, and says whether it does. */
  async settle(): Promise<boolean> {
    // A few rounds, for words typed while a save was on its way.
    for (let round = 0; round < 3; round++) {
      await this.save();
      if (this.editor.isDestroyed || sameBlocks(this.currentBlocks(), this.synced.blocks)) {
        clearTimeout(this.timer);
        return true;
      }
    }
    return false;
  }

  private async send(): Promise<void> {
    if (this.editor.isDestroyed) return;
    const blocks = docToBlocks(this.editor.state.doc);
    if (sameBlocks(blocks, this.synced.blocks)) return this.onState('saved');

    this.onState('saving');
    try {
      const reply = await this.live.save(this.section, this.synced.version, blocks);
      // Quillipi may have merged in changes this editor hadn't seen yet, or, after it restarted,
      // answered that it can't place this save. Either way the person's words are kept.
      const next = afterSave(blocks, this.synced.blocks, reply, this.currentBlocks());
      this.synced = next.synced;
      if (next.show) this.show(next.show);
      this.onState('saved');
    } catch {
      // The connection dropped. When it comes back, `receive` merges and saves again.
      this.onState('offline');
      return;
    }
    // What is shown differs from what Quillipi has (typed during the save, or merged after a stale
    // reply), so save again, based on the version Quillipi just sent.
    if (!sameBlocks(this.currentBlocks(), this.synced.blocks)) this.edited();
  }

  /** The section as Quillipi has it now, because of a change elsewhere or after reconnecting. */
  receive(version: string, blocks: Block[]): void {
    const merged = mergeBlocks(this.synced.blocks, blocks, this.currentBlocks()).blocks;
    this.synced = { version, blocks };
    this.show(merged);
    if (!sameBlocks(merged, blocks)) this.edited();
  }

  private currentBlocks(): Block[] {
    return docToBlocks(this.editor.state.doc);
  }

  private show(blocks: Block[]): void {
    if (!this.editor.isDestroyed) showBlocks(this.editor, blocks, { fromElsewhere: true });
  }
}
