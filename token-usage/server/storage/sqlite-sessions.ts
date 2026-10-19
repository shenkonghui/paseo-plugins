import path from "node:path";
import type { TokenUsageAgentId, TokenUsageLogger } from "../types.js";
import {
  openSqliteReadonly,
  openSqliteWritable,
  readNumber,
  type SqliteRow,
  type SqliteValue,
  type SqliteWritableDatabase,
} from "../sqlite.js";
import type {
  AgentCleanupResult,
  AgentDiskUsage,
  StorageContext,
  TokenUsageStorageTarget,
} from "./types.js";
import { directorySize, fileBytes, pathExists, resolveXdgDataHome } from "./shared.js";
import { unavailable, errorUsage, messageOf } from "./file-sessions.js";

interface CountableDatabase {
  prepare(sql: string): { all(...params: SqliteValue[]): SqliteRow[] };
}

function countSessions(db: CountableDatabase, sql: string, params: SqliteValue[]): number {
  return readNumber(db.prepare(sql).all(...params)[0]?.c) ?? 0;
}

function tableNames(db: CountableDatabase): Set<string> {
  const names = new Set<string>();
  for (const row of db.prepare("select name from sqlite_master where type = 'table'").all()) {
    if (typeof row.name === "string") {
      names.add(row.name);
    }
  }
  return names;
}

/** 库文件 + WAL/SHM 边车文件的总大小。 */
async function databaseBytes(dbPath: string): Promise<number> {
  return (
    (await fileBytes(dbPath)) +
    (await fileBytes(`${dbPath}-wal`)) +
    (await fileBytes(`${dbPath}-shm`))
  );
}

/**
 * 删除后的空间要 VACUUM 才会真正归还文件；VACUUM 失败时删除仍然生效，只是空间未回收。
 * 返回错误文案（成功为 null）。
 */
async function vacuum(db: SqliteWritableDatabase, logger: TokenUsageLogger): Promise<string | null> {
  try {
    db.exec("pragma wal_checkpoint(truncate)");
    db.exec("vacuum");
    db.exec("pragma wal_checkpoint(truncate)");
    return null;
  } catch (error) {
    logger.debug({ err: error }, "SQLite VACUUM failed after session cleanup");
    return `会话已删除，但 VACUUM 失败、空间尚未回收：${messageOf(error)}`;
  }
}

/** 按会话数比例估算可回收字节；数据库型 agent 无法廉价地逐会话精确统计。 */
function estimateBytes(dbBytes: number, staleSessions: number, totalSessions: number): number {
  if (totalSessions <= 0 || staleSessions <= 0) {
    return 0;
  }
  return Math.round((dbBytes * staleSessions) / totalSessions);
}

/**
 * OpenCode 把所有消息放在一个 SQLite 库里。删除 `session_v2` 会按外键级联清掉
 * `session_message` / `session_pending` / `session_inbox` / `instruction_state`。
 */
export class OpencodeStorage implements TokenUsageStorageTarget {
  readonly agentId: TokenUsageAgentId = "opencode";
  readonly displayName = "OpenCode";

  private rootDir(homeDir: string): string {
    return path.join(resolveXdgDataHome(homeDir), "opencode");
  }

  private databasePath(homeDir: string): string {
    return path.join(this.rootDir(homeDir), "opencode.db");
  }

  async measure(context: StorageContext): Promise<AgentDiskUsage> {
    const root = this.rootDir(context.homeDir);
    const dbPath = this.databasePath(context.homeDir);
    if (!(await pathExists(dbPath))) {
      return unavailable(this.agentId, this.displayName, root);
    }
    try {
      const totalBytes = await directorySize(root, context.gate);
      const db = await openSqliteReadonly(dbPath);
      let total = 0;
      let stale = 0;
      try {
        total = countSessions(db, "select count(*) as c from session_v2", []);
        stale = countSessions(db, "select count(*) as c from session_v2 where time_updated < ?", [
          context.staleCutoffMs,
        ]);
      } finally {
        db.close();
      }
      const dbBytes = await databaseBytes(dbPath);
      return {
        agentId: this.agentId,
        displayName: this.displayName,
        status: "available",
        error: null,
        totalBytes,
        paths: [root],
        sessionCount: total,
        sessionBytes: dbBytes,
        staleSessionCount: stale,
        staleSessionBytes: estimateBytes(dbBytes, stale, total),
      };
    } catch (error) {
      return errorUsage(this.agentId, this.displayName, context.logger, error, [root]);
    }
  }

  async cleanup(context: StorageContext): Promise<AgentCleanupResult> {
    const dbPath = this.databasePath(context.homeDir);
    if (!(await pathExists(dbPath))) {
      return failure(this.agentId, this.displayName, `未找到数据库 ${dbPath}`);
    }
    const before = await databaseBytes(dbPath);
    try {
      const db = await openSqliteWritable(dbPath);
      try {
        const stale = countSessions(
          db,
          "select count(*) as c from session_v2 where time_updated < ?",
          [context.staleCutoffMs],
        );
        if (stale === 0) {
          return skip(this.agentId, this.displayName);
        }
        db.exec("begin immediate");
        try {
          db.prepare("delete from session_v2 where time_updated < ?").run(context.staleCutoffMs);
          db.exec("commit");
        } catch (error) {
          db.exec("rollback");
          throw error;
        }
        const vacuumError = await vacuum(db, context.logger);
        const after = await databaseBytes(dbPath);
        return cleaned(this.agentId, this.displayName, stale, before - after, vacuumError);
      } finally {
        db.close();
      }
    } catch (error) {
      context.logger.debug({ err: error, dbPath }, "OpenCode session cleanup failed");
      return failure(this.agentId, this.displayName, messageOf(error));
    }
  }
}

