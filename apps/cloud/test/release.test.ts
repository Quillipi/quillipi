import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PIN_FILE, makeConfig, parseJsonc, readPin, sha256 } from '../../../deploy/build.mjs';
import { OWN_WORKER, checkStatus, deployedAddresses, makeOwnCopy } from '../scripts/deploy.mjs';
import { changelogNotes, checkSource, publish } from '../scripts/publish.mjs';
import { COPY_FILES, KEPT_FILES, filesUnder, makeRelease, releaseConfig, storageVersion } from '../scripts/release.mjs';
import { ROOM_STORAGE } from '../src/durable-store.js';
import { LIBRARY_STORAGE } from '../src/library.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const json = (path: string) => JSON.parse(read(path));
const VERSION: string = json('package.json').version;

describe('the release file', () => {
  const source = () => parseJsonc(read('apps/cloud/wrangler.jsonc'));

  it("carries Quillipi's own Cloudflare settings, pointed at its bundled files, and no copy's", () => {
    const config = releaseConfig({ ...source(), kv_namespaces: [{ binding: 'OAUTH_KV', id: 'someones-id' }] });
    expect(config).toMatchObject({ main: 'worker/index.js', no_bundle: true, assets: { directory: 'web', not_found_handling: 'single-page-application' }, kv_namespaces: [{ binding: 'OAUTH_KV' }] });
    for (const key of ['$schema', 'name', 'vars']) expect(config).not.toHaveProperty(key);
    // Everything else is the source's, unchanged: the Worker's routes, Durable Objects, migrations.
    for (const key of ['compatibility_date', 'compatibility_flags', 'durable_objects', 'migrations', 'observability', 'workers_dev', 'preview_urls']) expect(config[key], key).toEqual(source()[key]);
    expect(config.assets.run_worker_first).toEqual(source().assets.run_worker_first);
  });

  it('is the same file for the same content, whatever order it was read in', () => {
    const parts = (order: 1 | -1) => {
      const files = (entries: [string, string][]) => new Map((order === 1 ? entries : [...entries].reverse()).map(([path, text]) => [path, Buffer.from(text)]));
      return {
        version: '0.3.0',
        storage: order === 1 ? { library: 1, room: 1 } : { room: 1, library: 1 },
        config: order === 1 ? { a: 1, b: { c: 2, d: 3 } } : { b: { d: 3, c: 2 }, a: 1 },
        worker: files([['index.js', 'x']]),
        web: files([['a.html', 'a'], ['assets/b.js', 'b'], ['icons/c.png', '\u0089PNG']]),
        copy: files([['build.mjs', 'b'], ['README.md', 'r']]),
      };
    };
    const text = makeRelease(parts(1));
    expect(makeRelease(parts(-1))).toBe(text);
    expect(text.endsWith('}\n')).toBe(true);
    expect(Object.keys(JSON.parse(text).web)).toEqual(['a.html', 'assets/b.js', 'icons/c.png']);
  });

  it('records the storage versions the code writes', () => {
    expect(storageVersion('apps/cloud/src/library.ts', 'LIBRARY_STORAGE')).toBe(LIBRARY_STORAGE);
    expect(storageVersion('apps/cloud/src/durable-store.ts', 'ROOM_STORAGE')).toBe(ROOM_STORAGE);
    expect(() => storageVersion('apps/cloud/src/library.ts', 'NO_SUCH')).toThrow('has no "export const NO_SUCH = <number>;"');
  });

  it("carries every file of deploy/ that is Quillipi's, and none that is a copy's own", () => {
    const local = new Set(['node_modules', 'dist', '.wrangler']);
    const files = [...filesUnder(join(ROOT, 'deploy'), (path: string) => local.has(path.split('/')[0]!)).keys()].sort();
    expect(files).toEqual([...COPY_FILES, ...KEPT_FILES].sort());
  });
});

