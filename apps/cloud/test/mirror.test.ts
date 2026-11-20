import { newId, serializeSection } from '@inklog/core';
import { MemoryStore, initNotebook } from '@inklog/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { DurableStore } from '../src/durable-store.js';
import { GitHubApp } from '../src/github.js';
import { Mirror, gitDate } from '../src/mirror.js';
import { NotebookHost } from '../src/notebook-host.js';
import { FakeGitHub } from './fake-github.js';
import { nodeSql } from './node-sql.js';

const NAME = 'inklog-notebook-test';
const OWNER = { name: 'The Octocat', email: 'OctoCat@users.noreply.github.com' };
const AGENT = 'Claude via claude.ai';
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0xff, 0x00, 0xfe]);
const TZ = process.env.TZ;

afterEach(() => {
  if (TZ === undefined) delete process.env.TZ;
  else process.env.TZ = TZ;
});

/** The files `quillipi init` makes on the laptop. */
async function startingFiles(): Promise<Record<string, string>> {
  const store = new MemoryStore(OWNER);
  await initNotebook(store, { name: NAME, person: OWNER });
  const files: Record<string, string> = {};
  for (const rel of ['inklog.json', 'AGENTS.md', '.gitignore', 'sections/overview.md']) files[rel] = (await store.read(rel))!;
  return files;
}

function section(...texts: string[]): string {
  return serializeSection({ blocks: texts.map((text, i) => ({ id: newId(), type: i ? 'p' : 'h1', text })) });
}

/** A repo with a laptop-made history: folders, an image, a deletion and a merge. */
async function laptopRepo(fake: FakeGitHub): Promise<string[]> {
  fake.createRepo(NAME);
  const repo = fake.repos.get(NAME)!;
  const first = await fake.laptopCommit(NAME, await startingFiles(), `Start ${NAME}`, { at: 1_793_900_000 });
  const second = await fake.laptopCommit(NAME, { 'sections/overview.md': section('Inklog Notebook Test', 'Written on the laptop.'), 'assets/pic.png': PNG, 'canvas/a.json': '{}', 'canvas/a.svg': '<svg/>' }, 'Add a picture and a drawing', { at: 1_793_900_100 });
  repo.main = first;
  const side = await fake.laptopCommit(NAME, { 'notes.md': 'side branch' }, 'On a side branch', { at: 1_793_900_150 });
  repo.main = second; // back on the main line, then merge the side branch in
  await fake.laptopCommit(NAME, { 'canvas/a.svg': null, 'canvas/a.json': null, 'notes.md': 'side branch' }, 'Merge the side branch\n\nAnd drop the drawing.', { at: 1_793_900_200, parents: [second, side], tz: '-0700' });
  return repo.history();
}

interface Cloud {
  store: DurableStore;
  mirror: Mirror;
  host: NotebookHost;
  /** Times the mirror asked to run, as the Durable Object's alarm would. */
  alarms: number[];
}

function cloud(fake: FakeGitHub, { sql = nodeSql(), requestsPerStep = 40, now = () => fake.now() } = {}): Cloud {
  const store = new DurableStore(sql, OWNER);
  const alarms: number[] = [];
  const app = new GitHubApp({ appId: fake.appId, privateKey: fake.privateKey, owner: fake.owner, fetch: fake.fetch, now });
  const mirror = new Mirror({ app, store, notebook: NAME, schedule: async (time) => void alarms.push(time), now, requestsPerStep });
  return { store, mirror, host: new NotebookHost(store, NAME, OWNER, mirror), alarms };
}

/** Runs the alarm until no more steps are asked for; returns the requests each step made. */
async function runAlarms(fake: FakeGitHub, { mirror, alarms }: Cloud, limit = 50): Promise<number[]> {
  const perStep: number[] = [];
  while (alarms.length && perStep.length < limit) {
    alarms.length = 0;
    const before = fake.requests.length;
    await mirror.step();
    perStep.push(fake.requests.length - before);
  }
  return perStep;
}

