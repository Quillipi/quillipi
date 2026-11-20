/**
 * One-click notebooks, end to end in Node: Claude's door, the library, the notebook rooms and the
 * GitHub mirror, against a stand-in GitHub with an organization for notebooks.
 */
import { MemoryStore, initNotebook } from '@inklog/engine';
import { describe, expect, it } from 'vitest';
import { callTool } from '../src/door.js';
import type { Env } from '../src/env.js';
import { FakeCloud, OWNER } from './fake-cloud.js';
import { FakeGitHub } from './fake-github.js';

const ORG = 'octo-notebooks';
const CLAUDE = 'Claude via claude.ai';

function setup({ clock = { now: 1_800_000_000_000 } } = {}) {
  const github = new FakeGitHub({ owner: ORG });
  github.now = () => clock.now;
  const cloud = new FakeCloud({ github, clock });
  const env = { GITHUB_OWNER: ORG, GITHUB_APP_ID: github.appId, GITHUB_APP_PRIVATE_KEY: github.privateKey, ...cloud.bindings } as unknown as Env;
  const tool = (name: string, args: Record<string, unknown> = {}) => callTool(env, CLAUDE, name, args);
  return { github, cloud, env, tool, clock };
}

/** The first heading's block ID in a read reply. */
function firstBlock(reply: string, section: string): string {
  return new RegExp(`^${section} "[^"]*"[^\\n]*\\n\\^(\\w+) h1`, 'm').exec(reply)![1]!;
}

