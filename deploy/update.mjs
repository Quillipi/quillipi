// Quillipi's updates for this copy. Once a week the workflow in .github/workflows/update.yml runs this:
// when Quillipi's source repository has published a newer release than quillipi-release.json names, it
// opens an issue here saying what is new. Running the workflow yourself applies it: Quillipi's files
// here are replaced with the release's (wrangler.jsonc, which is yours, never is) and committed, and
// Cloudflare deploys that commit. To undo an update, revert its commit.
//
// Without GitHub Actions:  npm run update             says whether a newer Quillipi is out
//                          npm run update -- apply    applies it here; then commit and push

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PIN_FILE, download, fileBytes, readPin, releaseUrl, safePath, sha256 } from './build.mjs';

/** Files an update never writes: the copy's own settings, its pin (written apart) and its workflows. */
const KEPT = /^(wrangler\.jsonc|quillipi-release\.json|\.github\/.*)$/;
/** Marks the issue this workflow keeps, so the next run finds it. */
const MARK = '<!-- quillipi-update -->';

/** Whether version `a` is newer than `b`, both like 0.3.0. */
export function newer(a, b) {
  const [x, y] = [a, b].map((version) => version.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

function api(token) {
  return { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'quillipi-copy', ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

/** The newest release of Quillipi's source repository: its version, notes and page. */
export async function latestRelease(source, { fetch, token }) {
  const response = await fetch(`https://api.github.com/repos/${source}/releases/latest`, { headers: api(token) });
  if (!response.ok) {
    const hint = response.status === 404 ? ' Is that repository public, with a release published?' : '';
    throw new Error(`GitHub answered ${response.status} when asked for ${source}'s newest release.${hint}`);
  }
  const release = await response.json();
  const version = String(release.tag_name).replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`${source}'s newest release is tagged "${release.tag_name}", which isn't a version such as v0.3.0.`);
  return { version, notes: String(release.body ?? '').trim(), page: String(release.html_url ?? '') };
}

/**
 * Reads a release file just enough to apply it: its version, Quillipi's files for a copy, and the
 * storage versions it writes. Every release format keeps these, so this works on newer formats too.
 */
export function readRelease(bytes, version) {
  const release = JSON.parse(Buffer.from(bytes).toString('utf8'));
  if (release.version !== version || typeof release.copy !== 'object' || release.copy === null) throw new Error(`The file for Quillipi ${version} isn't a release of it.`);
  for (const path of Object.keys(release.copy)) {
    if (KEPT.test(safePath(path))) throw new Error(`Quillipi ${version} would replace ${path}, which this copy keeps as its own.`);
  }
  return release;
}

/** The parts of Quillipi's storage a release moves forward, such as "library 1 → 2". */
export function storageMoves(before = {}, after = {}) {
  return Object.keys(after)
    .sort()
    .filter((part) => after[part] > (before[part] ?? 1))
    .map((part) => `${part} ${before[part] ?? 1} → ${after[part]}`);
}

/** Writes the release's files and its pin into `dir`; returns the files written. */
export function applyRelease(dir, bytes, release, source) {
  const written = [];
  for (const [path, file] of Object.entries(release.copy)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), fileBytes(file));
    written.push(path);
  }
  const pin = { source, version: release.version, sha256: sha256(bytes), storage: release.storage };
  writeFileSync(join(dir, PIN_FILE), `${JSON.stringify(pin, null, 2)}\n`);
  return [...written.sort(), PIN_FILE];
}

/** What this copy runs and what it could run: the pin, the newest release and its file. */
async function lookUp(dir, { fetch, token, wait }) {
  const pin = readPin(readFileSync(join(dir, PIN_FILE), 'utf8'));
  const latest = await latestRelease(pin.source, { fetch, token });
  if (!newer(latest.version, pin.version)) return { pin, latest };
  const bytes = await download(releaseUrl({ source: pin.source, version: latest.version }), { fetch, wait });
  return { pin, latest, bytes, release: readRelease(bytes, latest.version) };
}

function storageWarning(moves) {
  if (moves.length === 0) return '';
  return `**This update moves how Quillipi stores its data forward** (${moves.join(', ')}). Once it has run, reverting it would leave Quillipi refusing to open what the newer one saved, until you update again; nothing would be lost.`;
}

/** The issue that says a new Quillipi is out, and how to update. */
export function noticeBody({ repo, current, latest, moves }) {
  return [
    `A new Quillipi is out: **${latest.version}**. This Quillipi runs ${current}.`,
    latest.notes || `What's new: ${latest.page}`,
    `**To update**, open [Update Quillipi](https://github.com/${repo}/actions/workflows/update.yml), choose **Run workflow**, and confirm. It commits the new release to this repository, and Cloudflare deploys it within a few minutes. This issue closes when that's done.`,
    storageWarning(moves),
    `**To undo** an update, revert its commit, "Update Quillipi to ${latest.version}".`,
    '**To update without being asked**, change `QUILLIPI_UPDATES: notice` to `QUILLIPI_UPDATES: automatic` in `.github/workflows/update.yml`.',
    MARK,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** The issues of `repo` this workflow keeps. */
function issues(repo, { fetch, token }) {
  async function call(method, path, body) {
    const response = await fetch(`https://api.github.com/repos/${repo}${path}`, { method, headers: api(token), body: body && JSON.stringify(body) });
    if (!response.ok) {
      const hint = response.status === 410 ? ' Issues are turned off in this repository; turn them on to get update notices.' : '';
      throw new Error(`GitHub answered ${response.status} to ${method} ${path}.${hint}`);
    }
    return response.json();
  }
  return {
    async open() {
      // With issues turned off there is no notice to find, and nothing to close.
      const response = await fetch(`https://api.github.com/repos/${repo}/issues?state=open&per_page=100`, { headers: api(token) });
      if (response.status === 410) return [];
      if (!response.ok) throw new Error(`GitHub answered ${response.status} when asked for this repository's issues.`);
      const list = await response.json();
      return list.filter((issue) => !issue.pull_request && String(issue.body ?? '').includes(MARK));
    },
    async write(open, title, body) {
      if (open.length === 0) return call('POST', '/issues', { title, body });
      return call('PATCH', `/issues/${open[0].number}`, { title, body });
    },
    async close(issue, comment) {
      await call('POST', `/issues/${issue.number}/comments`, { body: comment });
      await call('PATCH', `/issues/${issue.number}`, { state: 'closed', state_reason: 'completed' });
    },
  };
}

/**
 * The weekly check, and the update when the workflow is run by hand (or every time, with
 * QUILLIPI_UPDATES set to automatic). Returns what it did: current, noticed or updated.
 */
export async function runWorkflow({ dir, env, fetch, git, wait, log = console.log }) {
  const mode = (env.QUILLIPI_UPDATES ?? '').trim() || 'notice';
  if (mode !== 'notice' && mode !== 'automatic') throw new Error(`QUILLIPI_UPDATES is "${mode}"; it should be notice or automatic.`);
  const repo = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  const notices = issues(repo, { fetch, token });
  const open = await notices.open();
  const { pin, latest, bytes, release } = await lookUp(dir, { fetch, token, wait });

  if (!release) {
    for (const issue of open) await notices.close(issue, `This Quillipi runs ${pin.version}, the newest release.`);
    log(`This Quillipi runs ${pin.version}, the newest release.`);
    return 'current';
  }
  const moves = storageMoves(pin.storage, release.storage);
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' && mode === 'notice') {
    const issue = await notices.write(open, `Quillipi ${latest.version} is ready`, noticeBody({ repo, current: pin.version, latest, moves }));
    log(`Quillipi ${latest.version} is ready; this Quillipi runs ${pin.version}. Issue #${issue.number} says how to update.`);
    return 'noticed';
  }

  const files = applyRelease(dir, bytes, release, pin.source);
  git(['config', 'user.name', 'github-actions[bot]']);
  git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  git(['add', '--', ...files]);
  const details = [`From ${pin.version}. ${latest.page}`.trim(), storageWarning(moves).replaceAll('**', '')].filter(Boolean).join('\n\n');
  git(['commit', '-m', `Update Quillipi to ${latest.version}`, '-m', details]);
  git(['push']);
  const commit = git(['rev-parse', '--short', 'HEAD']).trim();
  for (const issue of open) await notices.close(issue, `Updated to Quillipi ${latest.version} in ${commit}. Cloudflare deploys it within a few minutes; to undo it, revert that commit.`);
  log(`Updated to Quillipi ${latest.version} in ${commit}: ${files.join(', ')}.`);
  return 'updated';
}

/** The same without GitHub Actions: says what is out, and applies it with `apply`. */
export async function runHere({ dir, apply, fetch, wait, log = console.log }) {
  const { pin, latest, bytes, release } = await lookUp(dir, { fetch, wait });
  if (!release) return log(`This copy runs Quillipi ${pin.version}, the newest release.`);
  const warning = storageWarning(storageMoves(pin.storage, release.storage)).replaceAll('**', '');
  if (!apply) return log([`Quillipi ${latest.version} is out; this copy runs ${pin.version}. To update: npm run update -- apply`, warning].filter(Boolean).join('\n'));
  const files = applyRelease(dir, bytes, release, pin.source);
  log([`Wrote Quillipi ${latest.version}'s files: ${files.join(', ')}.`, warning, 'Commit them and push: Cloudflare deploys the commit.'].filter(Boolean).join('\n'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = dirname(fileURLToPath(import.meta.url));
  const run =
    process.env.GITHUB_ACTIONS === 'true'
      ? runWorkflow({ dir, env: process.env, fetch, git: (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }) })
      : runHere({ dir, apply: process.argv[2] === 'apply', fetch });
  run.catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
