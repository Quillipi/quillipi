/**
 * A notebook kept in a Durable Object's SQLite database: the store the cloud runs the engine on.
 *
 * It behaves like the folder with Git on the laptop, and passes the same contract tests:
 * - working files live in `files`, split into chunks because SQLite rows are capped at 2 MB;
 * - history is a chain of commits in `commits`, each with a full snapshot of its files, and the
 *   content of every committed file lives once in `blobs`, under its Git blob ID;
 * - every blob, tree and commit ID is Git's own, so the history can be recreated on GitHub
 *   commit for commit, and a history from GitHub can be kept under GitHub's own IDs (mirror.ts);
 * - each commit's message is kept exactly as Git hashed it, so it can be sent to GitHub unchanged.
 *
 * It talks to SQLite through SqlDatabase, a small slice of the Durable Object's `ctx.storage.sql`,
 * so the tests can run it in Node on node:sqlite.
 */
import type { Person } from '@inklog/core';
import { type CommitRecord, type FileChanges, LAYOUT, type NotebookStore, blobId, checkPath, commitId, commitMessage, treeId } from '@inklog/engine';

export type SqlValue = string | number | null | ArrayBuffer | Uint8Array;

/** What the store needs from SQLite: the shape of a Durable Object's `ctx.storage.sql`. */
export interface SqlDatabase {
  exec(query: string, ...bindings: SqlValue[]): { toArray(): Record<string, SqlValue>[] };
  /** Runs `body` as one transaction: all of its writes happen, or none do. */
  transaction<T>(body: () => T): T;
}

/** Content is stored in pieces of this size, well under SQLite's 2 MB limit on a row. */
export const CHUNK_BYTES = 512 * 1024;

/**
 * The shape of a room's storage that this code reads and writes: these tables, and what the room
 * keeps in them (the working files, the engine's local state, the mirror's state). 1 is the shape
 * rooms have kept since step 2.4, including those from before it was recorded. A release that
 * changes the shape raises this and moves older rooms forward when it opens them.
 */
export const ROOM_STORAGE = 1;

/** A table every version keeps, holding the storage version under the key `storage`. */
const META = 'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)';

const SCHEMA = [
  // data may be NULL: some SQLite bindings store an empty blob that way.
  'CREATE TABLE IF NOT EXISTS files (path TEXT NOT NULL, n INTEGER NOT NULL, data BLOB, PRIMARY KEY (path, n))',
  'CREATE TABLE IF NOT EXISTS blobs (id TEXT NOT NULL, n INTEGER NOT NULL, data BLOB, PRIMARY KEY (id, n))',
  `CREATE TABLE IF NOT EXISTS commits (
    seq INTEGER PRIMARY KEY,
    oid TEXT NOT NULL UNIQUE,
    parent TEXT,
    tree TEXT NOT NULL,
    message TEXT NOT NULL,
    author TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    timezone INTEGER NOT NULL,
    files TEXT NOT NULL
  )`,
  // Commits listed on GitHub and waiting to be imported, newest first (mirror.ts).
  `CREATE TABLE IF NOT EXISTS import_queue (
    pos INTEGER PRIMARY KEY,
    oid TEXT NOT NULL UNIQUE,
    parent TEXT,
    tree TEXT NOT NULL,
    message TEXT NOT NULL,
    author TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  )`,
];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A commit with everything Git hashed to name it, plus its files as path → blob ID. */
export interface CommitDetail {
  oid: string;
  parent?: string;
  tree: string;
  /** The message exactly as Git keeps it, ending in one newline. */
  message: string;
  author: Person;
  /** Seconds since 1970. */
  timestamp: number;
  /** Minutes behind UTC, as Date#getTimezoneOffset counts. */
  timezone: number;
  files: Map<string, string>;
}

/** A commit listed on GitHub, waiting in the import queue. */
export interface QueuedCommit {
  oid: string;
  parent?: string;
  tree: string;
  message: string;
  author: Person;
  timestamp: number;
}

interface StoredCommit extends CommitRecord {
  detail: CommitDetail;
}

export class DurableStore implements NotebookStore {
  /** Commits already read, by ID. History never changes, so they never go stale. */
  private cache = new Map<string, StoredCommit>();

  constructor(
    private readonly sql: SqlDatabase,
    /** Who commits are made as, until the notebook records someone itself. */
    private readonly fallbackPerson: Person,
  ) {
    // The version is checked before anything else is written, so an older Quillipi changes nothing in a newer room.
    sql.exec(META);
    claimStorage(sql, 'meta', ROOM_STORAGE, 'This notebook');
    for (const statement of SCHEMA) sql.exec(statement);
  }

