import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import pkg from '../package.json';
import worker from '../src/index.js';
import { FakeCloud } from './fake-cloud.js';
import { FakeKV } from './fake-kv.js';

const ORIGIN = 'https://quillipi.example.workers.dev';
const env = {
  PUBLIC_URL: ORIGIN,
  COMMIT: 'abc1234',
  OWNER_NAME: 'The Octocat',
  OWNER_EMAIL: 'k@example.com',
  GITHUB_OWNER: 'octo-notebooks',
  GITHUB_CLIENT_ID: 'Iv23liTESTCLIENT',
  GITHUB_USER_ID: '583231',
  GITHUB_USER_LOGIN: 'OctoCat',
  ...new FakeCloud().bindings,
  OAUTH_KV: new FakeKV(),
} as Record<string, unknown>;

/** The cloud with two notebooks, whose rooms answer with who they are. */
async function withNotebooks(): Promise<{ env: Record<string, unknown>; cloud: FakeCloud }> {
  const cloud = new FakeCloud({ answer: (id, _agent, tool) => `${id} answered ${tool}` });
  await cloud.library.create({ title: 'Inklog notebook test', by: 'The Octocat' });
  await cloud.library.create({ title: 'Other', by: 'The Octocat' });
  return { env: { ...env, ...cloud.bindings, DEV_ROUTES: 'on' }, cloud };
}

async function get(path: string, method = 'GET', on = env, body?: string): Promise<Response> {
  const context = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
  return worker.fetch(new Request(`${ORIGIN}${path}`, { method, body }), on as never, context);
}

describe('the cloud front door', () => {
  it('reports its status, version and live commit', async () => {
    const response = await get('/status');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const status = (await response.json()) as Record<string, unknown>;
    expect(status).toMatchObject({ service: 'Quillipi', ok: true, version: pkg.version, commit: 'abc1234', notebooks: 'ok', github: 'not set up', signIn: 'not set up: GITHUB_CLIENT_SECRET missing', app: 'not set up: GITHUB_CLIENT_SECRET missing' });
    expect(await (await get('/status', 'GET', { ...env, GITHUB_CLIENT_SECRET: 'a secret' })).json()).toMatchObject({ signIn: 'ready' });
    expect(Date.parse(String(status.time))).not.toBeNaN();
  });

  it('serves only its own address', async () => {
    const context = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
    const elsewhere = await worker.fetch(new Request('http://127.0.0.1:8787/status'), env as never, context);
    expect(elsewhere.status).toBe(421);
    expect(await elsewhere.json()).toEqual({ error: `This address is not served here. Quillipi's address is ${ORIGIN}.` });
  });

  it('leaves the app’s pages to the static assets, which Cloudflare serves before the Worker', async () => {
    // In production, / and /n/… never reach the Worker (wrangler.jsonc, run_worker_first).
    expect((await get('/')).status).toBe(404);
    expect((await get('/nothing')).status).toBe(404);
  });

  it('asks for sign-in at /mcp, and tells apps how to sign in', async () => {
    const door = await get('/mcp', 'POST', env, '{}');
    expect(door.status).toBe(401);
    expect(door.headers.get('www-authenticate')).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
    expect(door.headers.get('www-authenticate')).toContain('scope="notebook"');

    const resource = await (await get('/.well-known/oauth-protected-resource/mcp')).json();
    expect(resource).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN], scopes_supported: ['notebook'], resource_name: 'Quillipi' });
    const server = await (await get('/.well-known/oauth-authorization-server')).json();
    expect(server).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/authorize`,
      token_endpoint: `${ORIGIN}/token`,
      registration_endpoint: `${ORIGIN}/register`,
      code_challenge_methods_supported: ['S256'],
      // offline_access is the authorization server's to grant, not a scope the door needs (sign-in.ts).
      scopes_supported: ['notebook', 'offline_access'],
    });
  });

  it('accepts only GET and HEAD', async () => {
    const response = await get('/status', 'POST');
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
    expect((await get('/status', 'HEAD')).status).toBe(200);
  });

  it("says when the library's storage fails", async () => {
    const broken = { ...env, LIBRARY: { idFromName: (name: string) => name, get: () => ({ ping: async () => Promise.reject(new Error('down')) }) } as never };
    expect(await (await get('/status', 'GET', broken)).json()).toMatchObject({ notebooks: 'failing: down' });
  });

  it('has the hand-run tool route only under wrangler dev, going through the library as the door does', async () => {
    const body = JSON.stringify({ tool: 'map' });
    expect((await get('/dev/tool', 'POST', env, body)).status).toBe(405);
    expect((await get('/dev/tool')).status).toBe(404);
    const none = await get('/dev/tool', 'POST', { ...env, DEV_ROUTES: 'on' }, body);
    expect(await none.text()).toBe('✗ There are no notebooks yet. Make one with create_notebook.\n');
    const { env: dev, cloud } = await withNotebooks();
    expect(await (await get('/dev/tool', 'POST', dev, body)).text()).toBe('inklog-notebook-test answered map\n');
    expect(await (await get('/dev/tool', 'POST', dev, JSON.stringify({ tool: 'read', notebook: 'other', args: { path: 'about' } }))).text()).toBe('other answered read\n');
    expect(cloud.calls).toEqual([
      ['inklog-notebook-test', 'Someone by hand', 'map', {}],
      ['other', 'Someone by hand', 'read', { path: 'about' }],
    ]);
    const unknown = await get('/dev/tool', 'POST', dev, JSON.stringify({ tool: 'map', notebook: 'nope' }));
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).toMatch(/^✗ No notebook "nope"\. The notebooks here are: (inklog-notebook-test, other|other, inklog-notebook-test)\.\n$/);
    const cards = (await (await get('/dev/library', 'GET', dev)).json()) as { id: string }[];
    expect(cards.map((card) => card.id).sort()).toEqual(['inklog-notebook-test', 'other']);
    expect((await get('/dev/library')).status).toBe(404);
  });

  it('says whether the GitHub App can be used, without calling GitHub or showing the key', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const ready = { ...env, GITHUB_APP_ID: '1234567', GITHUB_APP_PRIVATE_KEY: privateKey };
    expect(await (await get('/status', 'GET', ready)).json()).toMatchObject({ github: 'ready' });
    const broken = await (await get('/status', 'GET', { ...ready, GITHUB_APP_PRIVATE_KEY: 'oops-secret-text' })).text();
    expect(broken).toContain('"github": "failing: GITHUB_APP_PRIVATE_KEY is not a private key');
    expect(broken).not.toContain('oops-secret-text');
  });

  it('has the status and mirror routes only under wrangler dev', async () => {
    expect((await get('/dev/status')).status).toBe(404);
    expect((await get('/dev/mirror', 'POST', env, '{"action":"retry"}')).status).toBe(405);
    const { env: dev } = await withNotebooks();
    expect(await (await get('/dev/status?notebook=other', 'GET', dev)).json()).toEqual({ exists: true, sections: 1, commits: 1, uncommitted: 0 });
    expect(await (await get('/dev/mirror', 'POST', dev, '{"action":"retry"}')).text()).toBe('No mirror.\n');
    expect((await get('/dev/mirror', 'POST', dev, '{"action":"push"}')).status).toBe(400);
    expect((await get('/dev/mirror', 'GET', dev)).status).toBe(405);
    expect((await get('/dev/nothing', 'GET', dev)).status).toBe(404);
  });
});
