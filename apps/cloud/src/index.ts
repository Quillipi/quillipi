/**
 * Quillipi in the cloud: the always-on home of the notebooks, on Cloudflare.
 *
 * AI apps (Claude, ChatGPT, Codex, Cursor and any other that speaks MCP) connect at /mcp (door.ts)
 * after signing in with GitHub (sign-in.ts). In front of both is workers-oauth-provider: it answers
 * discovery, registers apps, issues tokens and checks the token on every request to /mcp. Each
 * notebook is a Durable Object that runs the engine on its own SQLite database (notebook-object.ts)
 * and mirrors its history to the GitHub repo of the same name (mirror.ts). /status is public, and
 * the /dev/ routes exist only under `wrangler dev`.
 *
 * The app itself (apps/web's built files) is served by Cloudflare as static assets, before this
 * Worker runs; wrangler.jsonc lists the routes that come here first. A browser signs in at /signin
 * (app-sign-in.ts) and then makes the app's calls under /api (app-api.ts).
 *
 * Until Quillipi is set up (settings.ts, isSetUp), the setup at /setup (setup.ts) is the way in: the
 * app's calls and its sign-in lead there.
 *
 * Every request first gets Quillipi's settings (settings.ts): the Worker's own variables and
 * secrets, and from the library whatever they don't hold.
 *
 * The sign-in steps a stranger can start, which write to Workers KV, are limited per visitor and
 * per day (sign-in-limits.ts); the signed-in owner never is.
 */
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import pkg from '../package.json';
import { appApi } from './app-api.js';
import { appSignIn } from './app-sign-in.js';
import { callTool, door, library } from './door.js';
import type { Env, Served } from './env.js';
import { importAppKey } from './github.js';
import { messagePage, pageHeaders } from './pages.js';
import { readSession, sessionStatus } from './session.js';
import { isSetUp, withSettings } from './settings.js';
import { setup } from './setup.js';
import { type Admission, visitorOf } from './sign-in-limits.js';
import { OFFLINE, SCOPE, authorize, callback, signInStatus, supportedRegistration } from './sign-in.js';

export { LibraryObject } from './library-object.js';
export { NotebookObject } from './notebook-object.js';
export type { Env } from './env.js';

/** A connection unused for this long must sign in again, as on the laptop. */
const REFRESH_TOKEN_LIFETIME = 90 * 24 * 60 * 60;

const HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

/** Sign-in for PUBLIC_URL, made on the first request, which is when the settings arrive. */
let signIn: { origin: string; provider: OAuthProvider<Served> } | undefined;

export default {
  async fetch(request, raw, ctx) {
    const reached = new URL(request.url).origin;
    const env = await served(raw, reached);
    const origin = new URL(env.PUBLIC_URL).origin;
    // Tokens are bound to one address, and the provider keeps its helpers on `env`, which
    // Cloudflare reuses between requests. So there is one address, and others are refused.
    if (reached !== origin) return json({ error: `This address is not served here. Quillipi's address is ${origin}.` }, 421);
    if (signIn?.origin !== origin) signIn = { origin, provider: signInFor(origin) };
    const refused = await limitSignIn(request, env);
    if (refused) return refused;
    const registering = request.method === 'POST' && new URL(request.url).pathname === '/register';
    return signIn.provider.fetch(registering ? await supportedRegistration(request) : request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

/**
 * Registering an app and the consent page write to Workers KV, so a stranger may start only so
 * many (sign-in-limits.ts). The owner, signed in to the app in this browser, is never limited.
 * If the library can't be asked, the sign-in goes ahead: the owner getting in matters more.
 */
async function limitSignIn(request: Request, env: Served): Promise<Response | undefined> {
  const { pathname } = new URL(request.url);
  const limited = (pathname === '/register' && request.method === 'POST') || pathname === '/authorize';
  if (!limited || (await readSession(request, env))) return undefined;
  let admission: Admission;
  try {
    admission = await library(env).admitSignIn(visitorOf(request));
  } catch (error) {
    console.error('Could not check the sign-in limits; letting this one through:', error);
    return undefined;
  }
  if (admission.admitted) return undefined;
  console.warn(`Sign-in refused: too many ${admission.reason === 'day' ? 'today' : 'from one visitor'}.`);
  const wait = admission.reason === 'day' ? 'after midnight UTC' : `in ${Math.ceil(admission.retryAfter / 60)} minutes`;
  const text = `Too many sign-ins were started ${admission.reason === 'day' ? 'here today' : 'from your network just now'}, so this one can’t start. Apps already connected keep working. Try again ${wait}.`;
  const retry = { 'retry-after': String(admission.retryAfter) };
  if (pathname === '/register') return json({ error: 'temporarily_unavailable', error_description: text }, 429, retry);
  const headers = pageHeaders();
  headers.set('retry-after', retry['retry-after']);
  return new Response(messagePage('Try again later', text), { status: 429, headers });
}

/**
 * The settings for a request. With no address set anywhere, before the setup, Quillipi serves the
 * one it is reached at: on Cloudflare its own workers.dev address, the only one that reaches it.
 * If the library can't be read, the Worker's own settings are used, and /status says the library
 * is failing.
 */
async function served(raw: Env, reached: string): Promise<Served> {
  const env = await withSettings(raw, () => library(raw).settings()).catch((error: unknown) => {
    console.error('Could not read the settings kept in the library:', error);
    return { ...raw };
  });
  return hasAddress(env) ? env : { ...env, PUBLIC_URL: reached };
}

function hasAddress(env: Env): env is Served {
  return Boolean(env.PUBLIC_URL?.trim());
}

function signInFor(origin: string): OAuthProvider<Served> {
  return new OAuthProvider<Served>({
    apiRoute: '/mcp',
    apiHandler: door,
    defaultHandler: { fetch: front },
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/token',
    clientRegistrationEndpoint: '/register',
    // Apps may also sign in with their published identity (a Client ID Metadata Document), as
    // Claude, ChatGPT, Codex and VS Code can; it needs the global_fetch_strictly_public flag in
    // wrangler.jsonc.
    clientIdMetadataDocumentEnabled: true,
    // An app on the computer may be called back by its own scheme, as Cursor was before July 2026
    // (cursor://…), besides http on this computer and https; the consent page warns of both.
    allowPrivateUseRedirectUris: true,
    scopesSupported: [SCOPE, OFFLINE],
    requiredScopes: [SCOPE],
    resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin], resource_name: 'Quillipi' },
    refreshTokenTTL: REFRESH_TOKEN_LIFETIME,
    refreshTokenIdleTTL: REFRESH_TOKEN_LIFETIME,
  });
}

/** Everything outside /mcp and the provider's own routes. */
async function front(request: Request, env: Served): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  if (pathname.startsWith('/dev/') && env.DEV_ROUTES === 'on') return dev(request, url, env);
  if (pathname === '/authorize') return authorize(request, env);
  if (pathname === '/callback') return callback(request, env);
  if (pathname === '/setup' || pathname.startsWith('/setup/')) return setup(request, env);
  if (pathname === '/signin' || pathname === '/signin/callback' || pathname === '/signout') {
    if (!isSetUp(env)) return toSetup(request);
    return appSignIn(request, env);
  }
  if (pathname.startsWith('/api/')) {
    // The app goes to the setup when it is told to; before it, there is no one to sign in.
    if (!isSetUp(env)) return json({ error: 'Quillipi isn’t set up yet.', setup: '/setup' }, 503);
    return appApi(request, env);
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'Only GET is supported here.' }, 405, { allow: 'GET, HEAD' });
  }
  switch (pathname) {
    case '/status':
      return json({
        service: 'Quillipi',
        ok: true,
        version: pkg.version,
        commit: env.COMMIT,
        notebooks: await libraryHealth(env),
        github: await githubHealth(env),
        setup: isSetUp(env) ? 'done' : 'not done',
        signIn: signInStatus(env),
        app: appStatus(env),
        time: new Date().toISOString(),
      });
    default:
      return json({ error: 'Not found.' }, 404);
  }
}

