/**
 * Remote access: a second door into Quillipi for apps in the cloud, such as Claude on claude.ai
 * and in the Claude mobile apps. It listens on a port of its own, which a tunnel (Cloudflare
 * Tunnel) makes reachable at the person's public address. The editor and its API are not on
 * this port, so from outside only sign-in and the agent tools can be reached.
 */
import http from 'node:http';
import type { RemoteStatus } from '@inklog/core';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { createOAuthMetadata, getOAuthProtectedResourceMetadataUrl, mcpAuthMetadataRouter, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import { runTool } from '@inklog/engine';
import { messagePage, pageHeaders } from './approval-page.js';
import { type Engine, UserError } from '@inklog/engine';
import { createMcpServer } from '@inklog/engine';
import { RemoteAuth, SCOPE } from './remote-auth.js';

export const DEFAULT_REMOTE_PORT = 4330;

export interface RemoteAccess {
  status(): RemoteStatus;
  disconnect(connectionId: string): Promise<void>;
  denyWaiting(): void;
  close(): Promise<void>;
}

export interface RemoteOptions {
  /** The public address, such as https://quillipi.example.com. The tunnel forwards it to `port`. */
  publicUrl: URL;
  port: number;
  version: string;
  /** Called when a sign-in starts or ends, or a connection is added or removed. */
  onChange(): void;
  /** Reports requests that failed, in plain words, so a problem is never silent. */
  log(line: string): void;
}

export async function startRemoteAccess(engine: Engine, options: RemoteOptions): Promise<RemoteAccess> {
  const { publicUrl } = options;
  const mcpUrl = new URL('/mcp', publicUrl);
  const auth = await RemoteAuth.load(engine.repo, mcpUrl, engine.name, options.onChange);
  const resourceName = `Quillipi notebook "${engine.name}"`;
  const app = express();
  app.disable('x-powered-by');
  // The tunnel runs on this computer and passes on the visitor's address; trust only it.
  app.set('trust proxy', 'loopback');

  app.use((request: Request, response: Response, next: NextFunction) => {
    response.on('finish', () => {
      const reason = failureReason(request, response.statusCode, publicUrl);
      if (reason) options.log(`Remote request failed: ${request.method} ${request.path} → ${response.statusCode}. ${reason}`);
    });
    next();
  });

  app.use((request: Request, response: Response, next: NextFunction) => {
    if (request.headers.host === publicUrl.host) return next();
    response.status(421).json({ error: 'This address is not served here.' });
  });

  app.use(mcpAuthRouter({ provider: auth, issuerUrl: publicUrl, resourceServerUrl: mcpUrl, scopesSupported: [SCOPE], resourceName }));
  // Sign-in details for the bare address too, so a connector added without /mcp works as well.
  const oauthMetadata = createOAuthMetadata({ provider: auth, issuerUrl: publicUrl, scopesSupported: [SCOPE] });
  app.use(mcpAuthMetadataRouter({ oauthMetadata, resourceServerUrl: publicUrl, scopesSupported: [SCOPE], resourceName }));

  app.post('/approve', express.urlencoded({ extended: false, limit: '4kb' }), (request: Request, response: Response) => {
    const form = request.body as Record<string, string | undefined>;
    const decision = auth.decide(form.request ?? '', form.decision === 'approve' ? { approve: true, code: form.code ?? '' } : { approve: false });
    if ('redirect' in decision) return response.redirect(302, decision.redirect);
    response.status(decision.status).set(pageHeaders(decision.returnTo)).send(decision.html);
  });

  const handleMcp = async (request: Request, response: Response) => {
    const agent = auth.agentFor(request.auth!.clientId);
    // A new server and transport for each request, so nothing is lost when Quillipi or the tunnel restarts.
    const server = createMcpServer({ call: (name, args) => runTool(engine, agent, name, args) }, options.version, { agent: () => agent });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
  };
  for (const resource of [mcpUrl, publicUrl]) {
    const signedIn = requireBearerAuth({ verifier: auth, requiredScopes: [SCOPE], resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource) });
    app.post(resource.pathname, signedIn, express.json({ limit: '5mb' }), handleMcp);
  }

  app.get('/', (_request: Request, response: Response) => {
    const text = `This is how Claude reaches the Quillipi notebook "${engine.name}". In Claude, add ${mcpUrl.href} as a custom connector.`;
    response.status(200).set(pageHeaders()).send(messagePage('Quillipi connector', text));
  });
  app.all(['/', '/mcp'], (_request: Request, response: Response) => {
    response.status(405).set('allow', 'POST').json({ error: 'Use POST.' });
  });
  app.use((_request: Request, response: Response) => {
    response.status(404).json({ error: 'Not found.' });
  });
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    console.error(error);
    if (!response.headersSent) response.status(500).json({ error: 'Something went wrong in Quillipi. The details are in its terminal.' });
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) =>
      reject(error.code === 'EADDRINUSE' ? new UserError(`Port ${options.port} is in use. Choose another with --remote-port.`) : error),
    );
    server.listen(options.port, '127.0.0.1', () => resolve());
  });

  return {
    status: () => ({ url: mcpUrl.href, ...auth.status() }),
    disconnect: (connectionId) => auth.disconnect(connectionId),
    denyWaiting: () => auth.denyWaiting(),
    async close() {
      await auth.flush();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Why a request failed, in words. Nothing for successes, for the 401 that normally starts
 * sign-in, or for the 405 an app gets when it checks whether it can open a stream.
 */
function failureReason(request: Request, status: number, publicUrl: URL): string | undefined {
  if (status < 400 || status === 405) return undefined;
  if (status === 401) return request.headers.authorization ? "The app's sign-in is no longer valid, so it must sign in again." : undefined;
  if (status === 421) return `It was sent to ${request.headers.host}, but Quillipi was started with --public-url ${publicUrl.origin}. Use the tunnel's current address.`;
  if (status === 403) return "The app's sign-in doesn't allow this.";
  if (status === 404) return 'Nothing is served at that path.';
  if (status === 429) return 'Too many requests in a short time; the app is being slowed down.';
  if (status >= 500) return 'Quillipi hit an error; the details are above.';
  return "Quillipi couldn't accept the request.";
}
