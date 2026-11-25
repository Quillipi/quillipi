/**
 * The first-time setup, for a newcomer whose Quillipi has just been deployed: one page that ticks
 * off its steps, at /setup, until Quillipi has its GitHub App and knows its owner.
 *
 *   1  Its address           the one the setup is done at (kept as PUBLIC_URL)
 *   2  An organization       made on GitHub's own page; its name is typed here
 *   3  Quillipi's GitHub App   made from a manifest: GitHub shows it filled in, and hands Quillipi
 *                            its keys itself (GET /setup/app)
 *   4  Install and sign in   GitHub returns after the install (GET /setup/installed); Quillipi checks
 *                            the installation with the App's own key, then signs the owner in
 *                            (GET /setup/callback), and only then keeps anything
 *
 * Like moving into a flat whose water and electricity are already connected: the newcomer only says
 * where their things go and picks up the keys.
 *
 * Safety: only the GitHub account named at deploy (GITHUB_USER_LOGIN) can finish a setup, and a
 * setup belongs to the browser that started it: its ID is in a signed cookie, and every return from
 * GitHub must carry that setup's own state. So a link someone sends can't plant their App in this
 * Quillipi. A setup in progress lives in the library for an hour after its last step; nothing from
 * it is used until the owner has signed in. The App's keys never travel in a cookie or a page.
 */
import { library } from './door.js';
import type { Env, Served } from './env.js';
import { Budget, GitHubApp, GitHubError, appFromManifest, canMakeRepos, findAccount } from './github.js';
import { type SetupAction, type SetupView, messagePage, pageHeaders, setupPage } from './pages.js';
import { clearCookie, cookie, readCookie, seal, sessionCookie, unseal } from './session.js';
import { type SettingName, type Settings, isSetUp, own } from './settings.js';
import { githubWeb, pkceChallenge, randomToken, whoSignedIn } from './sign-in.js';

/** A setup in progress, as the library keeps it. */
export interface SetupRecord {
  /** Carried through GitHub and back when the App is made and installed, so a return is this setup's. */
  state: string;
  organization?: { login: string };
  app?: {
    id: number;
    slug: string;
    name: string;
    clientId: string;
    clientSecret: string;
    privateKey: string;
    /** Whether its permissions let it make a repo for each new notebook. */
    makesRepos: boolean;
  };
  /** Installed on the whole organization, as checked with the App's own key. */
  installed?: boolean;
  /** The owner's sign-in on its way through GitHub. */
  signIn?: { state: string; verifier: string };
}

/** The browser's cookie for its setup: only the setup's ID, signed. */
const SETUP_COOKIE = '__Host-inklog-setup';
const COOKIE_SECONDS = 60 * 60;

/**
 * Settings the setup makes. If the Worker holds any of them while Quillipi isn't set up, its value
 * would win over the setup's and mix two Apps, so the setup says so instead of starting.
 */
