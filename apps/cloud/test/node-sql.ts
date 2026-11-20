/** A SqlDatabase on Node's built-in SQLite, so the cloud store can be tested without Cloudflare. */
import { DatabaseSync } from 'node:sqlite';
import type { SqlDatabase, SqlValue } from '../src/durable-store.js';

export function nodeSql(db = new DatabaseSync(':memory:')): SqlDatabase & { db: DatabaseSync } {
  return {
    db,
    exec(query: string, ...bindings: SqlValue[]) {
      // Durable Objects take and return blobs as ArrayBuffers; node:sqlite uses Uint8Arrays.
      const rows = db.prepare(query).all(...bindings.map((value) => (value instanceof ArrayBuffer ? new Uint8Array(value) : value)));
      const asDurable = rows.map((row) =>
        Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Uint8Array ? value.slice().buffer : value])),
      ) as Record<string, SqlValue>[];
      return { toArray: () => asDurable };
    },
    transaction<T>(body: () => T): T {
      db.exec('BEGIN');
      try {
        const result = body();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
