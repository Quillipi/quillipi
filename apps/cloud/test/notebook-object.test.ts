/**
 * A notebook's room as Cloudflare runs it (notebook-object.ts), in Node on its own SQLite
 * database: its settings are the Worker's own and, for what those don't hold, the library's.
 */
import { describe, expect, it } from 'vitest';
import { DurableStore } from '../src/durable-store.js';
import type { Env } from '../src/env.js';
import { NotebookObject } from '../src/notebook-object.js';
import type { Settings } from '../src/settings.js';
import { FakeGitHub } from './fake-github.js';
import { nodeSql } from './node-sql.js';

const OWNER = { OWNER_NAME: 'The Octocat', OWNER_EMAIL: '583231+OctoCat@users.noreply.github.com' };
const AGENT = 'Claude via claude.ai';

/** A room whose Worker holds `worker` and whose library keeps `stored`, which a test may change. */
function room(worker: Settings, stored: Settings = {}) {
  const sql = nodeSql();
  let alarm: number | null = null;
  const ctx = {
    storage: {
      sql: { exec: (query: string, ...bindings: never[]) => sql.exec(query, ...bindings) },
      transactionSync: <T>(body: () => T) => sql.transaction(body),
      getAlarm: async () => alarm,
      setAlarm: async (time: number) => void (alarm = time),
    },
    acceptWebSocket: () => {},
    getWebSockets: () => [],
    getTags: () => [],
  };
  const asked = { count: 0 };
  const library = {
    settings: async () => {
      asked.count++;
      return { ...stored };
    },
    update: async () => {},
  };
  const env = { COMMIT: 'abc1234', ...worker, LIBRARY: { idFromName: (name: string) => name, get: () => library } } as unknown as Env;
  return { object: new NotebookObject(ctx as never, env), sql, asked };
}

/** Who made each commit in a room's database, newest first. */
async function authors(sql: ReturnType<typeof nodeSql>): Promise<string[]> {
  return (await new DurableStore(sql, { name: 'nobody', email: 'nobody@example.com' }).log()).map((commit) => commit.author);
}

describe("a notebook's room", () => {
  it('makes its commits as the owner the library keeps, when the Worker has none, and asks once while awake', async () => {
    const { object, sql, asked } = room({}, OWNER);
    expect(await object.runTool('gym', AGENT, 'map', {})).toContain('gym · 1 sections');
    const reply = await object.runTool('gym', AGENT, 'organize', { ops: [{ op: 'section', name: 'Plan' }], commit: 'Add a plan' });
    expect(reply).toContain('committed #2');
    expect(await authors(sql)).toEqual(['The Octocat', 'The Octocat']);
    expect(asked.count).toBe(1);
  });

  it("uses the Worker's own settings when it holds them all, without asking the library", async () => {
    const github = new FakeGitHub({ owner: 'octo-notebooks' });
    const worker: Settings = {
      ...OWNER,
      PUBLIC_URL: 'https://quillipi.example.workers.dev',
      GITHUB_OWNER: 'octo-notebooks',
      GITHUB_APP_ID: github.appId,
      GITHUB_APP_PRIVATE_KEY: github.privateKey,
      GITHUB_CLIENT_ID: github.clientId,
      GITHUB_CLIENT_SECRET: github.clientSecret,
      GITHUB_USER_ID: '583231',
      GITHUB_USER_LOGIN: 'OctoCat',
      SESSION_SECRET: 'a-session-secret-of-at-least-32-characters',
    };
    const { object, asked } = room(worker, { OWNER_NAME: 'someone else' });
    expect(await object.status('gym')).toEqual({ exists: false, mirror: 'octo-notebooks/gym: not imported yet; the first tool call imports it.' });
    expect(asked.count).toBe(0);
  });

  it('has a GitHub mirror only with the App, its key and the organization for notebooks, wherever each is kept', async () => {
    const github = new FakeGitHub({ owner: 'octo-notebooks' });
    const app = { ...OWNER, GITHUB_APP_ID: github.appId, GITHUB_APP_PRIVATE_KEY: github.privateKey };
    const without = room(app).object;
    expect(await without.status('gym')).toEqual({ exists: false });
    expect(await without.retryMirror('gym')).toBe('The GitHub mirror is not set up here: the GitHub App, its private key and the organization for notebooks are needed.');
    const kept = room(app, { GITHUB_OWNER: 'octo-notebooks' }).object;
    expect(await kept.status('gym')).toMatchObject({ mirror: 'octo-notebooks/gym: not imported yet; the first tool call imports it.' });
  });

  it('starts no notebook while Quillipi doesn’t know who owns it, and does once it knows', async () => {
    const stored: Settings = {};
    const { object, sql } = room({}, stored);
    await expect(object.runTool('gym', AGENT, 'map', {})).rejects.toThrow('Quillipi isn’t set up yet: who owns it (OWNER_NAME and OWNER_EMAIL) isn’t known.');
    expect(await authors(sql)).toEqual([]);
    Object.assign(stored, OWNER);
    expect(await object.runTool('gym', AGENT, 'map', {})).toContain('gym · 1 sections');
    expect(await authors(sql)).toEqual(['The Octocat']);
  });

  it('keeps one engine while awake, so an open editor’s versions stay good from call to call', async () => {
    const { object } = room({}, OWNER);
    await object.runTool('gym', AGENT, 'map', {});
    const version = async () => ((await (await object.fetch(new Request('https://quillipi.example.workers.dev/api/n/gym/section?id=overview'))).json()) as { version: string }).version;
    const [first, second] = [await version(), await version()];
    // A version is <run>.<n>, with a new run each time an engine opens (engine.ts).
    expect(second).toBe(first);
  });

  it('opens the notebook once when two calls arrive together, and holds only that notebook', async () => {
    const { object, sql, asked } = room({}, OWNER);
    const replies = await Promise.all([object.runTool('gym', AGENT, 'map', {}), object.runTool('gym', 'Claude via Claude Code', 'map', {})]);
    for (const reply of replies) expect(reply).toContain('gym · 1 sections');
    expect(await authors(sql)).toEqual(['The Octocat']);
    expect(asked.count).toBe(1);
    await expect(object.status('kimet')).rejects.toThrow('This object holds "gym", not "kimet".');
  });
});
