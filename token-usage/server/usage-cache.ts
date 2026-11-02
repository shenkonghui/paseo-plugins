import {
  emptyCounters,
  mergeCounters,
  toWireCounters,
  type CollectedDay,
  type CollectedTokenUsage,
  type UsageCounters,
} from "./counters.js";
import { dayKeysBetween, localDayKey, localDayStartMs } from "./day-window.js";
import type {
  TokenUsageAgent,
  TokenUsageAgentId,
  TokenUsageDay,
  TokenUsageHour,
  TokenUsageIssue,
  TokenUsageModel,
} from "./types.js";

/**
 * 缓存的一天。粒度与采集窗口无关：1 / 7 / 30 天都从这些天拼出来，
 * 所以切窗口、重启都只需要重新读「今天」。
 */
export interface CachedDay {
  counters: UsageCounters;
  models: Map<string, UsageCounters>;
  sessionIds: Set<string>;
  /** 只有当天有小时桶；跨天后清空。 */
  hours: TokenUsageHour[];
  /** 只有当天有失败事件；跨天后清空。 */
  issues: TokenUsageIssue[];
}

/** 单个 agent 的按天缓存。 */
export interface AgentUsageCache {
  status: TokenUsageAgent["status"];
  error: string | null;
  sources: string[];
  /** 最近一次采集完成的时间，只用来判断「今天」是否还在 TTL 内。 */
  collectedAtMs: number;
  days: Map<string, CachedDay>;
}

const CACHE_VERSION = 2;
const AGENT_IDS: readonly TokenUsageAgentId[] = ["codebuddy", "pi", "opencode", "devin", "qoder"];
const AGENT_STATUSES: readonly TokenUsageAgent["status"][] = [
  "available",
  "unavailable",
  "error",
  "disabled",
];

export function emptyAgentCache(): AgentUsageCache {
  return {
    status: "unavailable",
    error: null,
    sources: [],
    collectedAtMs: 0,
    days: new Map(),
  };
}

