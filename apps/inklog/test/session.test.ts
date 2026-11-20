import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Engine } from '@inklog/engine';
import type { RepoFiles } from '../src/repo.js';
import { ownerTools } from '../src/owner.js';
import { type Server, startServer } from '../src/server.js';
import { rememberedPublicUrl, serve } from '../src/session.js';
import { initFolder, openFolder } from '../src/setup.js';
import { tempFolder } from './helpers.js';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function notebook(): Promise<{ dir: string; engine: Engine }> {
  const dir = path.join(tempFolder(), 'notebook');
  await initFolder(dir, { name: 'Karan', email: 'karan@example.com' });
  return { dir, engine: await openFolder(dir) };
}

async function startOwner(engine: Engine): Promise<Server> {
  const server = await startServer(engine, { port: 4980 + Math.floor(Math.random() * 15), webRoot: tempFolder(), notebook: 'notebook' });
  servers.push(server);
  // Pretend another process owns the folder: findOwner ignores the process that asks.
  const dir = (engine.repo as RepoFiles).dir;
  fs.mkdirSync(path.join(dir, '.inklog'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.inklog', 'owner.json'), JSON.stringify({ pid: process.ppid, port: server.port, token: server.token }));
  return server;
}

describe('the public address', () => {
  it('is remembered per notebook until it is turned off', async () => {
    const { dir, engine } = await notebook();
    expect(rememberedPublicUrl(dir, 'https://quillipi.example.com')?.href).toBe('https://quillipi.example.com/');
    expect(rememberedPublicUrl(dir, undefined)?.href).toBe('https://quillipi.example.com/');
    expect(rememberedPublicUrl(dir, 'off')).toBeUndefined();
    expect(rememberedPublicUrl(dir, undefined)).toBeUndefined();
    expect(() => rememberedPublicUrl(dir, 'http://example.com')).toThrow('must start with https://');
    await engine.flush();
  });
});

describe('several Quillipi processes', () => {
  it('lets a forwarding process find the owner again after Quillipi restarts', async () => {
    const { dir, engine } = await notebook();
    const first = await startOwner(engine);
    const tools = ownerTools(dir, { pid: process.ppid, port: first.port, token: first.token });
    expect(await tools.call('read', { path: 'overview' }, 'Claude via Claude Code')).toMatch(/^overview/);

    await first.close();
    servers.splice(servers.indexOf(first), 1);
    await startOwner(engine);
    expect(await tools.call('read', { path: 'overview' }, 'Claude via Claude Code')).toMatch(/^overview/);
    await engine.flush();
  });

  it('refuses to start remote access when another Quillipi already owns the folder without it', async () => {
    const { dir, engine } = await notebook();
    await startOwner(engine);
    await expect(serve(dir, { version: '0.2.1', open: false, remote: { publicUrl: new URL('https://quillipi.example.com'), port: 4995 } })).rejects.toThrow(
      'already running for this folder',
    );
    await engine.flush();
  });
});
