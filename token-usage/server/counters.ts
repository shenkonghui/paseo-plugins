import type {
  TokenUsageAgent,
  TokenUsageAgentId,
  TokenUsageCounters,
  TokenUsageDay,
  TokenUsageHour,
  TokenUsageIssue,
  TokenUsageIssueKind,
  TokenUsageModel,
} from "./types.js";

/**
 * Accumulated counters where a dimension is `null` until some record reports it.
 * `null` and `0` stay apart so the UI can tell "this agent does not report it"
 * from "this agent reported nothing".
 */
export interface UsageCounters {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requests: number;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
  costCredits: number | null;
}

/** One LLM call's usage. Absent fields were not reported by that record. */
export interface UsageDelta {
  /** Number of calls this delta represents; defaults to one. SQL aggregates pass their row count. */
  requests?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  costCredits?: number;
}

export interface UsageRecord {
  dayKey: string;
  /** `YYYY-MM-DDTHH`；只在记录属于「今天」时提供，用于小时视图。 */
  hourKey?: string;
  delta: UsageDelta;
  sessionId?: string;
  model?: string;
}

/** 一次失败请求；`timestampMs` 决定它落在哪一天、以及聚合时的先后。 */
export interface UsageIssueRecord {
  kind: TokenUsageIssueKind;
  message: string;
  timestampMs: number;
  code?: number;
  httpStatus?: number;
  retryable?: boolean;
  resetAtMs?: number;
  model?: string;
  sessionId?: string;
}

export function emptyCounters(): UsageCounters {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    requests: 0,
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd: null,
    costCredits: null,
  };
}

/** Keeps the non-reporting dimensions apart from genuine zeros. */
export function countersFromDelta(delta: UsageDelta): UsageCounters {
  const counters = emptyCounters();
  addUsageTo(counters, delta);
  return counters;
}

export function addUsageTo(target: UsageCounters, delta: UsageDelta): void {
  const input = readNumber(delta.inputTokens);
  const output = readNumber(delta.outputTokens);
  target.inputTokens += input;
  target.outputTokens += output;
  target.requests += readNumber(delta.requests, 1);
  target.totalTokens += readNumber(delta.totalTokens, input + output);
  target.reasoningTokens = addToOptional(target.reasoningTokens, delta.reasoningTokens);
  target.cacheReadTokens = addToOptional(target.cacheReadTokens, delta.cacheReadTokens);
  target.cacheWriteTokens = addToOptional(target.cacheWriteTokens, delta.cacheWriteTokens);
  target.costUsd = addToOptional(target.costUsd, delta.costUsd);
  target.costCredits = addToOptional(target.costCredits, delta.costCredits);
}

function addToOptional(target: number | null, value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) {
    return target;
  }
  return (target ?? 0) + value;
}

function readNumber(value: number | undefined, fallback = 0): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

interface DayBucket {
  counters: UsageCounters;
  sessions: Set<string>;
}

interface ModelBucket {
  model: string;
  counters: UsageCounters;
}

/**
 * 同一类失败的聚合桶。key 只由「kind + code + httpStatus + 重置时间」构成，
 * 不含 message（message 里带 requestID / 会话 id，按它聚合会一条都合不起来）。
 */
interface IssueBucket {
  kind: TokenUsageIssueKind;
  code: number | null;
  httpStatus: number | null;
  retryable: boolean | null;
  resetAtMs: number | null;
  message: string;
  model: string | null;
  sessionId: string | null;
  firstAtMs: number;
  lastAtMs: number;
  count: number;
}

/** Rolls per-call records into per-day, per-model, and overall buckets. */
export class UsageAccumulator {
  private readonly days = new Map<string, DayBucket>();
  private readonly hours = new Map<string, DayBucket>();
  private readonly models = new Map<string, ModelBucket>();
  private readonly sessions = new Set<string>();
  private readonly issues = new Map<string, IssueBucket>();
  private readonly totals: UsageCounters = emptyCounters();

  record(input: UsageRecord): void {
    addUsageTo(this.totals, input.delta);

    const day = this.days.get(input.dayKey) ?? { counters: emptyCounters(), sessions: new Set() };
    addUsageTo(day.counters, input.delta);
    if (input.sessionId) {
      day.sessions.add(input.sessionId);
      this.sessions.add(input.sessionId);
    }
    this.days.set(input.dayKey, day);

    if (input.hourKey) {
      const hour = this.hours.get(input.hourKey) ?? {
        counters: emptyCounters(),
        sessions: new Set(),
      };
      addUsageTo(hour.counters, input.delta);
      if (input.sessionId) {
        hour.sessions.add(input.sessionId);
      }
      this.hours.set(input.hourKey, hour);
    }

    if (input.model) {
      const bucket = this.models.get(input.model) ?? {
        model: input.model,
        counters: emptyCounters(),
      };
      addUsageTo(bucket.counters, input.delta);
      this.models.set(input.model, bucket);
    }
  }