  // Working files -------------------------------------------------------------

  async read(rel: string): Promise<string | undefined> {
    const bytes = await this.readBytes(rel);
    return bytes && decoder.decode(bytes);
  }

  async readBytes(rel: string): Promise<Uint8Array | undefined> {
    const rows = this.sql.exec('SELECT data FROM files WHERE path = ? ORDER BY n', checkPath(rel)).toArray();
    return rows.length ? join(rows.map((row) => row.data)) : undefined;
  }

  async write(rel: string, content: string | Uint8Array): Promise<void> {
    checkPath(rel);
    const bytes = toBytes(content);
    this.sql.transaction(() => {
      this.sql.exec('DELETE FROM files WHERE path = ?', rel);
      chunks(bytes).forEach((piece, n) => this.sql.exec('INSERT INTO files (path, n, data) VALUES (?, ?, ?)', rel, n, piece));
    });
  }

  async append(rel: string, text: string): Promise<void> {
    checkPath(rel);
    // A new chunk for each addition, so a growing log is never rewritten.
    this.sql.transaction(() => {
      const next = Number(this.sql.exec('SELECT COALESCE(MAX(n) + 1, 0) AS next FROM files WHERE path = ?', rel).toArray()[0]!.next);
      chunks(encoder.encode(text)).forEach((piece, i) => this.sql.exec('INSERT INTO files (path, n, data) VALUES (?, ?, ?)', rel, next + i, piece));
    });
  }

  async remove(rel: string): Promise<void> {
    this.sql.exec('DELETE FROM files WHERE path = ?', checkPath(rel));
  }

  async list(relDir: string, extension: string): Promise<string[]> {
    const prefix = `${checkPath(relDir)}/`;
    // substr rather than LIKE, so "_" and "%" in names are plain characters.
    const rows = this.sql.exec('SELECT DISTINCT path FROM files WHERE substr(path, 1, ?) = ? ORDER BY path', prefix.length, prefix).toArray();
    return rows.map((row) => String(row.path)).filter((rel) => rel.endsWith(extension));
  }

  // History -------------------------------------------------------------------

  async person(): Promise<Person> {
    const saved = this.getMeta('person');
    return saved ? (JSON.parse(saved) as Person) : { ...this.fallbackPerson };
  }

  /** Records who commits are made as, such as the person who signed in. */
  setPerson(person: Person): void {
    this.setMeta('person', JSON.stringify(person));
  }

  async head(): Promise<string | undefined> {
    const rows = this.sql.exec('SELECT oid FROM commits ORDER BY seq DESC LIMIT 1').toArray();
    return rows[0] ? String(rows[0].oid) : undefined;
  }

  async log(limit = 1000): Promise<CommitRecord[]> {
    const records: CommitRecord[] = [];
    for (let oid = await this.head(); oid && records.length < limit; oid = this.stored(oid)?.parent) {
      const { detail: _detail, ...record } = this.stored(oid)!;
      records.push(record);
    }
    return records;
  }

  async filesAt(commit: string): Promise<Map<string, string>> {
    const stored = this.stored(commit);
    if (!stored) throw new Error(`No commit ${commit}.`);
    return new Map(stored.detail.files);
  }

  async readAt(commit: string, rel: string): Promise<string | undefined> {
    const id = this.stored(commit)?.detail.files.get(rel);
    const bytes = id === undefined ? undefined : this.readBlob(id);
    return bytes && decoder.decode(bytes);
  }

  async commit(changes: FileChanges, message: string, author: Person): Promise<string> {
    const parent = await this.head();
    const files = new Map(parent ? this.stored(parent)!.detail.files : []);
    const newBlobs = new Map<string, Uint8Array>();
    for (const [rel, content] of changes) {
      checkPath(rel);
      if (content === null) {
        files.delete(rel);
        continue;
      }
      const bytes = toBytes(content);
      const id = await blobId(bytes);
      newBlobs.set(id, bytes);
      files.set(rel, id);
    }
    // Git counts whole seconds and records the time zone; in a Worker that is always UTC.
    const timestamp = Math.floor(Date.now() / 1000);
    const timezone = new Date(timestamp * 1000).getTimezoneOffset();
    const tree = await treeId(files);
    const oid = await commitId({ tree, parents: parent ? [parent] : [], author, timestamp, timezoneOffset: timezone, message });

    // Everything is computed; now write it all at once.
    this.sql.transaction(() => {
      for (const [id, bytes] of newBlobs) this.insertBlob(id, bytes);
      this.sql.exec(
        'INSERT INTO commits (oid, parent, tree, message, author, timestamp, timezone, files) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        oid,
        parent ?? null,
        tree,
        commitMessage(message),
        JSON.stringify({ name: author.name, email: author.email }),
        timestamp,
        timezone,
        JSON.stringify([...files]),
      );
    });
    return oid;
  }

