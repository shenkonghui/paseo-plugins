import path from "node:path";
import type { TokenUsageAgent } from "../types.js";
import type { TokenUsageCollectContext, TokenUsageCollector } from "../collector.js";
import { localDayKey, localHourKey } from "../day-window.js";
import { unavailableAgent, type UsageDelta, UsageAccumulator } from "../counters.js";
import {
  openSqliteReadonly,
  readNumber,
  readString,
  SqliteMissingError,
  SqliteUnavailableError,
  type SqliteDatabase,
  type SqliteRow,
} from "../sqlite.js";
import { classifyIssue, parseResetAt } from "../issues.js";

/**
 * OpenCode keeps every message in one SQLite file. Usage is read from the assistant
 * message payloads rather than `session_v2` totals, because those totals are not
 * dated and the chart needs per-day buckets. Rows are paged because reading them
 * is synchronous and the payloads are large.
 */
const PAGE_SIZE = 500;

export class OpencodeCollector implements TokenUsageCollector {
  readonly agentId = "opencode" as const;
  readonly displayName = "OpenCode";

  async collect(context: TokenUsageCollectContext): Promise<TokenUsageAgent> {
    const databasePath = resolveDatabasePath(context.homeDir);
    const accumulator = new UsageAccumulator();

    let db: SqliteDatabase;
    try {
      db = await openSqliteReadonly(databasePath);
    } catch (error) {
      return unavailableAgent({
        agentId: this.agentId,
        displayName: this.displayName,
        error: messageOf(error),
        status:
          error instanceof SqliteMissingError || error instanceof SqliteUnavailableError
            ? "unavailable"
            : "error",
      });
    }

    try {
      for (const rows of pageRows(db, {
        baseQuery: PAGE_QUERY,
        cursorQuery: PAGE_QUERY_WITH_CURSOR,
        cutoffMs: context.cutoffMs,
      })) {
        await context.gate.maybeYield();
        for (const row of rows) {
          applyRow(accumulator, row, context.todayStartMs);
        }
      }
      // 失败事件单独扫一遍：它只看本机当天 0 点以来，且大多数行没有 error 字段。
      for (const rows of pageRows(db, {
        baseQuery: ISSUE_QUERY,
        cursorQuery: ISSUE_QUERY_WITH_CURSOR,
        cutoffMs: context.issueCutoffMs,
      })) {
        await context.gate.maybeYield();
        for (const row of rows) {
          applyIssueRow(accumulator, row);
        }
      }
    } catch (error) {
      context.logger.debug({ err: error, databasePath }, "Failed to read OpenCode usage");
      return unavailableAgent({
        agentId: this.agentId,
        displayName: this.displayName,
        error: messageOf(error),
        status: "error",
      });
    } finally {
      db.close();
    }

    return accumulator.toAgent({
      agentId: this.agentId,
      displayName: this.displayName,
      status: "available",
    });
  }
}

const PAGE_QUERY = `
  select
    session_id as session_id,
    time_created as time_created,
    id as id,
    json_extract(data, '$.tokens.input') as input_tokens,
    json_extract(data, '$.tokens.output') as output_tokens,
    json_extract(data, '$.tokens.reasoning') as reasoning_tokens,
    json_extract(data, '$.tokens.cache.read') as cache_read_tokens,
    json_extract(data, '$.tokens.cache.write') as cache_write_tokens,
    json_extract(data, '$.cost') as cost_usd,
    json_extract(data, '$.model.id') as model
  from session_message
  where type = 'assistant' and time_created >= ?
  order by time_created, id
  limit ?
`;

const PAGE_QUERY_WITH_CURSOR = `
  select
    session_id as session_id,
    time_created as time_created,
    id as id,
    json_extract(data, '$.tokens.input') as input_tokens,
    json_extract(data, '$.tokens.output') as output_tokens,
    json_extract(data, '$.tokens.reasoning') as reasoning_tokens,
    json_extract(data, '$.tokens.cache.read') as cache_read_tokens,
    json_extract(data, '$.tokens.cache.write') as cache_write_tokens,
    json_extract(data, '$.cost') as cost_usd,
    json_extract(data, '$.model.id') as model
  from session_message
  where type = 'assistant' and time_created >= ? and (time_created, id) > (?, ?)
  order by time_created, id
  limit ?
`;

/** 只挑带 error 的 assistant 行；`like` 先筛掉绝大多数行，再解 JSON。 */
const ISSUE_QUERY = `
  select
    session_id as session_id,
    time_created as time_created,
    id as id,
    json_extract(data, '$.error') as error_json,
    json_extract(data, '$.model.id') as model
  from session_message
  where type = 'assistant' and time_created >= ? and data like '%"error":{%'
  order by time_created, id
  limit ?
`;

