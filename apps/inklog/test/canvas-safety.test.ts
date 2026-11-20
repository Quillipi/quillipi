/**
 * A canvas file can arrive through Git from anyone (a repo added from GitHub, a pull, another
 * person), and an editor's save is not trusted either: the engine keeps only well-formed elements
 * and writes a preview with no markup of its own (security audit of 2026-11-20).
 */
import fs from 'node:fs';
import path from 'node:path';
import { type Block } from '@inklog/core';
import { describe, expect, it } from 'vitest';
import { initFolder, openFolder } from '../src/setup.js';
import { tempFolder } from './helpers.js';

const BOX = { id: 'k1', kind: 'box', label: 'Upload', x: 20, y: 20, w: 112, h: 44 };
const EVIL = { id: 'k2"><img src=x onerror=alert(document.domain)>', kind: 'box', label: 'Hi', x: 200, y: 20, w: 112, h: 44 };

function canvas(elements: unknown[]): Block {
  return { id: 'k3m9pq2a', type: 'canvas', text: 'Flow', attrs: { wrap: 'inline', width: 100, aspect: 1.6, elements: elements as never } };
}

describe('canvases from outside', () => {
  it('writes only well-formed elements when an editor saves, and a preview without markup from them', async () => {
    const dir = path.join(tempFolder(), 'drawings');
    await initFolder(dir, { name: 'Karan', email: 'karan@example.com' });
    const engine = await openFolder(dir);
    const section = engine.section('overview')!;
    engine.save('overview', section.version, [...section.blocks, canvas([BOX, EVIL])]);
    await engine.flush();
    const json = JSON.parse(fs.readFileSync(path.join(dir, 'canvas/k3m9pq2a.json'), 'utf8'));
    expect(json.elements).toEqual([BOX]);
    expect(fs.readFileSync(path.join(dir, 'canvas/k3m9pq2a.svg'), 'utf8')).not.toContain('<img');
  });

  it('leaves out a crafted element when it opens a canvas file it didn’t write', async () => {
    const dir = path.join(tempFolder(), 'pulled');
    await initFolder(dir, { name: 'Karan', email: 'karan@example.com' });
    const first = await openFolder(dir);
    const section = first.section('overview')!;
    first.save('overview', section.version, [...section.blocks, canvas([BOX])]);
    await first.flush();
    // As if a pull brought in someone else's version of the file.
    fs.writeFileSync(path.join(dir, 'canvas/k3m9pq2a.json'), JSON.stringify({ version: 1, elements: [BOX, EVIL] }));
    const reopened = await openFolder(dir);
    const block = reopened.section('overview')!.blocks.find((candidate) => candidate.id === 'k3m9pq2a')!;
    expect(block.attrs?.elements).toEqual([BOX]);
  });
});
