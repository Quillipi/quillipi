/**
 * The browser's sign-in to the app: after GitHub says who it is, the browser gets a cookie signed
 * with the Worker secret SESSION_SECRET. Nothing is stored per sign-in or per request, so Workers
 * KV's daily writes are untouched; the cookie itself says who signed in and until when, and the
 * signature proves Quillipi wrote it.
 *
 * Like a wristband at an event: checked by looking at it, not by phoning a list. The trade-off is
 * that one stolen cookie can't be cancelled alone; changing SESSION_SECRET signs every browser out.
 */
import type { Env } from './env.js';

/** The session cookie. `__Host-` makes the browser keep it to this exact address, over HTTPS, for every path. */
export const SESSION_COOKIE = '__Host-inklog';
/** A sign-in on its way through GitHub: its state and PKCE verifier, bound to this browser. */
export const SIGN_IN_COOKIE = '__Host-inklog-signin';
/** How long a browser stays signed in without being used, as an AI app's connection does. */
export const SESSION_DAYS = 90;
/** A session older than this gets a fresh cookie when it is used, so the 90 days count from the last use. */
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000;
/** A sign-in must come back from GitHub within this time. */
export const SIGN_IN_MINUTES = 10;
/** Shorter secrets are refused: the cookie's signature is only as strong as the secret. */
const MIN_SECRET_LENGTH = 32;

export interface Session {
  /** The GitHub account's permanent ID, and its name when it signed in. */
  user: string;
  login: string;
  /** When this cookie was written and when it stops working, in milliseconds since 1970. */
  issued: number;
  expires: number;
}

/** Whether browser sign-in has its secret, naming what is wrong. Checked without calling anything. */
export function sessionStatus(env: Env): string {
  if (!env.SESSION_SECRET) return 'not set up: SESSION_SECRET missing';
  if (env.SESSION_SECRET.length < MIN_SECRET_LENGTH) return `not set up: SESSION_SECRET is shorter than ${MIN_SECRET_LENGTH} characters`;
  return 'ready';
}

/**
 * The session a request carries, if its cookie is genuine, unexpired and for the one account let
 * in. `renew` is a fresh cookie to send back when the session is more than a day old.
 */
export async function readSession(request: Request, env: Env, now = Date.now()): Promise<{ session: Session; renew?: string } | undefined> {
  if (sessionStatus(env) !== 'ready') return undefined;
  const session = await unseal<Session>(readCookie(request, SESSION_COOKIE), env.SESSION_SECRET!);
  if (!session || typeof session.user !== 'string' || typeof session.login !== 'string') return undefined;
  if (!(session.expires > now) || session.user !== env.GITHUB_USER_ID) return undefined;
  if (now - session.issued < RENEW_AFTER_MS) return { session };
  return { session, renew: await sessionCookie({ user: session.user, login: session.login }, env, now) };
}

/** A Set-Cookie value that signs this browser in for SESSION_DAYS. */
export async function sessionCookie({ user, login }: { user: string; login: string }, env: Env, now = Date.now()): Promise<string> {
  const lifetime = SESSION_DAYS * 24 * 60 * 60 * 1000;
  const value = await seal({ user, login, issued: now, expires: now + lifetime } satisfies Session, env.SESSION_SECRET!);
  return cookie(SESSION_COOKIE, value, lifetime / 1000);
}

/** A Set-Cookie value that removes a cookie. */
export function clearCookie(name: string): string {
  return cookie(name, '', 0);
}

/**
 * Cookies here are HttpOnly, so scripts can't read them; Secure, so they only travel over HTTPS;
 * and SameSite=Lax, so other sites can't send them with a form or a script, while the return
 * from GitHub, a top-level navigation, still carries them.
 */
export function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; Max-Age=${Math.max(0, Math.floor(maxAge))}; Secure; HttpOnly; SameSite=Lax`;
}

export function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get('cookie') ?? '').split(/;\s*/)) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at) === name) return part.slice(at + 1);
  }
  return undefined;
}

// Signing ------------------------------------------------------------------------

/** `<data>.<signature>`, both base64url: the data is readable, but changing it breaks the signature. */
export async function seal(data: unknown, secret: string): Promise<string> {
  const body = base64url(new TextEncoder().encode(JSON.stringify(data)));
  const signature = await crypto.subtle.sign('HMAC', await keyFor(secret), new TextEncoder().encode(body));
  return `${body}.${base64url(new Uint8Array(signature))}`;
}

/** The data in a sealed value, or nothing if it is missing, malformed or not signed with this secret. */
export async function unseal<T>(value: string | undefined, secret: string): Promise<T | undefined> {
  if (!value) return undefined;
  const [body, signature, extra] = value.split('.');
  if (!body || !signature || extra !== undefined) return undefined;
  try {
    // verify compares in constant time, so the signature can't be guessed byte by byte.
    const genuine = await crypto.subtle.verify('HMAC', await keyFor(secret), fromBase64url(signature), new TextEncoder().encode(body));
    return genuine ? (JSON.parse(new TextDecoder().decode(fromBase64url(body))) as T) : undefined;
  } catch {
    return undefined;
  }
}

/** One key per secret, kept between requests, because importing a key costs CPU time on every request. */
const keys = new Map<string, Promise<CryptoKey>>();

function keyFor(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    keys.clear(); // a changed secret replaces the old one
    keys.set(secret, key);
  }
  return key;
}

export function base64url(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
