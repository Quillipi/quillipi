/**
 * Quillipi's settings: its address, who owns it, the GitHub App and the key that signs the browser's
 * cookie. Each is named after the Worker variable or secret that can set it, such as
 * GITHUB_CLIENT_ID. A Worker variable that holds a value wins; otherwise the value comes from the
 * library's own storage (library.ts). So a fresh deploy works with no file to edit, and anyone can
 * still keep a key as a Worker secret, as a Quillipi set up by hand does.
 *
 * Like a front desk that keeps spare keys: a person who carries their own key uses it, and the
 * desk's key is there for anyone who doesn't.
 *
 * Cloudflare runs many copies of the Worker and the rooms at once, each with its own memory. A copy
 * keeps what the library said for at most KEEP_MS, and never while something is missing, because a
 * copy that kept "not set up" would go on saying so after the setup was done.
 */
import type { Env } from './env.js';
import { base64url } from './session.js';

/** Every setting, by the name of the Worker variable or secret that can set it. */
export const SETTINGS = [
  'PUBLIC_URL',
  'OWNER_NAME',
  'OWNER_EMAIL',
  'GITHUB_OWNER',
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'GITHUB_USER_ID',
  'GITHUB_USER_LOGIN',
  'SESSION_SECRET',
] as const;

export type SettingName = (typeof SETTINGS)[number];

/** Settings by name; any may be missing. */
export type Settings = Partial<Record<SettingName, string>>;

/** These are never shown, and the library never copies them from the Worker. */
export const SECRETS: ReadonlySet<SettingName> = new Set(['GITHUB_APP_PRIVATE_KEY', 'GITHUB_CLIENT_SECRET', 'SESSION_SECRET']);

/**
 * What a Quillipi needs before anyone can use it: GitHub's sign-in through the App, the one account
 * let in, and whom commits are made as. The first-time setup writes these (setup.ts), and the
 * GitHub App's key and organization for backups as well, which Quillipi can also run without.
 */
export const NEEDED: readonly SettingName[] = ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GITHUB_USER_ID', 'GITHUB_USER_LOGIN', 'OWNER_NAME', 'OWNER_EMAIL'];

/** Whether Quillipi is set up: until it is, every page leads to the setup. */
export function isSetUp(values: Settings): boolean {
  return NEEDED.every((name) => own(values, name) !== undefined);
}

/** How long a copy of the Worker or a room keeps the settings the library gave it. */
export const KEEP_MS = 30_000;

/** One setting as the owner sees it on `GET /api/settings`. A secret's value is never included. */
export interface SettingView {
  name: SettingName;
  secret: boolean;
  /** Where the value in use comes from: the Worker's own variables or secrets, or Quillipi's library. */
  from: 'worker' | 'quillipi' | 'missing';
  /** Whether the library keeps this value itself, so it holds if the Worker's variable goes. */
  kept: boolean;
  value?: string;
}

export function isSetting(name: string): name is SettingName {
  return (SETTINGS as readonly string[]).includes(name);
}

/** A setting's value, if it holds one: an empty or blank variable doesn't count. */
export function own(values: Settings, name: SettingName): string | undefined {
  const value = values[name];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** A new secret for signing cookies: 32 random bytes, 43 characters. */
export function newSecret(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * What the library last said, kept per `env`: Cloudflare gives a copy of the Worker, or of a
 * room, the same `env` for every request, so this is each copy's own memory.
 */
const kept = new WeakMap<Env, { at: number; settings: Promise<Settings> }>();

/**
 * `env` with every setting the Worker doesn't hold filled in from the library, which `stored`
 * asks. When the Worker holds them all, the library isn't asked and `env` itself comes back;
 * otherwise a new object does, so `env` is never changed.
 */
export async function withSettings(env: Env, stored: () => Promise<Settings>, now = Date.now()): Promise<Env> {
  const lacking = SETTINGS.filter((name) => own(env, name) === undefined);
  if (!lacking.length) return env;
  let asked = kept.get(env);
  if (!asked || now - asked.at >= KEEP_MS) {
    asked = { at: now, settings: stored() };
    kept.set(env, asked);
  }
  let settings: Settings;
  try {
    settings = await asked.settings;
  } catch (error) {
    if (kept.get(env) === asked) kept.delete(env);
    throw error;
  }
  const filled: Env = { ...env };
  for (const name of lacking) filled[name] = own(settings, name);
  // While something is missing nothing is kept, so a setup that has just finished shows at once.
  if (lacking.some((name) => filled[name] === undefined) && kept.get(env) === asked) kept.delete(env);
  return filled;
}
