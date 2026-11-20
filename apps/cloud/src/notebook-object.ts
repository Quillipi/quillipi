/**
 * The Durable Object that holds one notebook. Cloudflare runs exactly one instance of it per
 * notebook name, anywhere in the world, so it is the notebook's single owner, as one engine per
 * folder is on the laptop. Its SQLite database keeps the notebook when the object sleeps, and its
 * alarm runs the GitHub mirror's steps in the background.
 *
 * The editor reaches it at /api/n/<id>/… (the Worker checks the browser's sign-in first): its calls
 * through fetch, and its live connection as a WebSocket that hibernates. While a room naps, its
 * memory goes but the connections stay open; the next message wakes it and the engine opens again,
 * and saves based on versions from before are answered as stale (engine.ts), so no words are lost.
 *
 * Its settings (who its commits are made as, and the GitHub App for its mirror) are read when it
 * wakes: the Worker's own variables, and from the library what they don't hold (settings.ts).
 */
import { type Person, type ServerMessage, parseMeta } from '@inklog/core';
import { LAYOUT } from '@inklog/engine';
import { DurableObject } from 'cloudflare:workers';
import { DurableStore, durableSql } from './durable-store.js';
import { answerEditor } from './editor-door.js';
import type { Env } from './env.js';
import { GitHubApp } from './github.js';
import { LIBRARY_NAME } from './library.js';
import { Mirror } from './mirror.js';
import { type NewNotebookDetails, NotebookHost, type NotebookStatus } from './notebook-host.js';
import { withSettings } from './settings.js';

/** The object remembers which notebook it holds, so its alarm knows. */
const NAME_KEY = 'notebook';

export class NotebookObject extends DurableObject<Env> {
  /** The room's store and settings, and the notebook's host, each made once while the room is awake. */
  private opened?: Promise<{ store: DurableStore; env: Env }>;
  private hosted?: Promise<NotebookHost>;

  /** Runs an agent's tool call on the notebook, with the owner's instructions for every notebook. */
  async runTool(notebook: string, agent: string, tool: string, args: unknown, sharedInstructions?: string): Promise<string> {
    return (await this.hostFor(notebook)).runTool(agent, tool, args, sharedInstructions);
  }

  /** Starts a new notebook in this room; the library calls it from New notebook. */
  async create(notebook: string, details: NewNotebookDetails): Promise<'made' | 'taken'> {
    return (await this.hostFor(notebook)).create(details);
  }

  /** Links this room to the notebook's repo already on GitHub; the library calls it. */
  async adopt(notebook: string): Promise<string> {
    return (await this.hostFor(notebook)).adopt();
  }

  async status(notebook: string): Promise<NotebookStatus> {
    return (await this.hostFor(notebook)).status();
  }

  /** Lets a stopped or waiting mirror carry on at once. */
  async retryMirror(notebook: string): Promise<string> {
    const { mirror } = await this.hostFor(notebook);
    return mirror ? mirror.retry() : 'The GitHub mirror is not set up here: the GitHub App, its private key and the organization for notebooks are needed.';
  }

