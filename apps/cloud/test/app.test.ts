/**
 * The app in the cloud (step 3.4a), tested the way a browser uses it: signing in through the
 * stand-in GitHub, the session cookie, and the app's calls under /api, which reach the real
 * library and real notebook rooms on node:sqlite (fake-cloud.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeNext } from '../src/app-sign-in.js';
import worker, { type Env } from '../src/index.js';
import { SESSION_COOKIE, readSession, seal, sessionCookie, sessionStatus, unseal } from '../src/session.js';
import { SECRETS, SETTINGS, type SettingView, type Settings } from '../src/settings.js';
import { FakeCloud } from './fake-cloud.js';
import { FakeGitHub } from './fake-github.js';
import { FakeKV } from './fake-kv.js';

const ORIGIN = 'https://quillipi.example.workers.dev';
const SECRET = 'a-session-secret-of-at-least-32-characters';

/** No setting in the Worker at all, as on a fresh deploy. */
const NO_SETTINGS = Object.fromEntries(SETTINGS.map((name) => [name, undefined])) as Partial<Env>;
/** Only the Worker's secrets, as on a Quillipi that keeps its other settings inside itself. */
const ONLY_SECRETS = Object.fromEntries(SETTINGS.filter((name) => !SECRETS.has(name)).map((name) => [name, undefined])) as Partial<Env>;

/** The settings an env holds, as the library sees the Worker's. */
function settingsOf(env: Env): Settings {
  return Object.fromEntries(SETTINGS.map((name) => [name, env[name]]));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

interface App {
  env: Env;
  github: FakeGitHub;
  cloud: FakeCloud;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
}

/** The cloud with every setting in the Worker, but for `overrides`. `given` is the library and rooms, when a test sets them up itself. */
function app(overrides: Partial<Env> = {}, given?: FakeCloud): App {
  const github = new FakeGitHub();
  github.callbacks.push(`${ORIGIN}/signin/callback`);
  const values = {
    PUBLIC_URL: ORIGIN,
    COMMIT: 'abc1234',
    OWNER_NAME: 'The Octocat',
    OWNER_EMAIL: 'k@example.com',
    GITHUB_OWNER: 'octo-notebooks',
    GITHUB_CLIENT_ID: github.clientId,
    GITHUB_CLIENT_SECRET: github.clientSecret,
    GITHUB_USER_ID: '583231',
    GITHUB_USER_LOGIN: 'OctoCat',
    SESSION_SECRET: SECRET,
  };
  // The library sees the same variables and secrets as the Worker.
  const cloud = given ?? new FakeCloud({ worker: settingsOf({ ...values, ...overrides } as Env) });
  const env = { ...values, ...cloud.bindings, OAUTH_KV: new FakeKV(), ...overrides } as unknown as Env;
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => github.fetch(new Request(input, init)));
  const context = () => ({ waitUntil: () => {}, passThroughOnException: () => {}, props: {} }) as unknown as ExecutionContext;
  return { env, github, cloud, fetch: (input, init) => worker.fetch(new Request(new URL(input, ORIGIN), init), env, context()) };
}

/** A browser: it keeps this site's cookies, sends its own Origin on changes, and never follows redirects by itself. */
class Browser {
  readonly cookies = new Map<string, string>();

  constructor(private readonly app: App) {}

