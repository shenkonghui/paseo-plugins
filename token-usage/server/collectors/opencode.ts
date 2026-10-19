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
      let cursor: { timeCreated: number; id: string } | null = null;
      const base = db.prepare(PAGE_QUERY);
      const withCursor = db.prepare(PAGE_QUERY_WITH_CURSOR);
      for (;;) {
        await context.gate.maybeYield();
        const rows: SqliteRow[] = cursor
          ? withCursor.all(context.cutoffMs, cursor.timeCreated, cursor.id, PAGE_SIZE)
          : base.all(context.cutoffMs, PAGE_SIZE);
        if (rows.length === 0) {
          break;
        }
        for (const row of rows) {
          applyRow(accumulator, row, context.todayStartMs);
        }
        const last = rows[rows.length - 1]!;
        cursor = { timeCreated: readNumber(last.time_created) ?? 0, id: readString(last.id) ?? "" };
        if (rows.length < PAGE_SIZE) {
          break;
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

function resolveDatabasePath(homeDir: string): string {
  const dataHome = process.env.XDG_DATA_HOME || path.join(homeDir, ".local", "share");
  return path.join(dataHome, "opencode", "opencode.db");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
