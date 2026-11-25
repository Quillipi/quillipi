/**
 * The pages a person sees outside the app: the first-time setup, the app's sign-in, the consent
 * page an AI app's sign-in shows, and short messages. They run no scripts and can't be shown
 * inside another site. They wear the app's look (its desk, white paper, violet accent and drop of
 * ink), so the first page a newcomer sees is already Quillipi.
 */
import type { ConsentDescription } from '@cloudflare/workers-oauth-provider';

/**
 * Headers for every page. A form may submit only here, and the redirect after it may go only to
 * GitHub or back to the app that asked, so `formTargets` lists those addresses.
 */
export function pageHeaders(headers = new Headers(), formTargets: string[] = []): Headers {
  const formAction = ["'self'", ...formTargets.map(formSource)].join(' ');
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('cache-control', 'no-store');
  headers.set('content-security-policy', `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`);
  headers.set('x-frame-options', 'DENY');
  // No address is sent to other sites. Within Quillipi it is, because a browser sends a form's Origin
  // only then: with no-referrer, Chrome sends "Origin: null", and the setup's forms check it.
  headers.set('referrer-policy', 'same-origin');
  return headers;
}

/**
 * How a page names an address in `form-action`: by its origin, or, for an app link such as
 * cursor://…, whose origin is "null" and would match nothing, by its scheme.
 */
function formSource(target: string): string {
  const url = new URL(target);
  return isAppLink(url) ? url.protocol : url.origin;
}

/** An address that opens an app on this computer by its own scheme (RFC 8252's private-use URI), such as cursor://…. */
function isAppLink(url: URL): boolean {
  return url.protocol !== 'https:' && url.protocol !== 'http:';
}

/** Asks whether this app may use the notebooks. Everything about the app comes from the app, so it is escaped. */
export function consentPage(app: ConsentDescription, handle: string, owner: string): string {
  const name = escapeHtml(app.clientName);
  const origin = app.clientDomain
    ? `It is published by <strong>${escapeHtml(app.clientDomain)}</strong>.`
    : 'The app gave this name itself, so Quillipi can’t check it.';
  const redirect = new URL(app.redirectUri);
  const appLink = isAppLink(redirect);
  // An app link's host names no website, so it is shown with its scheme, such as cursor://anysphere.cursor-mcp.
  const target = appLink && redirect.host ? `${redirect.protocol}//${redirect.host}` : app.redirectHost;
  // Any program on the computer could be listening there, whatever name the app gave.
  const local =
    app.redirectIsLoopback || appLink
      ? '<p class="warning">Access goes to an app on this computer, such as Claude Code, Codex or Cursor. Continue only if you just started connecting from it.</p>'
      : '';
  return page(
    `Connect ${name} to Quillipi`,
    `<p><strong>${name}</strong> wants to read and edit your Quillipi notebooks and commit its changes. Large deletions will still wait for your review.</p>
    <p>${origin} Access will be sent to <strong>${escapeHtml(target)}</strong>.</p>
    ${local}
    <form method="post" action="/authorize">
      <input type="hidden" name="handle" value="${escapeHtml(handle)}">
      <div class="actions">
        <button type="submit" name="decision" value="approve" class="primary">Continue with GitHub</button>
        <button type="submit" name="decision" value="deny">Cancel</button>
      </div>
    </form>
    <p class="note">Only continue if you just added Quillipi as a connector yourself. GitHub then checks that you are ${escapeHtml(owner)}.</p>`,
  );
}

export interface PageAction {
  label: string;
  href: string;
  primary?: boolean;
}

export function messagePage(title: string, text: string, actions: PageAction[] = []): string {
  const links = actions.length
    ? `<div class="actions">${actions.map((action) => `<a href="${escapeHtml(action.href)}"${action.primary ? ' class="primary"' : ''}>${escapeHtml(action.label)}</a>`).join('')}</div>`
    : '';
  return page(escapeHtml(title), `<p>${escapeHtml(text)}</p>${links}`);
}

