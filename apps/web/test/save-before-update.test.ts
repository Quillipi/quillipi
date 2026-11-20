/**
 * Before a new version of Quillipi loads (installable.ts), every open section is saved: no words may
 * be lost to an update. Run in Node with the editor's own document and a stand-in connection.
 */
import type { Block, SectionData } from '@inklog/core';
import { getSchema } from '@tiptap/core';
import { Node } from '@tiptap/pm/model';
import { describe, expect, it, vi } from 'vitest';

// The schema's image and drawing views import the editor's API module, which reads the page's address.
vi.stubGlobal('location', new URL('http://127.0.0.1/n/test'));
const { blocksToDoc } = await import('../src/editor/convert');
const { editorExtensions } = await import('../src/editor/schema');
const { SectionSync, saveOpenSections } = await import('../src/editor/sync');

const schema = getSchema(editorExtensions());
const paragraph = (text: string): Block => ({ id: 'aaaaaaaa', type: 'p', text });

/** An open section showing `text`, with Quillipi's last confirmed text `saved`. */
function open(saved: string, text: string, save: (blocks: Block[]) => Promise<unknown>) {
  const editor = { isDestroyed: false, state: { doc: Node.fromJSON(schema, blocksToDoc([paragraph(text)])) } };
  const sent: string[] = [];
  const live = {
    save: (_section: string, _base: string, blocks: Block[]) => {
      sent.push(blocks[0]!.text);
      return save(blocks);
    },
  };
  const states: string[] = [];
  const initial: SectionData = { id: 'notes', title: 'Notes', version: 'run.1', blocks: [paragraph(saved)], head: null } as unknown as SectionData;
  const sync = new SectionSync('notes', editor as never, initial, live as never, (state) => states.push(state));
  const type = (more: string) => (editor.state.doc = Node.fromJSON(schema, blocksToDoc([paragraph(more)])));
  return { sync, sent, states, type };
}

const accepted = () => Promise.resolve({ type: 'saved', request: 1, section: 'notes', version: 'run.2' });

describe('saving before an update', () => {
  it('saves the words not yet saved, and says Quillipi has them', async () => {
    const section = open('Hello', 'Hello world', accepted);
    expect(await section.sync.settle()).toBe(true);
    expect(section.sent).toEqual(['Hello world']);
    section.sync.close();
  });

  it('says so when they can’t be saved, so nothing reloads', async () => {
    const section = open('Hello', 'Hello world', () => Promise.reject(new Error('Not connected to Quillipi.')));
    expect(await section.sync.settle()).toBe(false);
    expect(section.states.at(-1)).toBe('offline');
    section.sync.close();
  });

  it('waits for a save on its way, then saves the words typed meanwhile', async () => {
    let answer!: () => void;
    const first = new Promise((resolve) => (answer = () => resolve({ type: 'saved', request: 1, section: 'notes', version: 'run.2' })));
    const section = open('Hello', 'Hello there', (blocks) => (blocks[0]!.text === 'Hello there' ? first : accepted()));
    void section.sync.save();
    section.type('Hello there, friend');
    const settled = section.sync.settle();
    answer();
    expect(await settled).toBe(true);
    expect(section.sent).toEqual(['Hello there', 'Hello there, friend']);
    section.sync.close();
  });

  it('saves every section still open, and only those', async () => {
    const one = open('a', 'a1', accepted);
    const two = open('b', 'b1', accepted);
    const closed = open('c', 'c', accepted);
    closed.sync.close();
    expect(await saveOpenSections()).toBe(true);
    expect([one.sent, two.sent, closed.sent]).toEqual([['a1'], ['b1'], []]);

    const down = open('d', 'd1', () => Promise.reject(new Error('Not connected to Quillipi.')));
    expect(await saveOpenSections()).toBe(false);
    for (const section of [one, two, down]) section.sync.close();
  });
});