const MADE_BY_SETUP: readonly SettingName[] = ['GITHUB_OWNER', 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GITHUB_USER_ID'];

/** GitHub App names are at most 34 characters. */
const APP_NAME_LENGTH = 34;

/** GitHub's rule for account names: letters, digits and single hyphens inside, at most 39 characters. */
const ACCOUNT_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** A step that can't go on, with what the person should be told on the setup page. */
class Problem extends Error {
  constructor(
    readonly step: 2 | 3 | 4,
    message: string,
    readonly actions: SetupAction[] = [],
    readonly status = 400,
  ) {
    super(message);
  }
}

interface Context {
  request: Request;
  env: Served;
  origin: string;
  now: number;
}

/** Answers /setup and everything under it. */
export async function setup(request: Request, env: Served, now = Date.now()): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '') || '/setup';
  // Once Quillipi is set up, the setup is over, for everyone: the way in is the app.
  if (isSetUp(env)) return redirect('/');
  const ctx: Context = { request, env, origin: new URL(env.PUBLIC_URL).origin, now };
  const owner = own(env, 'GITHUB_USER_LOGIN');
  if (!owner) return page(messagePage('Who owns this Quillipi?', 'Set your GitHub username as the variable GITHUB_USER_LOGIN of this Worker in Cloudflare (Workers & Pages, then its Settings, then Variables and Secrets), and deploy. Then open this page again. Only that GitHub account can set Quillipi up and use it.'), 503);
  const held = await library(env).settingsView();
  const clash = held.filter((setting) => setting.from === 'worker' && MADE_BY_SETUP.includes(setting.name)).map((setting) => setting.name);
  if (clash.length) {
    return page(messagePage('Some settings are already in the Worker', `This Worker already holds ${clash.join(', ')}, and a Worker’s own values win over the setup’s. Either set every setting in the Worker, or remove these in Cloudflare (the Worker’s Settings, then Variables and Secrets) and open this page again.`), 409);
  }

  const changing = request.method === 'POST';
  if (changing && request.headers.get('origin') !== ctx.origin) return new Response('Use the setup page itself.', { status: 403 });
  try {
    switch (`${request.method} ${path}`) {
      case 'GET /setup':
        return show(ctx, owner, await current(ctx));
      case 'POST /setup/organization':
        return await chooseOrganization(ctx, owner);
      case 'GET /setup/app':
        return await appMade(ctx, url);
      case 'POST /setup/app/check':
        return await checkApp(ctx);
      case 'GET /setup/installed':
        return await installed(ctx, url);
      case 'POST /setup/signin':
        return await signIn(ctx, await need(ctx, 4), owner);
      case 'GET /setup/callback':
        return await finish(ctx, url, owner);
      case 'POST /setup/restart': {
        const found = await current(ctx);
        if (found) await library(env).endSetup(found.id);
        const response = redirect('/setup');
        response.headers.append('set-cookie', clearCookie(SETUP_COOKIE));
        return response;
      }
    }
    return page(messagePage('Nothing is here', 'This address isn’t a step of the setup.', [{ label: 'Open the setup', href: '/setup', primary: true }]), 404);
  } catch (error) {
    if (!(error instanceof Problem)) throw error;
    console.warn(`Setup stopped at step ${error.step}: ${error.message}`);
    return show(ctx, owner, await current(ctx), error);
  }
}

// The steps --------------------------------------------------------------------------------

