/**
 * Sign-in for the door, letting in one person, from any AI app. workers-oauth-provider is the
 * authorization server that apps talk to (discovery, registration, tokens); this module is its
 * /authorize page and GitHub's callback:
 *
 * 1. GET /authorize shows which app asks and where access will be sent, with Continue and Cancel.
 * 2. POST /authorize: on Continue, the browser goes to GitHub, with PKCE.
 * 3. GET /callback: GitHub sends the browser back with a code. The code becomes a GitHub token,
 *    used once to ask who signed in and then dropped. Only GITHUB_USER_ID is let in, and the app
 *    gets its own code.
 *
 * Every app reaches GitHub through Quillipi's one GitHub App, so without the consent page a
 * stranger's app could ride on the owner's GitHub session (MCP calls this the confused deputy). The
 * library's consent and upstream helpers bind the page and GitHub's state to this browser.
 */
import { AuthorizationError, CimdFetchError, type ConsentDescription, authorizationErrorRedirect } from '@cloudflare/workers-oauth-provider';
import { type DoorProps, library } from './door.js';
import type { Env, Served } from './env.js';
import { consentPage, messagePage, pageHeaders } from './pages.js';
import { base64url } from './session.js';
import { isSetUp } from './settings.js';

/** The one scope, the use of the notebooks: sign-in grants it and /mcp asks for it. */
export const SCOPE = 'notebook';
/**
 * The right to renew a sign-in, which some apps ask for and are granted. Every app gets a refresh
 * token anyway, but ChatGPT, as OpenAI says, may lose access after an hour without this scope.
 */
export const OFFLINE = 'offline_access';

/**
 * The grant and response types Quillipi's sign-in uses, as workers-oauth-provider supports them.
 * Version 1.2.4 refuses a registration that lists any other, such as the device code Gemini CLI
 * lists; RFC 7591 lets a server leave those out instead, as 1.3.0 does (supportedRegistration).
 */
const GRANT_TYPES = ['authorization_code', 'refresh_token'];
const RESPONSE_TYPES = ['code'];
/** Registrations are a few hundred bytes; a larger one goes to the library untouched, which limits it. */
const REGISTRATION_READ = 64 * 1024;

const NEEDED = ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GITHUB_USER_ID', 'GITHUB_USER_LOGIN'] as const;

/** What signing in with GitHub needs: the GitHub App as an OAuth client, and the one account let in. */
export interface GitHubSignIn {
  clientId: string;
  clientSecret: string;
  /** The account's permanent numeric ID, which alone decides who gets in, and its name. */
  userId: string;
  login: string;
}

/** A sign-in that can't go on, with what the person should be told. */
export class SignInError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    message: string,
  ) {
    super(message);
  }
}

/** Whether sign-in has its settings, naming any that are missing. Checked without calling GitHub. */
export function signInStatus(env: Env): string {
  const missing = NEEDED.filter((name) => !env[name]);
  return missing.length ? `not set up: ${missing.join(', ')} missing` : 'ready';
}

/** Sign-in's settings, or a page that says Quillipi isn't set up yet (settings.ts, isSetUp, which needs them all). */
export function githubSignIn(env: Env): GitHubSignIn {
  if (!isSetUp(env)) throw new SignInError(503, 'Quillipi isn’t set up yet', 'Its owner sets it up first, by opening Quillipi’s address in a browser. Then connect again.');
  return { clientId: env.GITHUB_CLIENT_ID!, clientSecret: env.GITHUB_CLIENT_SECRET!, userId: env.GITHUB_USER_ID!, login: env.GITHUB_USER_LOGIN! };
}

export function authorize(request: Request, env: Served): Promise<Response> {
  return guarded(async () => {
    const github = githubSignIn(env);
    if (request.method === 'GET') return consent(request, env, github);
    if (request.method === 'POST') return decide(request, env, github);
    return new Response(null, { status: 405, headers: { allow: 'GET, POST' } });
  });
}