/** The app's sign-in: one card on the desk. `next` is where the browser goes afterwards, a path on this site. */
export function signInPage(next: string, owner: string): string {
  return page(
    'Sign in to Quillipi',
    `<form method="post" action="/signin">
      <input type="hidden" name="next" value="${escapeHtml(next)}">
      <div class="actions"><button type="submit" class="primary">Continue with GitHub</button></div>
    </form>
    <p class="note">This Quillipi belongs to ${escapeHtml(owner)}.</p>`,
  );
}

/** Someone signed in to GitHub with another account. */
export function wrongAccountPage(login: string, owner: string, github: string): string {
  return messagePage('This GitHub account can’t use Quillipi', `You’re signed in to GitHub as ${login}. Only ${owner} can use this Quillipi.`, [
    { label: 'Use another GitHub account', href: new URL('/logout', github).href },
    { label: 'Try again', href: '/signin', primary: true },
  ]);
}

// The first-time setup -------------------------------------------------------------------------

/** What a step offers when it can't go on: a link (GitHub's pages open beside the setup), or a button that posts to the setup. */
export interface SetupAction {
  label: string;
  href?: string;
  form?: string;
  primary?: boolean;
  external?: boolean;
}

/** Everything the setup page shows (setup.ts works it out). */
export interface SetupView {
  /** The GitHub account named at deploy, the only one that can finish. */
  owner: string;
  /** Quillipi's address, the one the setup is done at. */
  address: string;
  /** GitHub's website. */
  github: string;
  /** Whether this browser has a setup in progress, which Start again throws away. */
  started: boolean;
  /** A name to suggest for the organization. */
  suggestion: string;
  organization?: string;
  /** The step that is open now; the ones before it are done. */
  step: 2 | 3 | 4;
  app?: { name: string; url: string };
  /** The form that takes the manifest to GitHub, while the App isn't made. */
  manifest?: { action: string; json: string };
  installUrl?: string;
  /** Installed and checked; only signing in is left. */
  installed?: boolean;
  /** What stopped the open step, shown in it. */
  problem?: { step: 2 | 3 | 4; text: string; actions: SetupAction[] };
}

