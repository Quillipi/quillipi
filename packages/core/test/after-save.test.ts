import { describe, expect, it } from 'vitest';
import { afterSave } from '../src/after-save.js';
import type { Block } from '../src/blocks.js';
import { mergeBlocks } from '../src/merge.js';
import { seeded } from './random.js';

const p = (id: string, text = id): Block => ({ id, type: 'p', text });
const texts = (blocks: readonly Block[] | undefined) => blocks?.map((block) => block.text);

describe('afterSave', () => {
  it('takes what was sent as the new base when the engine changed nothing else', () => {
    const sent = [p('a', 'One.')];
    expect(afterSave(sent, [p('a')], { version: 'run.2' }, sent)).toEqual({ synced: { version: 'run.2', blocks: sent } });
  });

  it('shows changes merged in by the engine, keeping what was typed while the save was out', () => {
    const sent = [p('a'), p('b', 'Typed.')];
    const reply = { version: 'run.3', blocks: [p('a', 'By Claude.'), p('b', 'Typed.')] };
    const current = [p('a'), p('b', 'Typed, and more.')];
    const next = afterSave(sent, [p('a'), p('b')], reply, current);
    expect(next.synced).toEqual({ version: 'run.3', blocks: reply.blocks });
    expect(texts(next.show)).toEqual(['By Claude.', 'Typed, and more.']);
  });

  it("keeps the person's words after a stale reply, with an agent's edits to other blocks", () => {
    const synced = [p('a'), p('b'), p('c')];
    // The room restarted without the person's edits since `synced`, and an agent changed c.
    const reply = { version: 'new.1', blocks: [p('a'), p('b'), p('c', 'By Claude.')], stale: true as const };
    const current = [p('a'), p('b', 'Typed after the restart.'), p('c'), p('d', 'A new line.')];
    const next = afterSave(current, synced, reply, current);
    expect(next.synced).toEqual({ version: 'new.1', blocks: reply.blocks });
    expect(texts(next.show)).toEqual(['a', 'Typed after the restart.', 'By Claude.', 'A new line.']);
    // Merging a stale reply against what was sent, as the editor did before, drops those words.
    expect(texts(mergeBlocks(current, reply.blocks, current).blocks)).toEqual(['a', 'b', 'By Claude.']);
  });

  it('lets the person win a block both changed, and keeps deletions on both sides', () => {
    const synced = [p('a'), p('b'), p('c'), p('d')];
    const reply = { version: 'new.1', blocks: [p('a', 'By Claude.'), p('b'), p('c')], stale: true as const }; // Claude edited a, deleted d
    const current = [p('a', 'By Karan.'), p('c'), p('d')]; // Karan edited a, deleted b
    expect(texts(afterSave(current, synced, reply, current).show)).toEqual(['By Karan.', 'c']);
  });

  it('shows nothing new when the stale reply already matches the editor', () => {
    const blocks = [p('a', 'Same.')];
    expect(afterSave(blocks, blocks, { version: 'new.1', blocks, stale: true }, blocks)).toEqual({ synced: { version: 'new.1', blocks } });
  });

  it("never drops the person's words after a stale reply (randomized)", () => {
    const random = seeded(32);
    for (let round = 0; round < 500; round++) {
      let next = 0;
      const id = () => `b${round}x${next++}`;
      const synced = Array.from({ length: 1 + random.int(8) }, () => p(id(), `base ${random.int(1000)}`));
      const edit = (who: string) => {
        const blocks: Block[] = [];
        for (const block of synced) {
          const roll = random.next();
          if (roll < 0.15) continue; // deleted
          blocks.push(roll < 0.4 ? p(block.id, `${who} ${random.int(1000)}`) : block);
          if (random.next() < 0.15) blocks.push(p(id(), `${who} new ${random.int(1000)}`));
        }
        return blocks;
      };
      const current = edit('person');
      const room = edit('agent');
      const shown = afterSave(current, synced, { version: 'new.1', blocks: room, stale: true }, current).show ?? current;
      const byId = new Map(shown.map((block) => [block.id, block.text]));
      const before = new Map(synced.map((block) => [block.id, block.text]));
      for (const block of current) {
        // Every block the person wrote or changed is there, as the person has it.
        if (before.get(block.id) !== block.text) expect(byId.get(block.id)).toBe(block.text);
      }
      for (const block of room) {
        // An agent's change survives wherever the person left that block alone.
        const personKept = current.find((other) => other.id === block.id)?.text === before.get(block.id);
        if (before.get(block.id) !== block.text && (personKept || !before.has(block.id))) expect(byId.get(block.id)).toBe(block.text);
      }
    }
  });
});
