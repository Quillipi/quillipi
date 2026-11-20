import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { KARAN, testNotebookStore } from '../../../packages/engine/test/store-contract.js';
import { CHUNK_BYTES, DurableStore, ROOM_STORAGE, StorageTooNew } from '../src/durable-store.js';
import { nodeSql } from './node-sql.js';

testNotebookStore('Durable Object SQLite', async () => new DurableStore(nodeSql(), KARAN));

describe('the Durable Object store', () => {
  it('keeps files bigger than a SQLite row, in pieces', async () => {
    const store = new DurableStore(nodeSql(), KARAN);
    const big = new Uint8Array(CHUNK_BYTES * 2 + 123).map((_, i) => i % 251);
    await store.write('assets/big.png', big);
    const same = (a?: Uint8Array) => a !== undefined && Buffer.from(a).equals(Buffer.from(big));
    expect(same(await store.readBytes('assets/big.png'))).toBe(true);
    const oid = await store.commit(new Map([['assets/big.png', big]]), 'Add a big image', KARAN);
    expect((await store.filesAt(oid)).has('assets/big.png')).toBe(true);
    expect(store.readBlob((await store.filesAt(oid)).get('assets/big.png')!)?.length).toBe(big.length);
    await store.write('assets/big.png', 'small now');
    expect(await store.read('assets/big.png')).toBe('small now');
    await store.write('empty.md', '');
    expect(await store.read('empty.md')).toBe('');
  });

  it('keeps everything when the object restarts', async () => {
    const sql = nodeSql();
    const before = new DurableStore(sql, KARAN);
    await before.write('sections/a.md', 'working text');
    await before.append('.inklog/calls/2026-11.jsonl', 'one\n');
    await before.append('.inklog/calls/2026-11.jsonl', 'two\n');
    const oid = await before.commit(new Map([['sections/a.md', 'committed text']]), 'First', KARAN);
    before.setPerson({ name: 'Karan B', email: 'karan@example.com' });

    const after = new DurableStore(sql, KARAN);
    expect(await after.head()).toBe(oid);
    expect(await after.read('sections/a.md')).toBe('working text');
    expect(await after.readAt(oid, 'sections/a.md')).toBe('committed text');
    expect(await after.read('.inklog/calls/2026-11.jsonl')).toBe('one\ntwo\n');
    expect(await after.person()).toEqual({ name: 'Karan B', email: 'karan@example.com' });
  });

  it('writes a commit completely or not at all', async () => {
    const sql = nodeSql();
    const store = new DurableStore(sql, KARAN);
    await store.commit(new Map([['a.md', 'one']]), 'First', KARAN);
    sql.db.exec('CREATE TRIGGER refuse BEFORE INSERT ON commits BEGIN SELECT RAISE(ABORT, "disk full"); END');
    await expect(store.commit(new Map([['b.md', 'two']]), 'Second', KARAN)).rejects.toThrow('disk full');
    // The blob written for b.md was rolled back with the commit.
    expect(sql.exec('SELECT COUNT(*) AS n FROM blobs').toArray()[0]!.n).toBe(1);
    expect((await store.log()).map((commit) => commit.message)).toEqual(['First']);
  });
});

