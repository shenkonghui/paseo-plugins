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

  // Held in a variable so TypeScript skips module resolution: @types/node@20 has no
  // node:sqlite typings yet, while the daemon runtime (Node 22+) provides it.
  const sqliteSpecifier: string = "node:sqlite";
  let module: SqliteModule;
  try {
    module = (await import(sqliteSpecifier)) as unknown as SqliteModule;
  } catch (error) {
    throw new SqliteUnavailableError(error instanceof Error ? error.message : String(error));
  }

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

interface SqliteDatabaseHandle {
  prepare(sql: string): { all(...params: SqliteValue[]): unknown[] };
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabaseHandle;
}
