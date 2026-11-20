import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commitFrom,
  fetchRelease,
  fileBytes,
  makeConfig,
  openRelease,
  parseJsonc,
  readPin,
  releaseUrl,
  safePath,
  sha256,
  unpack,
} from '../../../deploy/build.mjs';
import { newer, readRelease, runHere, runWorkflow, storageMoves } from '../../../deploy/update.mjs';
import { makeRelease, packFile } from '../scripts/release.mjs';

const DEPLOY = new URL('../../../deploy/', import.meta.url);
const folders: string[] = [];
const folder = () => {
  const made = mkdtempSync(join(tmpdir(), 'quillipi-copy-'));
  folders.push(made);
  return made;
};
afterEach(() => {
  for (const made of folders.splice(0)) rmSync(made, { recursive: true, force: true });
});

const CONFIG = {
  main: 'worker/index.js',
  no_bundle: true,
  compatibility_date: '2026-10-15',
  assets: { directory: 'web', run_worker_first: ['/api/*'] },
  kv_namespaces: [{ binding: 'OAUTH_KV' }],
};

/** A small release, as release.mjs makes them. */
function release({ version = '0.3.0', storage = { library: 1, room: 1 }, copy = new Map<string, string>([['build.mjs', '// build'], ['README.md', '# Quillipi']]) } = {}) {
  const bytes = (text: string) => Buffer.from(text);
  return Buffer.from(
    makeRelease({
      version,
      storage,
      config: CONFIG,
      worker: new Map([['index.js', bytes('export default {};\n')]]),
      web: new Map([['index.html', bytes('<!doctype html>')], ['icons/icon.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00])]]),
      copy: new Map([...copy].map(([path, text]) => [path, bytes(text)])),
    }),
  );
}

const pinOf = (bytes: Buffer, version = '0.3.0') => ({ source: 'quillipi/quillipi', version, sha256: sha256(bytes), storage: { library: 1, room: 1 } });

describe('reading wrangler.jsonc', () => {
  it('drops comments and trailing commas, never inside strings', () => {
    const text = '﻿{\n  // a comment with "quotes"\n  "url": "https://example.com/a//b", /* block\n comment */\n  "glob": "/api/*",\n  "say": "a \\"quoted\\" // word",\n  "list": [1, 2,],\n}\n';
    expect(parseJsonc(text)).toEqual({ url: 'https://example.com/a//b', glob: '/api/*', say: 'a "quoted" // word', list: [1, 2] });
    expect(() => parseJsonc('{ /* never closed }')).toThrow('A /* comment is never closed.');
  });

  it("reads the copy's file and Quillipi's own", () => {
    expect(parseJsonc(readFileSync(new URL('wrangler.jsonc', DEPLOY), 'utf8'))).toMatchObject({ name: 'quillipi', vars: { GITHUB_USER_LOGIN: '' } });
    expect(parseJsonc(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')).assets.run_worker_first).toContain('/mcp');
  });
});

describe('the pin', () => {
  it('names a repository, a version and a fingerprint, and the release file at its GitHub release', () => {
    const pin = readPin(readFileSync(new URL('quillipi-release.json', DEPLOY), 'utf8'));
    expect(pin.source).toBe('quillipi/quillipi');
    expect(releaseUrl(pin)).toBe(`https://github.com/quillipi/quillipi/releases/download/v${pin.version}/quillipi-${pin.version}.json`);
    for (const wrong of ['{}', '{"source":"quillipi/quillipi","version":"0.3","sha256":"' + 'a'.repeat(64) + '"}', '{"source":"x","version":"0.3.0","sha256":"' + 'a'.repeat(64) + '"}', '{"source":"a/b","version":"0.3.0","sha256":"ABC"}']) {
      expect(() => readPin(wrong)).toThrow('quillipi-release.json should name');
    }
  });
});

describe('getting the pinned release', () => {
  const answer = (bytes: Buffer, status = 200) => async () => new Response(status === 200 ? bytes : 'no', { status });

  it('downloads it once, keeps it, and uses the kept file while it is the pinned one', async () => {
    const bytes = release();
    const dir = folder();
    const asked: string[] = [];
    const fetch = async (url: string) => {
      asked.push(url);
      return new Response(bytes);
    };
    expect((await fetchRelease(pinOf(bytes), { dir, fetch })).equals(bytes)).toBe(true);
    expect((await fetchRelease(pinOf(bytes), { dir, fetch })).equals(bytes)).toBe(true);
    expect(asked).toEqual(['https://github.com/quillipi/quillipi/releases/download/v0.3.0/quillipi-0.3.0.json']);
    // A kept file that isn't the pinned one any more is downloaded again.
    writeFileSync(join(dir, 'quillipi-0.3.0.json'), 'changed');
    await fetchRelease(pinOf(bytes), { dir, fetch });
    expect(asked).toHaveLength(2);
  });

  it('refuses any other file, downloaded or given, and keeps nothing', async () => {
    const bytes = release();
    const dir = folder();
    const pin = { ...pinOf(bytes), sha256: 'f'.repeat(64) };
    await expect(fetchRelease(pin, { dir, fetch: answer(bytes) })).rejects.toThrow(`isn't the release quillipi-release.json names: its SHA-256 fingerprint is ${sha256(bytes)}`);
    expect(existsSync(join(dir, 'quillipi-0.3.0.json'))).toBe(false);
    writeFileSync(join(dir, 'given.json'), bytes);
    await expect(fetchRelease(pin, { dir, file: join(dir, 'given.json') })).rejects.toThrow('Nothing was built.');
    expect((await fetchRelease(pinOf(bytes), { dir, file: join(dir, 'given.json') })).equals(bytes)).toBe(true);
  });

  it('tries a failing download three times, and a missing one once', async () => {
    const bytes = release();
    let tries = 0;
    const flaky = async () => (++tries < 3 ? new Response('busy', { status: 503 }) : new Response(bytes));
    const waits: number[] = [];
    const wait = async (ms: number) => void waits.push(ms);
    expect((await fetchRelease(pinOf(bytes), { dir: folder(), fetch: flaky, wait })).equals(bytes)).toBe(true);
    expect(waits).toEqual([2000, 4000]);
    tries = 0;
    const missing = async () => (tries++, new Response('no', { status: 404 }));
    await expect(fetchRelease(pinOf(bytes), { dir: folder(), fetch: missing, wait })).rejects.toThrow('quillipi-0.3.0.json: it answered 404.');
    expect(tries).toBe(1);
  });

  it('reads only its own format and the pinned version', () => {
    const bytes = release();
    expect(openRelease(bytes, { version: '0.3.0' }).version).toBe('0.3.0');
    expect(() => openRelease(bytes, { version: '0.4.0' })).toThrow('The release file holds Quillipi 0.3.0, not 0.4.0.');
    const later = Buffer.from(JSON.stringify({ ...JSON.parse(bytes.toString()), inklog: 2 }));
    expect(() => openRelease(later, { version: '0.3.0' })).toThrow('Quillipi 0.3.0 is a release in format 2, and this build script reads format 1. Update this copy');
  });
});

describe('the config a copy deploys', () => {
  const ofRelease = { config: CONFIG };

  it("is the release's, with the copy's name, variables, resource IDs and routes", () => {
    const own = { $schema: 'x', name: 'my-quillipi', account_id: 'acc', routes: [{ pattern: 'notes.example.com', custom_domain: true }], workers_dev: false, vars: { GITHUB_USER_LOGIN: 'octocat', PUBLIC_URL: 'https://notes.example.com', OWNER_NAME: '  ' }, kv_namespaces: [{ binding: 'OAUTH_KV', id: 'abc' }] };
    const config = makeConfig(ofRelease, own, { commit: '1234567' });
    expect(config).toEqual({
      ...CONFIG,
      name: 'my-quillipi',
      account_id: 'acc',
      routes: own.routes,
      workers_dev: false,
      // A blank variable is left out: Quillipi then uses the value kept inside it.
      vars: { GITHUB_USER_LOGIN: 'octocat', PUBLIC_URL: 'https://notes.example.com', COMMIT: '1234567' },
      kv_namespaces: [{ binding: 'OAUTH_KV', id: 'abc' }],
    });
    expect(CONFIG.kv_namespaces).toEqual([{ binding: 'OAUTH_KV' }]);
  });

  it("from the template as it is: the Worker quillipi, no variable but the commit, the namespace it already has", () => {
    const own = parseJsonc(readFileSync(new URL('wrangler.jsonc', DEPLOY), 'utf8'));
    expect(makeConfig(ofRelease, own, { commit: 'by hand' })).toEqual({ ...CONFIG, name: 'quillipi', vars: { COMMIT: 'by hand' } });
  });

  it('refuses what a copy can’t set, rather than ignoring it', () => {
    expect(() => makeConfig(ofRelease, { name: 'x', main: 'src/index.ts', limits: {} }, { commit: 'c' })).toThrow('wrangler.jsonc sets "main", "limits", which Quillipi\'s release sets itself.');
    expect(() => makeConfig(ofRelease, { vars: {} }, { commit: 'c' })).toThrow('wrangler.jsonc needs "name"');
    expect(() => makeConfig(ofRelease, { name: 'x', vars: { N: 3 } }, { commit: 'c' })).toThrow("gives the variable N a value that isn't text");
    expect(() => makeConfig(ofRelease, { name: 'x', kv_namespaces: [{ binding: 'CACHE', id: 'a' }] }, { commit: 'c' })).toThrow('a KV namespace bound as CACHE, which Quillipi doesn\'t use');
  });

  it('names the commit as Cloudflare or GitHub Actions gives it', () => {
    expect(commitFrom({ WORKERS_CI_COMMIT_SHA: 'abcdef0123', GITHUB_SHA: 'ffffffff' })).toBe('abcdef0');
    expect(commitFrom({ GITHUB_SHA: '0123456789' })).toBe('0123456');
    expect(commitFrom({})).toBe('by hand');
  });
});

describe('unpacking a release', () => {
  it('writes the Worker and the app byte for byte, replacing the earlier ones, and the config', () => {
    const bytes = release();
    const out = folder();
    mkdirSync(join(out, 'web'));
    writeFileSync(join(out, 'web', 'stale.txt'), 'from an earlier release');
    const opened = openRelease(bytes, { version: '0.3.0' });
    unpack(opened, { name: 'quillipi' }, out);
    expect(readFileSync(join(out, 'worker', 'index.js'), 'utf8')).toBe('export default {};\n');
    expect(readFileSync(join(out, 'web', 'icons', 'icon.png')).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]))).toBe(true);
    expect(existsSync(join(out, 'web', 'stale.txt'))).toBe(false);
    expect(JSON.parse(readFileSync(join(out, 'wrangler.json'), 'utf8'))).toEqual({ name: 'quillipi' });
  });

  it('keeps text as text, with its byte order mark, and anything else in base64', () => {
    const bom = Buffer.from('﻿hello\n');
    expect(packFile(bom)).toEqual({ text: '﻿hello\n' });
    expect(fileBytes(packFile(bom)).equals(bom)).toBe(true);
    const binary = Buffer.from([0xff, 0xfe, 0x00, 0x80]);
    expect(packFile(binary)).toEqual({ base64: binary.toString('base64') });
    expect(fileBytes(packFile(binary)).equals(binary)).toBe(true);
  });

  it('writes only plain relative paths', () => {
    expect(safePath('assets/index-B_x.js')).toBe('assets/index-B_x.js');
    for (const path of ['../x', 'a/../../x', '/etc/x', 'a\\b', 'a//b', './a', '', 'a/']) expect(() => safePath(path), path).toThrow("isn't a plain relative path");
  });
});

describe('updates', () => {
  const REPO = 'someone/my-quillipi';

  /** A copy as the button makes it, at 0.3.0. */
  function copy() {
    const dir = folder();
    writeFileSync(join(dir, 'wrangler.jsonc'), '{ "name": "my-quillipi" }\n');
    writeFileSync(join(dir, 'build.mjs'), '// old build');
    writeFileSync(join(dir, 'quillipi-release.json'), JSON.stringify(pinOf(release())));
    return dir;
  }

  /** GitHub, as far as updates use it: Quillipi's newest release, its file, and this copy's issues. */
  function github(latest: string, file: Buffer, { issuesOff = false } = {}) {
    const issues: { number: number; title: string; body: string; state: string; comments: string[] }[] = [];
    const fetch = async (url: string | URL, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const { hostname, pathname } = new URL(String(url));
      const body = init.body ? JSON.parse(String(init.body)) : {};
      if (pathname === '/repos/quillipi/quillipi/releases/latest') return Response.json({ tag_name: `v${latest}`, body: `What's new in ${latest}.`, html_url: `https://github.com/quillipi/quillipi/releases/tag/v${latest}` });
      if (hostname === 'github.com' && pathname === `/quillipi/quillipi/releases/download/v${latest}/quillipi-${latest}.json`) return new Response(file);
      if (pathname.startsWith(`/repos/${REPO}/issues`) && issuesOff) return new Response('', { status: 410 });
      if (pathname === `/repos/${REPO}/issues` && method === 'GET') return Response.json(issues.filter((issue) => issue.state === 'open'));
      if (pathname === `/repos/${REPO}/issues` && method === 'POST') {
        issues.push({ number: issues.length + 1, state: 'open', comments: [], ...body });
        return Response.json(issues.at(-1));
      }
      const one = pathname.match(/^\/repos\/someone\/my-quillipi\/issues\/(\d+)(\/comments)?$/);
      if (one) {
        const issue = issues[Number(one[1]) - 1]!;
        if (one[2]) issue.comments.push(body.body);
        else Object.assign(issue, body);
        return Response.json(issue);
      }
      return new Response('not here', { status: 404 });
    };
    return { fetch, issues };
  }

  function git() {
    const calls: string[][] = [];
    return { calls, run: (args: string[]) => (calls.push(args), args[0] === 'rev-parse' ? 'abc1234\n' : '') };
  }

  const env = (event: string, more: Record<string, string> = {}) => ({ GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: 't', GITHUB_EVENT_NAME: event, ...more });
  const quiet = () => {};

  it('compares versions as numbers', () => {
    expect(newer('0.10.0', '0.9.9')).toBe(true);
    expect(newer('1.0.0', '0.99.0')).toBe(true);
    expect(newer('0.3.0', '0.3.0')).toBe(false);
    expect(newer('0.3.0', '0.3.1')).toBe(false);
  });

  it('says which parts of storage a release moves forward', () => {
    expect(storageMoves({ library: 1, room: 1 }, { library: 2, room: 1 })).toEqual(['library 1 → 2']);
    expect(storageMoves(undefined, { room: 3, library: 1 })).toEqual(['room 1 → 3']);
    expect(storageMoves({ library: 2 }, { library: 2 })).toEqual([]);
  });

  it('opens one issue when a newer Quillipi is out, and keeps it up to date', async () => {
    const dir = copy();
    const hub = github('0.4.0', release({ version: '0.4.0' }));
    const git1 = git();
    expect(await runWorkflow({ dir, env: env('schedule'), fetch: hub.fetch, git: git1.run, log: quiet })).toBe('noticed');
    expect(hub.issues).toHaveLength(1);
    expect(hub.issues[0]).toMatchObject({ title: 'Quillipi 0.4.0 is ready', state: 'open' });
    expect(hub.issues[0]!.body).toContain("What's new in 0.4.0.");
    expect(hub.issues[0]!.body).toContain('[Update Quillipi](https://github.com/someone/my-quillipi/actions/workflows/update.yml)');
    expect(hub.issues[0]!.body).not.toContain('stores its data forward');
    // The next week, still the same issue; nothing was written or committed.
    await runWorkflow({ dir, env: env('schedule'), fetch: hub.fetch, git: git1.run, log: quiet });
    expect(hub.issues).toHaveLength(1);
    expect(readFileSync(join(dir, 'build.mjs'), 'utf8')).toBe('// old build');
    expect(git1.calls).toEqual([]);
  });

  it('applies the update when run by hand: Quillipi’s files and the pin, committed; the copy’s own untouched', async () => {
    const dir = copy();
    const file = release({ version: '0.4.0', storage: { library: 2, room: 1 }, copy: new Map([['build.mjs', '// new build'], ['README.md', '# Quillipi 0.4']]) });
    const hub = github('0.4.0', file);
    await runWorkflow({ dir, env: env('schedule'), fetch: hub.fetch, git: git().run, log: quiet });
    expect(hub.issues[0]!.body).toContain('**This update moves how Quillipi stores its data forward** (library 1 → 2).');
    const commits = git();
    expect(await runWorkflow({ dir, env: env('workflow_dispatch'), fetch: hub.fetch, git: commits.run, log: quiet })).toBe('updated');
    expect(readFileSync(join(dir, 'build.mjs'), 'utf8')).toBe('// new build');
    expect(readFileSync(join(dir, 'wrangler.jsonc'), 'utf8')).toBe('{ "name": "my-quillipi" }\n');
    expect(readPin(readFileSync(join(dir, 'quillipi-release.json'), 'utf8'))).toEqual({ source: 'quillipi/quillipi', version: '0.4.0', sha256: sha256(file), storage: { library: 2, room: 1 } });
    expect(commits.calls.map((args) => args.slice(0, 2).join(' '))).toEqual(['config user.name', 'config user.email', 'add --', 'commit -m', 'push', 'rev-parse --short']);
    expect(commits.calls[2]).toEqual(['add', '--', 'README.md', 'build.mjs', 'quillipi-release.json']);
    expect(commits.calls[3]!.slice(0, 3)).toEqual(['commit', '-m', 'Update Quillipi to 0.4.0']);
    expect(commits.calls[3]![4]).toContain('From 0.3.0. https://github.com/quillipi/quillipi/releases/tag/v0.4.0');
    expect(commits.calls[3]![4]).toContain('This update moves how Quillipi stores its data forward (library 1 → 2).');
    expect(hub.issues[0]).toMatchObject({ state: 'closed', state_reason: 'completed' });
    expect(hub.issues[0]!.comments).toEqual(['Updated to Quillipi 0.4.0 in abc1234. Cloudflare deploys it within a few minutes; to undo it, revert that commit.']);
    // Up to date now: nothing more to do.
    expect(await runWorkflow({ dir, env: env('schedule'), fetch: hub.fetch, git: commits.run, log: quiet })).toBe('current');
  });

  it('updates without asking when set to automatic, and refuses an unknown setting', async () => {
    const dir = copy();
    const hub = github('0.4.0', release({ version: '0.4.0' }));
    expect(await runWorkflow({ dir, env: env('schedule', { QUILLIPI_UPDATES: 'automatic' }), fetch: hub.fetch, git: git().run, log: quiet })).toBe('updated');
    expect(hub.issues).toEqual([]);
    await expect(runWorkflow({ dir, env: env('schedule', { QUILLIPI_UPDATES: 'sometimes' }), fetch: hub.fetch, git: git().run, log: quiet })).rejects.toThrow('QUILLIPI_UPDATES is "sometimes"; it should be notice or automatic.');
  });

  it('closes a notice once the copy is up to date, and works with issues turned off', async () => {
    const dir = copy();
    const hub = github('0.3.0', release());
    hub.issues.push({ number: 1, title: 'Quillipi 0.3.0 is ready', body: 'x\n\n<!-- quillipi-update -->', state: 'open', comments: [] });
    hub.issues.push({ number: 2, title: 'Someone else’s issue', body: 'hello', state: 'open', comments: [] });
    expect(await runWorkflow({ dir, env: env('schedule'), fetch: hub.fetch, git: git().run, log: quiet })).toBe('current');
    expect(hub.issues.map((issue) => issue.state)).toEqual(['closed', 'open']);
    expect(await runWorkflow({ dir, env: env('schedule'), fetch: github('0.3.0', release(), { issuesOff: true }).fetch, git: git().run, log: quiet })).toBe('current');
    const off = github('0.4.0', release({ version: '0.4.0' }), { issuesOff: true });
    await expect(runWorkflow({ dir, env: env('schedule'), fetch: off.fetch, git: git().run, log: quiet })).rejects.toThrow('Issues are turned off in this repository; turn them on to get update notices.');
  });

  it('never lets a release replace what a copy keeps as its own, or write outside it', () => {
    for (const path of ['wrangler.jsonc', 'quillipi-release.json', '.github/workflows/update.yml']) {
      expect(() => readRelease(release({ version: '0.4.0', copy: new Map([[path, 'x']]) }), '0.4.0'), path).toThrow(`Quillipi 0.4.0 would replace ${path}, which this copy keeps as its own.`);
    }
    expect(() => readRelease(release({ version: '0.4.0', copy: new Map([['../x', 'x']]) }), '0.4.0')).toThrow("isn't a plain relative path");
    expect(() => readRelease(release({ version: '0.4.0' }), '0.5.0')).toThrow("The file for Quillipi 0.5.0 isn't a release of it.");
  });

  it('works without GitHub Actions: says what is out, and applies it with apply', async () => {
    const dir = copy();
    const hub = github('0.4.0', release({ version: '0.4.0', copy: new Map([['build.mjs', '// new build']]) }));
    const said: string[] = [];
    await runHere({ dir, apply: false, fetch: hub.fetch, log: (line: string) => said.push(line) });
    expect(said).toEqual(['Quillipi 0.4.0 is out; this copy runs 0.3.0. To update: npm run update -- apply']);
    expect(readFileSync(join(dir, 'build.mjs'), 'utf8')).toBe('// old build');
    await runHere({ dir, apply: true, fetch: hub.fetch, log: (line: string) => said.push(line) });
    expect(said[1]).toBe("Wrote Quillipi 0.4.0's files: build.mjs, quillipi-release.json.\nCommit them and push: Cloudflare deploys the commit.");
    expect(readFileSync(join(dir, 'build.mjs'), 'utf8')).toBe('// new build');
  });
});
