import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { runTool } from '@inklog/engine';
import { Engine } from '@inklog/engine';
import { createMcpServer } from '@inklog/engine';
import { APP_HEADERS, type Server, startServer } from '../src/server.js';
import { initFolder, openFolder } from '../src/setup.js';
import { tempFolder } from './helpers.js';

const running: { server: Server; engine: Engine }[] = [];
afterEach(async () => {
  for (const { server, engine } of running.splice(0)) {
    await server.close();
    await engine.flush();
  }
});

async function start() {
  const dir = path.join(tempFolder(), 'docs');
  await initFolder(dir, { name: 'Karan', email: 'karan@example.com' });
  const engine = await openFolder(dir);
  const webRoot = tempFolder();
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>Quillipi</title>');
  const server = await startServer(engine, { port: 4600 + Math.floor(Math.random() * 300), webRoot, notebook: 'docs' });
  running.push({ server, engine });
  const base = `http://localhost:${server.port}`;
  const login = await fetch(server.loginUrl, { redirect: 'manual' });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  return { engine, server, base, cookie, login };
}

function connect(url: string, headers: Record<string, string>): Promise<{ socket: WebSocket; messages: any[] }> {
  const socket = new WebSocket(url, { headers });
  const messages: any[] = [];
  socket.on('message', (data) => messages.push(JSON.parse(String(data))));
  return new Promise((resolve, reject) => socket.on('open', () => resolve({ socket, messages })).on('error', reject));
}

/** The notebook's live connection, as the editor opens it. */
const live = (base: string, cookie: string) => connect(`${base.replace('http', 'ws')}/api/n/docs/ws`, { cookie, origin: base });

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(check()).toBe(true);
};

