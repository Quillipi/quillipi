/**
 * Only one Quillipi process owns a folder at a time, so there is a single writer. The first
 * process (`quillipi serve` or `quillipi mcp`) writes .inklog/owner.json; later processes find it
 * and send their work to the owner over its local HTTP API.
 */
import fs from 'node:fs';
import path from 'node:path';
import { LAYOUT } from '@inklog/engine';
import type { ToolHost } from '@inklog/engine';

export interface Owner {
  pid: number;
  port: number;
  token: string;
  /** Set when the owner has remote access on. */
  publicUrl?: string;
}

function ownerFile(dir: string): string {
  return path.join(dir, LAYOUT.local, 'owner.json');
}

/** The process that owns the folder, if one is running and answering. */
export async function findOwner(dir: string): Promise<Owner | undefined> {
  let owner: Owner;
  try {
    owner = JSON.parse(fs.readFileSync(ownerFile(dir), 'utf8'));
  } catch {
    return undefined;
  }
  if (owner.pid === process.pid) return undefined;
  try {
    process.kill(owner.pid, 0); // throws if the process is gone
    const response = await fetch(`http://127.0.0.1:${owner.port}/api/ping`, { headers: { authorization: `Bearer ${owner.token}` } });
    return response.ok ? owner : undefined;
  } catch {
    return undefined;
  }
}

/** Records this process as the owner. The returned function gives the folder up again. */
export function claimOwnership(dir: string, owner: Owner): () => void {
  const file = ownerFile(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(owner));
  return () => {
    try {
      if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.rmSync(file);
    } catch {
      // Already gone.
    }
  };
}

/**
 * Tools that run in the owner process. If Quillipi was restarted since this process found it,
 * the old address or token stops working, so it looks for the new owner and tries once more.
 */
export function ownerTools(dir: string, owner: Owner): ToolHost {
  let current = owner;
  const send = (target: Owner, body: string) =>
    fetch(`http://127.0.0.1:${target.port}/api/tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${target.token}` },
      body,
    });
  return {
    async call(name, args, agent) {
      const body = JSON.stringify({ name, args, agent });
      let response = await send(current, body).catch(() => undefined);
      if (!response || response.status === 401) {
        const fresh = await findOwner(dir);
        if (!fresh) throw new Error('Quillipi is no longer running for this folder. Start it again with quillipi serve.');
        current = fresh;
        response = await send(current, body);
      }
      const answer = (await response.json()) as { text?: string; error?: string };
      if (!response.ok) throw new Error(answer.error ?? `Quillipi answered ${response.status}`);
      return answer.text ?? '';
    },
  };
}