/** The setup: one card with every step, the done ones ticked, the current one open. */
export function setupPage(view: SetupView): string {
  const host = new URL(view.address).host;
  const org = view.organization ? escapeHtml(view.organization) : '';
  const owner = escapeHtml(view.owner);
  const problem = (step: number) => (view.problem?.step === step ? problemBox(view.problem.text, view.problem.actions) : '');
  const steps: Step[] = [
    {
      title: 'Its address',
      done: `<code>${escapeHtml(host)}</code> · Claude and your browsers reach Quillipi here.`,
    },
    {
      title: 'An organization for your notebooks',
      done: `<a href="${escapeHtml(`${view.github}/${view.organization ?? ''}`)}" target="_blank" rel="noopener noreferrer">github.com/${org}</a>`,
      body: `<p>Each notebook gets a private GitHub repo there, with its whole history. Keep the organization for notebooks only: Quillipi’s App can reach every repo in it.</p>
        <p>GitHub makes one for free in about 30 seconds.</p>
        ${how([
          'The button opens GitHub’s page for a new organization, in a new tab.',
          'There, type a name for it and your email, choose <em>My personal account</em>, and press <em>Next</em>. If GitHub then asks you to add people, skip it.',
          'Come back to this tab and type the same name below.',
        ])}
        <div class="actions"><a class="button" href="${escapeHtml(`${view.github}/account/organizations/new?plan=free`)}" target="_blank" rel="noopener noreferrer">Make one on GitHub ${ARROW}</a></div>
        ${problem(2)}
        <form method="post" action="/setup/organization" class="field">
          <label for="organization">Its name</label>
          <div class="row">
            <input id="organization" name="organization" required maxlength="39" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="${escapeHtml(view.suggestion)}" value="${org}">
            <button type="submit" class="primary">Continue</button>
          </div>
        </form>`,
    },
    {
      title: 'Quillipi’s GitHub App',
      done: view.app ? `<a href="${escapeHtml(view.app.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(view.app.name)}</a>, made in your organization` : '',
      body: view.manifest
        ? `<p>Quillipi reaches your notebooks’ repos through a GitHub App of its own, in ${org}. GitHub shows it filled in, and hands Quillipi its keys by itself. There is nothing to copy.</p>
          ${how([
            'The button takes you to GitHub, in this tab, with Quillipi’s App already filled in.',
            'There, press the green <em>Create GitHub App</em> button at the bottom.',
            'GitHub brings you back here by itself, to the last step.',
          ])}
          ${problem(3)}
          <form method="post" action="${escapeHtml(view.manifest.action)}">
            <input type="hidden" name="manifest" value="${escapeHtml(view.manifest.json)}">
            <div class="actions"><button type="submit" class="primary">Create the App on GitHub</button></div>
          </form>
          <p class="note">You need to be an owner of ${org}. If GitHub says <em>Page not found</em>, check that you are signed in to GitHub as ${owner}.</p>`
        : problem(3),
    },
    {
      title: 'Install it and sign in',
      body: `<p>Install the App on ${org} with <em>All repositories</em>, so it can reach each notebook’s repo. Then GitHub checks that you are ${owner}, and Quillipi opens.</p>
        ${how([
          'The button takes you to GitHub’s page for installing the App, in this tab.',
          'There, choose <em>All repositories</em> and press <em>Install</em>.',
          'GitHub brings you back, and Quillipi signs you in with GitHub by itself; if GitHub asks, press <em>Authorize</em>. Then your Quillipi opens.',
        ])}
        ${problem(4)}
        ${
          // A problem that offers its own way on replaces the step's button.
          view.problem?.step === 4 && view.problem.actions.length
            ? ''
            : view.installed
              ? `<form method="post" action="/setup/signin"><div class="actions"><button type="submit" class="primary">Sign in with GitHub</button></div></form>`
              : `<div class="actions"><a class="button primary" href="${escapeHtml(view.installUrl ?? '/setup')}">Install on ${org}</a></div>`
        }`,
    },
  ];

  const list = steps
    .map((step, index) => {
      const number = index + 1;
      const state = number < view.step ? 'done' : number === view.step ? 'current' : 'waiting';
      const mark = state === 'done' ? CHECK : String(number);
      const detail = state === 'done' ? `<p class="summary">${step.done ?? ''}</p>` : state === 'current' ? `<div class="body">${step.body ?? ''}</div>` : '';
      return `<li class="${state}"${state === 'current' ? ' aria-current="step"' : ''}>
        <span class="mark" aria-hidden="true">${mark}</span>
        <div class="step"><h2>${step.title}<span class="sr"> (${state === 'done' ? 'done' : state === 'current' ? 'now' : 'later'})</span></h2>${detail}</div>
      </li>`;
    })
    .join('');

  return page(
    'Set up your Quillipi',
    `<p class="lead">For the GitHub account <strong>${owner}</strong> · about 3 minutes</p>
    <p class="owner">That is the GitHub username given when this Quillipi was deployed (<code>GITHUB_USER_LOGIN</code>). Only that account can finish the setup and use this Quillipi. Not yours? Change it in your Quillipi’s <code>wrangler.jsonc</code> and deploy again.</p>
    <ol class="steps">${list}</ol>
    <div class="foot">
      <p>${LOCK}<span>Your keys stay in your Cloudflare account and on GitHub. Nothing is sent anywhere else.</span></p>
      ${view.started ? '<form method="post" action="/setup/restart"><button type="submit" class="quiet">Start again</button></form>' : ''}
    </div>`,
    { wide: true },
  );
}

