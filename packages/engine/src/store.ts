/**
 * Where a notebook keeps its files and its history.
 *
 * The engine talks only to this interface, so the same engine can run on a folder with Git on a
 * laptop (RepoFiles, in repo.ts) or in the cloud. MemoryStore (memory-store.ts) is a third
 * implementation, used to prove that nothing in the engine reaches past this interface.
 *
 * Paths are relative to the notebook and use `/`, as Git does. The working files are the current
 * text. History is a chain of commits, each a complete snapshot of the files, made from exactly
 * the changes given; a commit never touches the working files, which is what makes partial
 * commits possible.
 */
import type { Person } from '@inklog/core';

/** Where things live inside a notebook. */
export const LAYOUT = {
  sections: 'sections',
  canvas: 'canvas',
  assets: 'assets',
  meta: 'inklog.json',
  agents: 'AGENTS.md',
  /** Local state that is never committed. */
  local: '.inklog',
} as const;

export interface CommitRecord {
  oid: string;
  message: string;
  author: string;
  /** Milliseconds since 1970. */
  at: number;
  parent?: string;
}

/** Files to commit: new content, or `null` to remove the path. */
export type FileChanges = Map<string, string | Uint8Array | null>;

export interface NotebookStore {
  // Working files ------------------------------------------------------------

  /** A file's text, or undefined if there is no such file. */
  read(rel: string): Promise<string | undefined>;
  readBytes(rel: string): Promise<Uint8Array | undefined>;
  /** Writes a whole file at once; a reader never sees half of it. */
  write(rel: string, content: string | Uint8Array): Promise<void>;
  /** Adds text to the end of a file, creating it if needed. For local logs that only grow. */
  append(rel: string, text: string): Promise<void>;
  remove(rel: string): Promise<void>;
  /** Files under `relDir`, at any depth, ending in `extension`, sorted. */
  list(relDir: string, extension: string): Promise<string[]>;

  // History ------------------------------------------------------------------

  /** The person commits are made as. */
  person(): Promise<Person>;
  /** The latest commit, or undefined before the first one. */
  head(): Promise<string | undefined>;
  /** Commits from the latest back, newest first. */
  log(limit?: number): Promise<CommitRecord[]>;
  /** Every file in a commit, with an ID of its content: equal IDs mean equal content. */
  filesAt(commit: string): Promise<Map<string, string>>;
  /** A file's text in a commit, or undefined if it wasn't there. */
  readAt(commit: string, rel: string): Promise<string | undefined>;
  /** Commits exactly the given changes on top of the latest commit, and returns the new commit's ID. */
  commit(changes: FileChanges, message: string, author: Person): Promise<string>;
}

/** Rejects paths that could reach outside the notebook. */
export function checkPath(rel: string): string {
  const parts = rel.split('/');
  if (!rel || rel.includes('\\') || rel.includes(':') || rel.startsWith('/') || parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`"${rel}" is not a path inside the notebook.`);
  }
  return rel;
}
