import { localDayKey } from "./day-window.js";
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

function addModelUsage(
  target: Map<string, UsageCounters>,
  model: string,
  delta: UsageDelta,
): void {
  const bucket = target.get(model) ?? emptyCounters();
  addUsageTo(bucket, delta);
  target.set(model, bucket);
}

/** 跨天合并：某个维度在任一天有值就算有值，全为 null 才保持 null。 */
export function mergeCounters(target: UsageCounters, source: UsageCounters): void {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.totalTokens += source.totalTokens;
  target.requests += source.requests;
  target.reasoningTokens = addNullable(target.reasoningTokens, source.reasoningTokens);
  target.cacheReadTokens = addNullable(target.cacheReadTokens, source.cacheReadTokens);
  target.cacheWriteTokens = addNullable(target.cacheWriteTokens, source.cacheWriteTokens);
  target.costUsd = addNullable(target.costUsd, source.costUsd);
  target.costCredits = addNullable(target.costCredits, source.costCredits);
}

function addNullable(target: number | null, value: number | null): number | null {
  if (value === null) {
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
  /** 当天按模型的明细；窗口的模型榜由各天相加而来。 */
  models: Map<string, UsageCounters>;
}

/** 小时桶只服务「今天」的曲线，不需要模型维度。 */
interface HourBucket {
  counters: UsageCounters;
  sessions: Set<string>;
}

/** 一天的明细快照；服务端按天缓存后拼装任意窗口。 */
export interface CollectedDay {
  counters: UsageCounters;
  models: Map<string, UsageCounters>;
  /** 当天出现过的会话（相对数据根的路径）；窗口内按并集去重。 */
  sessionIds: Set<string>;
  /** 只有「今天」有：0-23 点的小时桶。 */
  hours?: TokenUsageHour[];
  /** 只有「今天」有：当天 0 点以来的失败事件。 */
  issues?: TokenUsageIssue[];
}

/** A collector's output: the wire-shaped agent plus the per-day detail behind it. */
export interface CollectedTokenUsage {
  agent: TokenUsageAgent;
  days: Map<string, CollectedDay>;
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
  private readonly hours = new Map<string, HourBucket>();
  private readonly models = new Map<string, ModelBucket>();
  private readonly sessions = new Set<string>();
  private readonly issues = new Map<string, IssueBucket>();
  private readonly totals: UsageCounters = emptyCounters();

  record(input: UsageRecord): void {
    addUsageTo(this.totals, input.delta);

    const day = this.days.get(input.dayKey) ?? {
      counters: emptyCounters(),
      sessions: new Set<string>(),
      models: new Map<string, UsageCounters>(),
    };
    addUsageTo(day.counters, input.delta);
    if (input.sessionId) {
      day.sessions.add(input.sessionId);
      this.sessions.add(input.sessionId);
    }
    if (input.model) {
      addModelUsage(day.models, input.model, input.delta);
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
    sources?: string[];
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
      .map(([key, bucket]) => hourEntry(key, bucket))
      .sort((a, b) => a.hour - b.hour);

    return {
      agentId: input.agentId,
      displayName: input.displayName,
      status: input.status,
      error: input.error ?? null,
      sources: input.sources ?? [],
      totals: toWireCounters(this.totals),
      sessions: this.sessions.size,
      days,
      hours,
      models,
      issues: this.toIssues(),
    };
  }

  /**
   * 一次采集的完整结果：wire 形状的 agent + 按天明细。
   * 服务端缓存明细后，任意窗口都从每天拼装，不需要为了 7 / 30 天重扫历史。
   */
  toCollectedAgent(
    input: {
      agentId: TokenUsageAgentId;
      displayName: string;
      status: TokenUsageAgent["status"];
      error?: string | null;
      sources?: string[];
      /** 采集时刻，用来把小时桶与失败事件挂到「今天」这一天。 */
      todayMs: number;
    },
  ): CollectedTokenUsage {
    const days = new Map<string, CollectedDay>();
    for (const [date, bucket] of this.days) {
      days.set(date, {
        counters: bucket.counters,
        models: bucket.models,
        sessionIds: bucket.sessions,
      });
    }

    // 小时桶的 key 自带日期前缀；它只会为当天产生，挂回对应的天即可。
    for (const [key, bucket] of this.hours) {
      const day = days.get(key.slice(0, key.indexOf("T")));
      if (!day) {
        continue;
      }
      (day.hours ??= []).push(hourEntry(key, bucket));
    }

    const todayKey = localDayKey(input.todayMs);
    const today: CollectedDay = days.get(todayKey) ?? {
      counters: emptyCounters(),
      models: new Map<string, UsageCounters>(),
      sessionIds: new Set<string>(),
    };
    today.issues = this.toIssues();
    days.set(todayKey, today);

    return { agent: this.toAgent(input), days };
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
  sources?: string[];
}): TokenUsageAgent {
  return {
    agentId: input.agentId,
    displayName: input.displayName,
    status: input.status ?? "unavailable",
    error: input.error,
    sources: input.sources ?? [],
    totals: toWireCounters(emptyCounters()),
    sessions: 0,
    days: [],
    hours: [],
    models: [],
    issues: [],
  };
}

function hourEntry(key: string, bucket: HourBucket): TokenUsageHour {
  const hour = Number(key.slice(key.indexOf("T") + 1));
  return Object.assign(
    { hour: Number.isFinite(hour) ? hour : 0, sessions: bucket.sessions.size },
    toWireCounters(bucket.counters),
  );
}

export function toWireCounters(counters: UsageCounters): TokenUsageCounters {
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