describe('importing a notebook from GitHub', () => {
  it('copies the history in under GitHub’s own IDs, on the first tool call', async () => {
    const fake = new FakeGitHub();
    const chain = await laptopRepo(fake);
    const { host, store } = cloud(fake);

    const map = await host.runTool(AGENT, 'map', {});
    expect(map).toContain(`${NAME} · 1 sections`);
    expect((await store.log()).map((commit) => commit.oid)).toEqual(chain);
    expect(await store.head()).toBe(fake.repos.get(NAME)!.main);
    // The working files are the newest commit's, byte for byte, images included.
    expect(Buffer.from((await store.readBytes('assets/pic.png'))!).equals(Buffer.from(PNG))).toBe(true);
    expect(await store.read('notes.md')).toBe('side branch');
    expect(await store.read('canvas/a.svg')).toBeUndefined();
    const history = await host.runTool(AGENT, 'history', {});
    expect(history).toMatch(/#3 .*Merge the side branch[\s\S]*#2 .*Add a picture[\s\S]*#1 .*Start/);
    expect(history).not.toContain('On a side branch'); // first parents only
    expect(await host.status()).toMatchObject({ exists: true, commits: 3, mirror: `OctoCat/${NAME}: up to date at ${chain[0]!.slice(0, 7)}.` });
  });

  it('runs in steps that stay within the request budget, and says how far it has got', async () => {
    const fake = new FakeGitHub();
    fake.createRepo(NAME);
    await fake.laptopCommit(NAME, await startingFiles(), `Start ${NAME}`, { at: 1_793_000_000 });
    for (let i = 1; i <= 60; i++) await fake.laptopCommit(NAME, { [`sections/s${i}.md`]: section(`Section ${i}`), [`assets/${i}.png`]: Uint8Array.of(i, 0, i) }, `Add section ${i}`, { at: 1_793_000_000 + i });
    const notebook = cloud(fake);

    await expect(notebook.host.runTool(AGENT, 'map', {})).rejects.toThrow(/is being imported from GitHub\. OctoCat\/inklog-notebook-test: importing, \d+ of 61 commits imported\./);
    expect(fake.requests.length).toBeLessThanOrEqual(40);
    const steps = await runAlarms(fake, notebook);
    expect(Math.max(...steps)).toBeLessThanOrEqual(40);
    expect(steps.length).toBeGreaterThan(3);
    expect(await notebook.host.runTool(AGENT, 'map', {})).toContain('61 sections');
    expect(await notebook.store.head()).toBe(fake.repos.get(NAME)!.main);
  });

  it('carries on where it stopped, across restarts and tiny budgets, even halfway through a commit', async () => {
    const fake = new FakeGitHub();
    fake.createRepo(NAME);
    const many: Record<string, string> = await startingFiles();
    for (let i = 0; i < 25; i++) many[`sections/bulk-${i}.md`] = section(`Bulk ${i}`);
    await fake.laptopCommit(NAME, many, 'One big first commit');
    for (let i = 0; i < 230; i++) await fake.laptopCommit(NAME, { 'sections/overview.md': section('Overview', `Edit ${i}`) }, `Edit ${i}`, { at: 1_793_900_001 + i });
    const sql = nodeSql();
    let notebook = cloud(fake, { sql, requestsPerStep: 6 });
    await expect(notebook.host.runTool(AGENT, 'map', {})).rejects.toThrow('listing commits, 200 found so far');

    for (let steps = 0; steps < 400 && notebook.mirror.status().includes('importing'); steps++) {
      notebook = cloud(fake, { sql, requestsPerStep: 6 }); // the object restarts between steps
      const before = fake.requests.length;
      await notebook.mirror.step();
      expect(fake.requests.length - before).toBeLessThanOrEqual(6);
    }
    expect(notebook.mirror.status()).toMatch(/up to date/);
    expect((await notebook.store.log()).length).toBe(231);
    const head = (await notebook.store.head())!;
    expect(await notebook.store.read('sections/bulk-24.md')).toBe(await notebook.store.readAt(head, 'sections/bulk-24.md'));
    expect(await notebook.store.read('sections/bulk-24.md')).toContain('Bulk 24');
  });

  it('explains what is missing when there is no repo to import, and creates nothing', async () => {
    const fake = new FakeGitHub();
    const { host, store } = cloud(fake);
    await expect(host.runTool(AGENT, 'map', {})).rejects.toThrow(`There is no notebook "${NAME}" yet. Its history lives in the GitHub repo OctoCat/${NAME}, which doesn't exist or doesn't have the GitHub App installed.`);
    fake.createRepo(NAME, { installed: false });
    await expect(host.runTool(AGENT, 'map', {})).rejects.toThrow("doesn't have the GitHub App installed");
    fake.repos.get(NAME)!.installed = true;
    await expect(host.runTool(AGENT, 'map', {})).rejects.toThrow(`OctoCat/${NAME} has no commits yet.`);
    await fake.laptopCommit(NAME, { 'README.md': 'hello' }, 'Not a notebook');
    await expect(host.runTool(AGENT, 'map', {})).rejects.toThrow("isn't a Quillipi notebook: it has no inklog.json");
    expect(store.commitCount()).toBe(0);
    expect(await host.status()).toEqual({ exists: false, mirror: `OctoCat/${NAME}: not imported yet; the first tool call imports it.` });

    await fake.laptopCommit(NAME, await startingFiles(), 'Now it is one');
    expect(await host.runTool(AGENT, 'map', {})).toContain(`${NAME} · 1 sections`);
  });

  it("stops at files Quillipi can't keep, and says which", async () => {
    const fake = new FakeGitHub();
    await laptopRepo(fake);
    fake.use(async (request, next) => {
      const response = await next(request);
      if (!request.url.includes('/git/trees/')) return response;
      const body = (await response.json()) as { tree: unknown[] };
      body.tree.push({ path: 'tools/run.sh', mode: '100755', type: 'blob', sha: 'a'.repeat(40) });
      return new Response(JSON.stringify(body));
    });
    const { host, mirror } = cloud(fake);
    await expect(host.runTool(AGENT, 'map', {})).rejects.toThrow(/stopped\. tools\/run\.sh in commit \w{7} is a file with mode 100755; Quillipi notebooks hold only plain files\./);
    expect(await mirror.retry()).toMatch(/^Retrying\./);
    await expect(host.runTool(AGENT, 'map', {})).rejects.toThrow('mode 100755');
  });

  it("stops when what GitHub sends doesn't match its own IDs", async () => {
    for (const [route, change, error] of [
      ['/git/trees/', (body: any) => body.tree.pop(), /stopped\. The files of commit \w{7} don't give GitHub's tree \w{7}\./],
      ['/git/blobs/', (body: any) => (body.content = Buffer.from('something else').toString('base64')), /stopped\. GitHub sent content for blob \w{7} that has a different ID\./],
    ] as const) {
      const fake = new FakeGitHub();
      await laptopRepo(fake);
      fake.use(async (request, next) => {
        const response = await next(request);
        if (!request.url.includes(route)) return response;
        const body = await response.json();
        change(body);
        return new Response(JSON.stringify(body));
      });
      const { host, store } = cloud(fake);
      await expect(host.runTool(AGENT, 'map', {})).rejects.toThrow(error);
      expect(store.commitCount()).toBe(0);
    }
  });

  it('leaves a notebook that began in the cloud before the mirror alone', async () => {
    const fake = new FakeGitHub();
    const sql = nodeSql();
    await new NotebookHost(new DurableStore(sql, OWNER), NAME, OWNER).runTool(AGENT, 'map', {}); // no mirror yet
    const { host, mirror } = cloud(fake, { sql });
    expect(await host.runTool(AGENT, 'map', {})).toContain(NAME);
    expect(mirror.status()).toContain('not linked, because this notebook began in the cloud before the GitHub mirror');
    expect(fake.requests).toEqual([]);
  });
});

describe('pushing new commits to GitHub', () => {
  async function imported(fake: FakeGitHub, options?: Parameters<typeof cloud>[1]): Promise<Cloud> {
    await laptopRepo(fake);
    const notebook = cloud(fake, options);
    await notebook.host.runTool(AGENT, 'map', {});
    return notebook;
  }

  async function writeInCloud(host: NotebookHost, text: string, message: string): Promise<string> {
    return host.runTool(AGENT, 'patch', { path: 'overview', ops: [{ op: 'insert', after: null, type: 'p', text }], commit: message });
  }

  it('recreates each commit on GitHub with the same ID, and moves main', async () => {
    const fake = new FakeGitHub();
    const notebook = await imported(fake);
    expect(await writeInCloud(notebook.host, 'Written in the cloud.', 'First words from the cloud')).toMatch(/✓ committed #4/);
    expect(notebook.alarms).toHaveLength(1);
    expect(notebook.alarms[0]! - Date.now()).toBeGreaterThan(500); // a short wait, so a burst goes out together

    await runAlarms(fake, notebook);
    const repo = fake.repos.get(NAME)!;
    expect(repo.main).toBe(await notebook.store.head());
    expect(new TextDecoder().decode(repo.blobs.get(repo.filesAt(repo.main!).get('sections/overview.md')!))).toContain('Written in the cloud.');
    expect(repo.commits.get(repo.main!)!.message).toBe('First words from the cloud\n\nInkLog-Agent: Claude via claude.ai\n');
    expect(notebook.mirror.status()).toBe(`OctoCat/${NAME}: up to date at ${repo.main!.slice(0, 7)}.`);
  });

  it('pushes images, deletions, odd messages and commits made in other time zones exactly', async () => {
    const fake = new FakeGitHub();
    const { store, mirror, host, alarms } = await imported(fake);
    process.env.TZ = 'Asia/Kolkata';
    const fresh = Uint8Array.from([...PNG, 0x42]);
    await store.commit(new Map<string, Uint8Array | null>([['assets/new.png', fresh], ['assets/again.png', fresh], ['assets/copy.png', PNG], ['notes.md', null]]), '\n\nTitle with spaces  \r\n\r\nBody \n\n', OWNER);
    process.env.TZ = 'America/Los_Angeles';
    await store.commit(new Map([['assets/pic.png', null], ['docs/bom.md', '\uFEFFstarts with a byte-order mark\n'], ['docs/plain.md', 'café ☕\n']]), 'Second', OWNER);
    await host.runTool(AGENT, 'map', {});
    expect(store.commitDetail((await store.head())!)!.timezone).not.toBe(0);

    await runAlarms(fake, { store, mirror, host, alarms });
    const repo = fake.repos.get(NAME)!;
    expect(repo.main).toBe(await store.head());
    const [second, first] = repo.history();
    expect(repo.commits.get(first!)!.message).toBe('Title with spaces  \n\nBody \n');
    expect(repo.commits.get(first!)!.author.tz).toBe('+0530');
    expect(repo.commits.get(second!)!.author.tz).toMatch(/^-0[78]00$/);
    expect(repo.filesAt(second!).has('assets/pic.png')).toBe(false);
    expect(repo.filesAt(second!).has('notes.md')).toBe(false);
    expect(repo.filesAt(second!).get('assets/copy.png')).toBe(repo.filesAt(repo.history()[2]!).get('assets/pic.png'));
    // The new image went up once for both its paths, and the file with a byte-order mark went up as a
    // blob; the copy of the laptop's picture, which GitHub already had, was named by its ID.
    expect(fake.requests.filter((line) => line.endsWith('/git/blobs'))).toEqual([`POST /repos/OctoCat/${NAME}/git/blobs`, `POST /repos/OctoCat/${NAME}/git/blobs`]);
  });

  it('pushes a long run of commits in budgeted steps, moving main once per step', async () => {
    const fake = new FakeGitHub();
    const notebook = await imported(fake);
    for (let i = 0; i < 30; i++) await notebook.store.commit(new Map([[`notes/n${i}.md`, `Note ${i}\n`]]), `Note ${i}`, OWNER);
    await notebook.host.runTool(AGENT, 'map', {});
    const steps = await runAlarms(fake, notebook);
    expect(Math.max(...steps)).toBeLessThanOrEqual(40);
    expect(steps.length).toBe(2);
    expect(fake.repos.get(NAME)!.main).toBe(await notebook.store.head());
    expect(fake.requests.filter((line) => line.startsWith('PATCH'))).toHaveLength(2);
  });

  it("stops and says so when main moved without the cloud, and the notebook keeps working", async () => {
    const fake = new FakeGitHub();
    const notebook = await imported(fake);
    await fake.laptopCommit(NAME, { 'notes.md': 'pushed from the laptop' }, 'From the laptop', { at: 1_794_000_000 });
    await writeInCloud(notebook.host, 'Cloud text.', 'From the cloud');
    await runAlarms(fake, notebook);
    expect(notebook.mirror.status()).toMatch(/stopped\. On GitHub, main moved to \w{7} without the cloud \(did the laptop push\?\)\. The cloud's commits after \w{7} wait until merging arrives in Phase 4\./);
    expect(notebook.alarms).toEqual([]);

    const map = await notebook.host.runTool(AGENT, 'map', {});
    expect(map.split('\n')[0]).toMatch(/^⚠ GitHub mirror: OctoCat\/inklog-notebook-test: stopped\./);
    expect(await writeInCloud(notebook.host, 'More.', 'Still committing')).toMatch(/✓ committed #5/);
    await notebook.mirror.retry();
    await runAlarms(fake, notebook);
    expect(notebook.mirror.status()).toContain('stopped. On GitHub, main moved');
  });

  it('stops when main moves while it pushes', async () => {
    const fake = new FakeGitHub();
    const notebook = await imported(fake);
    fake.use(async (request, next) => {
      if (request.method === 'PATCH') await fake.laptopCommit(NAME, { 'race.md': 'x' }, 'Raced', { at: 1_794_000_000 });
      return next(request);
    });
    await writeInCloud(notebook.host, 'Cloud text.', 'From the cloud');
    await runAlarms(fake, notebook);
    expect(notebook.mirror.status()).toContain("stopped. GitHub's main moved while the cloud was pushing");
  });

  it('stops before the histories split when GitHub gives a different ID, keeping what matched', async () => {
    const fake = new FakeGitHub();
    const notebook = await imported(fake);
    let commits = 0;
    fake.use(async (request, next) => {
      const response = await next(request);
      if (!request.url.endsWith('/git/commits') || ++commits < 2) return response;
      return new Response(JSON.stringify({ sha: 'f'.repeat(40) }), { status: 201 }); // as if GitHub had signed it
    });
    await notebook.store.commit(new Map([['a.md', 'one\n']]), 'One', OWNER);
    const one = (await notebook.store.head())!;
    await notebook.store.commit(new Map([['b.md', 'two\n']]), 'Two', OWNER);
    await notebook.host.runTool(AGENT, 'map', {});
    await runAlarms(fake, notebook);
    expect(fake.repos.get(NAME)!.main).toBe(one);
    expect(notebook.mirror.status()).toMatch(/stopped\. GitHub gave commit \w{7} the ID fffffff, so the histories would split\./);
  });

  it('tries again after growing waits, up to 30 minutes, and forgets the failures once it works', async () => {
    const fake = new FakeGitHub();
    let now = Date.now();
    fake.now = () => now;
    const notebook = await imported(fake, { now: () => now });
    let broken = true;
    fake.use((request, next) => (broken && request.url.endsWith('/git/trees') ? Promise.resolve(new Response(JSON.stringify({ message: 'Server Error' }), { status: 502 })) : next(request)));
    await writeInCloud(notebook.host, 'Cloud text.', 'From the cloud');

    const waits: number[] = [];
    for (let i = 0; i < 8; i++) {
      notebook.alarms.length = 0;
      await notebook.mirror.step();
      waits.push((notebook.alarms.at(-1)! - now) / 1000);
      await notebook.mirror.step(); // too early: it only asks again for the same time
      now = notebook.alarms.at(-1)!;
    }
    expect(waits).toEqual([30, 60, 120, 240, 480, 960, 1800, 1800]);
    expect(notebook.mirror.status()).toContain('After 8 failed tries it tries again at');
    expect(notebook.mirror.status()).toContain('Last error: GitHub answered 502 to POST /repos/OctoCat/inklog-notebook-test/git/trees: Server Error');
    expect((await notebook.host.runTool(AGENT, 'map', {})).startsWith('⚠ GitHub mirror:')).toBe(true);

    broken = false;
    await notebook.mirror.step();
    expect(notebook.mirror.status()).toMatch(/up to date/);
    expect(notebook.mirror.notice()).toBeUndefined();
  });

  it('notices when main already has commits a step pushed before it could save', async () => {
    const fake = new FakeGitHub();
    const notebook = await imported(fake);
    const before = (await notebook.store.head())!;
    await writeInCloud(notebook.host, 'Cloud text.', 'From the cloud');
    await runAlarms(fake, notebook);
    notebook.store.setMeta('mirror', JSON.stringify({ state: 'mirroring', pushed: before })); // as if the save was lost
    await notebook.mirror.changed();
    fake.requests = [];
    await runAlarms(fake, notebook);
    expect(fake.requests).toEqual([`GET /repos/OctoCat/${NAME}/git/ref/heads/main`]);
    expect(notebook.mirror.status()).toMatch(/up to date/);
  });
});

describe('a notebook from before folders', () => {
  it('upgrades on its first call after the deploy, and pushes the upgrade to GitHub with the same ID', async () => {
    const fake = new FakeGitHub();
    fake.createRepo(NAME);
    // The test notebook as `quillipi init` made it before folders: no IDs in files, and the order as paths.
    const legacy = {
      'inklog.json': `${JSON.stringify({ name: NAME, sections: ['overview'] }, null, 2)}\n`,
      'AGENTS.md': 'A guide.\n',
      '.gitignore': '.inklog/\n',
      'sections/overview.md': section('Inklog Notebook Test', 'Written on the laptop.'),
    };
    await fake.laptopCommit(NAME, legacy, `Start ${NAME}`, { at: 1_793_900_000 });
    const notebook = cloud(fake);

    const map = await notebook.host.runTool(AGENT, 'map', {});
    expect(map).toContain(`${NAME} · 1 sections`);
    expect(await notebook.host.runTool(AGENT, 'history', {})).toMatch(/^#2 .*Upgrade to folders: a permanent ID in every section, and the folders in inklog.json\n#1 /);
    await runAlarms(fake, notebook);
    const repo = fake.repos.get(NAME)!;
    expect(repo.main).toBe(await notebook.store.head());
    const files = repo.filesAt(repo.main!);
    expect(new TextDecoder().decode(repo.blobs.get(files.get('sections/overview.md')!))).toMatch(/^---\nid: overview\n---\n\n# Inklog Notebook Test/);
    expect(JSON.parse(new TextDecoder().decode(repo.blobs.get(files.get('inklog.json')!)))).toEqual({ name: NAME, tree: ['overview'] });
    expect(notebook.mirror.status()).toBe(`OctoCat/${NAME}: up to date at ${repo.main!.slice(0, 7)}.`);
  });
});

describe('dates for GitHub', () => {
  it('are written in the commit’s own time zone, so GitHub hashes the same time', () => {
    expect(gitDate(1_793_900_000, 0)).toBe('2026-11-05T17:33:20Z');
    expect(gitDate(1_793_900_000, -330)).toBe('2026-11-05T23:03:20+05:30');
    expect(gitDate(1_793_900_000, 420)).toBe('2026-11-05T10:33:20-07:00');
    const commit = { timestamp: 1_793_900_000, timezoneOffset: -345 };
    expect(gitDate(commit.timestamp, commit.timezoneOffset)).toBe('2026-11-05T23:18:20+05:45');
  });
});
