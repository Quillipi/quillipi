/**
 * Sign-in for Claude's door, letting in one person. workers-oauth-provider is the authorization
 * server that apps talk to (discovery, registration, tokens); this module is its /authorize page
 * and GitHub's callback:
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
    // The app's name is kept in the grant's readable metadata too, so the Agents page can list it.
    const { redirectTo } = await oauth.completeAuthorization({ request: original, userId: String(user.id), metadata: { login: user.login, agent }, scope: [SCOPE], props });
    // For Home's Get started card. Claude is connected either way, so a failure here only waits for the next connection.
    await library(env)
      .noteClaudeConnected()
      .catch((error: unknown) => console.error('Could not note that Claude connected:', error));
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
 * `redirectUri` is the callback the sign-in went out with: Claude's, or the app's.
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

/** How commits and the activity list name an app's work, as on the laptop. The name is the app's own, so it is tidied. */
function agentName({ clientName, redirectIsLoopback }: ConsentDescription): string {
  const name = clientName.replace(/\s+/g, ' ').trim().slice(0, 60) || 'An app';
  if (!/claude/i.test(name)) return name;
  return redirectIsLoopback ? 'Claude via Claude Code' : 'Claude via claude.ai';
}

/** The library's reasons are short phrases, some ending in "; start again", which the page says anyway. */
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