describe('what the GitHub mirror needs from the store', () => {
  const queued = (oid: string, parent: string | undefined, tree: string) => ({ oid, ...(parent ? { parent } : {}), tree, message: `Commit ${oid.slice(0, 2)}\n`, author: KARAN, timestamp: 1_793_900_000 });

  it('keeps each message exactly as Git hashed it, and shows it trimmed', async () => {
    const store = new DurableStore(nodeSql(), KARAN);
    const oid = await store.commit(new Map([['a.md', 'one']]), '\n\nTitle  \r\n\r\nBody \n\n', KARAN);
    expect(store.commitDetail(oid)).toMatchObject({ message: 'Title  \n\nBody \n', author: KARAN, timezone: new Date().getTimezoneOffset() });
    expect((await store.log())[0]!.message).toBe('Title  \n\nBody');
  });

  it('imports queued commits oldest first under their own IDs, each with its blobs, all or nothing', async () => {
    const sql = nodeSql();
    const store = new DurableStore(sql, KARAN);
    const one = blob('one');
    const two = blob('two');
    store.queueImport([queued('b'.repeat(40), 'a'.repeat(40), 'tree-2'), queued('a'.repeat(40), undefined, 'tree-1')]);
    expect(store.importQueueSize()).toBe(2);
    const first = store.nextImport()!;
    expect(first.oid).toBe('a'.repeat(40));
    expect(() => store.importCommit(first, new Map([['a.md', one.id]]))).toThrow('needs blob');
    store.putBlob(one.id, one.bytes);
    expect(() => store.importCommit(store.nextImport()!, new Map([['a.md', one.id]]))).not.toThrow();
    const second = store.nextImport()!;
    expect(() => store.importCommit({ ...second, parent: 'c'.repeat(40) }, new Map())).toThrow("doesn't follow the latest commit");
    store.putBlob(two.id, two.bytes);
    store.importCommit(second, new Map([['a.md', one.id], ['dir/b.md', two.id]]));

    expect(store.importQueueSize()).toBe(0);
    expect(await store.head()).toBe('b'.repeat(40));
    expect((await store.log()).map((commit) => [commit.oid, commit.message, commit.parent])).toEqual([
      ['b'.repeat(40), 'Commit bb', 'a'.repeat(40)],
      ['a'.repeat(40), 'Commit aa', undefined],
    ]);
    expect(await store.readAt('b'.repeat(40), 'dir/b.md')).toBe('two');
    expect(store.commitsSince('a'.repeat(40))).toEqual(['b'.repeat(40)]);
    expect(() => store.commitsSince('d'.repeat(40))).toThrow('not in this notebook');
    expect(store.commitCount()).toBe(2);
  });

  it('checks out a commit as the working files, keeping local state', async () => {
    const store = new DurableStore(nodeSql(), KARAN);
    const big = new Uint8Array(CHUNK_BYTES + 10).map((_, i) => i % 256);
    const oid = await store.commit(new Map<string, Uint8Array | string>([['sections/a.md', 'committed'], ['assets/big.png', big]]), 'First', KARAN);
    await store.write('sections/a.md', 'edited');
    await store.write('stray.md', 'not in the commit');
    await store.append('.inklog/calls/2026-11.jsonl', 'kept\n');
    store.checkout(oid);
    expect(await store.read('sections/a.md')).toBe('committed');
    expect(await store.read('stray.md')).toBeUndefined();
    expect(Buffer.from((await store.readBytes('assets/big.png'))!).equals(Buffer.from(big))).toBe(true);
    expect(await store.read('.inklog/calls/2026-11.jsonl')).toBe('kept\n');
  });
});

describe("a room's storage version", () => {
  const version = (sql: ReturnType<typeof nodeSql>) => sql.exec("SELECT value FROM meta WHERE key = 'storage'").toArray()[0]?.value;
  const tables = (sql: ReturnType<typeof nodeSql>) => sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").toArray().map((row) => row.name);

  it('is recorded in a new room, and in a room from before versions were recorded, which is version 1', async () => {
    const fresh = nodeSql();
    new DurableStore(fresh, KARAN);
    expect(version(fresh)).toBe(String(ROOM_STORAGE));
    // A room as step 2.4 to S2 left it: the same tables, no version.
    const older = nodeSql();
    const store = new DurableStore(older, KARAN);
    const oid = await store.commit(new Map([['sections/a.md', 'text']]), 'First', KARAN);
    older.exec("DELETE FROM meta WHERE key = 'storage'");
    const reopened = new DurableStore(older, KARAN);
    expect(await reopened.head()).toBe(oid);
    expect(version(older)).toBe('1');
  });

  it('is refused when a newer Quillipi wrote the room, which is left exactly as it was', () => {
    const sql = nodeSql();
    new DurableStore(sql, KARAN);
    sql.exec("UPDATE meta SET value = '2' WHERE key = 'storage'");
    sql.exec('DROP TABLE import_queue'); // as a newer shape might have
    expect(() => new DurableStore(sql, KARAN)).toThrow(StorageTooNew);
    expect(() => new DurableStore(sql, KARAN)).toThrow('This notebook was saved by a newer Quillipi (storage version 2; this one reads up to 1). Update this Quillipi to its newest release; nothing was changed.');
    expect(version(sql)).toBe('2');
    expect(tables(sql)).not.toContain('import_queue');
    sql.exec("UPDATE meta SET value = 'two' WHERE key = 'storage'");
    expect(() => new DurableStore(sql, KARAN)).toThrow('This notebook has a storage version Quillipi can\'t read ("two"). Nothing was changed.');
  });
});

function blob(text: string): { id: string; bytes: Uint8Array } {
  const bytes = new TextEncoder().encode(text);
  return { id: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), bytes };
}
