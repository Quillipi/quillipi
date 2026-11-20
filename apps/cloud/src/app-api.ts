/**
 * The app's calls under /api, for a browser signed in with its session cookie (session.ts):
 *
 * - Home and the library: GET /api/home (everything Home draws, in one request, with whether
 *   Claude has connected yet), POST
 *   /api/notebooks (New notebook), archiving, the default notebook, and /api/library/ws, Home's
 *   live connection to the library.
 * - Agents: the apps connected to Claude's door, disconnecting one, and the owner's AI instructions
 *   for every notebook (GET and POST /api/instructions), which no agent tool can change.
 * - Quillipi's settings, as the owner may see them (GET /api/settings): where each comes from, and
 *   no secret's value.
 * - A notebook's own calls, files and live editor connection, /api/n/<id>/…, which go to its room
 *   (notebook-object.ts), where the same EditorApi as on the laptop answers them.
 *
 * Calls that change something, and live connections, must come from Quillipi's own address: the
 * cookie alone would let another site's form or script act for the owner.
 */
import { type AgentConnection, type HomeData, type Me, estimateTokens } from '@inklog/core';
import { library } from './door.js';
import type { Env, Served } from './env.js';
import { type Session, readSession } from './session.js';

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };

export async function appApi(request: Request, env: Served): Promise<Response> {
  const signedIn = await readSession(request, env);
  if (!signedIn) return json({ error: 'Sign in to Quillipi first.', signIn: '/signin' }, 401);
  const url = new URL(request.url);
  const changing = !['GET', 'HEAD'].includes(request.method) || request.headers.get('upgrade') !== null;
  if (changing && request.headers.get('origin') !== new URL(env.PUBLIC_URL).origin) return json({ error: 'This call must come from Quillipi itself.' }, 403);

  let response: Response;
  try {
    response = await route(request, url, env, signedIn.session);
  } catch (error) {
    // Refusals from the library (a taken title, the daily limit) are the person's to fix.
    response = json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
  // A session in use stays signed in: its cookie is renewed at most once a day. A live connection's answer can't carry it.
  if (signedIn.renew && response.status !== 101) {
    response = new Response(response.body, response);
    response.headers.append('set-cookie', signedIn.renew);
  }
  return response;
}

/** `session` is the one account let in: its ID is the owner's (readSession checked it). */
async function route(request: Request, url: URL, env: Env, { user, login }: Session): Promise<Response> {
  const path = url.pathname;
  const method = request.method;
  // Both are set once Quillipi is set up; until then the GitHub name stands in for the owner's.
  const me: Me = { login, name: env.OWNER_NAME ?? login, github: env.GITHUB_OWNER ?? '' };

  if (path.startsWith('/api/n/')) return notebookCall(request, path, env);
  if (path === '/api/library/ws') {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'Open this as a WebSocket.' }, 426);
    return library(env).fetch(request);
  }
  switch (`${method} ${path}`) {
    case 'GET /api/me':
      return json(me);
    case 'GET /api/home': {
      const shelf = library(env);
      // Opening Home is a visit; its answer says when the one before was, for "since your last visit".
      const [cards, lastVisit, directory, claudeConnected] = await Promise.all([shelf.cards(), shelf.visit(login), shelf.directory(), connected(env, user)]);
      return json({ me, cards, ...(lastVisit ? { lastVisit } : {}), ...(directory.default ? { default: directory.default } : {}), claudeConnected } satisfies HomeData);
    }
    case 'GET /api/notebooks': {
      const cards = await library(env).cards();
      return json({ notebooks: cards.filter((card) => !card.archived).map((card) => ({ id: card.id, name: card.title })) });
    }
    case 'POST /api/notebooks': {
      const { title, about, colour, github } = await body<{ title?: unknown; about?: unknown; colour?: unknown; github?: unknown }>(request);
      // A notebook whose repo is already in the organization, imported in the background on first use.
      if (typeof github === 'string') return json((await library(env).add({ repo: github, by: me.name })).card);
      const card = await library(env).create({
        title: String(title ?? ''),
        ...(typeof about === 'string' && about.trim() ? { about } : {}),
        ...(typeof colour === 'string' ? { colour } : {}),
        by: me.name,
      });
      return json(card);
    }
    case 'POST /api/default': {
      const { id } = await body<{ id?: unknown }>(request);
      await library(env).setDefault(String(id ?? ''));
      return json({ ok: true });
    }
    // The owner's AI instructions for every notebook, which every AI gets before a notebook's own.
    case 'GET /api/instructions': {
      const text = await library(env).instructions();
      return json({ text, tokens: estimateTokens(text) });
    }
    case 'POST /api/instructions': {
      const { text } = await body<{ text?: unknown }>(request);
      if (typeof text !== 'string') throw new Error('Send the instructions as text.');
      await library(env).setInstructions(text);
      return json({ ok: true });
    }
    case 'GET /api/agents':
      return json({ connections: await connections(env, user) });
    case 'POST /api/agents/disconnect': {
      const { id } = await body<{ id?: unknown }>(request);
      await env.OAUTH_PROVIDER.revokeGrant(String(id ?? ''), user);
      return json({ ok: true });
    }
    case 'GET /api/settings':
      return json({ settings: await library(env).settingsView() });
  }
  const archive = /^\/api\/notebooks\/([^/]+)\/archive$/.exec(path);
  if (archive && method === 'POST') {
    const { archived } = await body<{ archived?: unknown }>(request);
    return json(await library(env).archive(decodeURIComponent(archive[1]!), archived !== false));
  }
  return json({ error: 'Not found.' }, 404);
}

