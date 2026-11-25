/**
 * Stand-ins for signing in to the door the way AI apps do: the MCP SDK's own OAuth client finds
 * sign-in from a 401, registers or uses a published identity, and sends "the person" to the consent
 * page; a pretend browser keeps cookies, clicks Continue and passes through the stand-in GitHub; then
 * the client exchanges its code and calls tools, which reach a stand-in for the notebooks.
 * sign-in.test.ts and any-ai.test.ts use them.
 */
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { expect, vi } from 'vitest';
import worker, { type Env } from '../src/index.js';
import type { Settings } from '../src/settings.js';
import { FakeCloud } from './fake-cloud.js';
import { FakeGitHub } from './fake-github.js';
import { FakeKV } from './fake-kv.js';

export const ORIGIN = 'https://quillipi.example.workers.dev';
export const MCP = new URL('/mcp', ORIGIN);
export const CLAUDE_AI = 'https://claude.ai/api/mcp/auth_callback';

export interface AppOptions {
  /** Every callback it registers, for an app that registers; by default only `redirectUrl`. */
  redirectUris?: string[];
  /** The grant types it registers with. */
  grantTypes?: string[];
}

/** Plays an AI app's side of sign-in, keeping everything in memory. `redirectUrl` is the callback this sign-in uses. */
export class TestApp implements OAuthClientProvider {
  info?: OAuthClientInformationMixed;
  saved?: OAuthTokens;
  verifier = '';
  authorizationUrl?: URL;

  constructor(
    private readonly name = 'Claude',
    public redirectUrl = CLAUDE_AI,
    /** The app's published identity (CIMD), when it signs in with one instead of registering. */
    readonly clientMetadataUrl?: string,
    private readonly options: AppOptions = {},
  ) {}

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.name,
      redirect_uris: this.options.redirectUris ?? [this.redirectUrl],
      grant_types: this.options.grantTypes ?? ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
}

export interface Cloud {
  env: Env;
  github: FakeGitHub;
  kv: FakeKV;
  /** The library and the rooms. */
  notebooks: FakeCloud;
  /** Tool calls that reached the notebooks: notebook, agent, tool, arguments. */
  calls: unknown[][];
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

/**
 * Every setting in the Worker; `overrides` changes them. The rooms answer with who they are, to see
 * where each call went, unless `rooms` is 'real'.
 */
export async function cloud(overrides: Partial<Env> = {}, { rooms = 'answering' }: { rooms?: 'answering' | 'real' } = {}): Promise<Cloud> {
  const github = new FakeGitHub();
  const kv = new FakeKV();
  const values = {
    PUBLIC_URL: ORIGIN,
    COMMIT: 'abc1234',
    OWNER_NAME: 'The Octocat',
    OWNER_EMAIL: 'k@example.com',
    // The organization for notebooks, as in production: the pages and GitHub's hint name the person, not it.
    GITHUB_OWNER: 'octo-notebooks',
    GITHUB_APP_ID: github.appId,
    GITHUB_APP_PRIVATE_KEY: github.privateKey,
    GITHUB_CLIENT_ID: github.clientId,
    GITHUB_CLIENT_SECRET: github.clientSecret,
    GITHUB_USER_ID: '583231',
    GITHUB_USER_LOGIN: 'OctoCat',
    SESSION_SECRET: 'a-session-secret-of-at-least-32-characters',
  };
  // The library is real, and sees the same variables and secrets as the Worker.
  const answer = rooms === 'answering' ? (id: string, _agent: string, tool: string) => `${id} answered ${tool}` : undefined;
  const notebooks = new FakeCloud({ ...(answer ? { answer } : {}), worker: { ...values, ...overrides } as Settings });
  await notebooks.library.create({ title: 'Inklog notebook test', by: 'The Octocat' });
  await notebooks.library.create({ title: 'Other notebook', by: 'The Octocat' });
  const calls = notebooks.calls;
  const env = { ...values, ...notebooks.bindings, OAUTH_KV: kv, ...overrides } as unknown as Env;
  // The Worker's own requests go to GitHub; here they reach the stand-in.
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => github.fetch(new Request(input, init)));
  const context = () => ({ waitUntil: () => {}, passThroughOnException: () => {}, props: {} }) as unknown as ExecutionContext;
  return { env, github, kv, notebooks, calls, fetch: (input, init) => worker.fetch(new Request(input, init) as Parameters<typeof worker.fetch>[0], env, context()) };
}