  /** 记一次失败请求；同 kind / code / 状态 / 重置时间的记录合并计数。 */
  recordIssue(input: UsageIssueRecord): void {
    const key = [
      input.kind,
      input.code ?? "-",
      input.httpStatus ?? "-",
      input.resetAtMs ?? "-",
    ].join("|");
    const bucket = this.issues.get(key);
    if (!bucket) {
      this.issues.set(key, {
        kind: input.kind,
        code: input.code ?? null,
        httpStatus: input.httpStatus ?? null,
        retryable: input.retryable ?? null,
        resetAtMs: input.resetAtMs ?? null,
        message: input.message,
        model: input.model ?? null,
        sessionId: input.sessionId ?? null,
        firstAtMs: input.timestampMs,
        lastAtMs: input.timestampMs,
        count: 1,
      });
      return;
    }
    bucket.count += 1;
    bucket.firstAtMs = Math.min(bucket.firstAtMs, input.timestampMs);
    // 展示用的原文取最近一次，避免聚合后的描述停在很久以前那条。
    if (input.timestampMs >= bucket.lastAtMs) {
      bucket.lastAtMs = input.timestampMs;
      bucket.message = input.message;
      bucket.model = input.model ?? null;
      bucket.sessionId = input.sessionId ?? null;
      bucket.retryable = input.retryable ?? bucket.retryable;
    }
  }

  toAgent(input: {
    agentId: TokenUsageAgentId;
    displayName: string;
    status: TokenUsageAgent["status"];
    error?: string | null;
  }): TokenUsageAgent {
    const days: TokenUsageDay[] = [...this.days.entries()]
      .map(([date, bucket]) =>
        Object.assign({ date, sessions: bucket.sessions.size }, toWireCounters(bucket.counters)),
      )
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    const models: TokenUsageModel[] = [...this.models.values()]
      .map((bucket) => Object.assign({ model: bucket.model }, toWireCounters(bucket.counters)))
      .sort((a, b) => b.totalTokens - a.totalTokens);
    const hours: TokenUsageHour[] = [...this.hours.entries()]
      .map(([key, bucket]) => {
        const hour = Number(key.slice(key.indexOf("T") + 1));
        return Object.assign(
          { hour: Number.isFinite(hour) ? hour : 0, sessions: bucket.sessions.size },
          toWireCounters(bucket.counters),
        );
      })
      .sort((a, b) => a.hour - b.hour);

    return {
      agentId: input.agentId,
      displayName: input.displayName,
      status: input.status,
      error: input.error ?? null,
      totals: toWireCounters(this.totals),
      sessions: this.sessions.size,
      days,
      hours,
      models,
      issues: this.toIssues(),
    };
  }

  /** 最近的排前面；同一时刻按出现次数多的排前面。 */
  private toIssues(): TokenUsageIssue[] {
    return [...this.issues.values()]
      .map((bucket) => ({
        kind: bucket.kind,
        code: bucket.code,
        httpStatus: bucket.httpStatus,
        retryable: bucket.retryable,
        message: bucket.message,
        model: bucket.model,
        sessionId: bucket.sessionId,
        firstAt: new Date(bucket.firstAtMs).toISOString(),
        lastAt: new Date(bucket.lastAtMs).toISOString(),
        count: bucket.count,
        resetAt: bucket.resetAtMs === null ? null : new Date(bucket.resetAtMs).toISOString(),
      }))
      .sort((a, b) => (a.lastAt === b.lastAt ? b.count - a.count : a.lastAt < b.lastAt ? 1 : -1));
  }
}

export function unavailableAgent(input: {
  agentId: TokenUsageAgentId;
  displayName: string;
  error: string;
  status?: TokenUsageAgent["status"];
}): TokenUsageAgent {
  return {
    agentId: input.agentId,
    displayName: input.displayName,
    status: input.status ?? "unavailable",
    error: input.error,
    totals: toWireCounters(emptyCounters()),
    sessions: 0,
    days: [],
    hours: [],
    models: [],
    issues: [],
  };
}

function toWireCounters(counters: UsageCounters): TokenUsageCounters {
  const wire: TokenUsageCounters = {
    inputTokens: counters.inputTokens,
    outputTokens: counters.outputTokens,
    totalTokens: counters.totalTokens,
    requests: counters.requests,
  };
  if (counters.reasoningTokens !== null) {
    wire.reasoningTokens = counters.reasoningTokens;
  }
  if (counters.cacheReadTokens !== null) {
    wire.cacheReadTokens = counters.cacheReadTokens;
  }
  if (counters.cacheWriteTokens !== null) {
    wire.cacheWriteTokens = counters.cacheWriteTokens;
  }
  if (counters.costUsd !== null) {
    wire.costUsd = counters.costUsd;
  }
  if (counters.costCredits !== null) {
    wire.costCredits = counters.costCredits;
  }
  return wire;
}
