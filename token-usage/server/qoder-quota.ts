import fs from "node:fs";
import path from "node:path";
import type { TokenUsageLogger } from "./types.js";
import type { TokenUsageQoderQuota } from "../shared/rpc.js";

const MARKER = "quota/usage response:";
/** Startup-shell logs below this never contain a quota response. */
const MIN_LOG_BYTES = 16 * 1024;
/** Backstop for a rare no-hit scan; the real tree is ~200 MB of logs. */
const MAX_RUNS_READ = 2000;
const MAX_BYTES_READ = 512 * 1024 * 1024;

interface QuotaBucket {
  total: number;
  used: number;
  remaining: number;
  percentage: number | null;
}

interface RawQuotaResponse {
  userType?: unknown;
  usageType?: unknown;
  isQuotaExceeded?: unknown;
  totalUsagePercentage?: unknown;
  expiresAt?: unknown;
  userQuota?: unknown;
  addOnQuota?: unknown;
}

function toNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toBucket(raw: unknown): QuotaBucket | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const total = toNumber(record.total);
  const used = toNumber(record.used);
  const remaining = toNumber(record.remaining);
  if (total === null || used === null || remaining === null) {
    return null;
  }
  return { total, used, remaining, percentage: toNumber(record.percentage) };
}

function extractQuotaLine(line: string): RawQuotaResponse | null {
  const jsonStart = line.indexOf("{");
  if (jsonStart === -1) {
    return null;
  }
  try {
    const parsed = JSON.parse(line.slice(jsonStart)) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as RawQuotaResponse;
    }
  } catch {
    // Log lines echo shell commands that mention the marker too; only a line
    // whose tail parses as JSON can be a real API response.
  }
  return null;
}

function toQuota(raw: RawQuotaResponse, observedAtMs: number): TokenUsageQoderQuota | null {
  const plan = toBucket(raw.userQuota);
  if (!plan) {
    return null;
  }
  const expiresAtMs = toNumber(raw.expiresAt);
  return {
    userType: typeof raw.userType === "string" ? raw.userType : "unknown",
    usageType: typeof raw.usageType === "string" ? raw.usageType : "credits",
    isQuotaExceeded: raw.isQuotaExceeded === true,
    totalUsagePercentage: toNumber(raw.totalUsagePercentage),
    expiresAt: expiresAtMs !== null ? new Date(expiresAtMs).toISOString() : null,
    plan,
    addOn: toBucket(raw.addOnQuota),
    observedAt: new Date(observedAtMs).toISOString(),
  };
}

/**
 * The qoder-cn CLI never sees real token counts (its gateway returns zeros), but it
 * logs its subscription credits quota whenever it starts. The freshest quota snapshot
 * therefore comes from scanning its run logs, newest first.
 */
export function collectQoderQuota(
  homeDir: string,
  logger: TokenUsageLogger,
): TokenUsageQoderQuota | null {
  const runsDir = path.join(homeDir, ".qoder-cn", "logs", "runs");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  // Quota is fetched at CLI startup, so the actively written (newest-mtime) logs
  // are the most likely and freshest hits; walk them first.
  const candidates: Array<{ file: string; mtimeMs: number; name: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const logFile = path.join(runsDir, entry.name, "qodercli.log");
    try {
      const stat = fs.statSync(logFile);
      if (stat.size >= MIN_LOG_BYTES) {
        candidates.push({ file: logFile, mtimeMs: stat.mtimeMs, name: entry.name });
      }
    } catch {
      // Missing or unreadable log; skip.
    }
  }
  candidates.sort(
    (a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0),
  );

  let bytesRead = 0;
  let runsRead = 0;
  for (const candidate of candidates) {
    if (runsRead >= MAX_RUNS_READ || bytesRead >= MAX_BYTES_READ) {
      break;
    }
    let content: string;
    try {
      content = fs.readFileSync(candidate.file, "utf8");
    } catch (error) {
      logger.debug({ err: error, file: candidate.file }, "Skipping unreadable qoder run log");
      continue;
    }
    runsRead += 1;
    bytesRead += content.length;
    // Logs echo shell commands that mention the marker, so walk every occurrence
    // from the end and take the newest one that parses as a real quota response.
    let searchEnd = content.length;
    for (;;) {
      const markerIndex = content.lastIndexOf(MARKER, searchEnd - 1);
      if (markerIndex === -1) {
        break;
      }
      searchEnd = markerIndex;
      const lineEnd = content.indexOf("\n", markerIndex);
      const line = content.slice(markerIndex, lineEnd === -1 ? undefined : lineEnd);
      const raw = extractQuotaLine(line);
      if (!raw) {
        continue;
      }
      const quota = toQuota(raw, candidate.mtimeMs);
      if (quota) {
        return quota;
      }
    }
  }
  return null;
}
