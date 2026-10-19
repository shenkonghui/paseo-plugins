import path from "node:path";

import {
  openSqliteReadonly,
  readNumber,
  readString,
  type SqliteRow,
} from "../sqlite.js";

/**
 * Devin's `sessions.db` runs to gigabytes and `message_nodes.created_at` is not
 * indexed, so the only fast path is one full-table aggregate whose scan and JSON
 * extraction stay inside SQLite's C code. This runs in the plugin process (not
 * the daemon), and the collector's yield gate bounds the event-loop impact.
 */
export interface DevinUsageRow {
  sessionId: string | null;
  model: string | null;
  timestampSec: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface DevinCollectRequest {
  homeDir: string;
  cutoffMs: number;
}

// The metrics JSON is extracted once into a materialized CTE: re-parsing the full
// multi-kilobyte `chat_message` per summed field dominated the whole query.
// Group by exact timestamp: hour buckets can straddle a local midnight in half-hour zones.
/** 最快的活动探测：sessions 只有几千行，用来判断窗口内是否可能有消息。 */
const LATEST_ACTIVITY_QUERY = `
  select max(last_activity_at) as latest
  from sessions
`;

const USAGE_QUERY = `
  with recent as materialized (
    select id from sessions where last_activity_at >= ?
  ),
  calls as materialized (
    select
      m.session_id as session_id,
      m.created_at as created_at,
      json_extract(m.chat_message, '$.metadata.metrics') as metrics
    from message_nodes m
    join recent r on r.id = m.session_id
    where m.created_at >= ?
  )
  select
    session_id as session_id,
    created_at as timestamp_sec,
    count(*) as requests,
    sum(json_extract(metrics, '$.input_tokens')) as input_tokens,
    sum(json_extract(metrics, '$.output_tokens')) as output_tokens,
    sum(json_extract(metrics, '$.cache_read_tokens')) as cache_read_tokens,
    sum(json_extract(metrics, '$.cache_creation_tokens')) as cache_write_tokens
  from calls
  where metrics is not null
  group by session_id, created_at
`;

const SESSION_QUERY = `
  select id, model
  from sessions
`;

export async function collectDevinRows(request: DevinCollectRequest): Promise<DevinUsageRow[]> {
  const databasePath = resolveDatabasePath(request.homeDir);
  const db = await openSqliteReadonly(databasePath);
  try {
    const cutoffSec = Math.floor(request.cutoffMs / 1000);

    // 窗口内没有任何活动就直接返回：避免为「今天」去扫 1.9GB 的 message_nodes。
    const latest = readNumber(db.prepare(LATEST_ACTIVITY_QUERY).all()[0]?.latest);
    if (latest === undefined || latest < cutoffSec) {
      return [];
    }

    const models = new Map<string, string>();
    for (const session of db.prepare(SESSION_QUERY).all()) {
      const id = readString(session.id);
      const model = readString(session.model);
      if (id && model) {
        models.set(id, model);
      }
    }
    const rows = db.prepare(USAGE_QUERY).all(cutoffSec, cutoffSec);
    return rows.map((row: SqliteRow) => {
      const sessionId = readString(row.session_id) ?? null;
      return {
        sessionId,
        model: sessionId ? (models.get(sessionId) ?? null) : null,
        timestampSec: readNumber(row.timestamp_sec) ?? 0,
        requests: readNumber(row.requests) ?? 0,
        inputTokens: readNumber(row.input_tokens) ?? 0,
        outputTokens: readNumber(row.output_tokens) ?? 0,
        cacheReadTokens: readNumber(row.cache_read_tokens) ?? 0,
        cacheWriteTokens: readNumber(row.cache_write_tokens) ?? 0,
      };
    });
  } finally {
    db.close();
  }
}

function resolveDatabasePath(homeDir: string): string {
  const dataHome = process.env.XDG_DATA_HOME || path.join(homeDir, ".local", "share");
  return path.join(dataHome, "devin", "cli", "sessions.db");
}