describe('a new notebook from a chat', () => {
  it('is ready at once, and its repo appears in the organization with exactly the cloud’s history', async () => {
    const { github, cloud, tool } = setup();
    const made = await tool('create_notebook', { title: 'Test idea', about: 'A place to try one-click notebooks' });
    expect(made).toMatch(/^Made notebook "Test idea" with the ID test-idea\. Pass notebook: "test-idea" to the other tools\. Its private GitHub repo octo-notebooks\/test-idea is being made in the background\.\n\n/);
    // Its map and About section come with the reply, so Claude can write at once.
    expect(made).toContain('Test idea · 1 sections');
    expect(made).toMatch(/^about "About"/m);
    expect(made).toContain('A place to try one-click notebooks');
    const heading = firstBlock(made, 'about');
    const patched = await tool('patch', {
      notebook: 'test-idea',
      path: 'about',
      ops: [1, 2, 3].map((n) => ({ op: 'insert', after: heading, type: 'li', text: `Idea ${n}` })).reverse(),
      commit: 'Add three ideas',
    });
    expect(patched).toContain('committed #2');

    await cloud.runAlarms();
    const repo = github.repos.get('test-idea')!;
    expect(repo).toMatchObject({ private: true, description: 'A test notebook' });
    const store = cloud.room('test-idea').host.store;
    expect(repo.history()).toEqual((await store.log()).map((commit) => commit.oid));
    expect(repo.history()).toHaveLength(2); // GitHub's starter commit is gone from main
    expect([...repo.filesAt(repo.main!).keys()].sort()).toEqual(['.gitattributes', '.gitignore', 'AGENTS.md', 'inklog.json', 'sections/about.md']);
    expect(repo.commits.get(repo.main!)!.author.email).toBe(OWNER.email);

    const card = cloud.library.card('test-idea')!;
    expect(card).toMatchObject({ title: 'Test idea', about: 'A place to try one-click notebooks', createdBy: CLAUDE, from: 'new' });
    expect(card.summary).toMatchObject({
      title: 'Test idea',
      sections: 1,
      commits: 2,
      uncommitted: 0,
      last: { number: 2, message: 'Add three ideas', agent: CLAUDE },
      recent: [{ id: 'about', title: 'About', folder: '', by: CLAUDE, agent: true }],
      agentCommits: [{ number: 2, agent: CLAUDE, message: 'Add three ideas' }],
      backup: { state: 'backed-up', pushed: repo.main },
    });
    expect(JSON.parse(await store.read('inklog.json') as string)).toMatchObject({ name: 'Test idea', about: 'A place to try one-click notebooks', colour: card.colour });
  });

  it('waits a moment while GitHub is still making the repo, without counting that as a failure', async () => {
    const { github, cloud, tool, clock } = setup();
    github.makingFor = 3;
    await tool('create_notebook', { title: 'Patience' });
    const room = cloud.room('patience');
    await room.host.alarm();
    expect(room.host.mirror!.backup()).toMatchObject({ state: 'making', text: 'octo-notebooks/patience: making the repo on GitHub.' });
    expect(room.alarms.at(-1)).toBe(clock.now + 2000);
    await cloud.runAlarms();
    expect(room.host.mirror!.backup().state).toBe('backed-up');
    expect(github.repos.get('patience')!.history()).toEqual((await room.host.store.log()).map((commit) => commit.oid));
  });

  it('never overwrites a repo of the same name that holds other work, and says why', async () => {
    const { github, cloud, tool } = setup();
    github.createRepo('plan');
    const theirs = await github.laptopCommit('plan', { 'README.md': '# Someone else’s plan\n', 'notes.md': 'their work' }, 'Their work');
    await tool('create_notebook', { title: 'Plan' });
    await cloud.runAlarms();
    expect(github.repos.get('plan')!.main).toBe(theirs);
    const backup = cloud.room('plan').host.mirror!.backup();
    expect(backup).toMatchObject({ state: 'stopped' });
    expect(backup.text).toContain('A repo called octo-notebooks/plan was already on GitHub, with work that isn\'t this notebook\'s, so it was left alone.');
    // The notebook keeps working, and map tells Claude.
    expect(await tool('map', { notebook: 'plan' })).toMatch(/^⚠ GitHub mirror: octo-notebooks\/plan: stopped\./m);
    expect(cloud.library.card('plan')!.summary!.backup.state).toBe('stopped');
  });

  it('leaves the repo alone if main moves while the first commit goes up', async () => {
    const { github, cloud, tool } = setup();
    github.use(async (request, next) => {
      const reply = await next(request);
      // Someone pushes to the new repo just after the cloud's first commit is made there.
      if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/git/commits')) await github.laptopCommit('race', { 'theirs.md': 'x' }, 'Pushed meanwhile');
      return reply;
    });
    await tool('create_notebook', { title: 'Race' });
    await cloud.runAlarms();
    expect(github.repos.get('race')!.commits.get(github.repos.get('race')!.main!)!.message).toBe('Pushed meanwhile\n');
    expect(cloud.room('race').host.mirror!.backup()).toMatchObject({ state: 'stopped', text: expect.stringContaining('main of octo-notebooks/race moved while Quillipi was setting it up') });
  });

  it('starts in the next free room when a room already holds a notebook the library does not list', async () => {
    const { cloud, tool } = setup();
    // A room from before the library, with its notebook in it.
    const old = cloud.room('plan');
    await old.host.store.commit(new Map([['inklog.json', '{"name":"plan","tree":[]}\n']]), 'Start plan', OWNER);
    expect(await old.host.create({ title: 'Plan' })).toBe('taken');
    expect(await tool('create_notebook', { title: 'Plan' })).toContain('with the ID plan-2.');
    expect((await old.host.store.log()).map((commit) => commit.message)).toEqual(['Start plan']);
  });

  it('carries on over its own starter repo, as after a stop halfway through making it', async () => {
    const { github, cloud, tool } = setup();
    github.createRepo('half-made');
    await github.laptopCommit('half-made', { 'README.md': '# half-made\n' }, 'Initial commit');
    await tool('create_notebook', { title: 'Half made' });
    await cloud.runAlarms();
    const repo = github.repos.get('half-made')!;
    expect(repo.history()).toEqual((await cloud.room('half-made').host.store.log()).map((commit) => commit.oid));
  });

  it('says a notebook made where the GitHub App isn’t set up isn’t backed up, instead of promising a repo', async () => {
    const cloud = new FakeCloud();
    const env = { GITHUB_OWNER: ORG, ...cloud.bindings } as unknown as Env;
    const made = await callTool(env, CLAUDE, 'create_notebook', { title: 'Test idea' });
    expect(made).toMatch(/^Made notebook "Test idea" with the ID test-idea\. Pass notebook: "test-idea" to the other tools\. It isn’t backed up to GitHub: the GitHub App isn’t set up here\.\n\n/);
  });

  it('keeps working while the App is not on the organization yet, and catches up once it is', async () => {
    const { github, cloud, tool, clock } = setup();
    github.orgInstalled = false;
    const made = await tool('create_notebook', { title: 'Early' });
    await cloud.runAlarms(clock.now);
    const backup = cloud.room('early').host.mirror!.backup();
    expect(backup.state).toBe('retrying');
    expect(backup.text).toContain("The GitHub App isn't installed on the organization octo-notebooks.");
    await tool('patch', { notebook: 'early', path: 'about', ops: [{ op: 'insert', after: firstBlock(made, 'about'), type: 'p', text: 'Written before GitHub had it.' }], commit: 'Write before the backup' });
    github.orgInstalled = true;
    await cloud.runAlarms(); // the next try, 30 seconds later
    const repo = github.repos.get('early')!;
    expect(repo.history()).toEqual((await cloud.room('early').host.store.log()).map((commit) => commit.oid));
    expect(cloud.library.card('early')!.summary!.backup.state).toBe('backed-up');
  });
});

