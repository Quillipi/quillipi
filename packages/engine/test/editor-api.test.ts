/** The editor's calls and live connection, answered by the shared EditorApi on a store in memory, as in the cloud. */
import type { Block, ServerMessage } from '@inklog/core';
import { describe, expect, it } from 'vitest';
import { runTool } from '../src/agent.js';
import { EditorApi, MAX_JSON_BYTES } from '../src/editor-api.js';
import { Engine, UserError } from '../src/engine.js';
import { MemoryStore } from '../src/memory-store.js';
import { initNotebook } from '../src/notebook.js';

async function editorApi() {
  const store = new MemoryStore();
  await initNotebook(store, { name: 'gym-rollup', person: { name: 'Karan', email: 'karan@example.com' } });
  return new EditorApi<string>(await Engine.fromStore(store));
}

/** Sends one call the way a host does: `address` is what follows `/api/n/<notebook>/`. */
function ask(api: EditorApi<string>, method: string, address: string, body: string | Uint8Array = '', contentType = 'application/json') {
  const [path, query = ''] = address.split('?');
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return api.call({
    method,
    path: path!,
    query: new URLSearchParams(query),
    contentType,
    body: async (limit) => {
      if (bytes.length > limit) throw new UserError('That is too large.');
      return bytes;
    },
  });
}

const json = (value: unknown) => JSON.stringify(value);

describe('EditorApi', () => {
  it("answers the editor's calls with plain values", async () => {
    const api = await editorApi();
    expect(await ask(api, 'GET', 'repo')).toMatchObject({ status: 200, json: { name: 'gym-rollup' } });
    expect(await ask(api, 'GET', 'section?id=overview')).toMatchObject({ status: 200, json: { version: expect.stringMatching(/\.1$/) } });
    expect(await ask(api, 'GET', 'section?id=nope')).toEqual({ status: 400, json: { error: 'No section "nope".' } });

    expect(await ask(api, 'POST', 'sections', json({ title: 'Pricing' }))).toEqual({ status: 200, json: { id: 'pricing' } });
    const committed = await ask(api, 'POST', 'commit', json({ message: 'Add pricing' }));
    expect(committed).toMatchObject({ status: 200, json: { commit: { number: 2, message: 'Add pricing' } } });
    const oid = (committed as { json: { commit: { oid: string } } }).json.commit.oid;
    expect(await ask(api, 'GET', `snapshot?commit=${oid}`)).toMatchObject({ json: { sections: { pricing: [{ type: 'h1', text: 'Pricing' }] } } });
    expect(await ask(api, 'GET', 'agent-view?section=pricing')).toMatchObject({ json: { map: expect.stringContaining('gym-rollup'), read: expect.stringContaining('Pricing') } });

    expect(await ask(api, 'POST', 'include', json({ section: 'pricing', key: 'x', included: false }))).toEqual({ status: 200, json: { ok: true } });
    expect(await ask(api, 'POST', 'held', json({ index: 0, approve: true }))).toEqual({ status: 400, json: { error: 'That review is no longer pending.' } });
    expect(await ask(api, 'POST', 'commit', '{"message":')).toMatchObject({ status: 400 });
    expect(await ask(api, 'POST', 'commit', '[1]')).toEqual({ status: 400, json: { error: 'Send a JSON object.' } });
    expect(await ask(api, 'POST', 'commit', 'x'.repeat(MAX_JSON_BYTES + 1))).toEqual({ status: 400, json: { error: 'That is too large.' } });
    expect(await ask(api, 'GET', 'nothing')).toEqual({ status: 404, json: { error: 'Not found.' } });
    expect(await ask(api, 'GET', 'undo')).toEqual({ status: 404, json: { error: 'Not found.' } });
  });

  it('adds images and serves only files from assets and canvas, sandboxed', async () => {
    const api = await editorApi();
    const png = new Uint8Array([137, 80, 78, 71, 13, 10]);
    const added = await ask(api, 'POST', 'assets', png, 'image/png');
    const src = (added as { json: { src: string } }).json.src;
    expect(src).toMatch(/^assets\/[0-9a-f]{16}\.png$/);
    const file = await ask(api, 'GET', `files/${src}`);
    expect(file).toMatchObject({ status: 200, headers: { 'content-type': 'image/png', 'cache-control': 'max-age=31536000, immutable', 'x-content-type-options': 'nosniff' } });
    expect((file as { headers: Record<string, string> }).headers['content-security-policy']).toContain('sandbox');
    expect([...(file as { bytes: Uint8Array }).bytes]).toEqual([...png]);

    expect(await ask(api, 'POST', 'assets', 'hello', 'text/plain')).toMatchObject({ status: 400 });
    await api.engine.repo.write('assets/page.html', '<script>alert(1)</script>');
    expect((await ask(api, 'GET', 'files/assets/page.html')).status).toBe(404);
    for (const path of ['files/inklog.json', 'files/AGENTS.md', 'files/assets%2F..%2Finklog.json', 'files/..%2Finklog.json', 'files/%E0%A4%A', 'files/assets/missing.png', 'files/sections/overview.md']) {
      expect((await ask(api, 'GET', path)).status, path).toBe(404);
    }
  });

  it('applies saves from the live connection and sends updates to the other editors', async () => {
    const api = await editorApi();
    const engine = api.engine;
    const updates: { message: ServerMessage; except?: string }[] = [];
    const stop = api.listen((message, except) => updates.push({ message, except }));
    const section = engine.section('overview')!;
    const blocks: Block[] = [...section.blocks, { id: 'aaaaaaaa', type: 'p', text: 'Hello' }];

    const reply = api.receive(json({ type: 'save', request: 7, section: 'overview', base: section.version, blocks }), 'first');
    expect(reply).toEqual({ type: 'saved', request: 7, section: 'overview', version: engine.section('overview')!.version });
    expect(updates).toEqual([{ message: { type: 'section', section: 'overview', version: engine.section('overview')!.version, blocks, actor: { kind: 'person' } }, except: 'first' }]);

    await runTool(engine, 'Claude via claude.ai', 'patch', { path: 'overview', ops: [{ op: 'insert', after: null, text: 'From Claude' }] });
    expect(updates.at(-1)).toMatchObject({ message: { type: 'section', actor: { kind: 'agent' } }, except: undefined });

    // A save based on a version the engine still knows is merged, not answered as stale.
    const merged = api.receive(json({ type: 'save', request: 8, section: 'overview', base: section.version, blocks }), 'first');
    expect(merged).toMatchObject({ type: 'saved', blocks: expect.arrayContaining([expect.objectContaining({ text: 'From Claude' })]) });
    expect(merged).not.toHaveProperty('stale');
    expect(api.receive(json({ type: 'save', request: 9, section: 'overview', base: 'gone1234.1', blocks }), 'first')).toMatchObject({ type: 'saved', stale: true });
    expect(api.receive(json({ type: 'save', request: 10, section: 'nope', base: '', blocks }), 'first')).toEqual({ type: 'error', request: 10, error: 'No section "nope".' });
    expect(api.receive('not json', 'first')).toBeUndefined();
    expect(api.receive(json({ type: 'hello' }), 'first')).toBeUndefined();

    stop();
    const count = updates.length;
    await runTool(engine, 'Claude via claude.ai', 'patch', { path: 'overview', ops: [{ op: 'insert', after: null, text: 'Unheard' }] });
    expect(updates).toHaveLength(count);
    await engine.flush();
  });
});
