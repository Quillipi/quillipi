/**
 * Quillipi's settings (settings.ts): the Worker's own variables win, the library fills in the rest,
 * and what the library said is kept only for a while, and never while something is missing.
 */
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env.js';
import { Library } from '../src/library.js';
import { KEEP_MS, SECRETS, SETTINGS, type Settings, withSettings } from '../src/settings.js';
import { nodeSql } from './node-sql.js';

/** Every setting, as a Worker can hold them all; three of them are secrets. */
const FULL: Required<Settings> = {
  PUBLIC_URL: 'https://quillipi.octocat.workers.dev',
  OWNER_NAME: 'The Octocat',
  OWNER_EMAIL: '583231+OctoCat@users.noreply.github.com',
  GITHUB_OWNER: 'octo-notebooks',
  GITHUB_APP_ID: '1234567',
  GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\nnot a real key\n-----END RSA PRIVATE KEY-----',
  GITHUB_CLIENT_ID: 'Iv23liExampleClient0',
  GITHUB_CLIENT_SECRET: 'a-client-secret',
  GITHUB_USER_ID: '583231',
  GITHUB_USER_LOGIN: 'OctoCat',
  SESSION_SECRET: 'a-session-secret-of-at-least-32-characters',
};

const NON_SECRETS = Object.fromEntries(Object.entries(FULL).filter(([name]) => !SECRETS.has(name as never)));

/** The library, with a count of how often it was asked. */
function asking(settings: Settings) {
  const asked = { count: 0 };
  return {
    asked,
    stored: async () => {
      asked.count++;
      return settings;
    },
  };
}

const env = (values: Settings) => ({ COMMIT: 'abc1234', ...values }) as unknown as Env;

describe('settings for a request', () => {
  it("are the Worker's own when it holds them all, as a Quillipi set up by hand may, without asking the library", async () => {
    const worker = env(FULL);
    const { asked, stored } = asking({ OWNER_NAME: 'someone else' });
    expect(await withSettings(worker, stored)).toBe(worker);
    expect(asked.count).toBe(0);
  });

  it("take the Worker's value when it holds one, and the library's for the rest; an empty variable doesn't count", async () => {
    const worker = env({ ...FULL, OWNER_NAME: 'The owner on the Worker', GITHUB_USER_LOGIN: '', GITHUB_OWNER: '   ', SESSION_SECRET: undefined });
    const { stored } = asking({ ...FULL, OWNER_NAME: 'The owner in the library', SESSION_SECRET: 'the-library-made-this-secret-of-43-characters' });
    const filled = await withSettings(worker, stored);
    expect(filled).not.toBe(worker);
    expect(filled).toMatchObject({ OWNER_NAME: 'The owner on the Worker', GITHUB_USER_LOGIN: 'OctoCat', GITHUB_OWNER: 'octo-notebooks', SESSION_SECRET: 'the-library-made-this-secret-of-43-characters', COMMIT: 'abc1234' });
    // The Worker's own env is never changed.
    expect(worker.GITHUB_USER_LOGIN).toBe('');
    expect(worker.SESSION_SECRET).toBeUndefined();
  });

  it('keep what the library said for 30 seconds, for each copy of the Worker apart', async () => {
    const worker = env({ ...FULL, GITHUB_CLIENT_ID: undefined });
    const { asked, stored } = asking(FULL);
    const start = 1_800_000_000_000;
    await withSettings(worker, stored, start);
    await withSettings(worker, stored, start + KEEP_MS - 1);
    expect(asked.count).toBe(1);
    await withSettings(worker, stored, start + KEEP_MS);
    expect(asked.count).toBe(2);
    // Another copy has its own env, and asks for itself.
    await withSettings(env({ ...FULL, GITHUB_CLIENT_ID: undefined }), stored, start + KEEP_MS);
    expect(asked.count).toBe(3);
  });

  it('keep nothing while something is still missing, so a setup that has just finished shows at once', async () => {
    const worker = env({});
    const library: Settings = { SESSION_SECRET: 'the-library-made-this-secret-of-43-characters' };
    const { asked, stored } = asking(library);
    expect((await withSettings(worker, stored, 1000)).GITHUB_CLIENT_ID).toBeUndefined();
    Object.assign(library, FULL);
    expect((await withSettings(worker, stored, 1001)).GITHUB_CLIENT_ID).toBe(FULL.GITHUB_CLIENT_ID);
    expect(asked.count).toBe(2);
  });

  it('keep no failure: the next request asks the library again', async () => {
    const worker = env({ ...FULL, OWNER_NAME: undefined });
    let fail = true;
    const stored = async () => {
      if (fail) throw new Error('the library is down');
      return FULL;
    };
    await expect(withSettings(worker, stored)).rejects.toThrow('the library is down');
    fail = false;
    expect((await withSettings(worker, stored)).OWNER_NAME).toBe('The Octocat');
  });
});

