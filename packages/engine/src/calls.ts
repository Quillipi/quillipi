/**
 * The call log: one line for every tool call an AI agent makes, kept in
 * .inklog/calls/<year>-<month>.jsonl and never committed.
 *
 * It counts only what Quillipi receives and sends back, so it shows how many calls an agent made and
 * how much text they carried. Each call is also one step in which the agent's app reads the whole
 * conversation again, with its own instructions and thinking; that happens outside Quillipi.
 */
import { estimateTokens } from '@inklog/core';
import { LAYOUT, type NotebookStore } from './store.js';

export interface CallRecord {
  /** When the call started, in milliseconds since 1970. */
  at: number;
  agent: string;
  tool: string;
  /** The section the call named, if it named one. */
  target?: string;
  /** Estimated tokens in the arguments the agent sent. */
  sent: number;
  /** Estimated tokens in the reply Quillipi sent back, or in the error message. */
  returned: number;
  ms: number;
  ok: boolean;
}

export const CALLS_DIR = `${LAYOUT.local}/calls`;

/** A gap this long between one agent's calls starts a new session. */
export const SESSION_GAP_MS = 30 * 60_000;

const DAY_MS = 24 * 60 * 60_000;

export function describeCall(agent: string, tool: string, args: unknown, reply: string, ok: boolean, started: number, now = Date.now()): CallRecord {
  const target = targetOf(args);
  return {
    at: started,
    agent,
    tool,
    ...(target ? { target: target.slice(0, 120) } : {}),
    sent: estimateTokens(JSON.stringify(args ?? {})),
    returned: estimateTokens(reply),
    ms: now - started,
    // Tools report a failure such as a stale patch as a reply starting with ✗, not as an error.
    ok: ok && !reply.startsWith('✗'),
  };
}

/** The sections a call named: its path or list of paths, map's read list, or the paths of its ops. */
function targetOf(args: unknown): string | undefined {
  const { path, read, ops } = (args ?? {}) as { path?: unknown; read?: unknown; ops?: unknown };
  const named = [path, read, Array.isArray(ops) ? ops.map((op) => (op as { path?: unknown } | null)?.path) : undefined]
    .flat()
    .filter((value): value is string => typeof value === 'string');
  return named.length ? [...new Set(named)].join(', ') : undefined;
}

/** Adds one call to the log. Logging never stops a tool call, so a failure is only reported. */
export async function logCall(repo: NotebookStore, call: CallRecord): Promise<void> {
  try {
    await repo.append(callFile(call.at), `${JSON.stringify(call)}\n`);
  } catch (error) {
    console.error('Could not add a call to the call log:', error);
  }
}

function callFile(at: number): string {
  return `${CALLS_DIR}/${monthOf(at)}.jsonl`;
}

function monthOf(at: number): string {
  const date = new Date(at);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Every logged call since `since`, oldest first. Lines that can't be read are skipped. */
export async function readCalls(repo: NotebookStore, since: number): Promise<CallRecord[]> {
  const first = monthOf(since);
  const calls: CallRecord[] = [];
  for (const file of await repo.list(CALLS_DIR, '.jsonl')) {
    if (file.slice(CALLS_DIR.length + 1, -'.jsonl'.length) < first) continue;
    for (const line of ((await repo.read(file)) ?? '').split('\n')) {
      const call = parseCall(line);
      if (call && call.at >= since) calls.push(call);
    }
  }
  return calls.sort((a, b) => a.at - b.at);
}

function parseCall(line: string): CallRecord | undefined {
  if (!line.trim()) return undefined;
  try {
    const call = JSON.parse(line) as CallRecord;
    return typeof call.at === 'number' && typeof call.tool === 'string' && typeof call.returned === 'number' ? call : undefined;
  } catch {
    return undefined;
  }
}

export interface CallSession {
  agent: string;
  start: number;
  end: number;
  calls: CallRecord[];
}

/** Groups calls into sessions: one agent's calls, until it pauses for SESSION_GAP_MS. */
export function sessionsOf(calls: readonly CallRecord[]): CallSession[] {
  const open = new Map<string, CallSession>();
  const sessions: CallSession[] = [];
  for (const call of [...calls].sort((a, b) => a.at - b.at)) {
    let session = open.get(call.agent);
    if (!session || call.at - session.end > SESSION_GAP_MS) {
      session = { agent: call.agent, start: call.at, end: call.at, calls: [] };
      open.set(call.agent, session);
      sessions.push(session);
    }
    session.calls.push(call);
    session.end = call.at;
  }
  return sessions.sort((a, b) => a.start - b.start);
}

export interface RenderOptions {
  days: number;
  /** How a date and time are shown, and a time on the same day; tests pass fixed ones. */
  time?: (at: number) => string;
  clock?: (at: number) => string;
}

export function renderCalls(calls: readonly CallRecord[], { days, time = localTime, clock = localClock }: RenderOptions): string {
  const period = days === 1 ? 'the last day' : `the last ${days} days`;
  if (!calls.length) return `No AI agent called Quillipi in ${period}.`;

  const sessions = sessionsOf(calls);
  const lines = [
    `Quillipi calls in ${period}`,
    'This counts what Quillipi received and sent back. Each call is also one step in which',
    "the agent's app reads the whole conversation again, which Quillipi can't see.",
  ];
  for (const session of sessions) {
    const failed = session.calls.filter((call) => !call.ok).length;
    lines.push(
      '',
      `${time(session.start)} to ${sameDay(session.start, session.end) ? clock(session.end) : time(session.end)} · ${session.agent} · ${count(session.calls.length, 'call')} · ${tokens(sum(session.calls, 'returned'))} tokens returned`,
      `  ${byTool(session.calls)}`,
    );
    if (failed) lines.push(`  ${count(failed, 'call')} failed`);
  }

  const largest = [...calls].sort((a, b) => b.returned - a.returned).slice(0, 5);
  lines.push('', 'Largest replies');
  for (const call of largest) {
    lines.push(`  ${tokens(call.returned).padStart(5)}  ${call.tool}${call.target ? ` ${call.target}` : ''} · ${time(call.at)}`);
  }

  lines.push(
    '',
    `Total: ${count(calls.length, 'call')} in ${count(sessions.length, 'session')}, ${tokens(sum(calls, 'returned'))} tokens returned, ${tokens(sum(calls, 'sent'))} tokens sent.`,
  );
  return lines.join('\n');
}

export function sinceDays(days: number, now = Date.now()): number {
  return now - days * DAY_MS;
}

function byTool(calls: readonly CallRecord[]): string {
  const tools = new Map<string, { calls: number; returned: number }>();
  for (const call of calls) {
    const entry = tools.get(call.tool) ?? { calls: 0, returned: 0 };
    entry.calls++;
    entry.returned += call.returned;
    tools.set(call.tool, entry);
  }
  return [...tools]
    .sort(([, a], [, b]) => b.returned - a.returned)
    .map(([tool, entry]) => `${tool} ×${entry.calls} ${tokens(entry.returned)}`)
    .join(' · ');
}

function sum(calls: readonly CallRecord[], field: 'sent' | 'returned'): number {
  return calls.reduce((total, call) => total + call[field], 0);
}

function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function tokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}

function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

function localClock(at: number): string {
  return new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function localTime(at: number): string {
  return new Date(at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}
