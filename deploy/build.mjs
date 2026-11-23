// Quillipi's build for this copy. It gets the release quillipi-release.json names, checks that it is
// exactly that file (its SHA-256 fingerprint), and turns it into what `wrangler deploy` uploads:
// dist/worker/ (Quillipi's Worker, already bundled and tested), dist/web/ (the app) and
// dist/wrangler.json (Quillipi's own Cloudflare settings, joined with this copy's from wrangler.jsonc).
// It needs only Node.js. Quillipi's updates replace this file; your settings live in wrangler.jsonc.
//
//   node build.mjs                   the pinned release, downloaded once and kept in dist/
//   node build.mjs --release <file>  a release file you have, which must be the pinned one

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/**
 * The release format this script reads, which a release names under the key `inklog` (Quillipi's
 * code name, kept in its file formats). A release's `version` and `copy` keep their shape in every
 * format: an older copy's update.mjs reads them to bring in the scripts that read a newer one.
 */
export const RELEASE_FORMAT = 1;

/** The pin: which repository publishes Quillipi, which release this copy runs, and its fingerprint. */
export const PIN_FILE = 'quillipi-release.json';

/** What wrangler.jsonc may set: everything else comes from the release, so updates can change it. */
const OWN_SETTINGS = ['$schema', 'name', 'account_id', 'vars', 'kv_namespaces', 'routes', 'route', 'workers_dev'];

/** Reads JSON with comments and trailing commas, as wrangler.jsonc allows. */
export function parseJsonc(text) {
  return JSON.parse(withoutTrailingCommas(withoutComments(text.replace(/^﻿/, ''))));
}

/** Copies `text`, strings whole; elsewhere `skip(i)` says how many characters to leave out at i. */
function outsideStrings(text, skip) {
  let out = '';
  for (let i = 0; i < text.length; ) {
    if (text[i] === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      out += text.slice(i, end + 1);
      i = end + 1;
    } else {
      const count = skip(i);
      if (count > 0) i += count;
      else out += text[i++];
    }
  }
  return out;
}

function withoutComments(text) {
  return outsideStrings(text, (i) => {
    if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i);
      return (end < 0 ? text.length : end) - i;
    }
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw new SyntaxError('A /* comment is never closed.');
      return end + 2 - i;
    }
    return 0;
  });
}

function withoutTrailingCommas(text) {
  const closing = /\s*[}\]]/y;
  return outsideStrings(text, (i) => {
    if (text[i] !== ',') return 0;
    closing.lastIndex = i + 1;
    return closing.test(text) ? 1 : 0;
  });
}

/** A SHA-256 fingerprint, in hex. */
export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Checks the pin (quillipi-release.json): which repository publishes Quillipi, which release, and its fingerprint. */
export function readPin(text) {
  const pin = JSON.parse(text);
  const valid =
    /^[\w.-]+\/[\w.-]+$/.test(String(pin?.source)) && /^\d+\.\d+\.\d+$/.test(String(pin?.version)) && /^[0-9a-f]{64}$/.test(String(pin?.sha256));
  if (!valid) throw new Error(`${PIN_FILE} should name the repository Quillipi comes from ("owner/name"), a version such as 0.3.0, and the SHA-256 fingerprint of that release file.`);
  return pin;
}

export function releaseName(version) {
  return `quillipi-${version}.json`;
}

/** Where a release is published: a file attached to its GitHub release. */
export function releaseUrl({ source, version }) {
  return `https://github.com/${source}/releases/download/v${version}/${releaseName(version)}`;
}

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/** Downloads `url`, trying three times, as a download can fail for a moment. */
export async function download(url, { fetch = globalThis.fetch, wait = pause, headers = {} } = {}) {
  let failure = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { headers: { 'user-agent': 'quillipi-copy', ...headers } });
      if (response.ok) return Buffer.from(await response.arrayBuffer());
      failure = `it answered ${response.status}`;
      // Missing stays missing: a release not published yet, or a repository that isn't public.
      if (response.status === 404) break;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (attempt < 3) await wait(attempt * 2000);
  }
  throw new Error(`Couldn't download ${url}: ${failure}.`);
}

/**
 * The bytes of the pinned release: `file` if given, else the copy kept in `dir` by an earlier build,
 * else downloaded and kept there. Whichever it is, its fingerprint must be the pinned one.
 */
