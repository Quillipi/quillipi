/**
 * The door: /mcp, where every AI app connects, which workers-oauth-provider opens only with a
 * token from sign-in. Each request gets a fresh MCP server on the SDK's web-standard transport,
 * stateless with plain JSON replies, as on the laptop, so nothing is kept between requests. One
 * address serves every notebook: each tool takes `notebook`, the library (library.ts) says which
 * room that is, and the call goes to that notebook's Durable Object. The door has one tool of its
 * own, create_notebook.
 */
import { createMcpServer, instructions } from '@inklog/engine';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import pkg from '../package.json';
import type { Env } from './env.js';
import { type Directory, LIBRARY_NAME, MAX_TITLE } from './library.js';

/** What sign-in stores with an app's grant, and the door gets with each of its requests. */
export interface DoorProps {
  /** How the app's work is credited, such as "Claude via claude.ai" or "ChatGPT". */
  agent: string;
}

/**
 * Making a notebook from a chat. Kept short: tool definitions ride along in every step of a chat.
 * The app's New notebook runs the same code in the library.
 */
export const CREATE_NOTEBOOK = {
  title: 'New notebook',
  description:
    "Make a new notebook, ready at once, with its own private GitHub repo made in the background. Returns its ID, which other tools take as `notebook`, and its map. With `github`, add a notebook whose repo is already in the notebooks' GitHub organization instead.",
  schema: {
    title: z.string().max(MAX_TITLE).optional().describe('Such as "Gym rollup"'),
    about: z.string().max(300).optional().describe('One line on what it is for'),
    github: z.string().optional().describe("A repo's name, to add instead of making one"),
  },
  readOnly: false,
};

/** The part of an app's first request, `initialize`, that says which app it is and which version of MCP it speaks. */
interface Opening {
  protocolVersion?: unknown;
  clientInfo?: { name?: unknown; version?: unknown; title?: unknown };
}

export const door = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== 'POST') return Response.json({ error: 'Use POST.' }, { status: 405, headers: { allow: 'POST' } });
    const { agent } = ctx.props as DoorProps;
    const opening = await openingOf(request);
    // The list of notebooks goes in the instructions, which an app reads once, when it connects.
    let text = instructions();
    if (opening) {
      text = await instructionsFor(env);
      // One line per connection, so Cloudflare's logs show which app came, as what, and how.
      console.log(`Connected: ${agent}, as ${describeApp(opening)}.`);
    }
    const server = createMcpServer({ call: (tool, args, by) => callTool(env, by, tool, args) }, pkg.version, {
      agent: () => agent,
      instructions: text,
      extraArgs: { notebook: z.string().optional() },
      tools: { create_notebook: CREATE_NOTEBOOK },
      // Each copy's own icon, from the app's files, which Cloudflare serves to anyone.
      icon: new URL('/icons/icon-192.png', request.url).href,
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(acceptingJson(request));
  },
} satisfies ExportedHandler<Env>;

export function library(env: Env) {
  return env.LIBRARY.get(env.LIBRARY.idFromName(LIBRARY_NAME));
}

/** Runs a tool: create_notebook in the library, any other in its notebook's room. `notebook` belongs to the door, not to the tool. */
export async function callTool(env: Env, agent: string, tool: string, args: unknown): Promise<string> {
  if (tool === 'create_notebook') return createNotebook(env, agent, (args ?? {}) as { title?: string; about?: string; github?: string });
  const { notebook, ...toolArgs } = (args ?? {}) as { notebook?: string };
  // map names the notebooks, so an app that kept the instructions from when it connected still learns of new ones.
  const { id, shared, directory } = await library(env).route(notebook, tool === 'map');
  return room(env, id).runTool(id, agent, tool, toolArgs, { shared, directory });
}

async function createNotebook(env: Env, agent: string, { title, about, github }: { title?: string; about?: string; github?: string }): Promise<string> {
  if (github !== undefined) {
    const { card, status } = await library(env).add({ repo: github, by: agent, byAgent: true });
    return `Added notebook ${card.id} from GitHub. ${status} Tools wait until the import is done; pass notebook: "${card.id}".`;
  }
  if (!title?.trim()) throw new Error('Give the new notebook a title, or `github` to add one from GitHub.');
  const card = await library(env).create({ title, ...(about ? { about } : {}), by: agent, byAgent: true });
  const { shared, directory } = await library(env).route(card.id, true);
  // Its map and its About section come with the reply, so the AI can write at once without another call.
  const map = await room(env, card.id).runTool(card.id, agent, 'map', { read: ['about'] }, { shared, directory });
  // The room has a GitHub mirror only with the App, its key and the organization (notebook-object.ts).
  const backup =
    env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_OWNER
      ? `Its private GitHub repo ${env.GITHUB_OWNER}/${card.id} is being made in the background.`
      : 'It isn’t backed up to GitHub: the GitHub App isn’t set up here.';
  return `Made notebook "${card.title}" with the ID ${card.id}. Pass notebook: "${card.id}" to the other tools. ${backup}\n\n${map}`;
}

function room(env: Env, id: string) {
  return env.NOTEBOOK.get(env.NOTEBOOK.idFromName(id));
}

/** The instructions with the notebooks there are: their IDs in the first paragraph, which some apps read alone, and their titles at the end. */
async function instructionsFor(env: Env): Promise<string> {
  const directory = await library(env).directory();
  const text = instructions(notebooksOf(directory));
  if (!directory.notebooks.length) return `${text}\n\nMake a notebook with create_notebook.`;
  const list = directory.notebooks.map((notebook) => `${notebook.id} ("${notebook.title}")`).join(', ');
  return `${text}\n\nNotebooks here: ${list}. Tools work in ${directory.default} unless you pass \`notebook\`. To make a new one, use create_notebook.`;
}

function notebooksOf({ notebooks, default: fallback }: Directory) {
  return { ids: notebooks.map((notebook) => notebook.id), ...(fallback ? { fallback } : {}) };
}

/** An app's `initialize`, which opens a connection and is answered with the instructions; undefined for any other request. */
async function openingOf(request: Request): Promise<Opening | undefined> {
  try {
    const body: unknown = await request.clone().json();
    const first = (Array.isArray(body) ? body : [body]).find((message) => (message as { method?: unknown } | null)?.method === 'initialize') as { params?: Opening } | undefined;
    return first && (first.params ?? {});
  } catch {
    return undefined;
  }
}

/** How an app introduced itself, such as "codex-mcp-client 0.98.0 (Codex), MCP 2025-06-18". Its words are its own, so each is cut short and kept to one line. */
function describeApp({ clientInfo, protocolVersion }: Opening): string {
  const said = (value: unknown) => String(value ?? '?').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').slice(0, 80);
  const title = clientInfo?.title === undefined ? '' : ` (${said(clientInfo.title)})`;
  return `${said(clientInfo?.name)} ${said(clientInfo?.version)}${title}, MCP ${said(protocolVersion)}`;
}

/**
 * The door answers only in plain JSON, so a request need not offer event streams too. The SDK
 * refuses one that doesn't with 406, and some apps send only `Accept: application/json`.
 */
function acceptingJson(request: Request): Request {
  const accept = request.headers.get('accept') ?? '';
  if (accept.includes('application/json') && accept.includes('text/event-stream')) return request;
  const headers = new Headers(request.headers);
  headers.set('accept', 'application/json, text/event-stream');
  return new Request(request, { headers });
}