  // Mirror support (mirror.ts) ---------------------------------------------

  getMeta(key: string): string | undefined {
    const row = this.sql.exec('SELECT value FROM meta WHERE key = ?', key).toArray()[0];
    return row ? String(row.value) : undefined;
  }

  /** Sets a value, or removes it when `value` is undefined. */
  setMeta(key: string, value: string | undefined): void {
    if (value === undefined) this.sql.exec('DELETE FROM meta WHERE key = ?', key);
    else this.sql.exec('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value);
  }

  commitDetail(oid: string): CommitDetail | undefined {
    return this.stored(oid)?.detail;
  }

  commitCount(): number {
    return Number(this.sql.exec('SELECT COUNT(*) AS n FROM commits').toArray()[0]!.n);
  }

  /** The commits after `oid` up to the latest, oldest first; every commit when `oid` is undefined. */
  commitsSince(oid: string | undefined): string[] {
    const after: string[] = [];
    let at = this.sql.exec('SELECT oid FROM commits ORDER BY seq DESC LIMIT 1').toArray()[0]?.oid as string | undefined;
    for (; at !== oid; at = this.stored(at)!.parent) {
      if (at === undefined) throw new Error(`Commit ${oid} is not in this notebook's history.`);
      after.push(at);
    }
    return after.reverse();
  }

  readBlob(id: string): Uint8Array | undefined {
    const rows = this.sql.exec('SELECT data FROM blobs WHERE id = ? ORDER BY n', id).toArray();
    return rows.length ? join(rows.map((row) => row.data)) : undefined;
  }

  hasBlob(id: string): boolean {
    return this.sql.exec('SELECT 1 FROM blobs WHERE id = ? LIMIT 1', id).toArray().length > 0;
  }

  /** Keeps a file's content under its Git blob ID, which the caller has checked. */
  putBlob(id: string, bytes: Uint8Array): void {
    this.sql.transaction(() => this.insertBlob(id, bytes));
  }

  /** Adds commits to the import queue, newest first, as they come from GitHub. */
  queueImport(commits: readonly QueuedCommit[]): void {
    this.sql.transaction(() => {
      for (const commit of commits) {
        this.sql.exec(
          'INSERT INTO import_queue (oid, parent, tree, message, author, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
          commit.oid,
          commit.parent ?? null,
          commit.tree,
          commit.message,
          JSON.stringify(commit.author),
          commit.timestamp,
        );
      }
    });
  }

  /** The oldest queued commit: the next to import. */
  nextImport(): QueuedCommit | undefined {
    const row = this.sql.exec('SELECT * FROM import_queue ORDER BY pos DESC LIMIT 1').toArray()[0];
    if (!row) return undefined;
    return {
      oid: String(row.oid),
      ...(row.parent ? { parent: String(row.parent) } : {}),
      tree: String(row.tree),
      message: String(row.message),
      author: JSON.parse(String(row.author)) as Person,
      timestamp: Number(row.timestamp),
    };
  }

  importQueueSize(): number {
    return Number(this.sql.exec('SELECT COUNT(*) AS n FROM import_queue').toArray()[0]!.n);
  }

  /**
   * Records a queued commit under GitHub's own ID, with its files as path → blob ID, and takes it
   * off the queue, in one transaction. Its parent must be the latest commit and its blobs stored.
   */
  importCommit(commit: QueuedCommit, files: ReadonlyMap<string, string>): void {
    const head = this.sql.exec('SELECT oid FROM commits ORDER BY seq DESC LIMIT 1').toArray()[0]?.oid;
    if ((head ?? undefined) !== commit.parent) throw new Error(`Commit ${commit.oid} doesn't follow the latest commit.`);
    for (const id of new Set(files.values())) if (!this.hasBlob(id)) throw new Error(`Commit ${commit.oid} needs blob ${id}, which isn't stored.`);
    this.sql.transaction(() => {
      this.sql.exec(
        'INSERT INTO commits (oid, parent, tree, message, author, timestamp, timezone, files) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        commit.oid,
        commit.parent ?? null,
        commit.tree,
        commit.message,
        JSON.stringify(commit.author),
        commit.timestamp,
        0, // GitHub's API gives times in UTC, without the author's own time zone
        JSON.stringify([...files]),
      );
      this.sql.exec('DELETE FROM import_queue WHERE oid = ?', commit.oid);
    });
  }

  /** Makes the working files exactly a commit's files. Local state in .inklog/ stays. */
  checkout(oid: string): void {
    const commit = this.stored(oid);
    if (!commit) throw new Error(`No commit ${oid}.`);
    const local = `${LAYOUT.local}/`;
    this.sql.transaction(() => {
      this.sql.exec('DELETE FROM files WHERE substr(path, 1, ?) != ?', local.length, local);
      for (const [rel, id] of commit.detail.files) {
        this.sql.exec('INSERT INTO files (path, n, data) SELECT ?, n, data FROM blobs WHERE id = ?', rel, id);
      }
    });
  }

  // Inside ----------------------------------------------------------------------

  /** A commit by ID, read once and then kept. */
  private stored(oid: string): StoredCommit | undefined {
    const cached = this.cache.get(oid);
    if (cached) return cached;
    const row = this.sql.exec('SELECT * FROM commits WHERE oid = ?', oid).toArray()[0];
    if (!row) return undefined;
    const detail: CommitDetail = {
      oid,
      ...(row.parent ? { parent: String(row.parent) } : {}),
      tree: String(row.tree),
      message: String(row.message),
      author: JSON.parse(String(row.author)) as Person,
      timestamp: Number(row.timestamp),
      timezone: Number(row.timezone),
      files: new Map(JSON.parse(String(row.files)) as [string, string][]),
    };
    const commit: StoredCommit = {
      oid,
      message: detail.message.trimEnd(),
      author: detail.author.name,
      at: detail.timestamp * 1000,
      ...(detail.parent ? { parent: detail.parent } : {}),
      detail,
    };
    this.cache.set(oid, commit);
    return commit;
  }

  private insertBlob(id: string, bytes: Uint8Array): void {
    if (this.hasBlob(id)) return;
    chunks(bytes).forEach((piece, n) => this.sql.exec('INSERT INTO blobs (id, n, data) VALUES (?, ?, ?)', id, n, piece));
  }
}

function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? encoder.encode(content) : new Uint8Array(content);
}

