/**
 * The local web server: the editor's files, the notebook's calls and its live connection.
 *
 * What the editor asks of the notebook is answered by EditorApi (packages/engine/src/editor-api.ts),
 * which the cloud uses too, under the same addresses: `/n/<id>` for the page, `/api/n/<id>/…` for
 * its calls and files, and `/api/n/<id>/ws` for its live connection. This file keeps only what is
 * the laptop's own: sign-in, the address checks, the built editor's files, remote access, and the
 * calls other Quillipi processes make through owner.ts.
 *
 * It listens on 127.0.0.1 only and every API call needs the session token, which the browser
 * gets as a cookie by opening the login link `quillipi serve` prints. The Host and Origin
 * checks stop other websites from reaching it through DNS rebinding.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { ServerMessage } from '@inklog/core';
import { type WebSocket, WebSocketServer } from 'ws';
import { EditorApi, type EditorReply, MAX_JSON_BYTES, runTool } from '@inklog/engine';
import { type Engine, UserError } from '@inklog/engine';
import type { RemoteAccess } from './remote.js';

export interface Server {
  port: number;
  token: string;
  /** Opening this link signs the browser in. */
  loginUrl: string;
  /** Shows remote access (status, connections) in the editor. */
  attachRemote(remote: RemoteAccess): void;
  /** Tells every open editor that repo-level information changed. */
  broadcastRepo(): void;
  close(): Promise<void>;
}

export interface ServerOptions {
  port: number;
  webRoot: string;
  /** The notebook's ID, which its addresses carry: a slug of the folder's name (notebookId). */
  notebook: string;
}

/**
 * The same security headers as the cloud gives the app (apps/web/public/_headers, which a test
 * keeps these equal to): the page runs only its own scripts, talks only to this address, and
 * can't be shown inside another site. So even text that slipped past every check couldn't run.
 */
export const APP_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
};

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

