import type { TokenUsageAgent, TokenUsageDay, TokenUsageHour } from "../shared/rpc";
import type { TokenUsageWindowDays } from "./types";

/** Accepts both wire counters (optional, undefined) and window counters (null). */
interface CounterSource {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requests: number;
  reasoningTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  costUsd?: number | null;
  costCredits?: number | null;
}

export interface WindowCounters {
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

export interface AgentWindow {
  totals: WindowCounters;
  days: TokenUsageDay[];
  /** 当天 0-23 点（只用于「今天」窗口）。 */
  hours: TokenUsageHour[];
  sessions: number;
}

/** Local YYYY-MM-DD key; mirrors the daemon's localDayKey bucketing. */
export function localDateKey(ms: number): string {
  const date = new Date(ms);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function windowStartDateKey(nowMs: number, days: TokenUsageWindowDays): string {
  return localDateKey(nowMs - (days - 1) * 24 * 60 * 60 * 1000);
}

export function emptyWindowCounters(): WindowCounters {
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

function addCountersTo(target: WindowCounters, counters: CounterSource): void {
  target.inputTokens += counters.inputTokens;
  target.outputTokens += counters.outputTokens;
  target.totalTokens += counters.totalTokens;
  target.requests += counters.requests;
  target.reasoningTokens = addToOptional(target.reasoningTokens, counters.reasoningTokens);
  target.cacheReadTokens = addToOptional(target.cacheReadTokens, counters.cacheReadTokens);
  target.cacheWriteTokens = addToOptional(target.cacheWriteTokens, counters.cacheWriteTokens);
  target.costUsd = addToOptional(target.costUsd, counters.costUsd);
  target.costCredits = addToOptional(target.costCredits, counters.costCredits);
}

function addToOptional(target: number | null, value: number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return target;
  }
  return (target ?? 0) + value;
}

function dayIsInWindow(date: string, startKey: string): boolean {
  return date >= startKey;
}

/** Slices one agent's 30-day payload down to the requested window. */
export function agentWindow(
  agent: TokenUsageAgent,
  days: TokenUsageWindowDays,
  nowMs: number,
): AgentWindow {
  const startKey = windowStartDateKey(nowMs, days);
  const inWindow = agent.days.filter((day) => dayIsInWindow(day.date, startKey));
  const totals = emptyWindowCounters();
  for (const day of inWindow) {
    addCountersTo(totals, day);
  }
  return {
    totals,
    days: inWindow,
    hours: agent.hours,
    sessions: inWindow.reduce((sum, day) => sum + day.sessions, 0),
  };
}

export interface CombinedWindow {
  totals: WindowCounters;
  /** One entry per calendar day in the window (oldest first), zeros included. */
  days: Array<{ date: string; counters: WindowCounters }>;
  /** 当天 0-23 点（本地时区），只在「今天」窗口用于小时视图。 */
  hours: Array<{ hour: number; counters: WindowCounters }>;
  agents: Array<{ agent: TokenUsageAgent; window: AgentWindow }>;
}

/** Rolls all agents into shared day buckets so the chart can stack/compare them. */
export function combineAgentWindows(
  agents: TokenUsageAgent[],
  days: TokenUsageWindowDays,
  nowMs: number,
): CombinedWindow {
  const byDate = new Map<string, WindowCounters>();
  const endKey = localDateKey(nowMs);
  for (let ms = nowMs - (days - 1) * 24 * 60 * 60 * 1000; ; ms += 24 * 60 * 60 * 1000) {
    const key = localDateKey(ms);
    byDate.set(key, emptyWindowCounters());
    if (key >= endKey) {
      break;
    }
  }

  const perAgent = agents.map((agent) => {
    const window = agentWindow(agent, days, nowMs);
    for (const day of window.days) {
      const bucket = byDate.get(day.date);
      if (bucket) {
        addCountersTo(bucket, day);
      }
    }
    return { agent, window };
  });

  const totals = emptyWindowCounters();
  for (const { window } of perAgent) {
    addCountersTo(totals, window.totals);
  }

  // 小时桶固定 24 个，缺的补零，方便画图。
  const byHour = new Map<number, WindowCounters>();
  for (let hour = 0; hour < 24; hour += 1) {
    byHour.set(hour, emptyWindowCounters());
  }
  for (const { agent } of perAgent) {
    // 老快照没有 hours 字段，按空处理。
    for (const hour of agent.hours ?? []) {
      const bucket = byHour.get(hour.hour);
      if (bucket) {
        addCountersTo(bucket, hour);
      }
    }
  }

  return {
    totals,
    days: [...byDate.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, counters]) => ({ date, counters })),
    hours: [...byHour.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([hour, counters]) => ({ hour, counters })),
    agents: perAgent,
  };
}
