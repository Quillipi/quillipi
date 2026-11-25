/**
 * The first-time setup (S2), tested the way a newcomer goes through it: a fresh Quillipi whose Worker
 * knows only the owner's GitHub username, a browser that keeps cookies, and a stand-in GitHub that
 * makes the organization's App from Quillipi's manifest, installs it and signs the owner in. The
 * library and its storage are real (fake-cloud.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index.js';
import { Budget, GitHubApp } from '../src/github.js';
import { SETUPS_KEPT, SETUP_MS } from '../src/library.js';
import { SETTINGS, type Settings } from '../src/settings.js';
import { manifest } from '../src/setup.js';
import { setupPage } from '../src/pages.js';
import { FakeCloud } from './fake-cloud.js';
import { FakeGitHub } from './fake-github.js';
import { FakeKV } from './fake-kv.js';

const ORIGIN = 'https://quillipi.octocat.workers.dev';
const ORG = 'octo-notebooks';
/** What a fresh deploy's Worker holds: the deploy form's one field, the owner's GitHub username. */
const DEPLOYED: Settings = { GITHUB_USER_LOGIN: 'OctoCat' };

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Fresh {
  env: Env;
  github: FakeGitHub;
  cloud: FakeCloud;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
}

/** A just-deployed Quillipi: no setting in the Worker but `worker`, and nothing in the library. */
function fresh(worker_: Settings = DEPLOYED, given?: FakeCloud): Fresh {
  const github = new FakeGitHub({ owner: ORG });
  github.signedIn = { id: 583231, login: 'OctoCat', name: 'The Octocat' };
  const cloud = given ?? new FakeCloud({ worker: worker_ });
  const none = Object.fromEntries(SETTINGS.map((name) => [name, undefined]));
  const env = { ...none, COMMIT: 'abc1234', ...worker_, ...cloud.bindings, OAUTH_KV: new FakeKV() } as unknown as Env;
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => github.fetch(new Request(input, init)));
  const context = () => ({ waitUntil: () => {}, passThroughOnException: () => {}, props: {} }) as unknown as ExecutionContext;
  return { env, github, cloud, fetch: (input, init) => worker.fetch(new Request(new URL(input, ORIGIN), init), env, context()) };
}

/** A browser: it keeps this site's cookies, sends its Origin on a form, and never follows a redirect by itself. */
class Browser {
  readonly cookies = new Map<string, string>();

  constructor(private readonly site: Fresh) {}

