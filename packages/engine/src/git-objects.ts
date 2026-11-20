/**
 * Git's object IDs, computed the way Git computes them: the SHA-1 of a short header followed by
 * the object's bytes. With these, a store that isn't a Git folder (in memory, or in the cloud)
 * still names every file, folder and commit exactly as Git would. So its history can be
 * recreated on GitHub commit for commit, and compared with the history on the laptop.
 *
 * Only what Quillipi writes is covered: files with mode 100644, folders, and commits without
 * signatures.
 */
import type { Person } from '@inklog/core';
import { digestHex } from './digest.js';

const encoder = new TextEncoder();

/** Git's ID for a file's content. */
export function blobId(bytes: Uint8Array): Promise<string> {
  return objectId('blob', bytes);
}

/**
 * The ID of the root tree holding these files, given as path → blob ID. Git keeps a tree for
 * every folder, so folders are built from the paths; there are no empty folders.
 */
export async function treeId(files: ReadonlyMap<string, string>): Promise<string> {
  const here = new Map<string, string>();
  const folders = new Map<string, Map<string, string>>();
  for (const [rel, id] of files) {
    const slash = rel.indexOf('/');
    if (slash < 0) {
      here.set(rel, id);
      continue;
    }
    const name = rel.slice(0, slash);
    if (!folders.has(name)) folders.set(name, new Map());
    folders.get(name)!.set(rel.slice(slash + 1), id);
  }
  const entries = [...here].map(([name, id]) => ({ name, id, folder: false }));
  for (const [name, inside] of folders) entries.push({ name, id: await treeId(inside), folder: true });
  // Git sorts entries by their bytes, with a folder's name read as if it ended in "/".
  entries.sort((a, b) => compareBytes(encoder.encode(a.name + (a.folder ? '/' : '')), encoder.encode(b.name + (b.folder ? '/' : ''))));
  const parts = entries.flatMap(({ name, id, folder }) => [encoder.encode(`${folder ? '40000' : '100644'} ${name}\0`), hexBytes(id)]);
  return objectId('tree', concat(parts));
}

export interface CommitObject {
  tree: string;
  parents: readonly string[];
  /** Author and committer: Quillipi makes them the same. */
  author: Person;
  /** Seconds since 1970, as Git counts. */
  timestamp: number;
  /** The author's time zone, as JavaScript's Date#getTimezoneOffset gives it: minutes behind UTC. */
  timezoneOffset: number;
  message: string;
}

/** A commit's text, exactly as Git stores it. */
export function commitText(commit: CommitObject): string {
  const who = `${commit.author.name} <${commit.author.email}> ${commit.timestamp} ${gitTimezone(commit.timezoneOffset)}`;
  return [`tree ${commit.tree}`, ...commit.parents.map((parent) => `parent ${parent}`), `author ${who}`, `committer ${who}`, '', commitMessage(commit.message)].join('\n');
}

export function commitId(commit: CommitObject): Promise<string> {
  return objectId('commit', encoder.encode(commitText(commit)));
}

/**
 * A commit message as Git keeps it: no carriage returns, no blank lines at the start, and exactly
 * one newline at the end. Sending GitHub the message in this form makes its commit ID match.
 */
export function commitMessage(message: string): string {
  return `${message.replace(/\r/g, '').replace(/^\n+/, '').replace(/\n+$/, '')}\n`;
}

/** A time zone as Git writes it, such as +0530 for India. JavaScript counts the other way. */
export function gitTimezone(offsetMinutes: number): string {
  const ahead = -offsetMinutes;
  const minutes = Math.abs(ahead);
  const sign = ahead < 0 ? '-' : '+';
  return `${sign}${String(Math.floor(minutes / 60)).padStart(2, '0')}${String(minutes % 60).padStart(2, '0')}`;
}

/** Git's ID for the empty tree, which is the same in every repository. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function objectId(type: 'blob' | 'tree' | 'commit', body: Uint8Array): Promise<string> {
  return digestHex('SHA-1', concat([encoder.encode(`${type} ${body.length}\0`), body]));
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const whole = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let at = 0;
  for (const part of parts) {
    whole.set(part, at);
    at += part.length;
  }
  return whole;
}

function hexBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}