/** 第一个没有缓存的天（0 点）；窗口内都有缓存时返回 undefined。 */
export function missingDayStartMs(
  cache: AgentUsageCache,
  startMs: number,
  endMs: number,
): number | undefined {
  const cursor = new Date(localDayStartMs(startMs));
  const end = localDayStartMs(endMs);
  while (cursor.getTime() <= end) {
    if (!cache.days.has(localDayKey(cursor.getTime()))) {
      return cursor.getTime();
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return undefined;
}

/**
 * 把一次采集的结果并回缓存：`[startMs, nowMs]` 内的天全部以本次结果为准，
 * 没采到数据的天落成显式的空桶（这样「没采过」和「当天为 0」才分得清）。
 * 早于 `pruneBeforeMs` 的桶被丢掉，缓存不会随天数无限增长。
 */
export function mergeCollection(input: {
  cache: AgentUsageCache;
  collected: CollectedTokenUsage;
  /** 本次采集覆盖的第一天 0 点。 */
  startMs: number;
  nowMs: number;
  collectedAtMs: number;
  /** 窗口上限对应的第一天，早于它的桶不再保留。 */
  pruneBeforeMs: number;
}): AgentUsageCache {
  const { cache, collected, startMs, nowMs, collectedAtMs, pruneBeforeMs } = input;
  const todayKey = localDayKey(nowMs);
  const pruneBeforeKey = localDayKey(pruneBeforeMs);
  const days = new Map(cache.days);

  for (const key of dayKeysBetween(startMs, nowMs)) {
    const collectedDay = collected.days.get(key);
    days.set(key, collectedDay ? copyDay(collectedDay) : emptyCachedDay());
  }

  for (const [key, day] of days) {
    if (key < pruneBeforeKey) {
      days.delete(key);
      continue;
    }
    if (key !== todayKey) {
      if (day.hours.length > 0) {
        day.hours = [];
      }
      if (day.issues.length > 0) {
        day.issues = [];
      }
    }
  }

  return {
    status: collected.agent.status,
    error: collected.agent.error,
    sources: collected.agent.sources,
    collectedAtMs,
    days,
  };
}

/** 用缓存里的天拼出某个窗口的 agent 快照。 */
export function composeWindow(input: {
  agentId: TokenUsageAgentId;
  displayName: string;
  cache: AgentUsageCache;
  startMs: number;
  nowMs: number;
}): TokenUsageAgent {
  const startKey = localDayKey(input.startMs);
  const todayKey = localDayKey(input.nowMs);
  const days: TokenUsageDay[] = [];
  const totals = emptyCounters();
  const models = new Map<string, UsageCounters>();
  const sessions = new Set<string>();

  const keys = [...input.cache.days.keys()]
    .filter((key) => key >= startKey && key <= todayKey)
    .sort();

  for (const key of keys) {
    const day = input.cache.days.get(key)!;
    mergeCounters(totals, day.counters);
    for (const [model, counters] of day.models) {
      const bucket = models.get(model) ?? emptyCounters();
      mergeCounters(bucket, counters);
      models.set(model, bucket);
    }
    for (const sessionId of day.sessionIds) {
      sessions.add(sessionId);
    }
    days.push({ date: key, sessions: day.sessionIds.size, ...toWireCounters(day.counters) });
  }

  const today = input.cache.days.get(todayKey);
  const modelList: TokenUsageModel[] = [...models.entries()]
    .map(([model, counters]) => ({ model, ...toWireCounters(counters) }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  return {
    agentId: input.agentId,
    displayName: input.displayName,
    status: input.cache.status,
    error: input.cache.error,
    sources: input.cache.sources,
    totals: toWireCounters(totals),
    sessions: sessions.size,
    days,
    hours: today?.hours ?? [],
    models: modelList,
    issues: today?.issues ?? [],
  };
}

export function serializeCaches(caches: ReadonlyMap<TokenUsageAgentId, AgentUsageCache>): string {
  const agents: Record<string, unknown> = {};
  for (const [agentId, cache] of caches) {
    const days: Record<string, unknown> = {};
    for (const [key, day] of cache.days) {
      days[key] = {
        counters: day.counters,
        models: Object.fromEntries(day.models),
        sessionIds: [...day.sessionIds],
        hours: day.hours,
        issues: day.issues,
      };
    }
    agents[agentId] = {
      status: cache.status,
      error: cache.error,
      sources: cache.sources,
      collectedAtMs: cache.collectedAtMs,
      days,
    };
  }
  return JSON.stringify({ version: CACHE_VERSION, agents });
}

/** 读回落盘缓存；版本不符或结构损坏时返回 null，让服务端重新采集。 */
export function parseCaches(text: string): Map<TokenUsageAgentId, AgentUsageCache> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.version !== CACHE_VERSION || !isRecord(parsed.agents)) {
    return null;
  }

  const caches = new Map<TokenUsageAgentId, AgentUsageCache>();
  for (const [agentId, value] of Object.entries(parsed.agents)) {
    if (!isAgentId(agentId) || !isRecord(value) || !isRecord(value.days)) {
      continue;
    }
    const days = new Map<string, CachedDay>();
    for (const [key, raw] of Object.entries(value.days)) {
      const day = readDay(raw);
      if (day) {
        days.set(key, day);
      }
    }
    caches.set(agentId, {
      status: readStatus(value.status),
      error: typeof value.error === "string" ? value.error : null,
      sources: Array.isArray(value.sources)
        ? value.sources.filter((source): source is string => typeof source === "string")
        : [],
      collectedAtMs: typeof value.collectedAtMs === "number" ? value.collectedAtMs : 0,
      days,
    });
  }
  return caches;
}

function emptyCachedDay(): CachedDay {
  return {
    counters: emptyCounters(),
    models: new Map(),
    sessionIds: new Set(),
    hours: [],
    issues: [],
  };
}

function copyDay(day: CollectedDay): CachedDay {
  return {
    counters: { ...day.counters },
    models: new Map(day.models),
    sessionIds: new Set(day.sessionIds),
    hours: [...(day.hours ?? [])].sort((a, b) => a.hour - b.hour),
    issues: [...(day.issues ?? [])],
  };
}

function readDay(value: unknown): CachedDay | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const counters = readCounters(value.counters);
  if (!counters) {
    return undefined;
  }

  const models = new Map<string, UsageCounters>();
  if (isRecord(value.models)) {
    for (const [model, raw] of Object.entries(value.models)) {
      const parsed = readCounters(raw);
      if (parsed) {
        models.set(model, parsed);
      }
    }
  }

  const sessionIds = Array.isArray(value.sessionIds)
    ? value.sessionIds.filter((id): id is string => typeof id === "string")
    : [];

  return {
    counters,
    models,
    sessionIds: new Set(sessionIds),
    hours: readHours(value.hours),
    issues: Array.isArray(value.issues) ? (value.issues as TokenUsageIssue[]) : [],
  };
}

function readHours(value: unknown): TokenUsageHour[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const hours: TokenUsageHour[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.hour !== "number") {
      continue;
    }
    const counters = readCounters(raw);
    if (!counters) {
      continue;
    }
    hours.push({
      hour: raw.hour,
      sessions: typeof raw.sessions === "number" ? raw.sessions : 0,
      ...toWireCounters(counters),
    });
  }
  return hours.sort((a, b) => a.hour - b.hour);
}

function readCounters(value: unknown): UsageCounters | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const number = (key: string): number | undefined =>
    typeof value[key] === "number" && Number.isFinite(value[key]) ? (value[key] as number) : undefined;

  const inputTokens = number("inputTokens");
  const outputTokens = number("outputTokens");
  const totalTokens = number("totalTokens");
  const requests = number("requests");
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    totalTokens === undefined ||
    requests === undefined
  ) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    requests,
    reasoningTokens: number("reasoningTokens") ?? null,
    cacheReadTokens: number("cacheReadTokens") ?? null,
    cacheWriteTokens: number("cacheWriteTokens") ?? null,
    costUsd: number("costUsd") ?? null,
    costCredits: number("costCredits") ?? null,
  };
}

function readStatus(value: unknown): TokenUsageAgent["status"] {
  return AGENT_STATUSES.includes(value as TokenUsageAgent["status"])
    ? (value as TokenUsageAgent["status"])
    : "unavailable";
}

function isAgentId(value: string): value is TokenUsageAgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