/** What a step's button does, said plainly before it: where it goes, what to press there, how it comes back. */
function how(lines: string[]): string {
  return `<div class="how"><p class="how-title">What happens</p><ol>${lines.map((line) => `<li>${line}</li>`).join('')}</ol></div>`;
}

interface Step {
  title: string;
  /** What a done step shows, one line. */
  done?: string;
  /** What the open step shows. */
  body?: string;
}

function problemBox(text: string, actions: SetupAction[]): string {
  const buttons = actions
    .map((action) =>
      action.form
        ? `<form method="post" action="${escapeHtml(action.form)}"><button type="submit"${action.primary ? ' class="primary"' : ''}>${escapeHtml(action.label)}</button></form>`
        : `<a class="button${action.primary ? ' primary' : ''}" href="${escapeHtml(action.href ?? '/setup')}"${action.external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${escapeHtml(action.label)}${action.external ? ` ${ARROW}` : ''}</a>`,
    )
    .join('');
  return `<div class="problem" role="alert"><p>${escapeHtml(text)}</p>${buttons ? `<div class="actions">${buttons}</div>` : ''}</div>`;
}

const CHECK = '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ARROW = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6 3.5h6.5V10M12.5 3.5l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="sr"> (opens in a new tab)</span>';
const LOCK = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';

/**
 * Every page is one paper card on the desk, in the app's colours (apps/web/src/index.css): the
 * desk, white paper, violet for the main action, and Quillipi's drop of ink. The system's own font
 * stands in for the app's Inter, which these pages, sent by the Worker, don't load.
 */
