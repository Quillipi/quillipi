/**
 * The limits on sign-in steps a stranger can start (security audit of 2026-11-20): per visitor
 * every ten minutes, and for everyone together each UTC day, so Workers KV's daily writes are
 * left for the owner's own tokens.
 */
import { describe, expect, it } from 'vitest';
import { PER_DAY, PER_VISITOR, SignInLimits, WINDOW_MS, visitorOf } from '../src/sign-in-limits.js';
import { nodeSql } from './node-sql.js';

const NOON = Date.parse('2026-11-20T12:00:00Z');

function limits(start = NOON) {
  const clock = { now: start };
  const sql = nodeSql();
  return { clock, sql, limits: new SignInLimits(sql, () => clock.now) };
}

describe('sign-in limits', () => {
  it('lets one visitor start PER_VISITOR steps in ten minutes, then says when to come back', () => {
    const { clock, limits: l } = limits();
    for (let i = 0; i < PER_VISITOR; i++) expect(l.admit('203.0.113.7')).toEqual({ admitted: true });
    clock.now += 60_000;
    expect(l.admit('203.0.113.7')).toEqual({ admitted: false, reason: 'visitor', retryAfter: (WINDOW_MS - 60_000) / 1000 });
    // Someone else is not held up by them.
    expect(l.admit('198.51.100.2')).toEqual({ admitted: true });
    clock.now = NOON + WINDOW_MS;
    expect(l.admit('203.0.113.7')).toEqual({ admitted: true });
  });

  it('lets everyone together start PER_DAY steps a UTC day, kept across a restart, and counts nothing it refuses', () => {
    const { clock, sql, limits: l } = limits();
    for (let i = 0; i < PER_DAY; i++) expect(l.admit(`visitor-${i}`).admitted).toBe(true);
    const refused = l.admit('visitor-new');
    expect(refused).toEqual({ admitted: false, reason: 'day', retryAfter: 12 * 60 * 60 });
    // A library that wakes up again still knows today's count.
    const restarted = new SignInLimits(sql, () => clock.now);
    expect(restarted.admit('another').admitted).toBe(false);
    expect(Number(sql.exec('SELECT count FROM sign_in_days').toArray()[0]!.count)).toBe(PER_DAY);
    // A new day starts afresh, and the old day's row goes.
    clock.now = Date.parse('2026-11-21T00:00:01Z');
    expect(restarted.admit('another').admitted).toBe(true);
    expect(sql.exec('SELECT day, count FROM sign_in_days').toArray()).toEqual([{ day: '2026-11-21', count: 1 }]);
  });

  it('knows a visitor by IPv4 address, or by IPv6 /64 network, and stores no address', () => {
    const asking = (ip?: string) => new Request('https://q.example/authorize', { headers: ip ? { 'cf-connecting-ip': ip } : {} });
    expect(visitorOf(asking('203.0.113.7'))).toBe('203.0.113.7');
    expect(visitorOf(asking('2001:db8:aa:bb::1'))).toBe('2001:db8:aa:bb::/64');
    expect(visitorOf(asking('2001:0DB8:00aa:00bb:1:2:3:4'))).toBe('2001:db8:aa:bb::/64');
    expect(visitorOf(asking('2001:db8::5'))).toBe('2001:db8:0:0::/64');
    expect(visitorOf(asking())).toBe('unknown');
    const { sql, limits: l } = limits();
    l.admit('203.0.113.7');
    expect(JSON.stringify(sql.exec('SELECT * FROM sign_in_days').toArray())).not.toContain('203.0.113.7');
  });
});
