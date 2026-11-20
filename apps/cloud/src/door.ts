/**
 * Claude's door: /mcp, which workers-oauth-provider opens only with a token from sign-in. Each
 * request gets a fresh MCP server on the SDK's web-standard transport, stateless with plain JSON
 * replies, as on the laptop, so nothing is kept between requests. One address serves every
 * notebook: each tool takes `notebook`, the library (library.ts) says which room that is, and the
 * call goes to that notebook's Durable Object. The door has one tool of its own, create_notebook.
 */
import { INSTRUCTIONS, createMcpServer } from '@inklog/engine';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import pkg from '../package.json';
import type { Env } from './env.js';
import { LIBRARY_NAME, MAX_TITLE } from './library.js';

/** What sign-in stores with an app's grant, and the door gets with each of its requests. */
export interface DoorProps {
  /** How the app's work is credited, such as "Claude via claude.ai". */
  agent: string;
}

/**
 * Making a notebook from a chat. Kept short: tool definitions ride along in every step of a chat.
 * The app's New notebook runs the same code in the library.
 */
export const CREATE_NOTEBOOK = {
  description:
    "Make a new notebook, ready at once, with its own private GitHub repo made in the background. Returns its ID, which other tools take as `notebook`, and its map. With `github`, add a notebook whose repo is already in the notebooks' GitHub organization instead.",
  schema: {
    title: z.string().max(MAX_TITLE).optional().describe('Such as "Gym rollup"'),
    about: z.string().max(300).optional().describe('One line on what it is for'),
    github: z.string().optional().describe("A repo's name, to add instead of making one"),
  },
  readOnly: false,
};

export const door = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== 'POST') return Response.json({ error: 'Use POST.' }, { status: 405, headers: { allow: 'POST' } });
    const { agent } = ctx.props as DoorProps;
    // The list of notebooks goes in the instructions, which Claude reads once, when it connects.
    const instructions = (await connecting(request)) ? await instructionsFor(env) : INSTRUCTIONS;
    const server = createMcpServer({ call: (tool, args, by) => callTool(env, by, tool, args) }, pkg.version, {
      agent: () => agent,
      instructions,
      extraArgs: { notebook: z.string().optional() },
      tools: { create_notebook: CREATE_NOTEBOOK },
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
} satisfies ExportedHandler<Env>;

export function library(env: Env) {
  return env.LIBRARY.get(env.LIBRARY.idFromName(LIBRARY_NAME));
}

/** Runs a tool: create_notebook in the library, any other in its notebook's room. `notebook` belongs to the door, not to the tool. */
export async function callTool(env: Env, agent: string, tool: string, args: unknown): Promise<string> {
  if (tool === 'create_notebook') return createNotebook(env, agent, (args ?? {}) as { title?: string; about?: string; github?: string });
  const { notebook, ...toolArgs } = (args ?? {}) as { notebook?: string };
  const { id, shared } = await library(env).route(notebook);
  return room(env, id).runTool(id, agent, tool, toolArgs, shared);
}

async function createNotebook(env: Env, agent: string, { title, about, github }: { title?: string; about?: string; github?: string }): Promise<string> {
  if (github !== undefined) {
    const { card, status } = await library(env).add({ repo: github, by: agent });
    return `Added notebook ${card.id} from GitHub. ${status} Tools wait until the import is done; pass notebook: "${card.id}".`;
  }
  if (!title?.trim()) throw new Error('Give the new notebook a title, or `github` to add one from GitHub.');
  const card = await library(env).create({ title, ...(about ? { about } : {}), by: agent });
  const { shared } = await library(env).route(card.id);
  // Its map and its About section come with the reply, so Claude can write at once without another call.
  const map = await room(env, card.id).runTool(card.id, agent, 'map', { read: ['about'] }, shared);
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

/** The usual instructions, then the notebooks there are and which one tools use when none is named. */
async function instructionsFor(env: Env): Promise<string> {
  const { notebooks, default: fallback } = await library(env).directory();
  if (!notebooks.length) return `${INSTRUCTIONS}\n\nThere are no notebooks yet. Make one with create_notebook.`;
  const list = notebooks.map((notebook) => `${notebook.id} ("${notebook.title}")`).join(', ');
  return `${INSTRUCTIONS}\n\nNotebooks here: ${list}. Tools work in ${fallback} unless you pass \`notebook\`. To make a new one, use create_notebook.`;
}

/** Whether a request is the one that opens a connection, whose reply carries the instructions. */
async function connecting(request: Request): Promise<boolean> {
  try {
    const body: unknown = await request.clone().json();
    return (Array.isArray(body) ? body : [body]).some((message) => (message as { method?: unknown } | null)?.method === 'initialize');
  } catch {
    return false;
  }
}