/** Step 2: the organization's name, checked with GitHub. The setup starts here. */
async function chooseOrganization(ctx: Context, owner: string): Promise<Response> {
  const form = await ctx.request.formData().catch(() => new FormData());
  const name = String(form.get('organization') ?? '')
    .trim()
    .replace(/^@/, '')
    .replace(/^(https?:\/\/)?github\.com\//i, '')
    .replace(/\/.*$/, '');
  if (!ACCOUNT_NAME.test(name)) throw new Problem(2, name ? `“${name}” can’t be a GitHub organization’s name: use letters, digits and single hyphens.` : 'Type the organization’s name.');
  const account = await findAccount(name, githubAccess(ctx.env));
  if (account.kind === 'missing') throw new Problem(2, `GitHub has no account called “${name}”. Make the organization on GitHub first, then type its name here.`);
  if (account.kind === 'user') {
    throw new Problem(2, `${account.login} is a personal account. Quillipi needs an organization, because its App can make repos in an organization without keeping your GitHub sign-in.`);
  }
  // When GitHub can't be asked (it allows only a few requests an hour without a key), the name is
  // kept as typed: the next step, on GitHub's own page, shows whether it is right.
  const login = account.kind === 'organization' ? account.login : name;
  const found = await current(ctx);
  // A new organization starts the App over, since an App belongs to the organization it was made in.
  const record: SetupRecord = { state: found?.record.state ?? randomToken(), organization: { login } };
  if (found) {
    if (!(await library(ctx.env).saveSetup(found.id, record))) throw gone();
    return redirect('/setup');
  }
  const id = await library(ctx.env).startSetup(record);
  const response = redirect('/setup');
  response.headers.append('set-cookie', cookie(SETUP_COOKIE, await seal({ id, expires: ctx.now + COOKIE_SECONDS * 1000 }, secret(ctx.env)), COOKIE_SECONDS));
  return response;
}

/** Step 3, back from GitHub: the App was made from the manifest; GitHub hands it over for the code. */
async function appMade(ctx: Context, url: URL): Promise<Response> {
  const { id, record } = await need(ctx, 3);
  if (url.searchParams.get('state') !== record.state) throw stranger(3);
  const code = url.searchParams.get('code');
  if (!code) throw new Problem(3, 'GitHub came back without the App. Create it again.');
  let app;
  try {
    app = await appFromManifest(code, githubAccess(ctx.env));
  } catch (error) {
    throw new Problem(3, `${error instanceof Error ? error.message : String(error)} GitHub’s code works once, within an hour. Create the App again; if GitHub says the name is taken, the first one was made: delete it in the organization’s settings, or give the new one another name.`);
  }
  const organization = record.organization!.login;
  if (app.owner.login.toLowerCase() !== organization.toLowerCase()) {
    throw new Problem(3, `The App was made under ${app.owner.login}, not ${organization}. Create it again from this page.`);
  }
  const next: SetupRecord = {
    ...record,
    organization: { login: app.owner.login },
    app: { id: app.id, slug: app.slug, name: app.name, clientId: app.clientId, clientSecret: app.clientSecret, privateKey: app.privateKey, makesRepos: canMakeRepos(app.permissions) },
  };
  if (!(await library(ctx.env).saveSetup(id, next))) throw gone();
  return redirect('/setup');
}

/** Step 3 again: after the owner gave the App the permission to make repos on GitHub. */
async function checkApp(ctx: Context): Promise<Response> {
  const { id, record } = await need(ctx, 4);
  const app = record.app!;
  const permissions = await askGitHub(3, () => appOf(ctx.env, record).permissions(new Budget(2)));
  const next: SetupRecord = { ...record, app: { ...app, makesRepos: canMakeRepos(permissions) } };
  if (!(await library(ctx.env).saveSetup(id, next))) throw gone();
  return redirect('/setup');
}

/**
 * Step 4, back from GitHub after the install (the App's setup address). GitHub's own warning: the
 * installation_id here can be made up, so Quillipi asks GitHub with the App's key whether it is
 * really installed on the organization, and on every repo. Then straight on to signing in.
 */
async function installed(ctx: Context, url: URL): Promise<Response> {
  const { id, record } = await need(ctx, 4);
  // GitHub carries the state from the install link; a return after the person changed the
  // installation's repos on GitHub carries none, and the check below is the same either way.
  const state = url.searchParams.get('state');
  if (state !== null && state !== record.state) throw stranger(4);
  const installation = await askGitHub(4, () => appOf(ctx.env, record).organizationInstallation(new Budget(2)));
  const organization = record.organization!.login;
  if (!installation) throw new Problem(4, `The App isn’t installed on ${organization} yet. Install it, then GitHub brings you back here.`);
  if (!installation.allRepositories) {
    throw new Problem(4, `The App is installed on only some of ${organization}’s repositories, so it couldn’t reach the repos Quillipi makes for new notebooks. Choose All repositories on GitHub, save, and come back.`, [
      { label: 'Open the installation on GitHub', href: `${githubWeb(ctx.env)}/organizations/${encodeURIComponent(organization)}/settings/installations/${installation.id}`, external: true },
      { label: 'Check again', href: '/setup/installed', primary: true },
    ]);
  }
  const next: SetupRecord = { ...record, installed: true };
  if (!(await library(ctx.env).saveSetup(id, next))) throw gone();
  return signIn(ctx, { id, record: next }, own(ctx.env, 'GITHUB_USER_LOGIN')!);
}

/** Off to GitHub to sign in through the new App, with this setup's own state and PKCE. */
async function signIn(ctx: Context, { id, record }: { id: string; record: SetupRecord }, owner: string): Promise<Response> {
  if (!record.installed) throw new Problem(4, 'Install the App first.');
  const pending = { state: randomToken(), verifier: randomToken() };
  if (!(await library(ctx.env).saveSetup(id, { ...record, signIn: pending }))) throw gone();
  const authorizeAt = new URL('/login/oauth/authorize', githubWeb(ctx.env));
  authorizeAt.search = new URLSearchParams({
    client_id: record.app!.clientId,
    redirect_uri: `${ctx.origin}/setup/callback`,
    state: pending.state,
    code_challenge: await pkceChallenge(pending.verifier),
    code_challenge_method: 'S256',
    login: owner, // GitHub suggests the right account
    allow_signup: 'false',
  }).toString();
  return redirect(authorizeAt.href);
}

/**
 * The end, back from GitHub's sign-in: only the account named at deploy may finish. Then Quillipi
 * keeps what the setup found, in one go, and the browser is signed in and goes Home.
 */
async function finish(ctx: Context, url: URL, owner: string): Promise<Response> {
  const { id, record } = await need(ctx, 4);
  const params = url.searchParams;
  if (!record.signIn || params.get('state') !== record.signIn.state) throw stranger(4);
  const code = params.get('code');
  const again: SetupAction[] = [{ label: 'Sign in again', form: '/setup/signin', primary: true }];
  if (!code) throw new Problem(4, 'The sign-in was cancelled at GitHub. Nothing was kept.', again);
  const app = record.app!;
  const user = await whoSignedIn(ctx.env, app, code, record.signIn.verifier, `${ctx.origin}/setup/callback`).catch((error: unknown) => {
    throw new Problem(4, error instanceof Error ? error.message : String(error), again);
  });
  if (user.login.toLowerCase() !== owner.toLowerCase()) {
    throw new Problem(4, `Only ${owner} can set up this Quillipi. You signed in to GitHub as ${user.login}. Switch accounts on GitHub, then sign in again.`, [
      { label: 'Use another GitHub account', href: new URL('/logout', githubWeb(ctx.env)).href, external: true },
      ...again,
    ]);
  }
  const settings: Settings = {
    PUBLIC_URL: ctx.origin,
    OWNER_NAME: user.name ?? user.login,
    // GitHub's ID-based noreply address, so the notebooks' commits link to the owner's profile.
    OWNER_EMAIL: `${user.id}+${user.login}@users.noreply.github.com`,
    GITHUB_OWNER: record.organization!.login,
    GITHUB_APP_ID: String(app.id),
    GITHUB_APP_PRIVATE_KEY: app.privateKey,
    GITHUB_CLIENT_ID: app.clientId,
    GITHUB_CLIENT_SECRET: app.clientSecret,
    GITHUB_USER_ID: String(user.id),
    GITHUB_USER_LOGIN: user.login,
  };
  if (!(await library(ctx.env).finishSetup(id, settings))) throw gone();
  console.log(`Quillipi is set up for ${user.login}, with the GitHub App ${app.name} in ${record.organization!.login}.`);
  const home = redirect('/');
  home.headers.append('set-cookie', clearCookie(SETUP_COOKIE));
  home.headers.append('set-cookie', await sessionCookie({ user: String(user.id), login: user.login }, ctx.env, ctx.now));
  return home;
}

// The page ---------------------------------------------------------------------------------

/** The one setup page: every step, the done ones ticked and the current one open. */
function show(ctx: Context, owner: string, found: { record: SetupRecord } | undefined, problem?: Problem): Response {
  const record = found?.record;
  const organization = record?.organization?.login;
  const web = githubWeb(ctx.env);
  const view: SetupView = {
    owner,
    address: ctx.origin,
    github: web,
    started: Boolean(found),
    suggestion: `${owner.toLowerCase()}-notebooks`.slice(0, 39),
    ...(organization ? { organization } : {}),
    step: !organization ? 2 : !record?.app?.makesRepos ? 3 : 4,
  };
  if (organization && record?.app) {
    view.app = { name: record.app.name, url: `${web}/organizations/${encodeURIComponent(organization)}/settings/apps/${encodeURIComponent(record.app.slug)}` };
  }
  if (organization && !record?.app) {
    view.manifest = { action: `${web}/organizations/${encodeURIComponent(organization)}/settings/apps/new?state=${encodeURIComponent(record!.state)}`, json: JSON.stringify(manifest(ctx.origin, organization)) };
  }
  if (record?.app && !record.app.makesRepos && !problem) {
    problem = new Problem(3, 'The App can’t make repos, so new notebooks couldn’t be backed up. On GitHub, open its permissions, set Repository creation to Read and write (Contents too), save, and check again.', [
      { label: 'Open its permissions on GitHub', href: `${view.app!.url}/permissions`, external: true },
      { label: 'Check again', form: '/setup/app/check', primary: true },
    ], 200); // where the setup stands, not a failed request
  }
  if (record?.app?.makesRepos) {
    view.installUrl = `${web}/apps/${encodeURIComponent(record.app.slug)}/installations/new?state=${encodeURIComponent(record.state)}`;
    view.installed = Boolean(record.installed);
  }
  // A problem is shown in the step that is open, whichever step found it.
  if (problem) view.problem = { step: view.step, text: problem.message, actions: problem.actions };
  return page(setupPage(view), problem?.status ?? 200, [web]);
}

/**
 * What Quillipi's GitHub App is, as GitHub's manifest flow takes it: private, with no webhook, the
 * permissions the mirror needs, the three sign-in returns (the AI apps', the browser's and the setup's),
 * and where GitHub returns after it is made and after it is installed.
 */
export function manifest(origin: string, organization: string) {
  return {
    name: `Quillipi ${organization}`.slice(0, APP_NAME_LENGTH).replace(/[\s-]+$/, ''),
    url: origin,
    description: 'Keeps the history of your Quillipi notebooks: a private repo for each notebook, in this organization.',
    public: false,
    hook_attributes: { url: `${origin}/`, active: false },
    redirect_url: `${origin}/setup/app`,
    callback_urls: [`${origin}/callback`, `${origin}/signin/callback`, `${origin}/setup/callback`],
    setup_url: `${origin}/setup/installed`,
    setup_on_update: true,
    request_oauth_on_install: false,
    default_permissions: { contents: 'write', metadata: 'read', repository_creation: 'write' },
    default_events: [],
  };
}

// Inside -----------------------------------------------------------------------------------

/** This browser's setup in progress, if its cookie is genuine and the setup hasn't gone. */
async function current(ctx: Context): Promise<{ id: string; record: SetupRecord } | undefined> {
  const held = await unseal<{ id: string; expires: number }>(readCookie(ctx.request, SETUP_COOKIE), secret(ctx.env));
  if (!held || typeof held.id !== 'string' || !(held.expires > ctx.now)) return undefined;
  const record = await library(ctx.env).setup(held.id);
  return record ? { id: held.id, record } : undefined;
}

/** This browser's setup, which must have reached `step`. */
async function need(ctx: Context, step: 3 | 4): Promise<{ id: string; record: SetupRecord }> {
  const found = await current(ctx);
  if (!found) throw gone();
  const { record } = found;
  if (!record.organization) throw new Problem(2, 'Start with the organization.');
  if (step === 4 && !record.app) throw new Problem(3, 'Create the App first.');
  return found;
}

/** The new App as Quillipi uses it, with its own key. */
function appOf(env: Env, record: SetupRecord): GitHubApp {
  return new GitHubApp({ appId: String(record.app!.id), privateKey: record.app!.privateKey, owner: record.organization!.login, api: env.GITHUB_API });
}

async function askGitHub<T>(step: 3 | 4, ask: () => Promise<T>): Promise<T> {
  try {
    return await ask();
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error;
    throw new Problem(step, `${error.message} Try again in a moment.`, [{ label: 'Try again', href: '/setup', primary: true }], 502);
  }
}

function gone(): Problem {
  return new Problem(2, 'This setup isn’t here any more: it was started in another browser, started again, or left for more than an hour. Start from the organization; nothing was kept.');
}

function stranger(step: 3 | 4): Problem {
  return new Problem(step, 'This return from GitHub doesn’t belong to the setup in this browser, so nothing was changed. Carry on from this page.');
}

function githubAccess(env: Env) {
  return env.GITHUB_API ? { api: env.GITHUB_API } : {};
}

/** The key for the setup cookie: Quillipi's session secret, which it makes itself before any setup. */
function secret(env: Env): string {
  if (!env.SESSION_SECRET) throw new Error('Quillipi has no session secret, which the library makes when it opens.');
  return env.SESSION_SECRET;
}

function page(html: string, status = 200, formTargets: string[] = []): Response {
  return new Response(html, { status, headers: pageHeaders(new Headers(), formTargets) });
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });
}