describe('server', () => {
  it('only answers signed-in requests for its own host', async () => {
    const { server, base, cookie } = await start();
    expect((await fetch(`${base}/api/n/docs/repo`)).status).toBe(401);
    expect((await fetch(`${base}/api/notebooks`)).status).toBe(401);
    expect((await fetch(`${base}/api/n/docs/repo`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${base}/api/n/docs/repo`, { headers: { authorization: `Bearer ${server.token}` } })).status).toBe(200);
    expect((await fetch(`${base}/login?token=wrong`)).status).toBe(403);
    expect((await fetch(`${base}/api/n/docs/files/assets%2F..%2F..%2F.git%2Fconfig`, { headers: { cookie } })).status).toBe(404);
    expect((await fetch(`${base}/api/n/docs/files/..%2Finklog.json`, { headers: { cookie } })).status).toBe(404);
    expect((await fetch(`${base}/api/n/docs/files/inklog.json`, { headers: { cookie } })).status).toBe(404);
    expect((await fetch(`${base}/api/n/docs/files/%E0%A4%A`, { headers: { cookie } })).status).toBe(404);
    // fetch won't send a forged Host header, so this uses a raw request, as a rebinding attack would.
    const status = await new Promise<number>((resolve, reject) =>
      http.get({ port: server.port, host: '127.0.0.1', path: '/api/n/docs/repo', headers: { cookie, host: 'evil.example' } }, (response) => resolve(response.statusCode!)).on('error', reject),
    );
    expect(status).toBe(403);
  });

  it("serves the notebook at its own addresses, and only this notebook", async () => {
    const { base, cookie, login } = await start();
    expect(login.status).toBe(302);
    expect(login.headers.get('location')).toBe('/n/docs');
    expect((await fetch(`${base}/`, { redirect: 'manual' })).headers.get('location')).toBe('/n/docs');
    expect(await (await fetch(`${base}/n/docs`)).text()).toContain('<title>Quillipi</title>');

    expect(await (await fetch(`${base}/api/notebooks`, { headers: { cookie } })).json()).toEqual({ notebooks: [{ id: 'docs', name: 'docs' }] });
    expect((await (await fetch(`${base}/api/n/docs/repo`, { headers: { cookie } })).json()).name).toBe('docs');
    const other = await fetch(`${base}/api/n/other/repo`, { headers: { cookie } });
    expect(other.status).toBe(404);
    expect((await other.json()).error).toContain('No notebook "other" here');
    // The addresses from before there were notebook addresses answer nothing.
    expect((await fetch(`${base}/api/repo`, { headers: { cookie } })).status).toBe(404);
    expect((await fetch(`${base}/api/n/docs/nothing`, { headers: { cookie } })).status).toBe(404);
    expect((await fetch(`${base}/api/n/docs/section?id=nope`, { headers: { cookie } })).status).toBe(400);
  });

  it('gives the app the same security headers as the cloud, so text that slipped past every check still runs nothing (audit, 2026-11-20)', async () => {
    const { base } = await start();
    const page = await fetch(`${base}/n/docs`);
    for (const [name, value] of Object.entries(APP_HEADERS)) expect(page.headers.get(name)).toBe(value);
    // The cloud's headers for the app's files, from apps/web/public/_headers: the block for every path.
    const file = fs.readFileSync(path.join(import.meta.dirname, '../../web/public/_headers'), 'utf8');
    const block = file.split(/\n(?=\/)/).find((part) => part.startsWith('/*\n'))!;
    const cloud = Object.fromEntries(
      block
        .split('\n')
        .slice(1)
        .filter((line) => /^\s+\S/.test(line))
        .map((line) => {
          const at = line.indexOf(':');
          return [line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim()];
        }),
    );
    expect(APP_HEADERS).toEqual(cloud);
  });

  it('serves notebook images sandboxed, so an SVG opened on its own runs nothing', async () => {
    const { base, cookie } = await start();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const added = await fetch(`${base}/api/n/docs/assets`, { method: 'POST', headers: { cookie, 'content-type': 'image/svg+xml' }, body: svg });
    const { src } = await added.json();
    expect(src).toMatch(/^assets\/[0-9a-f]{16}\.svg$/);
    const file = await fetch(`${base}/api/n/docs/files/${src}`, { headers: { cookie } });
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('image/svg+xml');
    expect(file.headers.get('content-security-policy')).toContain('sandbox');
    expect(file.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await file.text()).toBe(svg);
    const text = await fetch(`${base}/api/n/docs/assets`, { method: 'POST', headers: { cookie, 'content-type': 'text/html' }, body: '<p>' });
    expect(text.status).toBe(400);
  });

  it("opens the live connection only at this notebook's address, signed in and from its own page", async () => {
    const { base, cookie } = await start();
    const ws = base.replace('http', 'ws');
    await expect(connect(`${ws}/ws`, { cookie, origin: base })).rejects.toThrow();
    await expect(connect(`${ws}/api/n/other/ws`, { cookie, origin: base })).rejects.toThrow();
    await expect(connect(`${ws}/api/n/docs/ws`, { cookie, origin: 'https://evil.example' })).rejects.toThrow();
    await expect(connect(`${ws}/api/n/docs/ws`, { origin: base })).rejects.toThrow();
    const { socket } = await live(base, cookie);
    socket.close();
  });

  it('saves over the WebSocket and pushes changes to other editors', async () => {
    const { engine, base, cookie } = await start();
    const first = await live(base, cookie);
    const second = await live(base, cookie);
    const section = engine.section('overview')!;

    first.socket.send(JSON.stringify({ type: 'save', request: 1, section: 'overview', base: section.version, blocks: [...section.blocks, { id: 'aaaaaaaa', type: 'p', text: 'Hello' }] }));
    await until(() => first.messages.some((message) => message.type === 'saved'));
    await until(() => second.messages.some((message) => message.type === 'section'));
    const saved = first.messages.find((message) => message.type === 'saved');
    expect(saved).toMatchObject({ request: 1, section: 'overview', version: engine.section('overview')!.version });
    expect(saved.version).not.toBe(section.version);
    expect(saved.stale).toBeUndefined();
    expect(first.messages.some((message) => message.type === 'section')).toBe(false);
    expect(second.messages.find((message) => message.type === 'section').blocks[1].text).toBe('Hello');

    await runTool(engine, 'Claude via Claude Code', 'patch', { path: 'overview', ops: [{ op: 'insert', after: null, text: 'From Claude' }] });
    await until(() => first.messages.some((message) => message.type === 'section' && message.actor.kind === 'agent'));
    first.socket.close();
    second.socket.close();
  });

  it('answers a save it cannot place as stale, and changes nothing', async () => {
    const { engine, base, cookie } = await start();
    const editor = await live(base, cookie);
    const before = engine.section('overview')!;
    for (const [request, version] of [
      [1, 'gone1234.1'],
      [2, 1],
    ] as const) {
      editor.socket.send(JSON.stringify({ type: 'save', request, section: 'overview', base: version, blocks: [{ id: 'aaaaaaaa', type: 'p', text: 'Typed before a restart' }] }));
      await until(() => editor.messages.some((message) => message.request === request));
      expect(editor.messages.find((message) => message.request === request)).toEqual({ type: 'saved', request, section: 'overview', version: before.version, blocks: before.blocks, stale: true });
    }
    expect(engine.section('overview')).toEqual(before);

    editor.socket.send(JSON.stringify({ type: 'save', request: 3, section: 'overview', base: before.version, blocks: 'not blocks' }));
    await until(() => editor.messages.some((message) => message.request === 3));
    expect(editor.messages.find((message) => message.request === 3)).toMatchObject({ type: 'error', error: 'That save was not a list of blocks.' });
    editor.socket.close();
  });

  it('runs tools for MCP processes that do not own the folder', async () => {
    const { base, server } = await start();
    const response = await fetch(`${base}/api/tool`, {
      method: 'POST',
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'read', args: { path: 'overview' }, agent: 'Claude via Claude Code' }),
    });
    expect((await response.json()).text).toMatch(/^overview "Docs" · 1 blocks/);
    expect((await fetch(`${base}/api/ping`, { headers: { authorization: `Bearer ${server.token}` } })).status).toBe(200);
  });
});

describe('MCP', () => {
  it('lists the tools with instructions and answers calls', async () => {
    const dir = path.join(tempFolder(), 'docs');
    await initFolder(dir, { name: 'Karan', email: 'karan@example.com' });
    const engine = await openFolder(dir);
    const server = createMcpServer({ call: (name, args, agent) => runTool(engine, agent, name, args) }, '0.1.0');
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'claude-code', version: '1.0.0' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

    expect(client.getInstructions()).toContain('Call map first');
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['map', 'read', 'search', 'changes', 'patch', 'commit', 'compare', 'history', 'organize']);

    const result = await client.callTool({ name: 'patch', arguments: { path: 'overview', ops: [{ op: 'insert', after: null, text: 'Hi' }] } });
    expect((result.content as { text: string }[])[0].text).toMatch(/^✓ inserted \^[a-z2-9]{8} \(p\)/);
    expect(engine.info().activity.at(-1)).toMatchObject({ agent: 'Claude via Claude Code', text: 'edited overview' });

    const failure = await client.callTool({ name: 'read', arguments: { path: 'missing' } });
    expect(failure.isError).toBe(true);
    await client.close();
    await engine.flush();
  });
});