/** A call to one notebook goes to its room, only when the library has it, so an unknown name makes nothing. */
async function notebookCall(request: Request, path: string, env: Env): Promise<Response> {
  const [encoded] = path.slice('/api/n/'.length).split('/');
  let id: string;
  try {
    id = decodeURIComponent(encoded ?? '');
  } catch {
    return json({ error: 'Not found.' }, 404);
  }
  if (!(await library(env).card(id))) return json({ error: `No notebook "${id}".` }, 404);
  return env.NOTEBOOK.get(env.NOTEBOOK.idFromName(id)).fetch(request);
}

/**
 * Whether Claude has connected at least once, for Home's Get started card. Sign-in notes it in the
 * library (sign-in.ts); a Quillipi whose Claude connected before that note existed is found once by
 * its grants, then noted, so Workers KV's daily list requests are spent only until Claude connects.
 */
async function connected(env: Env, user: string): Promise<boolean> {
  const shelf = library(env);
  if (await shelf.claudeConnected()) return true;
  const { items } = await env.OAUTH_PROVIDER.listUserGrants(user, { limit: 1 });
  if (!items.length) return false;
  await shelf.noteClaudeConnected();
  return true;
}

/**
 * The apps connected to Claude's door, newest first. Their names were kept with each grant since
 * step 3.4a; for an older grant the app's record names it, or the site its published identity is on.
 */
async function connections(env: Env, user: string): Promise<AgentConnection[]> {
  const oauth = env.OAUTH_PROVIDER;
  const found: AgentConnection[] = [];
  let cursor: string | undefined;
  do {
    const page = await oauth.listUserGrants(user, { limit: 100, ...(cursor ? { cursor } : {}) });
    for (const grant of page.items) {
      const kept = (grant.metadata as { agent?: unknown } | undefined)?.agent;
      found.push({ id: grant.id, app: typeof kept === 'string' ? kept : await appName(env, grant.clientId), since: grant.createdAt * 1000 });
    }
    cursor = page.cursor;
  } while (cursor);
  return found.sort((a, b) => b.since - a.since);
}

async function appName(env: Env, clientId: string): Promise<string> {
  if (/^https:\/\//.test(clientId)) return new URL(clientId).hostname;
  try {
    return (await env.OAUTH_PROVIDER.lookupClient(clientId))?.clientName || 'An app';
  } catch {
    return 'An app';
  }
}

async function body<T>(request: Request): Promise<T> {
  const value: unknown = await request.json().catch(() => undefined);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Send a JSON object.');
  return value as T;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, 'content-type': 'application/json; charset=utf-8' } });
}