/** 所有以 `session_id` 关联会话、且外键未级联的子表。 */
const DEVIN_SESSION_CHILD_TABLES = [
  "message_nodes",
  "prompt_history",
  "tool_call_state",
  "subagent_heads",
  "rendered_commits",
] as const;

/**
 * Devin 的会话分散在 `sessions` 与几张子表里，且外键没有级联，需要按序手动删除。
 * 库文件接近 GB 级，这里的占用按会话数比例估算，清理后以 VACUUM 前后差值报告实际释放量。
 */
export class DevinStorage implements TokenUsageStorageTarget {
  readonly agentId: TokenUsageAgentId = "devin";
  readonly displayName = "Devin";

  private rootDir(homeDir: string): string {
    return path.join(resolveXdgDataHome(homeDir), "devin");
  }

  private databasePath(homeDir: string): string {
    return path.join(this.rootDir(homeDir), "cli", "sessions.db");
  }

  async measure(context: StorageContext): Promise<AgentDiskUsage> {
    const root = this.rootDir(context.homeDir);
    const dbPath = this.databasePath(context.homeDir);
    if (!(await pathExists(dbPath))) {
      return unavailable(this.agentId, this.displayName, root);
    }
    try {
      const totalBytes = await directorySize(root, context.gate);
      const cutoffSec = Math.floor(context.staleCutoffMs / 1000);
      const db = await openSqliteReadonly(dbPath);
      let total = 0;
      let stale = 0;
      try {
        total = countSessions(db, "select count(*) as c from sessions", []);
        stale = countSessions(db, "select count(*) as c from sessions where last_activity_at < ?", [
          cutoffSec,
        ]);
      } finally {
        db.close();
      }
      const dbBytes = await databaseBytes(dbPath);
      return {
        agentId: this.agentId,
        displayName: this.displayName,
        status: "available",
        error: null,
        totalBytes,
        paths: [root],
        sessionCount: total,
        sessionBytes: dbBytes,
        staleSessionCount: stale,
        staleSessionBytes: estimateBytes(dbBytes, stale, total),
      };
    } catch (error) {
      return errorUsage(this.agentId, this.displayName, context.logger, error, [root]);
    }
  }

  async cleanup(context: StorageContext): Promise<AgentCleanupResult> {
    const dbPath = this.databasePath(context.homeDir);
    if (!(await pathExists(dbPath))) {
      return failure(this.agentId, this.displayName, `未找到数据库 ${dbPath}`);
    }
    const before = await databaseBytes(dbPath);
    const cutoffSec = Math.floor(context.staleCutoffMs / 1000);
    try {
      const db = await openSqliteWritable(dbPath);
      try {
        const stale = countSessions(
          db,
          "select count(*) as c from sessions where last_activity_at < ?",
          [cutoffSec],
        );
        if (stale === 0) {
          return skip(this.agentId, this.displayName);
        }
        db.exec("begin immediate");
        try {
          const existing = tableNames(db);
          for (const table of DEVIN_SESSION_CHILD_TABLES) {
            if (!existing.has(table)) {
              continue;
            }
            db.prepare(
              `delete from ${table} where session_id in (select id from sessions where last_activity_at < ?)`,
            ).run(cutoffSec);
          }
          db.prepare("delete from sessions where last_activity_at < ?").run(cutoffSec);
          db.exec("commit");
        } catch (error) {
          db.exec("rollback");
          throw error;
        }
        const vacuumError = await vacuum(db, context.logger);
        const after = await databaseBytes(dbPath);
        return cleaned(this.agentId, this.displayName, stale, before - after, vacuumError);
      } finally {
        db.close();
      }
    } catch (error) {
      context.logger.debug({ err: error, dbPath }, "Devin session cleanup failed");
      return failure(this.agentId, this.displayName, messageOf(error));
    }
  }
}

function skip(agentId: TokenUsageAgentId, displayName: string): AgentCleanupResult {
  return { agentId, displayName, status: "skipped", removedSessions: 0, freedBytes: 0, error: null };
}

function cleaned(
  agentId: TokenUsageAgentId,
  displayName: string,
  removedSessions: number,
  freedBytes: number,
  error: string | null,
): AgentCleanupResult {
  return {
    agentId,
    displayName,
    status: "cleaned",
    removedSessions,
    freedBytes: Math.max(0, freedBytes),
    error,
  };
}

function failure(
  agentId: TokenUsageAgentId,
  displayName: string,
  error: string,
): AgentCleanupResult {
  return { agentId, displayName, status: "error", removedSessions: 0, freedBytes: 0, error };
}