export async function fetchRelease(pin, { dir, file, fetch, wait } = {}) {
  if (file) return pinned(readFileSync(file), pin, file);
  const kept = join(dir, releaseName(pin.version));
  if (existsSync(kept)) {
    const bytes = readFileSync(kept);
    if (sha256(bytes) === pin.sha256) return bytes;
  }
  const url = releaseUrl(pin);
  const bytes = pinned(await download(url, { fetch, wait }), pin, url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(kept, bytes);
  return bytes;
}

function pinned(bytes, pin, from) {
  const found = sha256(bytes);
  if (found !== pin.sha256) {
    throw new Error(`${from} isn't the release ${PIN_FILE} names: its SHA-256 fingerprint is ${found}, and the pinned one is ${pin.sha256}. Nothing was built.`);
  }
  return bytes;
}

/** Reads a release file, checking it is the version expected and in a format this script reads. */
export function openRelease(bytes, { version }) {
  const release = JSON.parse(Buffer.from(bytes).toString('utf8'));
  if (release.inklog !== RELEASE_FORMAT) {
    throw new Error(`Quillipi ${release.version} is a release in format ${release.inklog}, and this build script reads format ${RELEASE_FORMAT}. Update this copy's Quillipi files first (npm run update -- apply), which brings the script that reads it.`);
  }
  if (release.version !== version) throw new Error(`The release file holds Quillipi ${release.version}, not ${version}.`);
  return release;
}

/** Where a copy keeps its weekly update check. Cloudflare's GitHub app can't add workflow files, so Home asks the owner to. */
export const UPDATE_WORKFLOW = '.github/workflows/update.yml';

const COMMIT_ID = /^[0-9a-f]{7,40}$/i;

/**
 * The commit being deployed, as Cloudflare's builds or GitHub Actions name it, else as the copy's
 * Git checkout says. Only a real commit ID counts: Cloudflare's first build of a new copy gave
 * WORKERS_CI_COMMIT_SHA as "main". "unknown" in a build service that named none, else "by hand".
 */
export function commitFrom(env, head) {
  const sha = [env.WORKERS_CI_COMMIT_SHA, env.GITHUB_SHA, head].find((value) => COMMIT_ID.test(value ?? ''));
  if (sha) return sha.slice(0, 7).toLowerCase();
  return env.WORKERS_CI || env.GITHUB_ACTIONS ? 'unknown' : 'by hand';
}

/**
 * What the copy's Git checkout in `dir` says: the commit checked out, and the GitHub repository
 * its remote "origin" points at. Read from the files, so the build needs no Git program; anything
 * missing is left out. A clone's remote address can carry a token, so only "owner/name" is kept.
 */
export function readGit(dir) {
  const git = join(dir, '.git');
  if (!existsSync(join(git, 'HEAD'))) return {};
  const read = (path) => {
    try {
      return readFileSync(join(git, path), 'utf8');
    } catch {
      return undefined;
    }
  };
  const found = {};
  const head = headCommit(read);
  if (head) found.head = head;
  const origin = originUrl(read('config') ?? '');
  const repository = origin && githubRepository(origin);
  if (repository) found.repository = repository;
  return found;
}

function headCommit(read) {
  const head = read('HEAD')?.trim() ?? '';
  const ref = /^ref: (refs\/\S+)$/.exec(head)?.[1];
  if (!ref) return COMMIT_ID.test(head) ? head : undefined;
  const loose = read(ref)?.trim();
  if (loose && COMMIT_ID.test(loose)) return loose;
  // A fresh clone keeps its branches in packed-refs: "<commit> <ref>" per line.
  for (const line of (read('packed-refs') ?? '').split('\n')) {
    const [sha, name] = line.trim().split(' ');
    if (name === ref && COMMIT_ID.test(sha ?? '')) return sha;
  }
  return undefined;
}

/** The address of the remote "origin" in a Git config file. */
export function originUrl(config) {
  let inOrigin = false;
  for (const line of config.split('\n')) {
    const text = line.trim();
    if (text.startsWith('[')) inOrigin = /^\[remote\s+"origin"\]$/.test(text);
    else if (inOrigin) {
      const url = /^url\s*=\s*(.+)$/.exec(text)?.[1];
      if (url) return url.trim();
    }
  }
  return undefined;
}

/** "owner/name" from a GitHub repository's address, over HTTPS (with or without a token) or SSH. */
export function githubRepository(url) {
  const match = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  if (!match || match[2] === '.' || match[2] === '..') return undefined;
  return `${match[1]}/${match[2]}`;
}

/**
 * This copy's GitHub repository, for Home's Turn on updates step: its checkout's origin, else, in
 * Cloudflare's build without one, the repository the Deploy to Cloudflare button makes, which is
 * named after the Worker in the GitHub account given as GITHUB_USER_LOGIN. Undefined when unknown,
 * as for this repository's own Quillipi, which is built from a folder with no Git and needs no step.
 */
export function repositoryFrom(git, env, own) {
  if (git.repository) return git.repository;
  const login = own.vars?.GITHUB_USER_LOGIN?.trim() ?? '';
  if (env.WORKERS_CI && /^[A-Za-z0-9-]+$/.test(login) && /^[\w.-]+$/.test(own.name ?? '')) return `${login}/${own.name}`;
  return undefined;
}

/**
 * The Cloudflare settings `wrangler deploy` uses: the release's own (bindings, Durable Object
 * migrations, compatibility date and flags, assets), and this copy's from wrangler.jsonc: its
 * Worker's name, its variables, the IDs of its resources, its routes. A blank variable is left out,
 * which means Quillipi uses the value kept inside it. A setting a copy can't set is an error, never
 * ignored, so nothing in wrangler.jsonc can quietly do nothing. The build adds what it found:
 * COMMIT, REPOSITORY (the copy's GitHub repository, when known) and UPDATE_WORKFLOW ("found" or
 * "missing"), which Home's Get started reads to show Turn on updates and tick it.
 */
export function makeConfig(release, own, { commit, repository, workflow }) {
  const unknown = Object.keys(own).filter((key) => !OWN_SETTINGS.includes(key));
  if (unknown.length > 0) {
    throw new Error(`wrangler.jsonc sets ${unknown.map((key) => `"${key}"`).join(', ')}, which Quillipi's release sets itself. A copy can set ${OWN_SETTINGS.slice(1).join(', ')}.`);
  }
  if (typeof own.name !== 'string' || own.name.trim() === '') throw new Error('wrangler.jsonc needs "name": the name of this Quillipi\'s Worker.');
  const config = structuredClone(release.config);
  config.name = own.name;
  for (const key of ['account_id', 'routes', 'route', 'workers_dev']) if (own[key] !== undefined) config[key] = own[key];

  // The copy's repository as found; one named in wrangler.jsonc wins, for a copy that was renamed.
  const vars = { ...config.vars, ...(repository ? { REPOSITORY: repository } : {}) };
  for (const [name, value] of Object.entries(own.vars ?? {})) {
    if (typeof value !== 'string') throw new Error(`wrangler.jsonc gives the variable ${name} a value that isn't text.`);
    if (value.trim() === '') delete vars[name];
    else vars[name] = value;
  }
  config.vars = { ...vars, COMMIT: commit, ...(workflow === undefined ? {} : { UPDATE_WORKFLOW: workflow ? 'found' : 'missing' }) };

  const ids = new Map();
  for (const namespace of own.kv_namespaces ?? []) {
    if (!(config.kv_namespaces ?? []).some((ours) => ours.binding === namespace.binding)) {
      throw new Error(`wrangler.jsonc has a KV namespace bound as ${namespace.binding}, which Quillipi doesn't use.`);
    }
    if (namespace.id) ids.set(namespace.binding, namespace.id);
  }
  // Without an ID, Wrangler keeps the namespace this Worker already has, or makes one on a first deploy.
  if (config.kv_namespaces) config.kv_namespaces = config.kv_namespaces.map((ours) => (ids.has(ours.binding) ? { ...ours, id: ids.get(ours.binding) } : ours));
  return config;
}

/** A release's path for a file, checked to stay inside the folder it is written to. */
export function safePath(path) {
  const plain = /^[\w.@-]+(\/[\w.@-]+)*$/.test(path) && !path.split('/').some((part) => part === '.' || part === '..');
  if (!plain) throw new Error(`The release has a file at "${path}", which isn't a plain relative path.`);
  return path;
}

/** A file as a release keeps it: text as it is, anything else in base64. */
export function fileBytes(file) {
  return typeof file.text === 'string' ? Buffer.from(file.text, 'utf8') : Buffer.from(file.base64, 'base64');
}

/** Writes the release's Worker and app, replacing earlier ones, and the config beside them. */
export function unpack(release, config, out) {
  for (const part of ['worker', 'web']) {
    rmSync(join(out, part), { recursive: true, force: true });
    for (const [path, file] of Object.entries(release[part])) {
      const target = join(out, part, safePath(path));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, fileBytes(file));
    }
  }
  writeFileSync(join(out, 'wrangler.json'), `${JSON.stringify(config, null, 2)}\n`);
}

async function main() {
  const { values } = parseArgs({ options: { release: { type: 'string' } } });
  const here = dirname(fileURLToPath(import.meta.url));
  const pin = readPin(readFileSync(join(here, PIN_FILE), 'utf8'));
  const own = parseJsonc(readFileSync(join(here, 'wrangler.jsonc'), 'utf8'));
  const out = join(here, 'dist');
  const bytes = await fetchRelease(pin, { dir: out, file: values.release && resolve(values.release) });
  const release = openRelease(bytes, pin);
  const git = readGit(here);
  const config = makeConfig(release, own, {
    commit: commitFrom(process.env, git.head),
    repository: repositoryFrom(git, process.env, own),
    workflow: existsSync(join(here, UPDATE_WORKFLOW)),
  });
  unpack(release, config, out);
  console.log(`Quillipi ${release.version} is ready to deploy as the Worker "${config.name}", with ${join('dist', 'wrangler.json')}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
