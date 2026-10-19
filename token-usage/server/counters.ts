import type {
  TokenUsageAgent,
  TokenUsageAgentId,
  TokenUsageCounters,
  TokenUsageDay,
  TokenUsageHour,
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

/** Rolls per-call records into per-day, per-model, and overall buckets. */
export class UsageAccumulator {
  private readonly days = new Map<string, DayBucket>();
  private readonly hours = new Map<string, DayBucket>();
  private readonly models = new Map<string, ModelBucket>();
  private readonly sessions = new Set<string>();
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
    };
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