/** Splits content into pieces for storage. Empty content is one empty piece, so the file exists. */
function chunks(bytes: Uint8Array): ArrayBuffer[] {
  const pieces: ArrayBuffer[] = [];
  for (let at = 0; at < bytes.length || pieces.length === 0; at += CHUNK_BYTES) {
    pieces.push(bytes.slice(at, at + CHUNK_BYTES).buffer);
  }
  return pieces;
}

function join(values: SqlValue[]): Uint8Array {
  const parts = values.map((value) =>
    value instanceof ArrayBuffer ? new Uint8Array(value) : value instanceof Uint8Array ? value : value === null ? new Uint8Array() : encoder.encode(String(value)),
  );
  const whole = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let at = 0;
  for (const part of parts) {
    whole.set(part, at);
    at += part.length;
  }
  return whole;
}

/** A database written by a newer Quillipi than this one. */
export class StorageTooNew extends Error {}

/**
 * Records that this code's storage `version` now writes a database, after checking that no newer
 * Quillipi wrote it. `table` is the database's own (key, value) table, which every version keeps, and
 * the version is kept there under the key `storage`. A database written by a newer Quillipi is refused
 * and left as it is: a Quillipi going back to an older release can never damage what the newer one
 * wrote. No recorded version means version 1, the shape kept before versions were recorded; a
 * release that raises the version moves older databases forward here.
 */
export function claimStorage(sql: SqlDatabase, table: 'meta' | 'settings', version: number, what: string): void {
  const saved = sql.exec(`SELECT value FROM ${table} WHERE key = 'storage'`).toArray()[0]?.value;
  const found = saved === undefined ? 1 : Number(saved);
  if (!Number.isInteger(found) || found < 1) throw new StorageTooNew(`${what} has a storage version Quillipi can't read ("${String(saved)}"). Nothing was changed.`);
  if (found > version) {
    throw new StorageTooNew(`${what} was saved by a newer Quillipi (storage version ${found}; this one reads up to ${version}). Update this Quillipi to its newest release; nothing was changed.`);
  }
  if (saved === undefined) sql.exec(`INSERT INTO ${table} (key, value) VALUES ('storage', ?)`, String(version));
}

/** A Durable Object's own SQLite database, as the stores here use it. */
export function durableSql(storage: DurableObjectStorage): SqlDatabase {
  return {
    exec: (query, ...bindings) => storage.sql.exec(query, ...bindings),
    transaction: (body) => storage.transactionSync(body),
  };
}