  async open(url: string, init: RequestInit = {}, origin: string | null = ORIGIN): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set('cookie', [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '));
    if (origin && init.method && init.method !== 'GET') headers.set('origin', origin);
    const response = await this.app.fetch(url, { ...init, headers, redirect: 'manual' });
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const at = pair!.indexOf('=');
      const [name, value] = [pair!.slice(0, at).trim(), pair!.slice(at + 1)];
      if (/max-age=0/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }

  post(url: string, body: unknown, origin: string | null = ORIGIN): Promise<Response> {
    return this.open(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, origin);
  }

  /** Continue with GitHub, through GitHub, and back. Returns the response to the return from GitHub. */
  async signIn(next = '/'): Promise<Response> {
    const toGitHub = await this.open('/signin', { method: 'POST', body: new URLSearchParams({ next }) });
    expect(toGitHub.status).toBe(303);
    const back = this.app.github.authorize(new URL(toGitHub.headers.get('location')!));
    return this.open(back.pathname + back.search);
  }
}

describe('signing the browser in', () => {
  it('shows one card, goes to GitHub with PKCE and the account hint, and comes back signed in', async () => {
    const a = app();
    const browser = new Browser(a);
    const page = await browser.open('/signin?next=%2Fn%2Fgym-rollup');
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Continue with GitHub');
    expect(html).toContain('<title>Sign in to Quillipi</title>');
    expect(html).toContain('<span>Quillipi</span>');
    expect(html).toContain('This Quillipi belongs to OctoCat.');
    expect(html).toContain('value="/n/gym-rollup"');
    expect(page.headers.get('content-security-policy')).toContain("form-action 'self' https://github.com");

    const toGitHub = await browser.open('/signin', { method: 'POST', body: new URLSearchParams({ next: '/n/gym-rollup' }) });
    const github = new URL(toGitHub.headers.get('location')!);
    expect(Object.fromEntries(github.searchParams)).toMatchObject({ client_id: a.github.clientId, redirect_uri: `${ORIGIN}/signin/callback`, code_challenge_method: 'S256', login: 'OctoCat' });
    expect(toGitHub.headers.getSetCookie()[0]).toMatch(/^__Host-inklog-signin=.+; Path=\/; Max-Age=600; Secure; HttpOnly; SameSite=Lax$/);

    const back = a.github.authorize(github);
    const home = await browser.open(back.pathname + back.search);
    expect(home.status).toBe(303);
    expect(home.headers.get('location')).toBe('/n/gym-rollup');
    expect([...browser.cookies.keys()]).toEqual([SESSION_COOKIE]);
    const cookie = home.headers.getSetCookie().find((line) => line.startsWith(`${SESSION_COOKIE}=`))!;
    expect(cookie).toMatch(/; Path=\/; Max-Age=7776000; Secure; HttpOnly; SameSite=Lax$/);
    // GitHub's token was used once, to ask who signed in.
    expect(a.github.requests).toEqual(['POST /login/oauth/access_token', 'GET /user']);

    expect(await (await browser.open('/api/me')).json()).toEqual({ login: 'OctoCat', name: 'The Octocat', github: 'octo-notebooks' });
    // Signed in, the sign-in page goes straight on.
    expect((await browser.open('/signin?next=%2Fagents')).headers.get('location')).toBe('/agents');
  });

  it('lets in no other GitHub account, even one with the name OctoCat, and gives it no cookie', async () => {
    for (const account of [{ id: 1234, login: 'someone-else' }, { id: 5678, login: 'OctoCat' }]) {
      const a = app();
      a.github.signedIn = account;
      const browser = new Browser(a);
      const back = await browser.signIn();
      expect(back.status).toBe(403);
      expect(await back.text()).toContain(`You’re signed in to GitHub as ${account.login}. Only OctoCat can use this Quillipi.`);
      expect(browser.cookies.size).toBe(0);
    }
  });

  it('refuses a return from GitHub in another browser, an old one, and one cancelled at GitHub', async () => {
    const a = app();
    const owner = new Browser(a);
    const toGitHub = await owner.open('/signin', { method: 'POST', body: new URLSearchParams({ next: '/' }) });
    const back = a.github.authorize(new URL(toGitHub.headers.get('location')!));
    // A link someone sends: another browser has no sign-in cookie.
    const elsewhere = await new Browser(a).open(back.pathname + back.search);
    expect(elsewhere.status).toBe(400);
    expect(await elsewhere.text()).toContain('It was started in another browser, or more than 10 minutes ago.');
    // The right browser but the wrong state.
    const forged = await owner.open(`/signin/callback?code=x&state=${'a'.repeat(43)}`);
    expect(forged.status).toBe(400);

    vi.useFakeTimers({ now: Date.now() });
    const b = new Browser(a);
    const later = await b.open('/signin', { method: 'POST', body: new URLSearchParams({ next: '/' }) });
    const backLater = a.github.authorize(new URL(later.headers.get('location')!));
    vi.setSystemTime(Date.now() + 11 * 60_000);
    expect((await b.open(backLater.pathname + backLater.search)).status).toBe(400);
    vi.useRealTimers();

    const c = new Browser(a);
    const going = await c.open('/signin', { method: 'POST', body: new URLSearchParams({ next: '/' }) });
    const state = new URL(going.headers.get('location')!).searchParams.get('state')!;
    const cancelled = await c.open(`/signin/callback?error=access_denied&state=${state}`);
    expect(cancelled.status).toBe(400);
    expect(await cancelled.text()).toContain('The sign-in was cancelled at GitHub');
    expect(c.cookies.has(SESSION_COOKIE)).toBe(false);
  });

  it('goes afterwards only to a path on this site', () => {
    expect(safeNext('/n/gym-rollup/s/plan?x=1')).toBe('/n/gym-rollup/s/plan?x=1');
    for (const elsewhere of ['https://evil.example', '//evil.example', '/\\evil.example', 'evil', '', null, '/a\r\nset-cookie: x']) expect(safeNext(elsewhere)).toBe('/');
  });

  it('never goes to another site through characters a browser drops or turns around (audit, 2026-11-20)', async () => {
    // Browsers drop tabs and line breaks from an address and read a backslash as a slash, so each
    // of these would be //evil.example to a browser.
    for (const trick of ['/\t/evil.example', '/\n/evil.example', '/\r/evil.example', '/\t\\evil.example', '/\\/evil.example', '/a\u0000b', '/a\u007fb']) {
      expect(safeNext(trick)).toBe('/');
    }
    expect(safeNext('/n/gym-rollup#plan')).toBe('/n/gym-rollup#plan');
    // The way the owner would meet it: a link to /signin while signed in goes straight on, so it must stay here.
    const a = app();
    const browser = new Browser(a);
    await browser.signIn();
    const response = await browser.open('/signin?next=/%09/evil.example');
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/');
  });

  it('signs out only from a form on Quillipi itself', async () => {
    const a = app();
    const browser = new Browser(a);
    await browser.signIn();
    expect((await browser.open('/signout', { method: 'POST' }, 'https://evil.example')).status).toBe(403);
    expect(browser.cookies.has(SESSION_COOKIE)).toBe(true);
    const out = await browser.open('/signout', { method: 'POST' });
    expect(out.headers.get('location')).toBe('/signin');
    expect(browser.cookies.has(SESSION_COOKIE)).toBe(false);
    expect((await browser.open('/api/me')).status).toBe(401);
  });

  it("signs in with Quillipi's own session secret when the Worker has none, and refuses a short one of the Worker's", async () => {
    const cloud = new FakeCloud();
    const a = app({ SESSION_SECRET: undefined }, cloud);
    const browser = new Browser(a);
    expect((await browser.signIn('/agents')).headers.get('location')).toBe('/agents');
    expect(await (await browser.open('/api/me')).json()).toMatchObject({ login: 'OctoCat' });
    // The cookie is signed with the secret the library made, which no page shows.
    const signed = browser.cookies.get(SESSION_COOKIE)!;
    expect(await unseal(signed, cloud.library.settings().SESSION_SECRET!)).toMatchObject({ user: '583231' });
    expect(await (await a.fetch('/status')).json()).toMatchObject({ app: 'ready' });

    const short = app({ SESSION_SECRET: 'short' });
    const page = await short.fetch('/signin');
    expect(page.status).toBe(503);
    expect(await page.text()).toContain('Quillipi’s browser sign-in is not set up: SESSION_SECRET is shorter than 32 characters.');
    expect(await (await short.fetch('/status')).json()).toMatchObject({ app: 'not set up: SESSION_SECRET is shorter than 32 characters' });
  });

  it('starts with no settings anywhere: leads to the setup, keeps its own session secret, and serves the address it is reached at', async () => {
    const cloud = new FakeCloud();
    const a = app(NO_SETTINGS, cloud);
    const missing = 'not set up: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_USER_ID, GITHUB_USER_LOGIN missing';
    expect(await (await a.fetch('/status')).json()).toMatchObject({ ok: true, notebooks: 'ok', github: 'not set up', setup: 'not done', signIn: missing, app: missing });
    // The app's sign-in and calls lead to the setup (setup.test.ts), and Claude is told to wait for it.
    const page = await a.fetch('/signin');
    expect(page.status).toBe(303);
    expect(page.headers.get('location')).toBe('/setup');
    const claude = await a.fetch('/authorize?response_type=code&client_id=anything');
    expect(claude.status).toBe(503);
    expect(await claude.text()).toContain('Quillipi isn’t set up yet');
    const me = await a.fetch('/api/me');
    expect(me.status).toBe(503);
    expect(await me.json()).toEqual({ error: 'Quillipi isn’t set up yet.', setup: '/setup' });
    expect(cloud.library.settings().SESSION_SECRET).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // With no address set anywhere, Quillipi serves the one it is reached at: on Cloudflare, its own.
    expect((await a.fetch('https://quillipi.someone.workers.dev/status')).status).toBe(200);
  });

  it('works with its non-secret settings kept in the library and only its secrets in the Worker, as after S3', async () => {
    const full = app();
    const cloud = new FakeCloud({ worker: settingsOf({ ...full.env, ...ONLY_SECRETS }) });
    // The copy the library made while the Worker still had its variables.
    cloud.library.keepSettings(settingsOf(full.env));
    const a = app(ONLY_SECRETS, cloud);
    expect(await (await a.fetch('/status')).json()).toMatchObject({ signIn: 'ready', app: 'ready' });
    expect((await a.fetch('https://quillipi.someone.workers.dev/status')).status).toBe(421);

    const browser = new Browser(a);
    expect((await browser.signIn('/agents')).headers.get('location')).toBe('/agents');
    expect(await (await browser.open('/api/me')).json()).toEqual({ login: 'OctoCat', name: 'The Octocat', github: 'octo-notebooks' });
    expect(await (await browser.post('/api/notebooks', { title: 'Gym rollup' })).json()).toMatchObject({ id: 'gym-rollup', createdBy: 'The Octocat' });

    const { settings } = (await (await browser.open('/api/settings')).json()) as { settings: SettingView[] };
    expect(settings.find((setting) => setting.name === 'OWNER_NAME')).toEqual({ name: 'OWNER_NAME', secret: false, from: 'quillipi', kept: true, value: 'The Octocat' });
    expect(settings.find((setting) => setting.name === 'GITHUB_CLIENT_SECRET')).toEqual({ name: 'GITHUB_CLIENT_SECRET', secret: true, from: 'worker', kept: false });
    // Every non-secret the Worker had is kept and used; this test's Worker never had a GitHub App.
    for (const setting of settings.filter((each) => !each.secret)) {
      expect(setting).toMatchObject(full.env[setting.name] === undefined ? { from: 'missing', kept: false } : { from: 'quillipi', kept: true, value: full.env[setting.name] });
    }
    const shown = JSON.stringify(settings);
    expect(shown).not.toContain(SECRET);
    expect(shown).not.toContain(a.github.clientSecret);
  });

  it('shows the settings only to the signed-in owner', async () => {
    const a = app();
    expect((await a.fetch('/api/settings')).status).toBe(401);
    const browser = new Browser(a);
    await browser.signIn();
    const { settings } = (await (await browser.open('/api/settings')).json()) as { settings: SettingView[] };
    expect(settings.find((setting) => setting.name === 'PUBLIC_URL')).toMatchObject({ from: 'worker', value: ORIGIN });
    expect(JSON.stringify(settings)).not.toContain(SECRET);
  });
});

describe('the session cookie', () => {
  const env = { SESSION_SECRET: SECRET, GITHUB_USER_ID: '583231', GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'y' } as unknown as Env;
  const withCookie = (value: string) => new Request(ORIGIN, { headers: { cookie: `other=1; ${SESSION_COOKIE}=${value}` } });
  const valueOf = (line: string) => line.slice(line.indexOf('=') + 1, line.indexOf(';'));

  it('is genuine only with this secret, unchanged, unexpired, and for the one account', async () => {
    const now = Date.UTC(2026, 10, 15);
    const value = valueOf(await sessionCookie({ user: '583231', login: 'OctoCat' }, env, now));
    expect(await readSession(withCookie(value), env, now + 1000)).toMatchObject({ session: { user: '583231', login: 'OctoCat' } });
    // Changed by a byte, signed with another secret, expired, or for another account: no session.
    const [body, signature] = value.split('.');
    const tampered = JSON.parse(atob(body!.replace(/-/g, '+').replace(/_/g, '/')));
    tampered.user = '1234';
    const forged = `${btoa(JSON.stringify(tampered)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.${signature}`;
    expect(await readSession(withCookie(forged), env, now)).toBeUndefined();
    expect(await readSession(withCookie(`${body}.${signature!.slice(0, -2)}AA`), env, now)).toBeUndefined();
    const other = valueOf(await sessionCookie({ user: '583231', login: 'OctoCat' }, { ...env, SESSION_SECRET: `${SECRET}-other` } as Env, now));
    expect(await readSession(withCookie(other), env, now)).toBeUndefined();
    expect(await readSession(withCookie(value), env, now + 91 * 24 * 60 * 60 * 1000)).toBeUndefined();
    const someoneElse = await seal({ user: '1234', login: 'x', issued: now, expires: now + 1e9 }, SECRET);
    expect(await readSession(withCookie(someoneElse), env, now)).toBeUndefined();
    expect(await readSession(withCookie('garbage'), env, now)).toBeUndefined();
    expect(await unseal('a.b.c', SECRET)).toBeUndefined();
  });

  it('is renewed when it is used and more than a day old, so 90 days count from the last use', async () => {
    const now = Date.UTC(2026, 10, 15);
    const value = valueOf(await sessionCookie({ user: '583231', login: 'OctoCat' }, env, now));
    expect((await readSession(withCookie(value), env, now + 60 * 60 * 1000))!.renew).toBeUndefined();
    const renewed = (await readSession(withCookie(value), env, now + 2 * 24 * 60 * 60 * 1000))!.renew!;
    expect(renewed).toMatch(/^__Host-inklog=.+; Max-Age=7776000;/);
    expect(await readSession(withCookie(valueOf(renewed)), env, now + 91 * 24 * 60 * 60 * 1000)).toBeDefined();
  });

  it('needs a secret of at least 32 characters', () => {
    expect(sessionStatus({ SESSION_SECRET: 'x'.repeat(31) } as Env)).toBe('not set up: SESSION_SECRET is shorter than 32 characters');
    expect(sessionStatus({ SESSION_SECRET: 'x'.repeat(32) } as Env)).toBe('ready');
  });
});

describe("the app's calls", () => {
  async function signedIn() {
    const a = app();
    const browser = new Browser(a);
    await browser.signIn();
    return { a, browser };
  }

  it('need the session, and changes need Quillipi’s own Origin', async () => {
    const { a, browser } = await signedIn();
    const anonymous = await a.fetch('/api/home');
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: 'Sign in to Quillipi first.', signIn: '/signin' });
    expect((await browser.post('/api/notebooks', { title: 'Gym rollup' }, 'https://evil.example')).status).toBe(403);
    expect((await browser.post('/api/notebooks', { title: 'Gym rollup' }, null)).status).toBe(403);
    // A live connection from another site is refused the same way.
    expect((await browser.open('/api/library/ws', { headers: { upgrade: 'websocket', origin: 'https://evil.example' } }, null)).status).toBe(403);
    expect(a.cloud.library.cards()).toEqual([]);
  });

  it('make a notebook with New notebook, and Home gets everything in one request, with the visit before', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 15, 9), toFake: ['Date'] });
    const { a, browser } = await signedIn();
    const made = await browser.post('/api/notebooks', { title: 'Gym rollup', about: 'Standardise gyms', colour: '#c4413b' });
    expect(await made.json()).toMatchObject({ id: 'gym-rollup', title: 'Gym rollup', about: 'Standardise gyms', colour: '#c4413b', createdBy: 'The Octocat', from: 'new' });
    expect(await (await browser.post('/api/notebooks', { title: 'Gym rollup' })).json()).toMatchObject({ id: 'gym-rollup-2' });
    expect(await (await browser.post('/api/notebooks', { title: '   ' })).json()).toEqual({ error: 'A new notebook needs a title.' });

    const first = (await (await browser.open('/api/home')).json()) as { me: unknown; cards: { id: string }[]; lastVisit?: number; default?: string };
    expect(first.me).toEqual({ login: 'OctoCat', name: 'The Octocat', github: 'octo-notebooks' });
    expect(first.cards.map((card) => card.id).sort()).toEqual(['gym-rollup', 'gym-rollup-2']);
    expect(first.lastVisit).toBeUndefined();
    expect(first.default).toBe('gym-rollup');
    vi.setSystemTime(Date.UTC(2026, 10, 15, 10));
    expect(await (await browser.open('/api/home')).json()).toMatchObject({ lastVisit: Date.UTC(2026, 10, 15, 9) });
    expect(a.cloud.library.card('gym-rollup')?.summary).toMatchObject({ title: 'Gym rollup', sections: 1, commits: 1 });
  });

  it("say whether a copy's updates are on, as its build found them, and only for a repository named plainly", async () => {
    const home = async (env: Partial<Env>) => {
      const browser = new Browser(app(env));
      await browser.signIn();
      return { home: (await (await browser.open('/api/home')).json()) as { updates?: unknown }, alone: await (await browser.open('/api/updates')).json() };
    };
    // This repository's own Quillipi: no copy's repository, so no Turn on updates.
    expect(await home({})).toEqual({ home: expect.not.objectContaining({ updates: expect.anything() }), alone: {} });
    const missing = await home({ REPOSITORY: 'Ki-met/quillipi', UPDATE_WORKFLOW: 'missing' });
    expect(missing.home.updates).toEqual({ repository: 'Ki-met/quillipi', on: false });
    expect(missing.alone).toEqual({ updates: { repository: 'Ki-met/quillipi', on: false } });
    expect((await home({ REPOSITORY: 'Ki-met/quillipi', UPDATE_WORKFLOW: 'found' })).alone).toEqual({ updates: { repository: 'Ki-met/quillipi', on: true } });
    for (const odd of ['Ki-met', 'Ki-met/quillipi?x=1', 'a/b/c', 'Ki-met/..', '"><script>']) expect((await home({ REPOSITORY: odd })).alone, odd).toEqual({});
  });

  it('archive a notebook, choose the default, and list the notebooks', async () => {
    const { browser } = await signedIn();
    await browser.post('/api/notebooks', { title: 'Gym rollup' });
    await browser.post('/api/notebooks', { title: 'KiMet' });
    expect(await (await browser.post('/api/default', { id: 'kimet' })).json()).toEqual({ ok: true });
    expect(await (await browser.open('/api/home')).json()).toMatchObject({ default: 'kimet' });
    expect(await (await browser.post('/api/default', { id: 'nope' })).json()).toEqual({ error: 'No notebook "nope".' });
    expect(await (await browser.post('/api/notebooks/gym-rollup/archive', { archived: true })).json()).toMatchObject({ id: 'gym-rollup', archived: true });
    expect(await (await browser.open('/api/notebooks')).json()).toEqual({ notebooks: [{ id: 'kimet', name: 'KiMet' }] });
    expect(await (await browser.post('/api/notebooks/gym-rollup/archive', { archived: false })).json()).toMatchObject({ archived: false });
  });

  it("reach a notebook's room only when the library has it, so an unknown name makes nothing", async () => {
    const { a, browser } = await signedIn();
    const unknown = await browser.open('/api/n/nope/repo');
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'No notebook "nope".' });
    expect(a.cloud.rooms.has('nope')).toBe(false);

    await browser.post('/api/notebooks', { title: 'Gym rollup' });
    expect(await (await browser.open('/api/n/gym-rollup/repo')).json()).toMatchObject({ name: 'Gym rollup', sections: [{ id: 'about', title: 'About' }], backup: { state: 'off' } });
    expect(await (await browser.post('/api/n/gym-rollup/details', { name: 'Gyms' })).json()).toMatchObject({ commit: { number: 2, message: 'Rename the notebook to “Gyms”' } });
    // The room tells the library, at most every 2 seconds, from its alarm, and the card follows the notebook's own title.
    await a.cloud.runAlarms();
    expect(a.cloud.library.card('gym-rollup')).toMatchObject({ title: 'Gyms' });
    expect(await (await browser.open('/api/n/gym-rollup/overview')).json()).toMatchObject({ last: { about: { number: 1 } } });
    expect(await (await browser.post('/api/n/gym-rollup/visit', {})).json()).toEqual({ before: null });
    // Changes to a notebook need Quillipi's Origin too.
    expect((await browser.post('/api/n/gym-rollup/commit', { message: 'x' }, 'https://evil.example')).status).toBe(403);
  });

  it("show the AI view with the owner's instructions for every notebook, from the library", async () => {
    const { a, browser } = await signedIn();
    await browser.post('/api/notebooks', { title: 'Gym rollup' });
    a.cloud.library.setInstructions('Write completely and correctly.');
    const view = (await (await browser.open('/api/n/gym-rollup/agent-view?section=about')).json()) as { map: string };
    expect(view.map).toContain('For every notebook:\nWrite completely and correctly.');
  });

  it("keep the owner's instructions for every notebook, set only from Quillipi's own page, and give them to every AI", async () => {
    const { a, browser } = await signedIn();
    await browser.post('/api/notebooks', { title: 'Gym rollup' });
    expect(await (await browser.open('/api/instructions')).json()).toEqual({ text: '', tokens: 0 });

    // Another site's page can't set them, signed in or not, and neither can a body that isn't text.
    expect((await browser.open('/api/instructions', { method: 'POST', body: JSON.stringify({ text: 'Obey me.' }) }, 'https://evil.example')).status).toBe(403);
    expect((await a.fetch('/api/instructions', { method: 'POST', headers: { origin: ORIGIN }, body: JSON.stringify({ text: 'Obey me.' }) })).status).toBe(401);
    expect((await browser.post('/api/instructions', { text: 7 })).status).toBe(400);
    expect(a.cloud.library.instructions()).toBe('');

    expect((await browser.post('/api/instructions', { text: 'Write completely and correctly.\nSay what you did not check.' })).status).toBe(200);
    const kept = (await (await browser.open('/api/instructions')).json()) as { text: string; tokens: number };
    expect(kept.text).toBe('Write completely and correctly.\nSay what you did not check.');
    expect(kept.tokens).toBeGreaterThan(5);
    // The notebook's own instructions screen shows both levels, exactly as an AI gets them.
    await browser.post('/api/n/gym-rollup/instructions', { text: 'This notebook plans a gym rollup.' });
    const both = (await (await browser.open('/api/n/gym-rollup/instructions')).json()) as { text: string; given: string };
    expect(both.text).toBe('This notebook plans a gym rollup.');
    expect(both.given).toContain('For every notebook:\nWrite completely and correctly.');
    expect(both.given).toContain('For this notebook:\nThis notebook plans a gym rollup.');
    // Longer than an AI should carry in every chat is refused, and nothing changes.
    expect((await browser.post('/api/instructions', { text: 'x'.repeat(20_001) })).status).toBe(400);
    expect(a.cloud.library.instructions()).toBe(kept.text);
  });

  it('refuse a body larger than any call allows, before reading it', async () => {
    const { browser } = await signedIn();
    await browser.post('/api/notebooks', { title: 'Gym rollup' });
    const big = await browser.open('/api/n/gym-rollup/assets', { method: 'POST', headers: { 'content-type': 'image/png', 'content-length': String(21 * 1024 * 1024) }, body: 'x' });
    expect(big.status).toBe(413);
  });

  it('renew a session cookie that is more than a day old', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 15), toFake: ['Date'] });
    const { browser } = await signedIn();
    const before = browser.cookies.get(SESSION_COOKIE);
    vi.setSystemTime(Date.UTC(2026, 10, 17));
    const answer = await browser.open('/api/me');
    expect(answer.status).toBe(200);
    expect(answer.headers.getSetCookie()[0]).toMatch(/^__Host-inklog=/);
    expect(browser.cookies.get(SESSION_COOKIE)).not.toBe(before);
  });
});