export function callback(request: Request, env: Served): Promise<Response> {
  return guarded(async () => {
    if (request.method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } });
    const github = githubSignIn(env);
    const oauth = env.OAUTH_PROVIDER;
    const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(request);
    const code = new URL(request.url).searchParams.get('code');
    if (!code) {
      headers.set('location', authorizationErrorRedirect(original, 'access_denied', 'The sign-in was cancelled at GitHub.'));
      return new Response(null, { status: 302, headers });
    }
    const user = await whoSignedIn(env, github, code, data.verifier, callbackUrl(env));
    if (String(user.id) !== github.userId) {
      throw new SignInError(403, 'This GitHub account can’t use Quillipi', `Only ${github.login} can. You signed in to GitHub as ${user.login}. Switch accounts on GitHub, then connect again from the app.`);
    }
    const agent = agentName(await oauth.describeConsent(original));
    const props: DoorProps = { agent };
    const scope = original.scope.includes(OFFLINE) ? [SCOPE, OFFLINE] : [SCOPE];
    // The app's name is kept in the grant's readable metadata too, so the Agents page can list it.
    const { redirectTo } = await oauth.completeAuthorization({ request: original, userId: String(user.id), metadata: { login: user.login, agent }, scope, props });
    // For Home's Get started card. The app is connected either way, so a failure here only waits for the next connection.
    await library(env)
      .noteAiConnected()
      .catch((error: unknown) => console.error('Could not note that an AI app connected:', error));
    headers.set('location', redirectTo);
    return new Response(null, { status: 302, headers });
  });
}

async function consent(request: Request, env: Served, github: GitHubSignIn): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const authRequest = await oauth.parseAuthRequest(request);
  // Described before the consent begins, so an app that can't be looked up leaves nothing stored.
  const app = await oauth.describeConsent(authRequest);
  const { handle, headers } = await oauth.beginConsent(authRequest);
  return new Response(consentPage(app, handle, github.login), { headers: pageHeaders(headers, [githubWeb(env), app.redirectUri]) });
}

async function decide(request: Request, env: Served, github: GitHubSignIn): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const form = await request.formData();
  const handle = String(form.get('handle') ?? '');
  if (form.get('decision') !== 'approve') {
    const { headers } = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers });
  }
  const approved = await oauth.approveConsent(request, handle);
  const verifier = randomToken();
  const { state, headers } = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
  const authorizeAt = new URL('/login/oauth/authorize', githubWeb(env));
  authorizeAt.search = new URLSearchParams({
    client_id: github.clientId,
    redirect_uri: callbackUrl(env),
    state,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: 'S256',
    login: github.login, // GitHub suggests the right account
    allow_signup: 'false',
  }).toString();
  headers.set('location', authorizeAt.href);
  return new Response(null, { status: 302, headers });
}

/**
 * Trades GitHub's code for a GitHub token and asks GitHub whose it is. The token isn't kept.
 * `redirectUri` is the callback the sign-in went out with: the door's, the app's or the setup's.
 */