describe('the settings kept in the library', () => {
  it("copy the Worker's non-secret settings, never a secret, and follow a change", () => {
    const library = new Library(nodeSql(), { rooms: { create: async () => 'made', adopt: async () => '' } });
    library.keepSettings(FULL);
    const kept = library.settings();
    expect(Object.fromEntries(Object.entries(kept).filter(([name]) => name !== 'SESSION_SECRET'))).toEqual(NON_SECRETS);
    expect(kept.GITHUB_APP_PRIVATE_KEY).toBeUndefined();
    expect(kept.GITHUB_CLIENT_SECRET).toBeUndefined();
    // The Worker has its own session secret, so the library makes none.
    expect(kept.SESSION_SECRET).toBeUndefined();

    library.keepSettings({ ...FULL, OWNER_NAME: 'Karan', GITHUB_OWNER: '' });
    expect(library.settings()).toMatchObject({ OWNER_NAME: 'Karan', GITHUB_OWNER: 'octo-notebooks' });
    // The default notebook lives in the same table, and is not a setting.
    expect(Object.keys(library.settings()).every((name) => (SETTINGS as readonly string[]).includes(name))).toBe(true);
  });

  it('make a secret for the browser’s cookie once, when neither the Worker nor the library has one, and keep it', () => {
    const sql = nodeSql();
    const rooms = { create: async () => 'made' as const, adopt: async () => '' };
    const first = new Library(sql, { rooms });
    first.keepSettings({});
    const secret = first.settings().SESSION_SECRET!;
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The library opens again, as a Durable Object does after a nap: the same secret.
    const again = new Library(sql, { rooms });
    again.keepSettings({});
    expect(again.settings().SESSION_SECRET).toBe(secret);
    expect(new Library(nodeSql(), { rooms }).settings().SESSION_SECRET).toBeUndefined();
  });

  it('show the owner where each setting comes from, and never a secret’s value', () => {
    const library = new Library(nodeSql(), { rooms: { create: async () => 'made', adopt: async () => '' } });
    library.keepSettings(FULL);
    const view = library.settingsView(FULL);
    expect(view.map((setting) => setting.name)).toEqual([...SETTINGS]);
    expect(view.every((setting) => setting.from === 'worker')).toBe(true);
    expect(view.filter((setting) => setting.kept).map((setting) => setting.name)).toEqual(Object.keys(NON_SECRETS));
    expect(view.find((setting) => setting.name === 'PUBLIC_URL')).toEqual({ name: 'PUBLIC_URL', secret: false, from: 'worker', kept: true, value: FULL.PUBLIC_URL });
    expect(view.find((setting) => setting.name === 'GITHUB_CLIENT_SECRET')).toEqual({ name: 'GITHUB_CLIENT_SECRET', secret: true, from: 'worker', kept: false });
    const shown = JSON.stringify(view);
    for (const name of SECRETS) expect(shown).not.toContain(FULL[name]);

    // Once the Worker's variables go and only its secrets stay (S3), the copies are what Quillipi uses.
    const secrets = Object.fromEntries([...SECRETS].map((name) => [name, FULL[name]]));
    const after = library.settingsView(secrets);
    expect(after.find((setting) => setting.name === 'OWNER_NAME')).toEqual({ name: 'OWNER_NAME', secret: false, from: 'quillipi', kept: true, value: 'The Octocat' });
    expect(after.find((setting) => setting.name === 'SESSION_SECRET')).toEqual({ name: 'SESSION_SECRET', secret: true, from: 'worker', kept: false });
    expect(library.settingsView({}).find((setting) => setting.name === 'GITHUB_CLIENT_SECRET')).toEqual({ name: 'GITHUB_CLIENT_SECRET', secret: true, from: 'missing', kept: false });
  });
});
