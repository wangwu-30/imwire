import { createRequire } from "node:module";

export interface SqlStatement<T = Record<string, unknown>> {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): T | undefined;
  all(...params: unknown[]): T[];
}

export interface SqlDatabase {
  exec(sql: string): void;
  prepare<T = Record<string, unknown>>(sql: string): SqlStatement<T>;
  transaction<T>(fn: () => T): T;
  close(): void;
}

type RawDb = {
  exec(sql: string): void;
  prepare(sql: string): {
    run: (...params: unknown[]) => { changes: number | bigint };
    get: (...params: unknown[]) => unknown;
    all: (...params: unknown[]) => unknown[];
  };
  close(): void;
};

/**
 * Prefer better-sqlite3 (CI includes a compiler). Fall back to `node:sqlite`
 * on Node 22+. Both paths set WAL + busy_timeout.
 */
export function openSqlite(path: string): SqlDatabase {
  const req = createRequire(import.meta.url);
  try {
    const Database = req("better-sqlite3") as (new (filename: string) => RawDb & {
      pragma(src: string): unknown;
    });
    const db = new Database(path);
    try {
      db.pragma("journal_mode = WAL");
      db.pragma("busy_timeout = 5000");
      db.pragma("foreign_keys = ON");
    } catch {
      // :memory:
    }
    return wrap(db);
  } catch (nativeErr) {
    let nodeSqlite: { DatabaseSync?: new (filename: string) => RawDb };
    try {
      nodeSqlite = req("node:sqlite") as { DatabaseSync?: new (filename: string) => RawDb };
    } catch (builtinErr) {
      throw new Error(
        `SQLite unavailable. Install better-sqlite3 (needs a compiler on Node 20) or use Node 22+ (node:sqlite). native=${String(nativeErr)} builtin=${String(builtinErr)}`,
      );
    }
    if (!nodeSqlite.DatabaseSync) {
      throw new Error(
        `SQLite unavailable. Install better-sqlite3 (needs a compiler on Node 20) or use Node 22+. native=${String(nativeErr)}`,
      );
    }
    const db = new nodeSqlite.DatabaseSync(path);
    const wrapped = wrap(db);
    try {
      wrapped.exec("PRAGMA journal_mode = WAL");
      wrapped.exec("PRAGMA busy_timeout = 5000");
      wrapped.exec("PRAGMA foreign_keys = ON");
    } catch {
      // :memory:
    }
    return wrapped;
  }
}

function wrap(db: RawDb): SqlDatabase {
  return {
    exec: (sql) => db.exec(sql),
    prepare<T = Record<string, unknown>>(sql: string): SqlStatement<T> {
      const stmt = db.prepare(sql);
      return {
        run: (...params) => ({ changes: Number(stmt.run(...params).changes) }),
        get: (...params) => stmt.get(...params) as T | undefined,
        all: (...params) => stmt.all(...params) as T[],
      };
    },
    transaction<T>(fn: () => T): T {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // already closed / no txn
        }
        throw err;
      }
    },
    close: () => db.close(),
  };
}
