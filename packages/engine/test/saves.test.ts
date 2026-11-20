/**
 * Editor saves across a restart of the engine. In the cloud a notebook's room forgets everything
 * in memory after about ten seconds idle while the editor stays connected, so this happens there
 * after every pause in typing; on the laptop a restart closes the connection too.
 */
import { type Block, type SaveReply, type SectionData, afterSave, blockHash, sameBlocks } from '@inklog/core';
import { describe, expect, it } from 'vitest';
import { runTool } from '../src/agent.js';
import { Engine } from '../src/engine.js';
import { MemoryStore } from '../src/memory-store.js';
import { initNotebook } from '../src/notebook.js';

const p = (id: string, text: string): Block => ({ id, type: 'p', text });
const texts = (blocks: readonly Block[]) => blocks.map((block) => block.text);

async function notebook(): Promise<{ store: MemoryStore; engine: Engine }> {
  const store = new MemoryStore();
  await initNotebook(store, { name: 'gym-rollup', person: { name: 'Karan', email: 'karan@example.com' } });
  return { store, engine: await Engine.fromStore(store) };
}

/** The editor's side of saving, as apps/web/src/editor/sync.ts does it, without a browser. */
class Editor {
  synced: { version: string; blocks: Block[] };
  current: Block[];
  constructor(data: SectionData) {
    this.synced = { version: data.version, blocks: data.blocks };
    this.current = data.blocks;
  }
  save(engine: Engine): SaveReply {
    const sent = this.current;
    const reply = engine.save('overview', this.synced.version, sent);
    const next = afterSave(sent, this.synced.blocks, reply, this.current);
    this.synced = next.synced;
    if (next.show) this.current = next.show;
    return reply;
  }
  get unsaved(): boolean {
    return !sameBlocks(this.current, this.synced.blocks);
  }
}

describe('saves across a restart', () => {
  it("keeps the person's words and an agent's edit when the room restarts in the middle of typing", async () => {
    const { store, engine: before } = await notebook();
    const editor = new Editor(before.section('overview')!);
    const [title] = editor.current;
    editor.current = [title, p('aaaaaaaa', 'First line.')];
    expect(editor.save(before).stale).toBeUndefined();
    await runTool(before, 'Claude via claude.ai', 'patch', { path: 'overview', ops: [{ op: 'replace', id: title.id, base: blockHash(title), text: 'Gym rollup plan' }] });
    await before.flush(); // the room saves everything before each reply, then sleeps

    const after = await Engine.fromStore(store); // and wakes for the editor's next message
    const untouched = after.section('overview')!;
    editor.current = [title, p('aaaaaaaa', 'First line, and more.'), p('bbbbbbbb', 'A second line.')];
    const reply = editor.save(after);
    expect(reply.stale).toBe(true);
    expect(after.section('overview')).toEqual(untouched); // nothing was merged against the wrong text
    expect(texts(editor.current)).toEqual(['Gym rollup plan', 'First line, and more.', 'A second line.']);

    expect(editor.unsaved).toBe(true); // so the editor saves again, now on the room's own version
    expect(editor.save(after).stale).toBeUndefined();
    expect(texts(after.section('overview')!.blocks)).toEqual(['Gym rollup plan', 'First line, and more.', 'A second line.']);
    expect(editor.unsaved).toBe(false);
    expect(after.pending().find((change) => change.key === title.id)?.by).toEqual(['agent']);
  });

  it('never takes a version from before a restart for one after it', async () => {
    const { store, engine: first } = await notebook();
    const second = await Engine.fromStore(store);
    const old = first.section('overview')!.version;
    const now = second.section('overview')!;
    expect(old).toMatch(/^[a-z2-9]{8}\.1$/);
    expect(now.version).toMatch(/^[a-z2-9]{8}\.1$/);
    expect(now.version).not.toBe(old);
    // Before, both were 1, so this save would have been merged against the wrong text.
    for (const base of [old, '1', '']) {
      expect(second.save('overview', base, [p('aaaaaaaa', 'Typed before the restart.')])).toEqual({ version: now.version, blocks: now.blocks, stale: true });
    }
    expect(second.section('overview')).toEqual(now);

    // Also after the same number of changes on both sides of the restart.
    const [title] = now.blocks;
    for (const engine of [first, second]) {
      for (const text of ['One.', 'Two.']) engine.save('overview', engine.section('overview')!.version, [title, p('aaaaaaaa', text)]);
    }
    expect(second.save('overview', first.section('overview')!.version, [title, p('aaaaaaaa', 'From before.')]).stale).toBe(true);
    await first.flush();
    await second.flush();
  });

  it('answers a save based on a version older than the kept ones as stale', async () => {
    const { engine } = await notebook();
    const [title] = engine.section('overview')!.blocks;
    const first = engine.section('overview')!.version;
    for (let n = 0; n < 50; n++) {
      engine.save('overview', engine.section('overview')!.version, [title, p('aaaaaaaa', `Draft ${n}`)]);
    }
    expect(engine.save('overview', first, [title, p('aaaaaaaa', 'Old')]).stale).toBe(true);
    expect(engine.save('overview', engine.section('overview')!.version, [title, p('aaaaaaaa', 'New')]).stale).toBeUndefined();
    await engine.flush();
  });
});