/** The person's browser: it keeps cookies per site and never follows redirects by itself. */
export class Browser {
  private cookies = new Map<string, string>();

  constructor(private readonly cloud: Cloud) {}

  async open(url: string | URL, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set('cookie', [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '));
    const response = await this.cloud.fetch(url, { ...init, headers, redirect: 'manual' });
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const at = pair!.indexOf('=');
      const [name, value] = [pair!.slice(0, at).trim(), pair!.slice(at + 1)];
      if (/max-age=0/i.test(line) || !value) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }

  /** Clicks Continue or Cancel on a consent page. */
  submit(html: string, decision: 'approve' | 'deny'): Promise<Response> {
    const handle = /name="handle" value="([^"]+)"/.exec(html)![1]!;
    return this.open(new URL('/authorize', ORIGIN), {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ handle, decision }),
    });
  }
}

/**
 * Starts connecting as an app would, up to the moment the consent page opens. `scope` replaces the
 * scopes the app asks for, as an app that asks for more than the door names would.
 */
export async function startConnecting(c: Cloud, app: TestApp, { scope }: { scope?: string } = {}): Promise<{ transport: StreamableHTTPClientTransport; browser: Browser; page: Response; html: string }> {
  const transport = new StreamableHTTPClientTransport(MCP, { authProvider: app, fetch: c.fetch });
  await expect(new Client({ name: 'claude-ai', version: '1.0.0' }).connect(transport)).rejects.toThrow(UnauthorizedError);
  if (scope) app.authorizationUrl!.searchParams.set('scope', scope);
  const browser = new Browser(c);
  const page = await browser.open(app.authorizationUrl!);
  return { transport, browser, page, html: await page.text() };
}

/** Clicks Continue and passes through GitHub, returning where the browser is sent back to. */
export async function continueToGitHub(c: Cloud, browser: Browser, html: string): Promise<{ github: URL; back: Response }> {
  const toGitHub = await browser.submit(html, 'approve');
  expect(toGitHub.status).toBe(302);
  const github = new URL(toGitHub.headers.get('location')!);
  return { github, back: await browser.open(c.github.authorize(github)) };
}

/** How an MCP client introduces itself when it connects (MCP 2025-06-18 added the title). */
export interface ClientInfo {
  name: string;
  version: string;
  title?: string;
}

/** Connects all the way, and returns a connected MCP client that introduces itself as `client`. */
export async function connect(c: Cloud, app = new TestApp(), client: ClientInfo = { name: 'claude-ai', version: '1.0.0' }): Promise<Client> {
  const { transport, browser, html } = await startConnecting(c, app);
  const { back } = await continueToGitHub(c, browser, html);
  expect(back.status).toBe(302);
  await transport.finishAuth(new URL(back.headers.get('location')!).searchParams.get('code')!);
  return signedIn(c, app, client);
}

/** An MCP client for an app that has signed in already. */
export async function signedIn(c: Cloud, app: TestApp, client: ClientInfo = { name: 'claude-ai', version: '1.0.0' }): Promise<Client> {
  const connected = new Client(client);
  await connected.connect(new StreamableHTTPClientTransport(MCP, { authProvider: app, fetch: c.fetch }));
  return connected;
}

export const text = (result: Awaited<ReturnType<Client['callTool']>>) => (result.content as { text: string }[])[0]!.text;