function page(title: string, body: string, { wide = false } = {}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="#edecf2">
<title>${title.replace(/<[^>]*>/g, '')}</title>
<style>
  :root { --desk: #edecf2; --paper: #ffffff; --surface: #f6f5fa; --ink: #1b1826; --muted: #6c6980; --faint: #9390a6; --line: #eceaf2; --line-strong: #dcd9e6; --accent: #7350f2; --accent-strong: #6340e6; --accent-soft: #f4f1fe; --on-accent: #ffffff; --warning: #a5590b; --problem: #b42318; --problem-soft: #fef1f0; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; min-height: 100dvh; display: grid; place-items: center; padding: max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom)); background: var(--desk); color: var(--ink); font: 15px/1.55 system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; -webkit-font-smoothing: antialiased; }
  main { width: min(${wide ? 560 : 420}px, 100%); margin: 24px 0; padding: 32px; background: var(--paper); border-radius: 24px; box-shadow: 0 18px 50px -12px rgb(27 24 38 / 22%), 0 0 0 1px rgb(27 24 38 / 6%); }
  .brand { display: flex; align-items: center; gap: 8px; color: var(--accent); font-weight: 650; letter-spacing: -0.01em; }
  .brand span { color: var(--ink); }
  h1 { font-size: 1.45rem; line-height: 1.25; margin: 18px 0 4px; letter-spacing: -0.02em; font-weight: 650; }
  p { margin: 10px 0; }
  a { color: var(--accent); text-underline-offset: 3px; }
  code { font: 13px ui-monospace, 'Cascadia Code', 'SF Mono', Menlo, Consolas, monospace; background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 1px 6px; }
  em { font-style: normal; font-weight: 600; }
  .lead { color: var(--muted); margin: 0 0 6px; }
  .lead strong { color: var(--ink); font-weight: 650; }
  .owner { color: var(--muted); font-size: 0.875rem; margin: 0 0 18px; }
  .how { margin-top: 12px; padding: 12px 14px; border-radius: 12px; background: var(--surface); font-size: 0.875rem; }
  .how-title { margin: 0 0 4px; color: var(--ink); font-weight: 600; }
  .how ol { margin: 0; padding-left: 20px; }
  .how li + li { margin-top: 2px; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
  .actions form { display: contents; }
  button, .actions a, a.button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; flex: 1; min-height: 44px; padding: 10px 16px; border: 1px solid var(--line-strong); border-radius: 12px; background: var(--paper); color: var(--ink); font: inherit; font-weight: 550; text-align: center; text-decoration: none; cursor: pointer; transition: background-color 150ms, border-color 150ms; }
  button:hover, .actions a:hover, a.button:hover { background: var(--surface); }
  button.primary, .actions a.primary, a.button.primary { flex: 2; border-color: var(--accent); background: var(--accent); color: var(--on-accent); box-shadow: 0 6px 16px -8px rgb(115 80 242 / 70%); }
  button.primary:hover, .actions a.primary:hover, a.button.primary:hover { background: var(--accent-strong); }
  button:focus-visible, a:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button.quiet { flex: none; white-space: nowrap; min-height: 36px; padding: 6px 10px; border-color: transparent; background: none; color: var(--muted); font-weight: 500; }
  button.quiet:hover { color: var(--ink); background: var(--surface); }
  .warning { color: var(--warning); }
  .note { color: var(--muted); font-size: 0.875rem; margin-top: 16px; }
  .steps { list-style: none; margin: 0; padding: 0; }
  .steps > li { position: relative; display: flex; gap: 14px; padding: 0 0 22px; }
  .steps > li:not(:last-child)::before { content: ''; position: absolute; left: 13px; top: 32px; bottom: 4px; width: 2px; border-radius: 1px; background: var(--line); }
  .steps > li.done:not(:last-child)::before { background: var(--accent); opacity: 0.35; }
  .mark { flex: none; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; font-size: 13px; font-weight: 650; color: var(--faint); border: 2px solid var(--line-strong); background: var(--paper); }
  .done .mark { color: var(--on-accent); background: var(--accent); border-color: var(--accent); }
  .current .mark { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); box-shadow: 0 0 0 4px rgb(115 80 242 / 12%); }
  .step { flex: 1; min-width: 0; padding-top: 3px; }
  .step h2 { margin: 0; font-size: 1rem; line-height: 1.4; font-weight: 600; letter-spacing: -0.005em; }
  .waiting h2 { color: var(--muted); font-weight: 500; }
  .summary { margin: 2px 0 0; color: var(--muted); font-size: 0.875rem; overflow-wrap: anywhere; }
  .body { color: #3b3850; font-size: 0.9375rem; }
  .body .actions a, .body a.button { flex: none; }
  .field { margin-top: 18px; }
  .field label { display: block; font-size: 0.875rem; font-weight: 600; margin-bottom: 6px; }
  .row { display: flex; gap: 8px; }
  .row button { flex: none; }
  input { flex: 1; min-width: 0; min-height: 44px; padding: 10px 12px; border: 1px solid var(--line-strong); border-radius: 12px; font: inherit; font-size: 16px; color: var(--ink); background: var(--paper); }
  input::placeholder { color: var(--faint); }
  .problem { margin: 14px 0 0; padding: 12px 14px; border-radius: 12px; background: var(--problem-soft); color: var(--problem); font-size: 0.875rem; border: 1px solid rgb(180 35 24 / 14%); }
  .problem p { margin: 0; }
  .problem .actions { margin-top: 10px; }
  .problem .actions a, .problem button { min-height: 40px; flex: none; }
  .foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 4px; padding-top: 16px; border-top: 1px solid var(--line); color: var(--muted); font-size: 0.8125rem; }
  .foot p { display: flex; gap: 8px; align-items: flex-start; margin: 0; }
  .foot svg { flex: none; margin-top: 2px; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  @media (max-width: 480px) { main { padding: 24px 20px; border-radius: 20px; } .row { flex-direction: column; } .foot { flex-direction: column; align-items: flex-start; } }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
</head>
<body>
<main>
  <div class="brand"><svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true"><path d="M16 3c5 7 9 11.5 9 16.5a9 9 0 0 1-18 0C7 14.5 11 10 16 3z" fill="currentColor"/></svg><span>Quillipi</span></div>
  <h1>${title}</h1>
  ${body}
</main>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}