/** Before the setup, a browser opening a sign-in page is taken to the setup instead. */
function toSetup(request: Request): Response {
  if (request.method === 'GET') return new Response(null, { status: 303, headers: { location: '/setup', 'cache-control': 'no-store' } });
  return json({ error: 'Quillipi isn’t set up yet.', setup: '/setup' }, 503);
}

/** Whether the app's browser sign-in is set up: GitHub's settings and the session secret. */
function appStatus(env: Env): string {
  return [signInStatus(env), sessionStatus(env)].find((status) => status !== 'ready') ?? 'ready';
}

/** Whether the library's Durable Object and its database answer. It shows no notebook names. */
async function libraryHealth(env: Env): Promise<string> {
  try {
    return await library(env).ping();
  } catch (error) {
    return `failing: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Whether the GitHub mirror can run: the GitHub App, its private key, which must be readable, and
 * the organization for notebooks. It checks the key without calling GitHub, so this public page
 * can't be used to spend the App's requests.
 */
async function githubHealth(env: Env): Promise<string> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY || !env.GITHUB_OWNER) return 'not set up';
  try {
    await importAppKey(env.GITHUB_APP_PRIVATE_KEY);
    return 'ready';
  } catch (error) {
    return `failing: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Routes for trying the cloud by hand under `wrangler dev`, without signing in:
 * POST /dev/tool runs a tool as the door would, create_notebook included; GET /dev/status?notebook=
 * shows a notebook and its mirror; POST /dev/mirror {"action": "retry"} lets a stopped or waiting
 * mirror carry on; GET /dev/library shows every card.
 */
async function dev(request: Request, url: URL, env: Env): Promise<Response> {
  const route = url.pathname.slice('/dev/'.length);
  if (route === 'library') return json(await library(env).cards());
  if (!['tool', 'status', 'mirror'].includes(route)) return json({ error: 'Not found.' }, 404);
  let body: { notebook?: string; agent?: string; tool?: string; args?: unknown; action?: string } = {};
  if (route !== 'status') {
    if (request.method !== 'POST') return json({ error: 'POST a JSON body, such as {"tool": "map", "args": {}}.' }, 405, { allow: 'POST' });
    try {
      body = await request.json();
    } catch {
      return json({ error: 'The body is not JSON.' }, 400);
    }
  }
  try {
    if (route === 'tool') {
      if (!body.tool) return json({ error: 'Say which tool, such as {"tool": "map"}.' }, 400);
      const args = body.notebook === undefined ? (body.args ?? {}) : { ...(body.args as object), notebook: body.notebook };
      return text(`${await callTool(env, body.agent ?? 'Someone by hand', body.tool, args)}\n`);
    }
    const { id } = await library(env).route(body.notebook ?? url.searchParams.get('notebook') ?? undefined);
    const stub = env.NOTEBOOK.get(env.NOTEBOOK.idFromName(id));
    if (route === 'status') return json(await stub.status(id));
    if (body.action !== 'retry') return json({ error: 'Say {"action": "retry"}.' }, 400);
    return text(`${await stub.retryMirror(id)}\n`);
  } catch (error) {
    return text(`✗ ${error instanceof Error ? error.message : String(error)}\n`, 400);
  }
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(`${JSON.stringify(body, null, 2)}\n`, { status, headers: { ...HEADERS, 'content-type': 'application/json; charset=utf-8', ...extra } });
}

function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { ...HEADERS, 'content-type': 'text/plain; charset=utf-8' } });
}
