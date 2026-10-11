import { createRequire } from "node:module";

export interface SqlStatement {
  run(...params: unknown[]): { changes: number };
  get<T = Record<string, unknown>>(...params: unknown[]): T | undefined;
  all<T = Record<string, unknown>>(...params: unknown[]): T[];
}

export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
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
 * Prefer better-sqlite3 (CI is Node 20). Fall back to `node:sqlite` on Node 22+
 * if the native module is unavailable.
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
    } catch {
      // :memory:
    }
    return wrap(db);
  } catch {
    // native module missing — try node:sqlite
  }
  const nodeSqlite = req("node:sqlite") as {
    DatabaseSync?: new (filename: string) => RawDb;
  };
  if (!nodeSqlite.DatabaseSync) {
    throw new Error("no SQLite backend: install better-sqlite3 or use Node 22+");
  }
  return wrap(new nodeSqlite.DatabaseSync(path));
}

function wrap(db: RawDb): SqlDatabase {
  return {
    exec: (sql) => db.exec(sql),
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        run: (...params) => ({ changes: Number(stmt.run(...params).changes) }),
        get: <T>(...params: unknown[]) => stmt.get(...params) as T | undefined,
        all: <T>(...params: unknown[]) => stmt.all(...params) as T[],
      };
    },
    close: () => db.close(),
  };
}
