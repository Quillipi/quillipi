import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Emitter } from '../src/emitter.js';
import { Engine } from '../src/engine.js';
import { MemoryStore } from '../src/memory-store.js';
import { initNotebook } from '../src/notebook.js';

const SRC = path.resolve(import.meta.dirname, '../src');
const CORE = path.resolve(import.meta.dirname, '../../core/src');

/** Packages the engine may use, each of which runs in a browser and in a Cloudflare Worker. */
const ALLOWED_PACKAGES = new Set(['@inklog/core', 'zod', '@modelcontextprotocol/sdk/server/mcp.js', '@modelcontextprotocol/sdk/validation/types.js']);

const IMPORT = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
const NODE_GLOBALS = /\bNodeJS\.|\bprocess\.|\bBuffer\b|\b__dirname\b|\b__filename\b|\brequire\(/;

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function sourceFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts'))
    .map((file) => path.join(dir, file));
}

describe('the portable engine', () => {
  it('uses no Node-only module, package or global, and reaches nothing outside itself', () => {
    for (const file of sourceFiles(SRC)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(IMPORT)) {
        const specifier = match[1] ?? match[2] ?? match[3]!;
        if (specifier.startsWith('.')) {
          const target = path.resolve(path.dirname(file), specifier);
          expect(target.startsWith(SRC + path.sep), `${path.basename(file)} imports ${specifier}, outside the engine`).toBe(true);
        } else {
          expect(ALLOWED_PACKAGES.has(specifier), `${path.basename(file)} imports ${specifier}`).toBe(true);
        }
      }
    }
    for (const file of [...sourceFiles(SRC), ...sourceFiles(CORE)]) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source, `${path.basename(file)} imports a Node module`).not.toMatch(/['"]node:/);
      expect(withoutComments(source), `${path.basename(file)} uses a Node global`).not.toMatch(NODE_GLOBALS);
    }
  });

  it('names images by their content, as before', async () => {
    const store = new MemoryStore();
    await initNotebook(store, { name: 'notebook', person: { name: 'Karan', email: 'karan@example.com' } });
    const engine = await Engine.fromStore(store);
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const rel = await engine.addAsset(bytes, 'png');
    expect(rel).toBe(`assets/${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}.png`);
    expect([...((await store.readBytes(rel)) ?? [])]).toEqual([...bytes]);
    expect(await engine.addAsset(bytes, 'png')).toBe(rel);
  });
});

describe('Emitter', () => {
  it('calls listeners in order, and stops calling one that is removed', () => {
    const emitter = new Emitter<{ saved: [string, number] }>();
    const heard: string[] = [];
    const first = (name: string, n: number) => heard.push(`first ${name} ${n}`);
    emitter.on('saved', first).on('saved', (name) => heard.push(`second ${name}`));
    expect(emitter.emit('saved', 'roadmap', 2)).toBe(true);
    emitter.off('saved', first);
    emitter.emit('saved', 'overview', 3);
    expect(heard).toEqual(['first roadmap 2', 'second roadmap', 'second overview']);
    expect(emitter.listenerCount('saved')).toBe(1);
  });

  it('lets a listener remove itself without another one missing the event', () => {
    const emitter = new Emitter<{ ping: [] }>();
    const heard: string[] = [];
    const once = () => {
      heard.push('once');
      emitter.off('ping', once);
    };
    emitter.on('ping', once).on('ping', () => heard.push('always'));
    emitter.emit('ping');
    emitter.emit('ping');
    expect(heard).toEqual(['once', 'always', 'always']);
    expect(new Emitter<{ ping: [] }>().emit('ping')).toBe(false);
  });
});