export async function startServer(engine: Engine, options: ServerOptions): Promise<Server> {
  const token = randomBytes(24).toString('base64url');
  const sockets = new Set<WebSocket>();
  let port = options.port;
  let remote: RemoteAccess | undefined;
  const editor = new EditorApi<WebSocket>(engine, { info: (info) => (remote ? { ...info, remote: remote.status() } : info) });
  /** Where this notebook's page and calls live. */
  const page = `/n/${options.notebook}`;
  const calls = `/api${page}/`;

  const isAllowedHost = (host = '') => host === `localhost:${port}` || host === `127.0.0.1:${port}`;
  // Browsers share cookies between ports, so each running Quillipi needs its own cookie name.
  const cookie = () => `inklog-${port}=${token}`;
  const isSignedIn = (request: http.IncomingMessage) =>
    request.headers.authorization === `Bearer ${token}` || (request.headers.cookie ?? '').split(/;\s*/).includes(cookie());

  async function handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (!isAllowedHost(request.headers.host)) return send(response, 403, { error: 'Unknown host.' });

    if (url.pathname === '/login') {
      if (url.searchParams.get('token') !== token) return send(response, 403, { error: 'This login link has expired. Use the one quillipi serve printed.' });
      response.writeHead(302, { 'set-cookie': `${cookie()}; HttpOnly; SameSite=Strict; Path=/`, location: page });
      return void response.end();
    }
    // Until there is a home page, the notebook's page is the start.
    if (url.pathname === '/') {
      response.writeHead(302, { location: page });
      return void response.end();
    }
    if (!url.pathname.startsWith('/api/')) return sendAppFile(response, url.pathname);
    if (!isSignedIn(request)) return send(response, 401, { error: 'Open Quillipi from the link that quillipi serve printed.' });
    if (url.pathname.startsWith('/api/n/')) return notebookCall(request, response, url);
    return send(response, 200, await laptopCall(request, url));
  }

  /** A call to a notebook: answered by the shared EditorApi when it is this one. */
  async function notebookCall(request: http.IncomingMessage, response: http.ServerResponse, url: URL): Promise<void> {
    const [id, ...rest] = url.pathname.slice('/api/n/'.length).split('/');
    if (id !== options.notebook) return send(response, 404, { error: `No notebook "${id}" here. This Quillipi serves "${options.notebook}".` });
    const reply = await editor.call({
      method: request.method ?? 'GET',
      path: rest.join('/'),
      query: url.searchParams,
      contentType: request.headers['content-type'],
      body: (limit) => readBody(request, limit),
    });
    sendReply(response, reply);
  }

  /** Calls that belong to this laptop program rather than to a notebook. */
  async function laptopCall(request: http.IncomingMessage, url: URL): Promise<unknown> {
    switch (`${request.method} ${url.pathname}`) {
      // Other Quillipi processes check that the owner answers, and send it their agents' tool calls (owner.ts).
      case 'GET /api/ping':
        return { ok: true };
      case 'POST /api/tool': {
        const { name, args, agent } = await readJson<{ name: string; args: unknown; agent: string }>(request);
        return { text: await runTool(engine, String(agent || 'An AI agent'), name, args) };
      }
      case 'GET /api/notebooks':
        return { notebooks: [{ id: options.notebook, name: engine.name }] };
      // The app asks which Quillipi serves it: this one is the laptop's, with one notebook.
      case 'GET /api/me':
        return { laptop: { id: options.notebook, name: engine.name } };
      case 'POST /api/remote/disconnect': {
        const { id } = await readJson<{ id: string }>(request);
        if (!remote) throw new UserError('Remote access is off.');
        await remote.disconnect(String(id));
        return { ok: true };
      }
      case 'POST /api/remote/deny':
        remote?.denyWaiting();
        return { ok: true };
      default:
        throw new NotFound();
    }
  }

  /** The built editor. Any page that isn't one of its files gets the app, which reads the address. */
  function sendAppFile(response: http.ServerResponse, pathname: string): void {
    const root = path.resolve(options.webRoot);
    let file = path.resolve(root, `.${pathname}`);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
    if (!fs.existsSync(file)) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      return void response.end('The editor has not been built yet. Run "npm run build" in the Quillipi folder.');
    }
    response.writeHead(200, { ...APP_HEADERS, 'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(response);
  }

  // ---------------------------------------------------------------------------
  // Live updates

  const broadcast = (message: ServerMessage, except?: WebSocket) => {
    const text = JSON.stringify(message);
    for (const socket of sockets) if (socket !== except && socket.readyState === socket.OPEN) socket.send(text);
  };
  const stopListening = editor.listen(broadcast);

  const webSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_JSON_BYTES });
  const httpServer = http.createServer((request, response) => {
    handle(request, response).catch((error) => sendError(response, error));
  });
  httpServer.on('upgrade', (request, socket, head) => {
    const origin = request.headers.origin ?? '';
    const allowed =
      new URL(request.url ?? '/', 'http://localhost').pathname === `${calls}ws` &&
      isAllowedHost(request.headers.host) &&
      (origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}`) &&
      isSignedIn(request);
    if (!allowed) return void socket.destroy();
    webSockets.handleUpgrade(request, socket, head, (ws) => {
      sockets.add(ws);
      ws.on('close', () => sockets.delete(ws));
      ws.on('message', (data) => {
        const reply = editor.receive(String(data), ws);
        if (reply) ws.send(JSON.stringify(reply));
      });
    });
  });

  // Use the first free port from the one asked for.
  for (;;) {
    const listening = await new Promise<boolean>((resolve, reject) => {
      httpServer.once('error', (error: NodeJS.ErrnoException) => (error.code === 'EADDRINUSE' ? resolve(false) : reject(error)));
      httpServer.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (listening) break;
    if (++port > options.port + 20) throw new Error(`Ports ${options.port}–${port - 1} are all in use. Pass --port to choose another.`);
  }

  return {
    port,
    token,
    loginUrl: `http://localhost:${port}/login?token=${token}`,
    attachRemote(attached) {
      remote = attached;
    },
    broadcastRepo: () => broadcast({ type: 'repo', info: editor.info() }),
    async close() {
      stopListening();
      for (const socket of sockets) socket.terminate();
      webSockets.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

class NotFound extends Error {}

function send(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(body));
}

function sendReply(response: http.ServerResponse, reply: EditorReply): void {
  if ('json' in reply) return send(response, reply.status, reply.json);
  response.writeHead(reply.status, reply.headers);
  response.end(reply.bytes);
}

function sendError(response: http.ServerResponse, error: unknown): void {
  if (response.headersSent) return void response.end();
  if (error instanceof NotFound) return send(response, 404, { error: 'Not found.' });
  if (error instanceof UserError || error instanceof SyntaxError || (error instanceof Error && error.name === 'ZodError')) {
    return send(response, 400, { error: error.message });
  }
  console.error(error);
  send(response, 500, { error: 'Something went wrong in Quillipi. The details are in the terminal.' });
}

async function readBody(request: http.IncomingMessage, limit: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new UserError(`That is too large; the limit is ${Math.round(limit / 1024 / 1024)} MB.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson<T>(request: http.IncomingMessage): Promise<T> {
  return JSON.parse(Buffer.from(await readBody(request, MAX_JSON_BYTES)).toString('utf8') || '{}');
}
