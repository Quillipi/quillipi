/**
 * Remote access, tested the way Claude uses it: the SDK's own OAuth client discovers sign-in
 * from a 401, registers, sends "the person" to the approval page, and exchanges the code.
 */
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { afterEach, describe, expect, it } from 'vitest';
import { Engine } from '@inklog/engine';
import { type RemoteAccess, startRemoteAccess } from '../src/remote.js';
import { initFolder, openFolder } from '../src/setup.js';
import { tempFolder } from './helpers.js';

const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

/** Plays Claude's side of sign-in, keeping everything in memory. */
class TestClaude implements OAuthClientProvider {
  info?: OAuthClientInformationMixed;
  saved?: OAuthTokens;
  verifier = '';
  authorizationUrl?: URL;
  get redirectUrl() {
    return CALLBACK;
  }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: 'Claude', redirect_uris: [CALLBACK], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
}

interface Door {
  dir: string;
  logs: string[];
  engine: Engine;
  remote: RemoteAccess;
  publicUrl: URL;
  mcpUrl: URL;
}

const open: Door[] = [];
afterEach(async () => {
  for (const door of open.splice(0)) {
    await door.remote.close();
    await door.engine.flush();
  }
});

async function openDoor(dir?: string, port = 4700 + Math.floor(Math.random() * 250)): Promise<Door> {
  if (!dir) {
    dir = path.join(tempFolder(), 'notebook');
    await initFolder(dir, { name: 'Karan', email: 'karan@example.com' });
  }
  const engine = await openFolder(dir);
  const publicUrl = new URL(`http://localhost:${port}`);
  const logs: string[] = [];
  const remote = await startRemoteAccess(engine, { publicUrl, port, version: '0.2.1', onChange: () => {}, log: (line) => logs.push(line) });
  const door = { dir, logs, engine, remote, publicUrl, mcpUrl: new URL('/mcp', publicUrl) };
  open.push(door);
  return door;
}

/** Starts sign-in as Claude would and returns the approval page with its request ID. */
async function startSignIn(door: Door, claude: TestClaude, url = door.mcpUrl): Promise<{ transport: StreamableHTTPClientTransport; request: string }> {
  const transport = new StreamableHTTPClientTransport(url, { authProvider: claude });
  await expect(new Client({ name: 'claude-ai', version: '1.0.0' }).connect(transport)).rejects.toThrow(UnauthorizedError);
  const page = await (await fetch(claude.authorizationUrl!)).text();
  expect(page).toContain('Claude</strong> wants to read and edit your notebook <strong>notebook</strong>');
  return { transport, request: /name="request" value="([^"]+)"/.exec(page)![1] };
}

function answer(door: Door, form: Record<string, string>): Promise<Response> {
  return fetch(new URL('/approve', door.publicUrl), { method: 'POST', body: new URLSearchParams(form), redirect: 'manual' });
}

async function signIn(door: Door, claude = new TestClaude(), url = door.mcpUrl): Promise<{ client: Client; claude: TestClaude }> {
  const { transport, request } = await startSignIn(door, claude, url);
  const approved = await answer(door, { request, code: door.remote.status().pending!.code, decision: 'approve' });
  expect(approved.status).toBe(302);
  const back = new URL(approved.headers.get('location')!);
  expect(back.origin + back.pathname).toBe(CALLBACK);
  await transport.finishAuth(back.searchParams.get('code')!);
  const client = new Client({ name: 'claude-ai', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url, { authProvider: claude }));
  return { client, claude };
}

const text = (result: Awaited<ReturnType<Client['callTool']>>) => (result.content as { text: string }[])[0].text;

