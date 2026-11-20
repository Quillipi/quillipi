/**
 * Signing the browser in to the app, through the same GitHub App as Claude's sign-in, at its
 * second callback address, /signin/callback:
 *
 * 1. GET /signin shows one card: Continue with GitHub.
 * 2. POST /signin sends the browser to GitHub with PKCE. The state and the PKCE verifier go in a
 *    short-lived signed cookie, so only this browser can finish this sign-in.
 * 3. GET /signin/callback: GitHub sends the browser back with a code. The code becomes a GitHub
 *    token, used once to ask who signed in and then dropped. Only GITHUB_USER_ID is let in, and
 *    the browser gets its session cookie (session.ts).
 *
 * POST /signout removes the cookie. Unlike Claude's sign-in there is no consent page: the person
 * is signing in their own browser, and GitHub checks who they are.
 */
import type { Served } from './env.js';
import { messagePage, pageHeaders, signInPage, wrongAccountPage } from './pages.js';
import { SIGN_IN_COOKIE, SIGN_IN_MINUTES, SESSION_COOKIE, clearCookie, cookie, readCookie, readSession, seal, sessionCookie, sessionStatus, unseal } from './session.js';
import { type GitHubSignIn, SignInError, githubSignIn, githubWeb, pkceChallenge, randomToken, whoSignedIn } from './sign-in.js';

/** What the sign-in cookie holds while the browser is at GitHub. */
interface Pending {
  state: string;
  verifier: string;
  next: string;
  expires: number;
}

/** Answers /signin, /signin/callback and /signout. */
export async function appSignIn(request: Request, env: Served, now = Date.now()): Promise<Response> {
  const url = new URL(request.url);
  try {
    const github = githubSignIn(env);
    const session = sessionStatus(env);
    if (session !== 'ready') throw new SignInError(503, 'Sign-in isn’t set up yet', `Quillipi’s browser sign-in is ${session}.`);
    if (url.pathname === '/signout') return signOut(request, env);
    if (url.pathname === '/signin/callback') {
      if (request.method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } });
      return await finish(request, env, github, now);
    }
    if (request.method === 'POST') return await start(request, env, github, now);
    if (request.method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } });
    const next = safeNext(url.searchParams.get('next'));
    // Already signed in: go straight on.
    if (await readSession(request, env, now)) return redirect(next);
    return new Response(signInPage(next, github.login), { headers: pageHeaders(new Headers(), [githubWeb(env)]) });
  } catch (error) {
    if (!(error instanceof SignInError)) throw error;
    console.warn(`Browser sign-in stopped: ${error.title}. ${error.message}`);
    const headers = pageHeaders();
    headers.append('set-cookie', clearCookie(SIGN_IN_COOKIE));
    return new Response(messagePage(error.title, error.message, [{ label: 'Try again', href: '/signin', primary: true }]), { status: error.status, headers });
  }
}

/** Continue with GitHub: off to GitHub's sign-in, with this browser's state and PKCE. */
async function start(request: Request, env: Served, github: GitHubSignIn, now: number): Promise<Response> {
  const form = await request.formData().catch(() => new FormData());
  const pending: Pending = { state: randomToken(), verifier: randomToken(), next: safeNext(String(form.get('next') ?? '/')), expires: now + SIGN_IN_MINUTES * 60_000 };
  const authorizeAt = new URL('/login/oauth/authorize', githubWeb(env));
  authorizeAt.search = new URLSearchParams({
    client_id: github.clientId,
    redirect_uri: callbackUrl(env),
    state: pending.state,
    code_challenge: await pkceChallenge(pending.verifier),
    code_challenge_method: 'S256',
    login: github.login, // GitHub suggests the right account
    allow_signup: 'false',
  }).toString();
  const headers = new Headers({ location: authorizeAt.href, 'cache-control': 'no-store' });
  headers.append('set-cookie', cookie(SIGN_IN_COOKIE, await seal(pending, env.SESSION_SECRET!), SIGN_IN_MINUTES * 60));
  return new Response(null, { status: 303, headers });
}

/** Back from GitHub: check it is this browser's sign-in and the one account let in, then sign the browser in. */
async function finish(request: Request, env: Served, github: GitHubSignIn, now: number): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const pending = await unseal<Pending>(readCookie(request, SIGN_IN_COOKIE), env.SESSION_SECRET!);
  // A return without this browser's own sign-in, such as a link someone sent, goes nowhere.
  if (!pending || pending.state !== params.get('state') || !(pending.expires > now)) {
    throw new SignInError(400, 'This sign-in can’t go on', 'It was started in another browser, or more than 10 minutes ago. Sign in again.');
  }
  const code = params.get('code');
  if (!code) throw new SignInError(400, 'The sign-in was cancelled at GitHub', 'Nothing changed. Sign in again when you are ready.');
  const user = await whoSignedIn(env, github, code, pending.verifier, callbackUrl(env));
  const headers = pageHeaders();
  headers.append('set-cookie', clearCookie(SIGN_IN_COOKIE));
  if (String(user.id) !== github.userId) {
    console.warn(`Browser sign-in refused: GitHub account ${user.login} is not the owner.`);
    return new Response(wrongAccountPage(user.login, github.login, githubWeb(env)), { status: 403, headers });
  }
  const back = redirect(pending.next);
  back.headers.append('set-cookie', clearCookie(SIGN_IN_COOKIE));
  back.headers.append('set-cookie', await sessionCookie({ user: String(user.id), login: user.login }, env, now));
  return back;
}

/** Sign out: only a form from Quillipi's own pages may do it, so another site can't sign the owner out. */
function signOut(request: Request, env: Served): Response {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
  if (request.headers.get('origin') !== new URL(env.PUBLIC_URL).origin) return new Response('Sign out from Quillipi itself.', { status: 403 });
  const response = redirect('/signin');
  response.headers.append('set-cookie', clearCookie(SESSION_COOKIE));
  return response;
}

/** Any origin works for checking a path; this one can't be reached. */
const HERE = 'https://quillipi.invalid';

/**
 * Where to go after signing in: a path on this site only, so a link can't use Quillipi's sign-in
 * to send the owner somewhere else. `//evil.example` and `/\evil.example` are other sites to a
 * browser, and so is `/<tab>/evil.example`, because browsers drop tabs and line breaks from an
 * address. So control characters and backslashes are refused outright, and what is left must
 * still be a path here when a browser reads it.
 */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || /[\u0000-\u001f\u007f\\]/.test(next)) return '/';
  const url = new URL(next, HERE);
  return url.origin === HERE ? `${url.pathname}${url.search}${url.hash}` : '/';
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });
}

function callbackUrl(env: Served): string {
  return new URL('/signin/callback', env.PUBLIC_URL).href;
}