export async function whoSignedIn(
  env: Env,
  github: Pick<GitHubSignIn, 'clientId' | 'clientSecret'>,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<{ id: number; login: string; name?: string }> {
  const token = await askGitHub(
    new Request(new URL('/login/oauth/access_token', githubWeb(env)), {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Quillipi' },
      body: new URLSearchParams({ client_id: github.clientId, client_secret: github.clientSecret, code, redirect_uri: redirectUri, code_verifier: verifier }),
    }),
  );
  // GitHub answers a refused code with 200 and an error in the body.
  if (typeof token.body.access_token !== 'string') {
    const reason = token.body.error_description ?? token.body.error ?? `It answered ${token.status}.`;
    throw new SignInError(502, 'GitHub refused the sign-in', `${String(reason)} Connect again from the app.`);
  }
  const user = await askGitHub(
    new Request(`${env.GITHUB_API ?? 'https://api.github.com'}/user`, {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token.body.access_token}`, 'user-agent': 'Quillipi', 'x-github-api-version': '2022-11-28' },
    }),
  );
  if (typeof user.body.id !== 'number' || typeof user.body.login !== 'string') {
    throw new SignInError(502, 'GitHub didn’t say who signed in', `It answered ${user.status}. Connect again from the app.`);
  }
  const name = typeof user.body.name === 'string' && user.body.name.trim() ? user.body.name.trim() : undefined;
  return { id: user.body.id, login: user.body.login, ...(name ? { name } : {}) };
}

async function askGitHub(request: Request): Promise<{ status: number; body: Record<string, unknown> }> {
  let response: Response;
  try {
    response = await fetch(request);
  } catch (error) {
    throw new SignInError(502, 'GitHub couldn’t be reached', `${error instanceof Error ? error.message : String(error)}. Connect again from the app.`);
  }
  try {
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  } catch {
    throw new SignInError(502, 'GitHub sent something unexpected', `It answered ${response.status}. Connect again from the app.`);
  }
}

/**
 * Turns failures into a page or a redirect. A redirect back to the app is safe only when the
 * library has checked the app's address; anything else is shown here. Bugs and outages are left
 * to become a 500, which Cloudflare's logs keep.
 */
async function guarded(work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    const shown =
      error instanceof SignInError
        ? error
        : error instanceof AuthorizationError
          ? new SignInError(400, 'This sign-in can’t go on', `${sentence(error.description)} Connect again from the app.`)
          : error instanceof CimdFetchError
            ? new SignInError(400, 'This app couldn’t be checked', 'Its published description couldn’t be read. Try connecting again later.')
            : undefined;
    if (!shown) throw error;
    // Failed sign-ins are hard to diagnose from the app's side, so each one is logged in plain words.
    console.warn(`Sign-in stopped: ${shown.title}. ${shown.message}`);
    return new Response(messagePage(shown.title, shown.message), { status: shown.status, headers: pageHeaders() });
  }
}

/**
 * How commits and the activity list name an app's work. An app with a published identity is named
 * by the site that publishes it, which it can't fake: chatgpt.com publishes ChatGPT's and Codex's,
 * vscode.dev VS Code's. Any other app is named by the name it gave itself, tidied; Claude's names
 * say where it runs, as on the laptop.
 */
function agentName({ clientId, clientName, clientDomain, redirectIsLoopback }: ConsentDescription): string {
  const site = clientDomain?.toLowerCase();
  if (site === 'chatgpt.com') return new URL(clientId).pathname.includes('/codex/') ? 'Codex' : 'ChatGPT';
  if (site === 'vscode.dev') return 'VS Code';
  // An app that gave no name is called by its client ID, which says nothing to a person.
  const name = clientName === clientId ? '' : clientName.replace(/\s+/g, ' ').trim().slice(0, 60);
  if (site === 'claude.ai' || /claude/i.test(name)) return redirectIsLoopback ? 'Claude via Claude Code' : 'Claude via claude.ai';
  return name || site || 'An app';
}

/**
 * An app's registration (POST /register) without the grant and response types Quillipi doesn't
 * use, so an app that lists extra ones, such as Gemini CLI with the device code, can still sign
 * in. A list with none Quillipi uses is left as it is, for the library to refuse with its reason.
 * Anything that isn't a small JSON object goes on untouched.
 */
export async function supportedRegistration(request: Request): Promise<Request> {
  if (Number(request.headers.get('content-length') ?? 0) > REGISTRATION_READ) return request;
  // Read from a copy, so the request goes on whole if it is too large or isn't what was expected.
  const text = await readUpTo(request.clone(), REGISTRATION_READ);
  if (text === undefined) return request;
  let metadata: unknown;
  try {
    metadata = JSON.parse(text);
  } catch {
    return request;
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return request;
  const fields = metadata as Record<string, unknown>;
  const left: string[] = [];
  const keep = (name: string, supported: string[]) => {
    const listed = fields[name];
    if (!Array.isArray(listed) || !listed.some((value) => supported.includes(value))) return;
    left.push(...listed.filter((value) => !supported.includes(value)).map(String));
    fields[name] = listed.filter((value) => supported.includes(value));
  };
  keep('grant_types', GRANT_TYPES);
  keep('response_types', RESPONSE_TYPES);
  if (!left.length) return request;
  console.log(`Registration of ${JSON.stringify(String(fields.client_name ?? 'an app'))}: left out ${left.join(', ')}, which Quillipi doesn't use.`);
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  return new Request(request, { headers, body: JSON.stringify(fields) });
}

/** A request's body as text, or undefined once it runs past `limit` bytes, when the rest isn't read. */
async function readUpTo(request: Request, limit: number): Promise<string | undefined> {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return undefined;
    }
    text += decoder.decode(value, { stream: true });
  }
}

/** workers-oauth-provider's reasons are short phrases, some ending in "; start again", which the page says anyway. */
function sentence(reason: string): string {
  const text = reason.replace(/;\s*start again$/i, '').replace(/\.?$/, '.');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function githubWeb(env: Env): string {
  return env.GITHUB_WEB ?? 'https://github.com';
}

function callbackUrl(env: Served): string {
  return new URL('/callback', env.PUBLIC_URL).href;
}

export function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}
