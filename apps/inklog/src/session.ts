/** Running Quillipi for a folder: as the owner (engine, server, watcher) or through another owner. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { notebookId, runTool } from '@inklog/engine';
import { Engine, UserError } from '@inklog/engine';
import { createMcpServer } from '@inklog/engine';
import { openFolder } from './setup.js';
import { claimOwnership, findOwner, ownerTools } from './owner.js';
import { type RemoteAccess, startRemoteAccess } from './remote.js';
import { LAYOUT } from '@inklog/engine';
import { type Server, startServer } from './server.js';
import { watchSections } from './watch.js';

const WEB_ROOT = fileURLToPath(new URL('../../web/dist/', import.meta.url));
export const DEFAULT_PORT = 4321;

export interface Session {
  engine: Engine;
  server: Server;
  remote?: RemoteAccess;
  close(): Promise<void>;
}

export interface SessionOptions {
  version: string;
  port?: number;
  /** Opens remote access for apps in the cloud. See remote.ts. */
  remote?: { publicUrl: URL; port: number };
}

export async function startSession(dir: string, options: SessionOptions): Promise<Session> {
  const engine = await openFolder(dir);
  const server = await startServer(engine, { port: options.port ?? DEFAULT_PORT, webRoot: WEB_ROOT, notebook: notebookId(path.basename(path.resolve(dir))) });
  const remote = options.remote && (await startRemote(engine, server, { ...options.remote, version: options.version }));
  const stopWatching = watchSections(engine, dir);
  const release = claimOwnership(dir, { pid: process.pid, port: server.port, token: server.token, publicUrl: options.remote?.publicUrl.href });
  let closing: Promise<void> | undefined;
  return {
    engine,
    server,
    remote,
    close: () =>
      (closing ??= (async () => {
        await stopWatching();
        await remote?.close();
        await engine.flush();
        await server.close();
        release();
      })()),
  };
}

async function startRemote(engine: Engine, server: Server, options: { publicUrl: URL; port: number; version: string }): Promise<RemoteAccess> {
  let shownCode: string | undefined;
  const remote: RemoteAccess = await startRemoteAccess(engine, {
    ...options,
    log: (line) => console.log(line),
    onChange: () => {
      server.broadcastRepo();
      const waiting = remote.status().pending;
      // The code also appears in the editor; the terminal is for when the editor isn't open.
      if (waiting && waiting.code !== shownCode) console.log(`\n${waiting.app} wants to use this notebook. Approval code: ${waiting.code} (valid for 10 minutes)`);
      shownCode = waiting?.code;
    },
  });
  server.attachRemote(remote);
  return remote;
}

export async function serve(dir: string, options: SessionOptions & { open: boolean }): Promise<void> {
  const owner = await findOwner(dir);
  if (owner && options.remote && owner.publicUrl !== options.remote.publicUrl.href) {
    throw new UserError(
      'Quillipi is already running for this folder without this remote address, probably started by Claude Code. Close it (closing VS Code is enough), then run this again.',
    );
  }
  if (owner) {
    const url = `http://localhost:${owner.port}/login?token=${owner.token}`;
    console.log(`Quillipi is already running for this folder:\n  ${url}`);
    if (options.open) openBrowser(url);
    return;
  }
  const session = await startSession(dir, options);
  console.log(`Quillipi is running for ${dir}\n  ${session.server.loginUrl}`);
  if (session.remote) {
    console.log(`Remote access is on. Connector address for Claude:\n  ${session.remote.status().url}`);
    console.log('Quillipi remembers this address for this notebook; --public-url off turns remote access off.');
  }
  console.log('Press Ctrl+C to stop.');
  if (options.open) openBrowser(session.server.loginUrl);
  closeOnExit(session, { whenStdinCloses: false });
}

/** Speaks MCP over stdin and stdout. Messages for people go to stderr, which agents show as logs. */
export async function serveMcp(dir: string, version: string): Promise<void> {
  const owner = await findOwner(dir);
  let host = owner && ownerTools(dir, owner);
  if (!host) {
    const session = await startSession(dir, { version });
    console.error(`Quillipi editor for this folder: ${session.server.loginUrl}`);
    host = { call: (name, args, agent) => runTool(session.engine, agent, name, args) };
    // MCP clients stop servers by closing stdin.
    closeOnExit(session, { whenStdinCloses: true });
  }
  const server = createMcpServer(host, version);
  await server.connect(new StdioServerTransport());
}

function closeOnExit(session: Session, { whenStdinCloses }: { whenStdinCloses: boolean }): void {
  const stop = () => void session.close().finally(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  if (whenStdinCloses) process.stdin.once('end', stop);
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(command, args as string[], { stdio: 'ignore', detached: true, windowsVerbatimArguments: process.platform === 'win32' })
    .on('error', () => console.log('Open the link above in your browser.'))
    .unref();
}

/**
 * The public address for remote access. It is remembered per notebook, in .inklog/remote.json
 * (never committed), so it only has to be given once; "off" forgets it.
 */
export function rememberedPublicUrl(dir: string, given: string | undefined): URL | undefined {
  const file = path.join(dir, LAYOUT.local, 'remote.json');
  if (given === 'off') {
    fs.rmSync(file, { force: true });
    return undefined;
  }
  if (given) {
    const url = parsePublicUrl(given);
    if (fs.existsSync(path.join(dir, LAYOUT.meta))) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify({ publicUrl: url.href })}\n`);
    }
    return url;
  }
  return fs.existsSync(file) ? parsePublicUrl(JSON.parse(fs.readFileSync(file, 'utf8')).publicUrl) : undefined;
}

/** The public address must be https (plain http only for this computer, when testing) and have no path. */
export function parsePublicUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UserError(`"${value}" is not a web address. Use one like https://quillipi.example.com`);
  }
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local) throw new UserError('The public address must start with https://');
  if (url.pathname !== '/' || url.search || url.hash) throw new UserError(`Use the address without a path, such as ${url.origin}`);
  return url;
}