  /** The editor's calls and its live connection, at /api/n/<id>/…. */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const [encoded, ...rest] = url.pathname.slice('/api/n/'.length).split('/');
    const notebook = decodeURIComponent(encoded ?? '');
    const host = await this.hostFor(notebook);
    if (rest.join('/') === 'ws') {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return Response.json({ error: 'Open this as a WebSocket.' }, { status: 426 });
      const { 0: client, 1: server } = new WebSocketPair();
      // Tagged with the notebook, so a message that wakes the room knows which one it is for.
      this.ctx.acceptWebSocket(server, [notebook]);
      return new Response(null, { status: 101, webSocket: client });
    }
    return answerEditor(host, request, () => this.library().instructions());
  }

  /** A message from an open editor: a save, answered on the same connection. */
  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const [notebook] = this.ctx.getTags(socket);
    if (!notebook) return;
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
    const reply = await (await this.hostFor(notebook)).editorMessage(text, socket);
    if (reply) socket.send(JSON.stringify(reply));
  }

  override async webSocketClose(socket: WebSocket, code: number): Promise<void> {
    socket.close(code === 1005 ? 1000 : code, 'Closed');
  }

  /** Proves the object and its database answer, for /status. */
  async ping(): Promise<string> {
    this.ctx.storage.sql.exec('SELECT 1').toArray();
    return 'ok';
  }

  /** Runs the mirror's next step (making the repo, an import or a push), and a report that is due. */
  async alarm(): Promise<void> {
    const { store } = await this.open();
    const notebook = store.getMeta(NAME_KEY);
    if (notebook) await (await this.hostFor(notebook)).alarm();
  }

  /** The notebook's host, made on the first call while awake; two calls at once share it. */
  private async hostFor(notebook: string): Promise<NotebookHost> {
    this.hosted ??= this.makeHost(notebook).catch((error: unknown) => {
      this.hosted = undefined; // let the next call try again
      throw error;
    });
    const host = await this.hosted;
    if (host.name !== notebook) throw new Error(`This object holds "${host.name}", not "${notebook}".`);
    return host;
  }

  private async makeHost(notebook: string): Promise<NotebookHost> {
    const { store, env } = await this.open();
    const saved = store.getMeta(NAME_KEY);
    if (saved && saved !== notebook) throw new Error(`This object holds "${saved}", not "${notebook}".`);
    if (!saved) store.setMeta(NAME_KEY, notebook);
    const library = this.library();
    return new NotebookHost(store, notebook, ownerOf(env), this.mirrorFor(env, store, notebook), {
      report: (summary) => library.update(notebook, summary),
      schedule: (time) => this.wakeAt(time),
      broadcast: (message, except) => this.broadcast(message, except),
    });
  }

  /** The room's settings and its store, which makes commits as Quillipi's owner. */
  private open(): Promise<{ store: DurableStore; env: Env }> {
    this.opened ??= withSettings(this.env, () => this.library().settings())
      .then((env) => ({ env, store: new DurableStore(durableSql(this.ctx.storage), ownerOf(env)) }))
      .catch((error: unknown) => {
        this.opened = undefined; // let the next call try again
        throw error;
      });
    return this.opened;
  }

  private library() {
    return this.env.LIBRARY.get(this.env.LIBRARY.idFromName(LIBRARY_NAME));
  }

  /** Tells every open editor but `except`. A connection that has gone is skipped; Cloudflare closes it. */
  private broadcast(message: ServerMessage, except?: unknown): void {
    const text = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except) continue;
      try {
        socket.send(text);
      } catch {
        // closed while sending
      }
    }
  }

  /** The object has one alarm; keep whichever time comes first. */
  private async wakeAt(time: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > time) await this.ctx.storage.setAlarm(time);
  }

  /** The GitHub mirror, when the GitHub App, its key and the organization for notebooks are set. */
  private mirrorFor(env: Env, store: DurableStore, notebook: string): Mirror | undefined {
    const { GITHUB_APP_ID: appId, GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_OWNER: owner } = env;
    if (!appId || !privateKey || !owner) return undefined;
    return new Mirror({
      app: new GitHubApp({ appId, privateKey, owner, api: env.GITHUB_API }),
      store,
      notebook,
      // The repo's description on GitHub: the notebook's line about what it is for, as it was made.
      description: async () => parseMeta(await store.read(LAYOUT.meta)).about ?? '',
      schedule: (time) => this.wakeAt(time),
    });
  }
}

/** Who a room's commits are made as: Quillipi's owner, who must be known by now. */
function ownerOf(env: Env): Person {
  const { OWNER_NAME: name, OWNER_EMAIL: email } = env;
  if (!name || !email) throw new Error('Quillipi isn’t set up yet: who owns it (OWNER_NAME and OWNER_EMAIL) isn’t known.');
  return { name, email };
}