describe('remote access', () => {
  it('lets an approved app use the tools, with its work credited to it', async () => {
    const door = await openDoor();
    const { client } = await signIn(door);
    expect(door.remote.status().connections).toMatchObject([{ app: 'Claude' }]);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('patch');

    expect(text(await client.callTool({ name: 'map', arguments: {} }))).toContain('notebook · 1 sections');
    expect(text(await client.callTool({ name: 'patch', arguments: { path: 'overview', ops: [{ op: 'insert', after: null, text: 'From the web.' }] } }))).toMatch(/^✓ inserted/);
    expect(text(await client.callTool({ name: 'commit', arguments: { message: 'Add a line from claude.ai' } }))).toContain('✓ committed #2');
    expect(execFileSync('git', ['log', '-1', '--format=%B'], { cwd: door.dir, encoding: 'utf8' }).trim()).toBe('Add a line from claude.ai\n\nInkLog-Agent: Claude via claude.ai');
    await client.close();
  });

  it('turns away requests without a valid token and says where to sign in', async () => {
    const door = await openDoor();
    const call = (headers: Record<string, string>) =>
      fetch(door.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: '{}' });

    const anonymous = await call({});
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toContain(`resource_metadata="${door.publicUrl.origin}/.well-known/oauth-protected-resource/mcp"`);
    expect((await call({ authorization: 'Bearer made-up' })).status).toBe(401);
  });

  it('gives up after five wrong codes, and lets the person deny', async () => {
    const door = await openDoor();
    const { request } = await startSignIn(door, new TestClaude());
    for (let attempt = 1; attempt <= 4; attempt++) {
      const retry = await answer(door, { request, code: '000 000', decision: 'approve' });
      expect(await retry.text()).toContain(`${5 - attempt} ${attempt === 4 ? 'try' : 'tries'} left`);
    }
    const last = await answer(door, { request, code: '000 000', decision: 'approve' });
    expect(new URL(last.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
    expect(door.remote.status().pending).toBeUndefined();

    const second = await startSignIn(door, new TestClaude());
    const denied = await answer(door, { request: second.request, decision: 'deny' });
    expect(new URL(denied.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
    expect(door.remote.status().connections).toEqual([]);
  });

  it('rotates refresh tokens and keeps connections across restarts', async () => {
    const door = await openDoor();
    const { claude } = await signIn(door);
    const refresh = (token: string) =>
      fetch(new URL('/token', door.publicUrl), {
        method: 'POST',
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token, client_id: claude.info!.client_id }),
      });

    const first = claude.saved!.refresh_token!;
    const rotated = await refresh(first);
    expect(rotated.status).toBe(200);
    const next = (await rotated.json()).refresh_token as string;
    expect(next).not.toBe(first);
    expect((await refresh(first)).status).toBe(400);

    await door.remote.close();
    await door.engine.flush();
    open.splice(open.indexOf(door), 1);
    const restarted = await openDoor(door.dir, Number(door.publicUrl.port));
    expect((await refresh(next)).status).toBe(200);
    expect(restarted.remote.status().connections).toHaveLength(1);
  });

  it('cuts off an app the person disconnects', async () => {
    const door = await openDoor();
    const { client } = await signIn(door);
    await door.remote.disconnect(door.remote.status().connections[0].id);
    await expect(client.callTool({ name: 'map', arguments: {} })).rejects.toThrow();
  });

  it('answers only for its own address, and never serves the editor', async () => {
    const door = await openDoor();
    const status = await new Promise<number>((resolve, reject) =>
      http.get({ host: '127.0.0.1', port: door.publicUrl.port, path: '/.well-known/oauth-authorization-server', headers: { host: 'evil.example' } }, (response) => resolve(response.statusCode!)).on('error', reject),
    );
    expect(status).toBe(421);
    expect((await fetch(new URL('/api/n/notebook/repo', door.publicUrl))).status).toBe(404);
    expect((await fetch(new URL('/n/notebook', door.publicUrl))).status).toBe(404);
    const metadata = await (await fetch(new URL('/.well-known/oauth-authorization-server', door.publicUrl))).json();
    expect(metadata.issuer).toBe(door.publicUrl.href);
  });

  it('serves an approval page that runs no scripts and cannot be framed', async () => {
    const door = await openDoor();
    const claude = new TestClaude();
    await startSignIn(door, claude);
    const page = await fetch(claude.authorizationUrl!);
    const policy = page.headers.get('content-security-policy')!;
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("form-action 'self' https://claude.ai");
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    expect(await page.text()).not.toContain('<script');
  });

  it('also works when the connector is given the bare address, without /mcp', async () => {
    const door = await openDoor();
    const { client } = await signIn(door, new TestClaude(), door.publicUrl);
    expect(text(await client.callTool({ name: 'map', arguments: {} }))).toContain('notebook · 1 sections');
    await client.close();
  });

  it('keeps apps signed in when Quillipi restarts', async () => {
    const door = await openDoor();
    const { claude } = await signIn(door);
    await door.remote.close();
    await door.engine.flush();
    open.splice(open.indexOf(door), 1);
    const restarted = await openDoor(door.dir, Number(door.publicUrl.port));
    const listed = await fetch(restarted.mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${claude.saved!.access_token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(listed.status).toBe(200);
  });

  it('tells an old approval page what became of its request', async () => {
    const door = await openDoor();
    const claude = new TestClaude();
    const first = await startSignIn(door, claude);
    const second = await startSignIn(door, claude);
    expect(await (await answer(door, { request: first.request, code: door.remote.status().pending!.code, decision: 'approve' })).text()).toContain('A newer request replaced this one');

    await answer(door, { request: second.request, code: door.remote.status().pending!.code, decision: 'approve' });
    const again = await answer(door, { request: second.request, code: '000000', decision: 'approve' });
    expect(await again.text()).toContain('Already approved');
  });

  it('reports failed requests in words, but not the normal start of sign-in', async () => {
    const door = await openDoor();
    const post = (headers: Record<string, string>) =>
      fetch(door.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: '{}' });
    await post({});
    await post({ authorization: 'Bearer stale' });
    await fetch(new URL('/wp-login.php', door.publicUrl));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(door.logs).toEqual([
      "Remote request failed: POST /mcp → 401. The app's sign-in is no longer valid, so it must sign in again.",
      'Remote request failed: GET /wp-login.php → 404. Nothing is served at that path.',
    ]);
  });

  it('explains the address to someone who opens it in a browser', async () => {
    const door = await openDoor();
    expect(await (await fetch(door.publicUrl)).text()).toContain(`add ${door.mcpUrl.href} as a custom connector`);
  });
});