describe('adding a notebook already on GitHub', () => {
  it('imports it from its repo in the organization, and its card takes the title it keeps', async () => {
    const { github, cloud, tool } = setup();
    github.createRepo('inklog');
    const laptop = new MemoryStore(OWNER);
    await initNotebook(laptop, { name: 'Quillipi', person: OWNER });
    const files: Record<string, string> = {};
    for (const rel of ['inklog.json', 'AGENTS.md', '.gitignore', '.gitattributes', 'sections/overview.md']) files[rel] = (await laptop.read(rel))!;
    const head = await github.laptopCommit('inklog', files, 'Start Quillipi');

    const added = await tool('create_notebook', { github: 'octo-notebooks/inklog' });
    expect(added).toMatch(/^Added notebook inklog from GitHub\. octo-notebooks\/inklog: importing/);
    await cloud.runAlarms();
    expect(await tool('map', { notebook: 'inklog' })).toContain('Quillipi · 1 sections');
    expect(await cloud.room('inklog').host.store.head()).toBe(head);
    expect(cloud.library.card('inklog')).toMatchObject({ title: 'Quillipi', from: 'github', summary: { backup: { state: 'backed-up', pushed: head } } });

    await expect(tool('create_notebook', { github: 'missing' })).rejects.toThrow('There is no notebook "missing" yet.');
    expect(cloud.library.card('missing')).toBeUndefined();
  });

  it('adds a room that already holds the notebook, such as the test notebook from step 2.5, without importing again', async () => {
    const { github, cloud, tool } = setup();
    github.createRepo('inklog-notebook-test');
    const laptop = new MemoryStore(OWNER);
    await initNotebook(laptop, { name: 'inklog-notebook-test', person: OWNER });
    const files: Record<string, string> = {};
    for (const rel of ['inklog.json', 'AGENTS.md', '.gitignore', 'sections/overview.md']) files[rel] = (await laptop.read(rel))!;
    await github.laptopCommit('inklog-notebook-test', files, 'Start inklog-notebook-test');
    // Before the library, the first tool call on a room imported it (step 2.5).
    const room = cloud.room('inklog-notebook-test');
    await room.host.adopt();
    await cloud.runAlarms();
    const requests = github.requests.length;
    expect(await tool('create_notebook', { github: 'inklog-notebook-test' })).toContain('up to date');
    expect(github.requests.length).toBe(requests);
    expect(await tool('map')).toContain('inklog-notebook-test · 1 sections');
  });
});

it("gives every call the owner's instructions for every notebook, from the library", async () => {
  const { cloud, tool } = setup();
  await tool('create_notebook', { title: 'Rules' });
  cloud.library.setInstructions('Write completely and correctly.');
  const map = await tool('map', { notebook: 'rules' });
  expect(map).toMatch(/^Instructions from The Octocat, who owns this notebook\. Follow them in everything you do here\.\n\nFor every notebook:\nWrite completely and correctly\./);
});

it('reports to the library at most every two seconds, and sends what waited from the alarm', async () => {
  const { cloud, tool, clock } = setup();
  const made = await tool('create_notebook', { title: 'Busy' });
  const heading = firstBlock(made, 'about');
  const before = cloud.reports.length;
  for (const text of ['One', 'Two', 'Three']) await tool('patch', { notebook: 'busy', path: 'about', ops: [{ op: 'insert', after: heading, type: 'p', text }] });
  expect(cloud.reports.length).toBe(before); // all within two seconds of the last report
  expect(cloud.room('busy').alarms).toContain(clock.now + 2000);
  clock.now += 2000;
  await cloud.runAlarms(clock.now);
  expect(cloud.reports.at(-1)!.summary).toMatchObject({ uncommitted: 3, agentUncommitted: 3 });
});
