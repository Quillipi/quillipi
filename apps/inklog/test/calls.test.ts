import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runTool } from '@inklog/engine';
import { type CallRecord, SESSION_GAP_MS, readCalls, renderCalls, sessionsOf } from '@inklog/engine';
import { Engine } from '@inklog/engine';
import { RepoFiles } from '../src/repo.js';
import { initFolder, openFolder } from '../src/setup.js';
import { tempFolder } from './helpers.js';

const AGENT = 'Claude via claude.ai';

async function openNew(): Promise<Engine> {
  const dir = path.join(tempFolder(), 'notebook');
  await initFolder(dir, { name: 'Karan', email: 'karan@example.com' });
  return openFolder(dir);
}

function call(at: number, tool: string, returned: number, agent = AGENT, extra: Partial<CallRecord> = {}): CallRecord {
  return { at, agent, tool, sent: 10, returned, ms: 5, ok: true, ...extra };
}

describe('the call log', () => {
  it('records every tool call, including ones that fail', async () => {
    const engine = await openNew();
    const map = await runTool(engine, AGENT, 'map', {});
    await runTool(engine, AGENT, 'read', { path: 'overview' });
    await expect(runTool(engine, AGENT, 'read', { path: 'no-such-section' })).rejects.toThrow();

    const calls = await readCalls(engine.repo, 0);
    expect(calls.map((c) => [c.tool, c.target, c.ok])).toEqual([
      ['map', undefined, true],
      ['read', 'overview', true],
      ['read', 'no-such-section', false],
    ]);
    expect(calls[0]!.returned).toBe(Math.ceil(map.length / 4));
    expect(calls.every((c) => c.agent === AGENT && c.sent > 0 && c.returned > 0)).toBe(true);
  });

  it('keeps the log out of Git', async () => {
    const engine = await openNew();
    await runTool(engine, AGENT, 'map', {});
    expect(await engine.repo.read('.gitignore')).toContain('.inklog/');
  });

  it('never lets a logging failure break a tool call', async () => {
    const engine = await openNew();
    vi.spyOn(engine.repo, 'append').mockRejectedValue(new Error('disk full'));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runTool(engine, AGENT, 'map', {})).toContain('overview');
    expect(quiet).toHaveBeenCalled();
    quiet.mockRestore();
  });

  it('skips unreadable lines and calls before the period', async () => {
    const repo = new RepoFiles(tempFolder());
    const now = Date.UTC(2026, 10, 5, 12);
    const lines = [call(now - 3_600_000, 'map', 100), call(now - 40 * 86_400_000, 'read', 50)].map((c) => JSON.stringify(c));
    await repo.append('.inklog/calls/2026-11.jsonl', `${lines[0]}\nnot json\n\n`);
    await repo.append('.inklog/calls/2026-09.jsonl', `${lines[1]}\n`);
    const calls = await readCalls(repo, now - 7 * 86_400_000);
    expect(calls.map((c) => c.tool)).toEqual(['map']);
  });

  it('groups calls into sessions by agent and by long pauses', () => {
    const t = Date.UTC(2026, 10, 5, 10);
    const sessions = sessionsOf([
      call(t, 'map', 100),
      call(t + 60_000, 'read', 900),
      call(t + 90_000, 'map', 100, 'Claude via Claude Code'),
      call(t + 60_000 + SESSION_GAP_MS + 1, 'read', 900),
    ]);
    expect(sessions.map((s) => [s.agent, s.calls.length])).toEqual([
      [AGENT, 2],
      ['Claude via Claude Code', 1],
      [AGENT, 1],
    ]);
  });

  it('summarises calls per session, per tool and in total', () => {
    const t = Date.UTC(2026, 10, 5, 10);
    const text = renderCalls(
      [
        call(t, 'map', 1400),
        call(t + 1000, 'read', 2300, AGENT, { target: 'design' }),
        call(t + 2000, 'read', 900, AGENT, { target: 'roadmap' }),
        call(t + 3000, 'patch', 120, AGENT, { ok: false }),
      ],
      { days: 7, time: (at) => `T+${(at - t) / 1000}s`, clock: (at) => `+${(at - t) / 1000}s` },
    );
    expect(text).toContain(`T+0s to +3s · ${AGENT} · 4 calls · 4.7k tokens returned`);
    expect(text).toContain('read ×2 3.2k · map ×1 1.4k · patch ×1 120');
    expect(text).toContain('1 call failed');
    expect(text).toContain('2.3k  read design · T+1s');
    expect(text).toContain('Total: 4 calls in 1 session, 4.7k tokens returned, 40 tokens sent.');
    expect(renderCalls([], { days: 1 })).toBe('No AI agent called Quillipi in the last day.');
  });
});