  async open(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set('cookie', [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '));
    if (init.method === 'POST' && !headers.has('origin')) headers.set('origin', ORIGIN);
    const response = await this.site.fetch(url, { ...init, headers, redirect: 'manual' });
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const at = pair!.indexOf('=');
      const [name, value] = [pair!.slice(0, at).trim(), pair!.slice(at + 1)];
      if (/max-age=0/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }

  post(path: string, form: Record<string, string> = {}): Promise<Response> {
    return this.open(path, { method: 'POST', body: new URLSearchParams(form) });
  }

  /** Follows a redirect back to Quillipi from GitHub's side, which hands the browser a full address. */
  back(url: URL): Promise<Response> {
    expect(url.origin).toBe(ORIGIN);
    return this.open(url.pathname + url.search);
  }

  async page(): Promise<string> {
    const response = await this.open('/setup');
    expect(response.status).toBe(200);
    return response.text();
  }
}

/** The manifest form on the setup page, as the browser would post it to GitHub. */
function manifestForm(html: string): { action: URL; form: URLSearchParams } {
  const match = /<form method="post" action="([^"]+)">\s*<input type="hidden" name="manifest" value="([^"]+)">/.exec(html);
  if (!match) throw new Error('No manifest form on the page');
  return { action: new URL(unescape(match[1]!)), form: new URLSearchParams({ manifest: unescape(match[2]!) }) };
}

/** The Install link on the setup page. */
function installLink(html: string): URL {
  return new URL(unescape(/<a class="button primary" href="([^"]+)">Install on/.exec(html)![1]!));
}

function unescape(text: string): string {
  return text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Steps 2 and 3: the organization, then the App made on GitHub and handed back. */
async function throughTheApp(site: Fresh, browser: Browser): Promise<string> {
  expect((await browser.post('/setup/organization', { organization: ORG })).headers.get('location')).toBe('/setup');
  const { action, form } = manifestForm(await browser.page());
  const back = await browser.back(site.github.createApp(action, form));
  expect(back.headers.get('location')).toBe('/setup');
  return browser.page();
}

/** Step 4: installed, back to Quillipi, and on to GitHub's sign-in; returns the return from it. */
async function throughTheInstall(site: Fresh, browser: Browser, html: string): Promise<Response> {
  const toSignIn = await browser.back(site.github.install(installLink(html)));
  expect(toSignIn.status).toBe(303);
  return browser.back(site.github.authorize(new URL(toSignIn.headers.get('location')!)));
}

describe('a fresh Quillipi', () => {
  it('leads every way in to the setup, and Claude is told to wait for it', async () => {
    const site = fresh();
    expect(await (await site.fetch('/status')).json()).toMatchObject({ ok: true, setup: 'not done' });
    const me = await site.fetch('/api/me');
    expect(me.status).toBe(503);
    expect(await me.json()).toEqual({ error: 'Quillipi isn’t set up yet.', setup: '/setup' });
    const signIn = await site.fetch('/signin?next=/agents');
    expect([signIn.status, signIn.headers.get('location')]).toEqual([303, '/setup']);
    const claude = await site.fetch('/authorize?response_type=code&client_id=anything');
    expect(claude.status).toBe(503);
    expect(await claude.text()).toContain('Quillipi isn’t set up yet');

    const page = await site.fetch('/setup');
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<h1>Set up your Quillipi</h1>');
    expect(html).toContain('For the GitHub account <strong>OctoCat</strong> · about 3 minutes');
    expect(html).toContain('That is the GitHub username given when this Quillipi was deployed (<code>GITHUB_USER_LOGIN</code>). Only that account can finish the setup and use this Quillipi.');
    // Step 1 is done (its address), step 2 is open, 3 and 4 wait.
    expect(html.match(/<li class="(\w+)"/g)).toEqual(['<li class="done"', '<li class="current"', '<li class="waiting"', '<li class="waiting"']);
    expect(html).toContain('<code>quillipi.octocat.workers.dev</code>');
    expect(html).toContain('placeholder="octocat-notebooks"');
    expect(html).not.toContain('Start again');
    // A page with no scripts, which can't be framed, whose forms go only here and to GitHub.
    expect(page.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://github.com; frame-ancestors 'none'; base-uri 'none'");
    expect(html).not.toContain('<script');
  });

  it('is set up in four steps, from nothing to Home, signed in', async () => {
    const site = fresh();
    const browser = new Browser(site);
    const started = await browser.post('/setup/organization', { organization: ` ${ORG.toUpperCase()} ` });
    expect(started.status).toBe(303);
    expect(browser.cookies.has('__Host-inklog-setup')).toBe(true);
    // The cookie holds only the setup's ID, signed; the App's keys never travel in it.
    expect(started.headers.getSetCookie()[0]).toMatch(/^__Host-inklog-setup=[\w-]+\.[\w-]+; Path=\/; Max-Age=3600; Secure; HttpOnly; SameSite=Lax$/);

    let html = await browser.page();
    expect(html.match(/<li class="(\w+)"/g)).toEqual(['<li class="done"', '<li class="done"', '<li class="current"', '<li class="waiting"']);
    // GitHub spells the organization's name its own way, and Quillipi keeps that.
    expect(html).toContain(`github.com/${ORG}</a>`);
    expect(html).toContain('Start again');
    const { action, form } = manifestForm(html);
    expect(action.href).toMatch(new RegExp(`^https://github\\.com/organizations/${ORG}/settings/apps/new\\?state=[\\w-]{43}$`));
    expect(JSON.parse(form.get('manifest')!)).toEqual(manifest(ORIGIN, ORG));
    expect(manifest(ORIGIN, ORG)).toMatchObject({
      name: 'Quillipi octo-notebooks',
      public: false,
      hook_attributes: { active: false },
      redirect_url: `${ORIGIN}/setup/app`,
      callback_urls: [`${ORIGIN}/callback`, `${ORIGIN}/signin/callback`, `${ORIGIN}/setup/callback`],
      setup_url: `${ORIGIN}/setup/installed`,
      request_oauth_on_install: false,
      default_permissions: { contents: 'write', metadata: 'read', repository_creation: 'write' },
    });

    // On GitHub: Create GitHub App, and back with a one-time code that Quillipi trades for the App.
    expect((await browser.back(site.github.createApp(action, form))).headers.get('location')).toBe('/setup');
    html = await browser.page();
    expect(html.match(/<li class="(\w+)"/g)).toEqual(['<li class="done"', '<li class="done"', '<li class="done"', '<li class="current"']);
    expect(html).toContain('Quillipi octo-notebooks</a>, made in your organization');
    // Nothing is kept before the owner signs in: Quillipi isn't set up, and no setting is in the library yet.
    expect(site.cloud.library.settings().GITHUB_APP_ID).toBeUndefined();
    expect(html).not.toContain(site.github.clientSecret);
    expect(html).not.toContain('PRIVATE KEY');

    // Install on the organization; GitHub returns to the setup, which checks and goes on to sign in.
    const toSignIn = await browser.back(site.github.install(installLink(html)));
    expect(toSignIn.status).toBe(303);
    const signIn = new URL(toSignIn.headers.get('location')!);
    expect(Object.fromEntries(signIn.searchParams)).toMatchObject({ client_id: site.github.clientId, redirect_uri: `${ORIGIN}/setup/callback`, code_challenge_method: 'S256', login: 'OctoCat', allow_signup: 'false' });
    const home = await browser.back(site.github.authorize(signIn));
    expect([home.status, home.headers.get('location')]).toEqual([303, '/']);
    expect(browser.cookies.has('__Host-inklog-setup')).toBe(false);
    expect(browser.cookies.has('__Host-inklog')).toBe(true);

    // Quillipi is set up, with everything kept in the library, secrets included.
    expect(site.cloud.library.settings()).toMatchObject({
      PUBLIC_URL: ORIGIN,
      OWNER_NAME: 'The Octocat',
      OWNER_EMAIL: '583231+OctoCat@users.noreply.github.com',
      GITHUB_OWNER: ORG,
      GITHUB_APP_ID: site.github.appId,
      GITHUB_APP_PRIVATE_KEY: site.github.privateKey,
      GITHUB_CLIENT_ID: site.github.clientId,
      GITHUB_CLIENT_SECRET: site.github.clientSecret,
      GITHUB_USER_ID: '583231',
      GITHUB_USER_LOGIN: 'OctoCat',
    });
    expect(await (await site.fetch('/status')).json()).toMatchObject({ setup: 'done', github: 'ready', signIn: 'ready', app: 'ready' });
    expect(await (await browser.open('/api/me')).json()).toEqual({ login: 'OctoCat', name: 'The Octocat', github: ORG });
    expect(await (await browser.open('/api/home')).json()).toMatchObject({ cards: [], aiConnected: false });
    // The setup is over, for everyone.
    expect((await browser.open('/setup')).headers.get('location')).toBe('/');
    expect((await site.fetch('/setup/organization', { method: 'POST', headers: { origin: ORIGIN } })).headers.get('location')).toBe('/');
    // Only Quillipi's address is served now.
    expect((await site.fetch('https://quillipi.elsewhere.workers.dev/status')).status).toBe(421);

    // The App Quillipi was handed works with what was kept: it is installed on the whole
    // organization and makes a notebook's repo there.
    const kept = site.cloud.library.settings();
    const app = new GitHubApp({ appId: kept.GITHUB_APP_ID!, privateKey: kept.GITHUB_APP_PRIVATE_KEY!, owner: kept.GITHUB_OWNER!, fetch: site.github.fetch });
    expect(await app.organizationInstallation(new Budget(5))).toEqual({ id: 77, allRepositories: true });
    expect(await app.createRepo('gym-rollup', 'A test', new Budget(5))).toBe('made');
  });

  it('can be finished only by the account named at deploy, and keeps nothing until then', async () => {
    const site = fresh();
    const browser = new Browser(site);
    const html = await throughTheApp(site, browser);
    site.github.signedIn = { id: 99, login: 'someone-else' };
    const refused = await throughTheInstall(site, browser, html);
    expect(refused.status).toBe(400);
    const page = await refused.text();
    expect(page).toContain('Only OctoCat can set up this Quillipi. You signed in to GitHub as someone-else.');
    expect(page).toContain('href="https://github.com/logout"');
    expect(page).toContain('<form method="post" action="/setup/signin"><button type="submit" class="primary">Sign in again</button></form>');
    expect(site.cloud.library.settings().GITHUB_USER_ID).toBeUndefined();
    expect(await (await site.fetch('/status')).json()).toMatchObject({ setup: 'not done' });

    // The right account, from the same browser: Sign in again, and done.
    site.github.signedIn = { id: 583231, login: 'OctoCat' };
    const toGitHub = await browser.post('/setup/signin');
    const home = await browser.back(site.github.authorize(new URL(toGitHub.headers.get('location')!)));
    expect(home.headers.get('location')).toBe('/');
    // With no name on the GitHub profile, commits are made as the username.
    expect(site.cloud.library.settings()).toMatchObject({ GITHUB_USER_ID: '583231', OWNER_NAME: 'OctoCat' });
  });

  it('belongs to the browser that started it: returns from GitHub elsewhere, or with another state, change nothing', async () => {
    const site = fresh();
    const owner = new Browser(site);
    await owner.post('/setup/organization', { organization: ORG });
    const { action, form } = manifestForm(await owner.page());
    const fromGitHub = site.github.createApp(action, form);

    // Another browser (a link someone sent) gets nowhere, and the code is left unused.
    const stranger = new Browser(site);
    const elsewhere = await stranger.back(fromGitHub);
    expect(elsewhere.status).toBe(400);
    expect(await elsewhere.text()).toContain('This setup isn’t here any more');
    // In the owner's browser, a return with another state is refused, and the code still unused.
    const forged = new URL(fromGitHub);
    forged.searchParams.set('state', 'not-this-setups-state');
    const refused = await owner.back(forged);
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('doesn’t belong to the setup in this browser');
    expect(site.github.requests.filter((request) => request.includes('/conversions'))).toEqual([]);
    expect((await owner.back(fromGitHub)).headers.get('location')).toBe('/setup');

    // Steps that change something must come from the setup page itself.
    const posted = await site.fetch('/setup/organization', { method: 'POST', headers: { origin: 'https://evil.example' }, body: new URLSearchParams({ organization: ORG }) });
    expect(posted.status).toBe(403);
    // The sign-in's return must carry the state Quillipi sent.
    const html = await owner.page();
    const toSignIn = await owner.back(site.github.install(installLink(html)));
    const back = site.github.authorize(new URL(toSignIn.headers.get('location')!));
    back.searchParams.set('state', 'another');
    expect((await owner.back(back)).status).toBe(400);
    expect(site.cloud.library.settings().GITHUB_USER_ID).toBeUndefined();
  });

  it('keeps no App that GitHub says belongs to another account', async () => {
    const site = fresh();
    const browser = new Browser(site);
    await browser.post('/setup/organization', { organization: ORG });
    const { action, form } = manifestForm(await browser.page());
    const back = site.github.createApp(action, form);
    site.github.addAccount('someone-elses-org', 5, 'Organization');
    site.github.app!.owner = 'someone-elses-org';
    const refused = await browser.back(back);
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('The App was made under someone-elses-org, not octo-notebooks.');
    expect(await browser.page()).toContain('name="manifest"');
  });

  it('says before each button where it goes, what to press there, and how it comes back', () => {
    const view = { owner: 'OctoCat', address: 'https://quillipi.octocat.workers.dev', github: 'https://github.com', started: true, suggestion: 'octocat-notebooks', organization: 'octo-notebooks' };
    const steps = (page: string) => [...page.matchAll(/<div class="how">(.*?)<\/div>/g)].map((found) => [...found[1]!.matchAll(/<li>(.*?)<\/li>/g)].map((line) => line[1]));
    expect(steps(setupPage({ ...view, step: 2 }))).toEqual([[
      'The button opens GitHub’s page for a new organization, in a new tab.',
      'There, type a name for it and your email, choose <em>My personal account</em>, and press <em>Next</em>. If GitHub then asks you to add people, skip it.',
      'Come back to this tab and type the same name below.',
    ]]);
    expect(steps(setupPage({ ...view, step: 3, manifest: { action: 'https://github.com/organizations/octo-notebooks/settings/apps/new?state=s', json: '{}' } }))).toEqual([[
      'The button takes you to GitHub, in this tab, with Quillipi’s App already filled in.',
      'There, press the green <em>Create GitHub App</em> button at the bottom.',
      'GitHub brings you back here by itself, to the last step.',
    ]]);
    expect(steps(setupPage({ ...view, step: 4, installUrl: 'https://github.com/apps/quillipi-octo-notebooks/installations/new' }))).toEqual([[
      'The button takes you to GitHub’s page for installing the App, in this tab.',
      'There, choose <em>All repositories</em> and press <em>Install</em>.',
      'GitHub brings you back, and Quillipi signs you in with GitHub by itself; if GitHub asks, press <em>Authorize</em>. Then your Quillipi opens.',
    ]]);
  });

  it('shows the owner’s name from the Worker only as text', async () => {
    const page = await (await fresh({ GITHUB_USER_LOGIN: '<img src=x onerror=alert(1)>' }).fetch('/setup')).text();
    expect(page).toContain('For the GitHub account <strong>&lt;img src=x onerror=alert(1)&gt;</strong> · about 3 minutes');
    expect(page).not.toContain('<img');
  });

  it('checks the organization with GitHub: a person’s account or no account is refused, and an unreachable GitHub is no stop', async () => {
    const site = fresh();
    const browser = new Browser(site);
    const tries: [string, string][] = [
      ['OctoCat', 'OctoCat is a personal account. Quillipi needs an organization'],
      ['nobody-here', 'GitHub has no account called “nobody-here”.'],
      ['two--hyphens', 'can’t be a GitHub organization’s name'],
      ['', 'Type the organization’s name.'],
    ];
    for (const [name, says] of tries) {
      const page = await browser.post('/setup/organization', { organization: name });
      expect(page.status, name).toBe(400);
      expect(await page.text()).toContain(says);
    }
    expect(browser.cookies.size).toBe(0);
    // A link to the organization works as its name.
    expect((await browser.post('/setup/organization', { organization: `https://github.com/${ORG}` })).status).toBe(303);

    // GitHub allows only a few lookups an hour without a key; then the name is kept as typed.
    const limited = fresh();
    limited.github.use(async (request, next) => (new URL(request.url).pathname.startsWith('/users/') ? new Response('{"message":"API rate limit exceeded"}', { status: 403 }) : next(request)));
    const other = new Browser(limited);
    expect((await other.post('/setup/organization', { organization: 'Octo-Notebooks' })).status).toBe(303);
    expect(await other.page()).toContain('github.com/Octo-Notebooks</a>');
  });

  it('asks for the permission to make repos when GitHub made the App without it, and checks again', async () => {
    const site = fresh();
    site.github.dropPermissions = ['repository_creation'];
    const browser = new Browser(site);
    const html = await throughTheApp(site, browser);
    expect(html.match(/<li class="(\w+)"/g)).toEqual(['<li class="done"', '<li class="done"', '<li class="current"', '<li class="waiting"']);
    expect(html).toContain('The App can’t make repos');
    expect(html).toContain(`href="https://github.com/organizations/${ORG}/settings/apps/quillipi-octo-notebooks/permissions"`);
    expect(html).not.toContain('name="manifest"');

    // Still without it: the same.
    expect((await browser.post('/setup/app/check')).headers.get('location')).toBe('/setup');
    expect(await browser.page()).toContain('The App can’t make repos');
    // Set on GitHub: step 4 opens.
    site.github.app!.permissions.repository_creation = 'write';
    await browser.post('/setup/app/check');
    expect((await browser.page()).match(/<li class="(\w+)"/g)?.at(-1)).toBe('<li class="current"');
  });

  it('trusts no installation_id: it asks GitHub, and asks for All repositories', async () => {
    const site = fresh();
    const browser = new Browser(site);
    const html = await throughTheApp(site, browser);
    const install = installLink(html);
    // A made-up return before anything is installed.
    const early = await browser.open(`/setup/installed?installation_id=77&setup_action=install&state=${install.searchParams.get('state')}`);
    expect(early.status).toBe(400);
    expect(await early.text()).toContain(`The App isn’t installed on ${ORG} yet.`);

    // Installed on some repositories only.
    site.github.selection = 'selected';
    const some = await browser.back(site.github.install(install));
    expect(some.status).toBe(400);
    const page = await some.text();
    expect(page).toContain('installed on only some of octo-notebooks’s repositories');
    expect(page).toContain(`href="https://github.com/organizations/${ORG}/settings/installations/77"`);
    expect(page).toContain('href="/setup/installed">Check again</a>');
    expect(page).not.toContain('Install on octo-notebooks</a>');

    // Changed on GitHub: GitHub returns without a state (setup_on_update), or Check again is pressed.
    site.github.selection = 'all';
    const again = await browser.open('/setup/installed?installation_id=77&setup_action=update');
    expect(again.status).toBe(303);
    expect(new URL(again.headers.get('location')!).pathname).toBe('/login/oauth/authorize');
  });

  it('starts again on request, and forgets a setup left for an hour', async () => {
    const site = fresh();
    const browser = new Browser(site);
    await throughTheApp(site, browser);
    const restarted = await browser.post('/setup/restart');
    expect(restarted.headers.get('location')).toBe('/setup');
    expect(browser.cookies.has('__Host-inklog-setup')).toBe(false);
    expect((await browser.page()).match(/<li class="(\w+)"/g)?.[1]).toBe('<li class="current"');

    await browser.post('/setup/organization', { organization: ORG });
    site.cloud.clock.now += SETUP_MS + 1;
    const html = await browser.page();
    expect(html.match(/<li class="(\w+)"/g)?.[1]).toBe('<li class="current"');
    const late = await browser.post('/setup/app/check');
    expect(late.status).toBe(400);
    expect(await late.text()).toContain('left for more than an hour');
  });

  it('says what to do when it doesn’t know its owner, or the Worker already holds some settings', async () => {
    const nameless = await fresh({}).fetch('/setup');
    expect(nameless.status).toBe(503);
    expect(await nameless.text()).toContain('Set your GitHub username as the variable GITHUB_USER_LOGIN');

    const half = await fresh({ ...DEPLOYED, GITHUB_APP_ID: '123', GITHUB_CLIENT_ID: 'Iv23old' }).fetch('/setup');
    expect(half.status).toBe(409);
    expect(await half.text()).toContain('This Worker already holds GITHUB_APP_ID, GITHUB_CLIENT_ID');
  });

  it('is never shown on a Quillipi whose Worker holds every setting', async () => {
    const handMade: Settings = {
      PUBLIC_URL: ORIGIN,
      OWNER_NAME: 'The Octocat',
      OWNER_EMAIL: '583231+OctoCat@users.noreply.github.com',
      GITHUB_OWNER: 'octo-notebooks',
      GITHUB_APP_ID: '1234567',
      GITHUB_APP_PRIVATE_KEY: 'a key',
      GITHUB_CLIENT_ID: 'Iv23liExampleClient0',
      GITHUB_CLIENT_SECRET: 'secret',
      GITHUB_USER_ID: '583231',
      GITHUB_USER_LOGIN: 'OctoCat',
      SESSION_SECRET: 'a-session-secret-of-at-least-32-characters',
    };
    const site = fresh(handMade);
    for (const path of ['/setup', '/setup/organization', '/setup/callback?code=x&state=y']) {
      const response = await site.fetch(path);
      expect([path, response.status, response.headers.get('location')]).toEqual([path, 303, '/']);
    }
    expect(await (await site.fetch('/status')).json()).toMatchObject({ setup: 'done' });
    expect(site.cloud.settingsAsked).toBe(0);
  });
});

describe('setups in progress, in the library', () => {
  it('are kept for an hour after their last step, at most a few at once, the oldest going first', () => {
    const cloud = new FakeCloud();
    const library = cloud.library;
    const first = library.startSetup({ state: 'a' });
    cloud.clock.now += 1000;
    expect(library.saveSetup(first, { state: 'a', organization: { login: ORG } })).toBe(true);
    cloud.clock.now += SETUP_MS - 1;
    expect(library.setup(first)).toEqual({ state: 'a', organization: { login: ORG } });
    cloud.clock.now += 1;
    expect(library.setup(first)).toBeUndefined();
    expect(library.saveSetup(first, { state: 'a' })).toBe(false);

    const ids = Array.from({ length: SETUPS_KEPT + 2 }, (_, index) => {
      cloud.clock.now += 1;
      return library.startSetup({ state: String(index) });
    });
    expect(ids.slice(0, 2).map((id) => library.setup(id))).toEqual([undefined, undefined]);
    expect(ids.slice(2).every((id) => library.setup(id))).toBe(true);
  });

  it('finish by keeping the settings found, secrets included, and only while the setup is there', () => {
    const cloud = new FakeCloud();
    const library = cloud.library;
    const id = library.startSetup({ state: 'a' });
    expect(library.finishSetup(id, { GITHUB_APP_ID: '9', GITHUB_APP_PRIVATE_KEY: 'key', OWNER_NAME: '  ' })).toBe(true);
    expect(library.settings()).toMatchObject({ GITHUB_APP_ID: '9', GITHUB_APP_PRIVATE_KEY: 'key' });
    expect(library.settings().OWNER_NAME).toBeUndefined();
    expect(library.setup(id)).toBeUndefined();
    expect(library.finishSetup(id, { GITHUB_APP_ID: '10' })).toBe(false);
    expect(library.settings().GITHUB_APP_ID).toBe('9');
    expect(library.settingsView({}).find((setting) => setting.name === 'GITHUB_APP_PRIVATE_KEY')).toEqual({ name: 'GITHUB_APP_PRIVATE_KEY', secret: true, from: 'quillipi', kept: true });
  });
});