describe('what keeps the release honest', () => {
  it('one version for Quillipi: the root package, every package, and their references to each other', () => {
    const packages = ['apps/cloud', 'apps/inklog', 'apps/web', 'packages/core', 'packages/engine'];
    for (const folder of packages) {
      const pkg = json(`${folder}/package.json`);
      expect(pkg.version, folder).toBe(VERSION);
      for (const [name, wanted] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) if (name.startsWith('@inklog/')) expect(wanted, `${folder}: ${name}`).toBe(VERSION);
    }
  });

  it('the pin names this version, its storage, and Quillipi’s own repository', () => {
    const pin = readPin(read(`deploy/${PIN_FILE}`));
    expect(pin).toMatchObject({ source: 'quillipi/quillipi', version: VERSION, storage: { library: LIBRARY_STORAGE, room: ROOM_STORAGE } });
  });

  it('CHANGELOG.md says what is new in this version', () => {
    expect(changelogNotes(read('CHANGELOG.md'), VERSION)?.length).toBeGreaterThan(50);
  });

  it('copies carry the same license as this repository, with its required notice', () => {
    // The license asks that everyone who gets a copy also gets its terms and the Required Notice.
    expect(COPY_FILES).toContain('LICENSE');
    expect(read('deploy/LICENSE')).toBe(read('LICENSE'));
    expect(read('LICENSE')).toMatch(/^Required Notice: Copyright \d{4} .+ \(https:\/\/quillipi\.app\)$/m);
    for (const path of ['package.json', 'deploy/package.json']) expect(JSON.parse(read(path)).license, path).toBe('SEE LICENSE IN LICENSE');
  });

  it('copies run the same Wrangler and Node.js as this repository', () => {
    const lock = json('package-lock.json').packages;
    expect(json('deploy/package.json').devDependencies.wrangler).toBe(lock['node_modules/wrangler'].version);
    expect(json('deploy/package-lock.json').packages['node_modules/wrangler'].version).toBe(lock['node_modules/wrangler'].version);
    expect(read('deploy/.node-version')).toBe(read('.node-version'));
  });

  it("no one's own values in the repository: no address, owner, App or resource ID", () => {
    const cloud = parseJsonc(read('apps/cloud/wrangler.jsonc'));
    expect(cloud.vars).toEqual({ COMMIT: 'by hand', GITHUB_USER_LOGIN: '' });
    expect(cloud.kv_namespaces).toEqual([{ binding: 'OAUTH_KV' }]);
    const copy = parseJsonc(read('deploy/wrangler.jsonc'));
    expect(copy).toEqual({ $schema: 'node_modules/wrangler/config-schema.json', name: 'quillipi', vars: { GITHUB_USER_LOGIN: '' }, kv_namespaces: [{ binding: 'OAUTH_KV' }] });
  });

  it("the Deploy to Cloudflare form describes everything it asks a copy's owner for", () => {
    const copy = parseJsonc(read('deploy/wrangler.jsonc'));
    const asked = [...copy.kv_namespaces.map((namespace: { binding: string }) => namespace.binding), ...Object.keys(copy.vars)].sort();
    const described = json('deploy/package.json').cloudflare.bindings;
    expect(Object.keys(described).sort()).toEqual(asked);
    for (const name of asked) expect(described[name].description.length, name).toBeGreaterThan(20);
  });

  it("a copy's workflow runs update.mjs, asking before it updates", () => {
    const workflow = read('deploy/.github/workflows/update.yml');
    expect(workflow).toContain('run: node update.mjs');
    expect(workflow).toMatch(/^name: Update Quillipi$/m);
    expect(workflow).toMatch(/^ {10}QUILLIPI_UPDATES: notice$/m);
    expect(workflow).toMatch(/contents: write/);
    expect(workflow).toMatch(/issues: write/);
    // Here it would check this repository for updates of itself.
    expect(existsSync(join(ROOT, '.github/workflows/update.yml'))).toBe(false);
  });
});

