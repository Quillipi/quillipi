/**
 * A notebook kept entirely in memory. Tests run the engine on it to prove that the engine needs
 * nothing but the NotebookStore interface, and it is the model for the cloud store.
 *
 * Every ID is Git's: the same files get the same blob and tree IDs, and the same commit made at
 * the same second by the same person gets the same commit ID as in a real repository.
 */
import type { Person } from '@inklog/core';
import { blobId, commitId, treeId } from './git-objects.js';
import { type CommitRecord, type FileChanges, type NotebookStore, checkPath } from './store.js';

interface StoredCommit extends CommitRecord {
  /** Every file in the commit, by path, with its content ID. */
  files: Map<string, string>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class MemoryStore implements NotebookStore {
  private files = new Map<string, Uint8Array>();
  private blobs = new Map<string, Uint8Array>();
  private commits = new Map<string, StoredCommit>();
  private latest?: string;

  constructor(private readonly owner: Person = { name: 'You', email: 'you@localhost' }) {}

  async read(rel: string): Promise<string | undefined> {
    const bytes = this.files.get(checkPath(rel));
    return bytes && decoder.decode(bytes);
  }

  async readBytes(rel: string): Promise<Uint8Array | undefined> {
    const bytes = this.files.get(checkPath(rel));
    return bytes && new Uint8Array(bytes);
  }

  async write(rel: string, content: string | Uint8Array): Promise<void> {
    this.files.set(checkPath(rel), toBytes(content));
  }

  async append(rel: string, text: string): Promise<void> {
    const before = this.files.get(checkPath(rel)) ?? new Uint8Array();
    const added = encoder.encode(text);
    const joined = new Uint8Array(before.length + added.length);
    joined.set(before);
    joined.set(added, before.length);
    this.files.set(rel, joined);
  }

  async remove(rel: string): Promise<void> {
    this.files.delete(checkPath(rel));
  }

  async list(relDir: string, extension: string): Promise<string[]> {
    const prefix = `${checkPath(relDir)}/`;
    return [...this.files.keys()].filter((rel) => rel.startsWith(prefix) && rel.endsWith(extension)).sort();
  }

  async person(): Promise<Person> {
    return { ...this.owner };
  }

  async head(): Promise<string | undefined> {
    return this.latest;
  }

  async log(limit = 1000): Promise<CommitRecord[]> {
    const records: CommitRecord[] = [];
    for (let oid = this.latest; oid && records.length < limit; oid = this.commits.get(oid)?.parent) {
      const { files: _files, ...record } = this.commits.get(oid)!;
      records.push(record);
    }
    return records;
  }

  async filesAt(commit: string): Promise<Map<string, string>> {
    const stored = this.commits.get(commit);
    if (!stored) throw new Error(`No commit ${commit}.`);
    return new Map(stored.files);
  }

  async readAt(commit: string, rel: string): Promise<string | undefined> {
    const id = this.commits.get(commit)?.files.get(rel);
    const bytes = id === undefined ? undefined : this.blobs.get(id);
    return bytes && decoder.decode(bytes);
  }

  async commit(changes: FileChanges, message: string, author: Person): Promise<string> {
    const parent = this.latest;
    const files = new Map(parent ? this.commits.get(parent)!.files : []);
    for (const [rel, content] of changes) {
      checkPath(rel);
      if (content === null) {
        files.delete(rel);
        continue;
      }
      const bytes = toBytes(content);
      const id = await blobId(bytes);
      this.blobs.set(id, bytes);
      files.set(rel, id);
    }
    // Git counts whole seconds, and records the author's time zone with each commit.
    const timestamp = Math.floor(Date.now() / 1000);
    const timezoneOffset = new Date(timestamp * 1000).getTimezoneOffset();
    const tree = await treeId(files);
    const oid = await commitId({ tree, parents: parent ? [parent] : [], author, timestamp, timezoneOffset, message });
    this.commits.set(oid, { oid, message: message.trimEnd(), author: author.name, at: timestamp * 1000, ...(parent ? { parent } : {}), files });
    this.latest = oid;
    return oid;
  }
}

function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? encoder.encode(content) : new Uint8Array(content);
}
