/**
 * Sign-in and the door, tested the way Claude uses them (apps.ts plays its side and the person's
 * browser). any-ai.test.ts signs in as every other kind of app.
 */
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/index.js';
import { sessionCookie } from '../src/session.js';
import { SECRETS, SETTINGS } from '../src/settings.js';
import { PER_VISITOR } from '../src/sign-in-limits.js';
import { Browser, CLAUDE_AI, MCP, ORIGIN, TestApp, cloud, connect, continueToGitHub, startConnecting, text } from './apps.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('connecting Claude with GitHub sign-in', () => {
  it('lets the owner in, and sends each tool call to the notebook it names', async () => {
    const c = await cloud();
    const claude = new TestApp();
    const { transport, browser, page, html } = await startConnecting(c, claude);

    expect(page.status).toBe(200);
    expect(html).toContain('<strong>Claude</strong> wants to read and edit your Quillipi notebooks');
    expect(html).toContain('Access will be sent to <strong>claude.ai</strong>.');
    expect(html).toContain('GitHub then checks that you are OctoCat.');
    const policy = page.headers.get('content-security-policy')!;
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("form-action 'self' https://github.com https://claude.ai");

    const { github, back } = await continueToGitHub(c, browser, html);
    expect(Object.fromEntries(github.searchParams)).toMatchObject({ client_id: c.github.clientId, redirect_uri: `${ORIGIN}/callback`, code_challenge_method: 'S256', login: 'OctoCat' });
    expect(back.status).toBe(302);
    const toClaude = new URL(back.headers.get('location')!);
    expect(toClaude.origin + toClaude.pathname).toBe(CLAUDE_AI);
    expect(toClaude.searchParams.get('iss')).toBe(ORIGIN);
    await transport.finishAuth(toClaude.searchParams.get('code')!);
    expect(claude.saved).toMatchObject({ token_type: 'bearer', expires_in: 3600, scope: 'notebook' });
    expect(claude.saved!.refresh_token).toBeTruthy();

    const client = new Client({ name: 'claude-ai', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(MCP, { authProvider: claude, fetch: c.fetch }));
    // How the server introduces itself: apps show its title, and its website.
    expect(client.getServerVersion()).toMatchObject({ name: 'quillipi', title: 'Quillipi', websiteUrl: 'https://quillipi.app' });
    expect(client.getInstructions()).toMatch(/^Quillipi keeps notebooks: documents under version control that people and AIs write together\. Notebooks: inklog-notebook-test \(the default\), other-notebook\. Call map first/);
    expect(client.getInstructions()).toMatch(/Notebooks here: (inklog-notebook-test \("Inklog notebook test"\), other-notebook \("Other notebook"\)|other-notebook \("Other notebook"\), inklog-notebook-test \("Inklog notebook test"\))\. Tools work in inklog-notebook-test unless you pass `notebook`\. To make a new one, use create_notebook\.$/);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['map', 'read', 'search', 'changes', 'patch', 'commit', 'compare', 'history', 'organize', 'create_notebook']);
    for (const tool of tools) expect(Object.hasOwn(tool.inputSchema.properties ?? {}, 'notebook')).toBe(tool.name !== 'create_notebook');

    expect(text(await client.callTool({ name: 'map', arguments: {} }))).toBe('inklog-notebook-test answered map');
    expect(text(await client.callTool({ name: 'read', arguments: { path: 'overview', notebook: 'other-notebook' } }))).toBe('other-notebook answered read');
    const unknown = await client.callTool({ name: 'map', arguments: { notebook: 'inklog-notbook-test' } });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toMatch(/^✗ No notebook "inklog-notbook-test"\. The notebooks here are: (inklog-notebook-test, other-notebook|other-notebook, inklog-notebook-test)\.$/);
    // A title finds its notebook too, as Claude may say it.
    expect(text(await client.callTool({ name: 'map', arguments: { notebook: 'Other notebook' } }))).toBe('other-notebook answered map');
    expect(c.calls).toEqual([
      ['inklog-notebook-test', 'Claude via claude.ai', 'map', {}],
      // One section, as apps sent it before 0.5.0, arrives as the list read takes now.
      ['other-notebook', 'Claude via claude.ai', 'read', { path: ['overview'] }],
      ['other-notebook', 'Claude via claude.ai', 'map', {}],
    ]);

    // GitHub's token was used once, to ask who signed in, and is kept nowhere: the grant holds
    // only how the app's work is credited.
    expect(c.github.requests).toEqual(['POST /login/oauth/access_token', 'GET /user']);
    const grant = (await c.env.OAUTH_PROVIDER.unwrapToken(claude.saved!.access_token))!.grant;
    expect(grant.props).toEqual({ agent: 'Claude via claude.ai' });
    expect(grant.scope).toEqual(['notebook']);
    expect(c.kv.values().join('\n')).not.toContain('ghu_');
  });

  it('keeps Claude connected when its hour-long token is renewed', async () => {
    const c = await cloud();
    const claude = new TestApp();
    const client = await connect(c, claude);
    const first = claude.saved!;
    const renewed = await c.fetch(new URL('/token', ORIGIN), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: first.refresh_token!, client_id: claude.info!.client_id }),
    });
    const tokens = (await renewed.json()) as OAuthTokens;
    expect(tokens.access_token).not.toBe(first.access_token);
    expect(tokens.refresh_token).not.toBe(first.refresh_token);
    claude.saveTokens(tokens);
    expect(text(await client.callTool({ name: 'history', arguments: {} }))).toBe('inklog-notebook-test answered history');
  });

  it('lets Claude sign in with its published identity, and names the site that publishes it', async () => {
    const c = await cloud();
    const identity = 'https://claude.ai/oauth/mcp-client-metadata';
    const published = { client_id: identity, client_name: 'Claude', redirect_uris: [CLAUDE_AI], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
    c.github.use(async (request, next) => (request.url === identity ? Response.json(published, { headers: { 'cache-control': 'max-age=300' } }) : next(request)));
    const claude = new TestApp('Claude', CLAUDE_AI, identity);
    const { html } = await startConnecting(c, claude);
    expect(claude.info?.client_id).toBe(identity);
    expect(html).toContain('It is published by <strong>claude.ai</strong>.');
    const client = await connect(c, claude);
    await client.callTool({ name: 'map', arguments: {} });
    expect(c.calls).toEqual([['inklog-notebook-test', 'Claude via claude.ai', 'map', {}]]);
    expect(c.kv.keys().filter((key) => key.startsWith('client:'))).toEqual([]);
  });

  it('lets in no other GitHub account, even one that took over the name OctoCat', async () => {
    for (const account of [{ id: 1234, login: 'someone-else' }, { id: 5678, login: 'OctoCat' }]) {
      const c = await cloud();
      c.github.signedIn = account;
      const { browser, html } = await startConnecting(c, new TestApp());
      const { back } = await continueToGitHub(c, browser, html);
      expect(back.status).toBe(403);
      expect(back.headers.get('location')).toBeNull();
      expect(await back.text()).toContain(`Only OctoCat can. You signed in to GitHub as ${account.login}.`);
      expect(c.kv.keys().filter((key) => key.startsWith('grant:'))).toEqual([]);
    }
  });

  it('refuses a consent form sent from another browser, so no site can click Continue for the owner', async () => {
    const c = await cloud();
    const { html } = await startConnecting(c, new TestApp());
    const elsewhere = await new Browser(c).submit(html, 'approve');
    expect(elsewhere.status).toBe(400);
    expect(elsewhere.headers.get('location')).toBeNull();
    expect(await elsewhere.text()).toContain('This authorization was not started in this browser. Connect again from the app.');
  });

  it('refuses a return from GitHub in another browser, so a sign-in link someone sends the owner is useless', async () => {
    const c = await cloud();
    const { browser, html } = await startConnecting(c, new TestApp());
    const toGitHub = await browser.submit(html, 'approve');
    const back = await new Browser(c).open(c.github.authorize(new URL(toGitHub.headers.get('location')!)));
    expect(back.status).toBe(400);
    expect(back.headers.get('location')).toBeNull();
    expect(c.github.requests).toEqual([]);
  });

  it('sends Claude back with access_denied when the owner cancels, here or at GitHub', async () => {
    const c = await cloud();
    const first = await startConnecting(c, new TestApp());
    const cancelled = await first.browser.submit(first.html, 'deny');
    expect(cancelled.status).toBe(302);
    expect(new URL(cancelled.headers.get('location')!).searchParams.get('error')).toBe('access_denied');

    const second = await startConnecting(c, new TestApp());
    const toGitHub = new URL((await second.browser.submit(second.html, 'approve')).headers.get('location')!);
    const back = await second.browser.open(`${ORIGIN}/callback?error=access_denied&state=${toGitHub.searchParams.get('state')}`);
    expect(back.status).toBe(302);
    const toClaude = new URL(back.headers.get('location')!);
    expect(toClaude.origin + toClaude.pathname).toBe(CLAUDE_AI);
    expect(toClaude.searchParams.get('error')).toBe('access_denied');
    expect(c.github.requests).toEqual([]);
  });

  it('credits Claude Code, and warns that access goes to an app on this computer', async () => {
    const c = await cloud();
    const claude = new TestApp('Claude Code (quillipi)', 'http://localhost:54123/callback');
    const { html } = await startConnecting(c, claude);
    expect(html).toContain('Access will be sent to <strong>localhost</strong>.');
    expect(html).toContain('Access goes to an app on this computer, such as Claude Code, Codex or Cursor.');
    const client = await connect(c, claude);
    await client.callTool({ name: 'map', arguments: {} });
    expect(c.calls).toEqual([['inklog-notebook-test', 'Claude via Claude Code', 'map', {}]]);
  });

  it('shows the name an app gives itself as text, never as page code', async () => {
    const c = await cloud();
    const { html } = await startConnecting(c, new TestApp('<img src=x onerror=alert(1)>\n  Tool'));
    expect(html).toContain('<strong>&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('The app gave this name itself, so Quillipi can’t check it.');
  });

  it('says so when GitHub refuses the sign-in', async () => {
    const c = await cloud({ GITHUB_CLIENT_SECRET: 'an-old-secret' });
    const { browser, html } = await startConnecting(c, new TestApp());
    const { back } = await continueToGitHub(c, browser, html);
    expect(back.status).toBe(502);
    expect(await back.text()).toContain('The client_id and/or client_secret passed are incorrect.');
  });

  it('tells Claude to wait while Quillipi is not set up, and /status names what is missing', async () => {
    for (const missing of ['GITHUB_CLIENT_SECRET', 'GITHUB_USER_LOGIN', 'OWNER_EMAIL'] as const) {
      const c = await cloud({ [missing]: undefined });
      const page = await c.fetch(`${ORIGIN}/authorize?response_type=code&client_id=anything`);
      expect(page.status, missing).toBe(503);
      expect(await page.text()).toContain('Its owner sets it up first, by opening Quillipi’s address in a browser. Then connect again.');
      expect(await (await c.fetch(`${ORIGIN}/status`)).json()).toMatchObject({ setup: 'not done' });
    }
    expect(await (await (await cloud({ GITHUB_CLIENT_SECRET: undefined })).fetch(`${ORIGIN}/status`)).json()).toMatchObject({ signIn: 'not set up: GITHUB_CLIENT_SECRET missing' });
  });

  it('lists the connected apps on the Agents page, and Disconnect ends one for good', async () => {
    const c = await cloud();
    c.github.callbacks.push(`${ORIGIN}/signin/callback`);
    const claude = new TestApp();
    const client = await connect(c, claude);
    await connect(c, new TestApp('Claude Code', 'http://localhost:42421/callback'));

    // The owner's browser signs in to the app.
    const browser = new Browser(c);
    const toGitHub = await browser.open(new URL('/signin', ORIGIN), { method: 'POST', body: new URLSearchParams({ next: '/agents' }) });
    await browser.open(c.github.authorize(new URL(toGitHub.headers.get('location')!)));
    const { connections } = (await (await browser.open(new URL('/api/agents', ORIGIN))).json()) as { connections: { id: string; app: string; since: number }[] };
    expect(connections.map((connection) => connection.app).sort()).toEqual(['Claude via Claude Code', 'Claude via claude.ai']);
    expect(connections.every((connection) => Math.abs(connection.since - Date.now()) < 60_000)).toBe(true);

    const web = connections.find((connection) => connection.app === 'Claude via claude.ai')!;
    const disconnect = (origin: string) =>
      browser.open(new URL('/api/agents/disconnect', ORIGIN), { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ id: web.id }) });
    expect((await disconnect('https://evil.example')).status).toBe(403);
    expect((await disconnect(ORIGIN)).status).toBe(200);
    const after = (await (await browser.open(new URL('/api/agents', ORIGIN))).json()) as { connections: { app: string }[] };
    expect(after.connections.map((connection) => connection.app)).toEqual(['Claude via Claude Code']);
    // Its token no longer opens the door.
    await expect(client.callTool({ name: 'map', arguments: {} })).rejects.toThrow();
    expect(await c.env.OAUTH_PROVIDER.unwrapToken(claude.saved!.access_token)).toBeNull();
  });

  it('notes the first connection for Home’s Get started card, and finds a connection made before the note existed', async () => {
    const c = await cloud();
    c.github.callbacks.push(`${ORIGIN}/signin/callback`);
    expect(c.notebooks.library.aiConnected()).toBe(false);
    await connect(c);
    expect(c.notebooks.library.aiConnected()).toBe(true);

    // A Quillipi whose Claude connected before first connections were noted: its grants are there, but the note isn't.
    const before = await cloud();
    before.github.callbacks.push(`${ORIGIN}/signin/callback`);
    (before.env as { OAUTH_KV: unknown }).OAUTH_KV = c.kv;
    const browser = new Browser(before);
    const home = async () => ((await (await browser.open(new URL('/api/home', ORIGIN))).json()) as { aiConnected: boolean }).aiConnected;
    const toGitHub = await browser.open(new URL('/signin', ORIGIN), { method: 'POST', body: new URLSearchParams({ next: '/' }) });
    await browser.open(before.github.authorize(new URL(toGitHub.headers.get('location')!)));
    const listed = () => c.kv.lists;
    expect(await home()).toBe(true);
    expect(before.notebooks.library.aiConnected()).toBe(true);
    // Found once; after that the note answers, with no list of grants from Workers KV.
    const lists = listed();
    expect(await home()).toBe(true);
    expect(listed()).toBe(lists);

    // A new Quillipi, where Claude has never connected, says so.
    const fresh = await cloud();
    fresh.github.callbacks.push(`${ORIGIN}/signin/callback`);
    const newcomer = new Browser(fresh);
    const out = await newcomer.open(new URL('/signin', ORIGIN), { method: 'POST', body: new URLSearchParams({ next: '/' }) });
    await newcomer.open(fresh.github.authorize(new URL(out.headers.get('location')!)));
    expect(((await (await newcomer.open(new URL('/api/home', ORIGIN))).json()) as { aiConnected: boolean }).aiConnected).toBe(false);
  });

  it('asks the library for no settings when the Worker holds them all', async () => {
    const c = await cloud();
    const client = await connect(c);
    await client.callTool({ name: 'map', arguments: {} });
    expect(c.notebooks.settingsAsked).toBe(0);
  });

  it('connects with the non-secret settings kept in the library and only secrets in the Worker, as after S3', async () => {
    const full = await cloud();
    const onlySecrets = Object.fromEntries(SETTINGS.filter((name) => !SECRETS.has(name)).map((name) => [name, undefined])) as Partial<Env>;
    const c = await cloud(onlySecrets);
    // The copy the library made while the Worker still had its variables.
    c.notebooks.library.keepSettings(Object.fromEntries(SETTINGS.map((name) => [name, full.env[name]])));
    const claude = new TestApp();
    const { transport, browser, html } = await startConnecting(c, claude);
    expect(html).toContain('GitHub then checks that you are OctoCat.');
    const { github, back } = await continueToGitHub(c, browser, html);
    expect(Object.fromEntries(github.searchParams)).toMatchObject({ client_id: c.github.clientId, redirect_uri: `${ORIGIN}/callback`, login: 'OctoCat' });
    await transport.finishAuth(new URL(back.headers.get('location')!).searchParams.get('code')!);
    const client = new Client({ name: 'claude-ai', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(MCP, { authProvider: claude, fetch: c.fetch }));
    expect(text(await client.callTool({ name: 'map', arguments: { notebook: 'other-notebook' } }))).toBe('other-notebook answered map');
    expect(c.calls).toEqual([['other-notebook', 'Claude via claude.ai', 'map', {}]]);
    expect(c.notebooks.settingsAsked).toBeGreaterThan(0);
  });

  it('lets a stranger start only so many sign-ins, writes nothing for a refused one, and never limits the owner (audit, 2026-11-20)', async () => {
    const c = await cloud();
    const from = (ip: string) => ({ 'cf-connecting-ip': ip, 'content-type': 'application/json' });
    const register = (ip: string) =>
      c.fetch(new URL('/register', ORIGIN), { method: 'POST', headers: from(ip), body: JSON.stringify({ client_name: 'Flood', redirect_uris: ['https://evil.example/cb'], token_endpoint_auth_method: 'none' }) });
    for (let i = 0; i < PER_VISITOR; i++) expect((await register('203.0.113.7')).status).toBe(201);
    const writes = c.kv.puts;
    const refused = await register('203.0.113.7');
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await refused.json()).toMatchObject({ error: 'temporarily_unavailable' });
    const page = await c.fetch(new URL('/authorize?client_id=x', ORIGIN), { headers: from('203.0.113.7') });
    expect(page.status).toBe(429);
    expect(await page.text()).toContain('Apps already connected keep working.');
    expect(c.kv.puts).toBe(writes);
    // Another visitor isn't held up.
    expect((await register('198.51.100.2')).status).toBe(201);
    // The owner, signed in to the app in this browser, connects from the very same network.
    const claude = new TestApp();
    const transport = new StreamableHTTPClientTransport(MCP, { authProvider: claude, fetch: (input, init) => c.fetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), 'cf-connecting-ip': '198.51.100.2' } }) });
    await expect(new Client({ name: 'claude-ai', version: '1.0.0' }).connect(transport)).rejects.toThrow(UnauthorizedError);
    const owner = (await sessionCookie({ user: '583231', login: 'OctoCat' }, c.env)).split(';')[0]!;
    const consent = await c.fetch(claude.authorizationUrl!, { headers: { cookie: owner, 'cf-connecting-ip': '203.0.113.7' } });
    expect(consent.status).toBe(200);
  });

  it('answers only POST at /mcp, even with a token', async () => {
    const c = await cloud();
    const claude = new TestApp();
    await connect(c, claude);
    const response = await c.fetch(MCP, { headers: { authorization: `Bearer ${claude.saved!.access_token}` } });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });
});