const ISSUE_QUERY_WITH_CURSOR = `
  select
    session_id as session_id,
    time_created as time_created,
    id as id,
    json_extract(data, '$.error') as error_json,
    json_extract(data, '$.model.id') as model
  from session_message
  where type = 'assistant' and time_created >= ? and data like '%"error":{%'
    and (time_created, id) > (?, ?)
  order by time_created, id
  limit ?
`;

/**
 * Keyset-pages one query by `(time_created, id)` so a large table never loads at once.
 * The caller awaits the yield gate per page.
 */
function* pageRows(
  db: SqliteDatabase,
  queries: { baseQuery: string; cursorQuery: string; cutoffMs: number },
): Generator<SqliteRow[]> {
  const base = db.prepare(queries.baseQuery);
  const withCursor = db.prepare(queries.cursorQuery);
  let cursor: { timeCreated: number; id: string } | null = null;
  for (;;) {
    const rows: SqliteRow[] = cursor
      ? withCursor.all(queries.cutoffMs, cursor.timeCreated, cursor.id, PAGE_SIZE)
      : base.all(queries.cutoffMs, PAGE_SIZE);
    if (rows.length === 0) {
      return;
    }
    yield rows;
    const last = rows[rows.length - 1]!;
    cursor = { timeCreated: readNumber(last.time_created) ?? 0, id: readString(last.id) ?? "" };
    if (rows.length < PAGE_SIZE) {
      return;
    }
  }
}

function applyRow(accumulator: UsageAccumulator, row: SqliteRow, todayStartMs: number): void {
  const timeCreated = readNumber(row.time_created);
  if (timeCreated === undefined) {
    return;
  }
  const inputTokens = readNumber(row.input_tokens) ?? 0;
  const outputTokens = readNumber(row.output_tokens) ?? 0;
  const reasoningTokens = readNumber(row.reasoning_tokens) ?? 0;
  const cacheReadTokens = readNumber(row.cache_read_tokens) ?? 0;
  const cacheWriteTokens = readNumber(row.cache_write_tokens) ?? 0;
  // OpenCode's own total excludes cache; normalize to the full-dimension sum so
  // every agent's "total tokens" includes cache reads/writes.
  const delta: UsageDelta = {
    inputTokens: readNumber(row.input_tokens),
    outputTokens: readNumber(row.output_tokens),
    totalTokens:
      inputTokens + outputTokens + reasoningTokens + cacheReadTokens + cacheWriteTokens,
    reasoningTokens: readNumber(row.reasoning_tokens),
    cacheReadTokens: readNumber(row.cache_read_tokens),
    cacheWriteTokens: readNumber(row.cache_write_tokens),
    costUsd: readNumber(row.cost_usd),
  };
  accumulator.record({
    dayKey: localDayKey(timeCreated),
    hourKey: timeCreated >= todayStartMs ? localHourKey(timeCreated) : undefined,
    sessionId: readString(row.session_id),
    model: readString(row.model),
    delta,
  });
}

function applyIssueRow(accumulator: UsageAccumulator, row: SqliteRow): void {
  const timeCreated = readNumber(row.time_created);
  const serialized = readString(row.error_json);
  if (timeCreated === undefined || !serialized) {
    return;
  }
  const error = parseJson(serialized);
  if (!isRecord(error)) {
    return;
  }
  const nested = isRecord(error.response) ? bodyMessage(error.response.body) : undefined;
  const outer = typeof error.message === "string" ? error.message : undefined;
  const message = firstString(outer, nested)?.trim();
  if (!message) {
    return;
  }
  const type = typeof error.type === "string" ? error.type : undefined;
  const httpStatus = typeof error.status === "number" ? error.status : undefined;
  accumulator.recordIssue({
    kind: classifyIssue({ message, type, httpStatus }),
    message,
    timestampMs: timeCreated,
    httpStatus,
    resetAtMs: parseResetAt(message),
    model: readString(row.model),
    sessionId: readString(row.session_id),
  });
}

/** `response.body` 有时是嵌套的 JSON 字符串，里面的 message 比外层更具体。 */
function bodyMessage(body: unknown): string | undefined {
  if (typeof body !== "string") {
    return undefined;
  }
  const parsed = parseJson(body);
  if (!isRecord(parsed) || !isRecord(parsed.error)) {
    return undefined;
  }
  return typeof parsed.error.message === "string" ? parsed.error.message : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function firstString(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && value.length > 0);
}

function resolveDatabasePath(homeDir: string): string {
  const dataHome = process.env.XDG_DATA_HOME || path.join(homeDir, ".local", "share");
  return path.join(dataHome, "opencode", "opencode.db");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
