import { constants } from "node:fs";
import { access } from "node:fs/promises";

/**
 * Token collectors read hundreds of megabytes with synchronous work per file and
 * per SQLite page, so the driver is loaded lazily and a missing module surfaces as
 * `SqliteUnavailableError` rather than a crash.
 */
export type SqliteValue = number | string | null | bigint;

export interface SqliteRow {
  [column: string]: SqliteValue | undefined;
}

export interface SqliteStatement {
  all(...params: SqliteValue[]): SqliteRow[];
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface SqliteWritableStatement {
  run(...params: SqliteValue[]): void;
  all(...params: SqliteValue[]): SqliteRow[];
  get(...params: SqliteValue[]): SqliteRow | undefined;
}

/** 可写连接：清理旧会话时需要删除行并 VACUUM，只读连接做不到。 */
export interface SqliteWritableDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteWritableStatement;
  close(): void;
}

export class SqliteUnavailableError extends Error {
  constructor(reason: string) {
    super(`node:sqlite unavailable: ${reason}`);
    this.name = "SqliteUnavailableError";
  }
}

export class SqliteMissingError extends Error {
  constructor(filePath: string) {
    super(`database not found: ${filePath}`);
    this.name = "SqliteMissingError";
  }
}

export function readNumber(value: SqliteValue | undefined): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function readString(value: SqliteValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Opens an existing database without ever writing to it. */
export async function openSqliteReadonly(filePath: string): Promise<SqliteDatabase> {
  await access(filePath, constants.R_OK).catch(() => {
    throw new SqliteMissingError(filePath);
  });
  const module = await loadSqliteModule();

  let handle: SqliteDatabaseHandle;
  try {
    handle = new module.DatabaseSync(filePath, { readOnly: true });
  } catch (error) {
    throw new SqliteUnavailableError(error instanceof Error ? error.message : String(error));
  }

  return {
    prepare(sql: string): SqliteStatement {
      const statement = handle.prepare(sql);
      return {
        all(...params: SqliteValue[]): SqliteRow[] {
          return statement.all(...params) as SqliteRow[];
        },
      };
    },
    close(): void {
      handle.close();
    },
  };
}

/**
 * Opens a database for writing. Deletes and VACUUM run inside the plugin process,
 * so the busy timeout matters: without it a database held by a running agent CLI
 * would fail immediately with SQLITE_BUSY instead of waiting its turn.
 */
export async function openSqliteWritable(filePath: string): Promise<SqliteWritableDatabase> {
  await access(filePath, constants.R_OK | constants.W_OK).catch(() => {
    throw new SqliteMissingError(filePath);
  });
  const module = await loadSqliteModule();

  let handle: SqliteDatabaseHandle;
  try {
    handle = new module.DatabaseSync(filePath);
  } catch (error) {
    throw new SqliteUnavailableError(error instanceof Error ? error.message : String(error));
  }
  handle.exec("pragma busy_timeout = 5000");
  // 外键级联（OpenCode 删除 session_v2 时联动删除 session_message 等）需要显式打开。
  handle.exec("pragma foreign_keys = on");

  return {
    exec(sql: string): void {
      handle.exec(sql);
    },
    prepare(sql: string): SqliteWritableStatement {
      const statement = handle.prepare(sql);
      return {
        run(...params: SqliteValue[]): void {
          statement.run(...params);
        },
        all(...params: SqliteValue[]): SqliteRow[] {
          return statement.all(...params) as SqliteRow[];
        },
        get(...params: SqliteValue[]): SqliteRow | undefined {
          return statement.get(...params) as SqliteRow | undefined;
        },
      };
    },
    close(): void {
      handle.close();
    },
  };
}

async function loadSqliteModule(): Promise<SqliteModule> {
  // Held in a variable so TypeScript skips module resolution: @types/node@20 has no
  // node:sqlite typings yet, while the daemon runtime (Node 22+) provides it.
  const sqliteSpecifier: string = "node:sqlite";
  try {
    return (await import(sqliteSpecifier)) as unknown as SqliteModule;
  } catch (error) {
    throw new SqliteUnavailableError(error instanceof Error ? error.message : String(error));
  }
}

interface SqliteStatementHandle {
  all(...params: SqliteValue[]): unknown[];
  run(...params: SqliteValue[]): unknown;
  get(...params: SqliteValue[]): unknown;
}

interface SqliteDatabaseHandle {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatementHandle;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabaseHandle;
}
