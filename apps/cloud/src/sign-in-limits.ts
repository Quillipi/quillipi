/**
 * Limits on the sign-in steps a stranger can start without signing in: registering an app
 * (POST /register) and opening or answering the consent page (/authorize). Each of these makes
 * workers-oauth-provider write to Workers KV, and the Free plan allows 1,000 writes a day for the
 * whole account. Without a limit, anyone could spend them all, and then the owner's connected apps
 * couldn't refresh their tokens until midnight UTC (security audit of 2026-11-20).
 *
 * Like a ticket desk with a daily stock of tickets and a rule of a few per person: when the stock
 * is gone, the people already inside stay inside.
 *
 * - Each visitor (an IP address, or an IPv6 /64 network) may start PER_VISITOR in WINDOW_MS.
 *   These counts live only in memory, so no address is ever stored; they go when the library
 *   sleeps, which only makes the limit kinder.
 * - Strangers together may start PER_DAY a UTC day, counted in the library's database so a
 *   restart doesn't reset it. That leaves most of the day's writes for the owner's own tokens.
 * - The owner, signed in to the app in this browser, is never limited (index.ts checks first),
 *   and nothing refused is counted, so a refusal writes nothing.
 *
 * The library is one Durable Object for the whole cloud, so these counts are exact everywhere,
 * on every plan, with nothing for a newcomer to set up.
 */
import type { SqlDatabase } from './durable-store.js';

export const PER_VISITOR = 20;
export const WINDOW_MS = 10 * 60 * 1000;
export const PER_DAY = 300;

/** Visitors remembered at once; past this, the ones whose window has ended are let go. */
const REMEMBERED = 5_000;

export type Admission = { admitted: true } | { admitted: false; reason: 'visitor' | 'day'; retryAfter: number };

export class SignInLimits {
  private readonly visitors = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly sql: SqlDatabase,
    private readonly now: () => number = Date.now,
  ) {
    sql.exec('CREATE TABLE IF NOT EXISTS sign_in_days (day TEXT PRIMARY KEY, count INTEGER NOT NULL)');
  }

  /** Whether `visitor` may start one more sign-in step now; if so, it is counted. */
  admit(visitor: string): Admission {
    const now = this.now();
    const seen = this.visitors.get(visitor);
    const window = seen && now - seen.start < WINDOW_MS ? seen : { start: now, count: 0 };
    if (window.count >= PER_VISITOR) return { admitted: false, reason: 'visitor', retryAfter: Math.ceil((window.start + WINDOW_MS - now) / 1000) };
    const day = new Date(now).toISOString().slice(0, 10);
    const today = Number(this.sql.exec('SELECT count FROM sign_in_days WHERE day = ?', day).toArray()[0]?.count ?? 0);
    if (today >= PER_DAY) return { admitted: false, reason: 'day', retryAfter: Math.ceil((Date.parse(`${day}T00:00:00Z`) + 86_400_000 - now) / 1000) };
    this.sql.exec('INSERT INTO sign_in_days (day, count) VALUES (?, 1) ON CONFLICT (day) DO UPDATE SET count = count + 1', day);
    this.sql.exec('DELETE FROM sign_in_days WHERE day < ?', day);
    window.count++;
    this.visitors.set(visitor, window);
    if (this.visitors.size > REMEMBERED) this.forget(now);
    return { admitted: true };
  }

  private forget(now: number): void {
    for (const [visitor, window] of this.visitors) if (now - window.start >= WINDOW_MS) this.visitors.delete(visitor);
  }
}

/**
 * Who is asking, as Cloudflare saw them: the connecting IP address. An IPv6 address counts by
 * its /64 network, since one home or server usually holds a whole /64 and could change address
 * within it at will.
 */
export function visitorOf(request: Request): string {
  const ip = request.headers.get('cf-connecting-ip')?.trim();
  if (!ip) return 'unknown';
  if (!ip.includes(':')) return ip;
  return `${expandIPv6(ip).slice(0, 4).join(':')}::/64`;
}

/** The eight groups of an IPv6 address, with `::` filled in, lowercase and without leading zeros. */
function expandIPv6(ip: string): string[] {
  const [head = '', tail] = ip.toLowerCase().split('::');
  const start = head ? head.split(':') : [];
  const end = tail ? tail.split(':') : [];
  const groups = tail === undefined ? start : [...start, ...Array<string>(Math.max(0, 8 - start.length - end.length)).fill('0'), ...end];
  return groups.map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16).toString(16) : group));
}