describe("deploying this repository's own Quillipi", () => {
  it('keeps its own Worker, inklog, while a new copy is called quillipi', () => {
    expect(OWN_WORKER).toBe('inklog');
    const dir = mkdtempSync(join(tmpdir(), 'quillipi-own-'));
    try {
      const own = makeOwnCopy(dir);
      // A copy as the button makes one, with the template's settings but for the Worker's name.
      expect(own).toEqual({ ...parseJsonc(read('deploy/wrangler.jsonc')), name: 'inklog' });
      expect(parseJsonc(readFileSync(join(dir, 'wrangler.jsonc'), 'utf8'))).toEqual(own);
      for (const name of [...COPY_FILES, PIN_FILE]) expect(readFileSync(join(dir, name), 'utf8'), name).toBe(read(`deploy/${name}`));
      // So the release deploys to this Worker, keeping the namespace it has and the settings kept inside it.
      const config = makeConfig({ config: { main: 'worker/index.js', kv_namespaces: [{ binding: 'OAUTH_KV' }] } }, own, { commit: 'abc1234' });
      expect(config).toEqual({ main: 'worker/index.js', name: 'inklog', vars: { COMMIT: 'abc1234' }, kv_namespaces: [{ binding: 'OAUTH_KV' }] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('checking a deploy', () => {
  it("finds the deployed Worker's addresses in Wrangler's output file", () => {
    const output = ['{"type":"wrangler-session","version":1}', '{"type":"deploy","version":1,"worker_name":"inklog","targets":["https://quillipi.someone.workers.dev","notes.example.com/*"]}', ''].join('\n');
    expect(deployedAddresses(output)).toEqual(['https://quillipi.someone.workers.dev']);
    expect(() => deployedAddresses('{"type":"wrangler-session"}\n')).toThrow("Wrangler's output doesn't record a deploy.");
  });

  it('waits for /status to show the new version with the notebooks open', async () => {
    const answers = [{ version: '0.2.1', notebooks: 'ok' }, { version: '0.3.0', notebooks: 'ok' }];
    const asked: string[] = [];
    const fetch = async (url: URL) => (asked.push(String(url)), Response.json(answers.shift()));
    await checkStatus(['https://quillipi.someone.workers.dev'], '0.3.0', { fetch, wait: async () => {} });
    expect(asked).toEqual(['https://quillipi.someone.workers.dev/status', 'https://quillipi.someone.workers.dev/status']);
  });

  it('fails when the new Quillipi can’t open its notebooks, saying what it answered', async () => {
    const tooNew = { version: '0.3.0', notebooks: 'failing: Quillipi’s library was saved by a newer Quillipi' };
    const fetch = async () => Response.json(tooNew);
    await expect(checkStatus(['https://x.workers.dev'], '0.3.0', { fetch, wait: async () => {}, tries: 3 })).rejects.toThrow(
      "https://x.workers.dev/status didn't show Quillipi 0.3.0 with its notebooks open; the last answer: version 0.3.0, notebooks failing: Quillipi’s library was saved by a newer Quillipi.",
    );
  });
});

describe('publishing a release', () => {
  const NOTES = 'What is new.';
  const bytes = Buffer.from('{"inklog":1}\n');

  /** GitHub's releases API, as far as publishing uses it. */
  function github(existing: { draft: boolean; asset?: Buffer } | undefined) {
    const calls: string[] = [];
    let release = existing && { id: 7, tag_name: 'v0.3.0', draft: existing.draft, assets: existing.asset ? [{ name: 'quillipi-0.3.0.json', url: 'https://api.github.com/repos/quillipi/quillipi/releases/assets/9' }] : [] };
    const fetch = async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const { pathname } = new URL(url);
      calls.push(`${method} ${pathname}`);
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer t');
      if (pathname === '/repos/quillipi/quillipi/releases/tags/v0.3.0') return release && !release.draft ? Response.json(release) : new Response('', { status: 404 });
      if (pathname === '/repos/quillipi/quillipi/releases' && method === 'GET') return Response.json(release ? [release] : []);
      if (pathname === '/repos/quillipi/quillipi/releases' && method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({ tag_name: 'v0.3.0', target_commitish: 'abc', name: 'Quillipi 0.3.0', body: NOTES, draft: true });
        release = { id: 7, tag_name: 'v0.3.0', draft: true, assets: [] };
        return Response.json(release);
      }
      if (pathname === '/repos/quillipi/quillipi/releases/assets/9') return new Response(existing!.asset);
      if (pathname === '/repos/quillipi/quillipi/releases/7/assets') return Response.json({ name: 'quillipi-0.3.0.json' });
      if (pathname === '/repos/quillipi/quillipi/releases/7' && method === 'PATCH') {
        expect(JSON.parse(String(init.body))).toEqual({ draft: false, make_latest: 'true' });
        return Response.json({ ...release, draft: false });
      }
      return new Response('', { status: 500 });
    };
    return { fetch, calls };
  }
  const run = (fetch: unknown) => publish({ repo: 'quillipi/quillipi', token: 't', sha: 'abc', version: '0.3.0', bytes, notes: NOTES, fetch });

  it('publishes a new version as a draft first, so it is never seen without its file', async () => {
    const hub = github(undefined);
    expect(await run(hub.fetch)).toBe('Published Quillipi 0.3.0 as release v0.3.0.');
    expect(hub.calls).toEqual(['GET /repos/quillipi/quillipi/releases/tags/v0.3.0', 'GET /repos/quillipi/quillipi/releases', 'POST /repos/quillipi/quillipi/releases', 'POST /repos/quillipi/quillipi/releases/7/assets', 'PATCH /repos/quillipi/quillipi/releases/7']);
  });

  it('finishes a draft an earlier run left, and publishes a version only once', async () => {
    expect(await run(github({ draft: true }).fetch)).toBe('Published Quillipi 0.3.0 as release v0.3.0.');
    const same = github({ draft: false, asset: bytes });
    expect(await run(same.fetch)).toBe('Release v0.3.0 already has this file.');
    expect(same.calls.some((call) => call.startsWith('POST') || call.startsWith('PATCH'))).toBe(false);
    await expect(run(github({ draft: false, asset: Buffer.from('other') }).fetch)).rejects.toThrow(`Release v0.3.0 already has quillipi-0.3.0.json, and it is a different file (SHA-256 ${sha256(Buffer.from('other'))}). A version is published once: give Quillipi a new version.`);
    expect(await run(github({ draft: false }).fetch)).toBe('Added quillipi-0.3.0.json to release v0.3.0.');
  });

  it('publishes only where the pin sends copies to look', () => {
    const pin = { source: 'quillipi/quillipi', version: '0.4.0', sha256: 'a'.repeat(64) };
    expect(() => checkSource(pin, 'quillipi/quillipi')).not.toThrow();
    expect(() => checkSource(pin, 'Quillipi/Quillipi')).not.toThrow();
    expect(() => checkSource(pin, 'someone/fork')).toThrow(`deploy/${PIN_FILE} says Quillipi comes from quillipi/quillipi, but this is someone/fork, so copies would never see this release. Set its "source" to "someone/fork".`);
  });

  it("takes a version's notes from CHANGELOG.md", () => {
    const changelog = '# Changelog\n\n## 0.4.0 (2026-12-01)\n\nNewer.\n\n## 0.3.0 (2026-11-18)\n\n- One.\n- Two.\n\n## 0.2.1\n\nOlder.\n';
    expect(changelogNotes(changelog, '0.3.0')).toBe('- One.\n- Two.');
    expect(changelogNotes(changelog, '0.2.1')).toBe('Older.');
    expect(changelogNotes(changelog, '0.3.1')).toBeUndefined();
  });
});
