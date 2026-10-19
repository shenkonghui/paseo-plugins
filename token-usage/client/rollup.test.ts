import { describe, expect, it } from "vitest";
import type { TokenUsageAgent, TokenUsageDay, TokenUsageHour } from "../shared/rpc";
import type { TokenUsageWindowDays } from "./types";
import { agentWindow, combineAgentWindows, localDateKey, windowStartDateKey } from "./rollup";

// Fixed to a local noon so every window boundary is far from midnight.
const NOW = new Date(2026, 9, 14, 12, 0, 0).getTime();

function day(date: string, counters: Partial<TokenUsageDay>): TokenUsageDay {
  return {
    date,
    sessions: 1,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    requests: 0,
    ...counters,
  } as TokenUsageDay;
}

function agent(
  days: TokenUsageDay[],
  status: TokenUsageAgent["status"] = "available",
): TokenUsageAgent {
  return {
    agentId: "pi",
    displayName: "Pi",
    status,
    error: null,
    totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0 },
    sessions: 0,
    days,
    hours: [],
    models: [],
  };
}

describe("localDateKey", () => {
  it("formats local dates zero-padded", () => {
    expect(localDateKey(new Date(2026, 0, 5, 3, 0, 0).getTime())).toBe("2026-01-05");
  });
});

describe("windowStartDateKey", () => {
  it("starts today for the 1-day window", () => {
    expect(windowStartDateKey(NOW, 1)).toBe("2026-10-14");
  });

  it("includes today for the 7-day window", () => {
    expect(windowStartDateKey(NOW, 7)).toBe("2026-10-08");
  });
});

describe("agentWindow", () => {
  it("slices days into the window and sums counters with sessions", () => {
    const pi = agent([
      day("2026-10-06", { totalTokens: 100, inputTokens: 60, outputTokens: 40, requests: 2 }),
      day("2026-10-10", {
        totalTokens: 10,
        inputTokens: 6,
        outputTokens: 4,
        requests: 1,
        sessions: 2,
      }),
      day("2026-10-14", {
        totalTokens: 5,
        inputTokens: 3,
        outputTokens: 2,
        requests: 1,
        costUsd: 0.25,
      }),
    ]);

    const week = agentWindow(pi, 7, NOW);
    expect(week.days.map((entry) => entry.date)).toEqual(["2026-10-10", "2026-10-14"]);
    expect(week.sessions).toBe(3);
    expect(week.totals.totalTokens).toBe(15);
    expect(week.totals.requests).toBe(2);
    expect(week.totals.costUsd).toBe(0.25);

    const today = agentWindow(pi, 1, NOW);
    expect(today.days.map((entry) => entry.date)).toEqual(["2026-10-14"]);
  });
});

describe("combineAgentWindows", () => {
  it("fills every calendar day in the window and merges agents", () => {
    const pi = agent([day("2026-10-13", { totalTokens: 8, requests: 1 })]);
    const other = agent([day("2026-10-14", { totalTokens: 3, requests: 1, cacheReadTokens: 9 })]);

    // 3 天窗口不在 TokenUsageWindowDays 联合类型内，仅用于测试日界计算。
    const combined = combineAgentWindows([pi, other], 3 as TokenUsageWindowDays, NOW);

    expect(combined.days.map((entry) => entry.date)).toEqual([
      "2026-10-12",
      "2026-10-13",
      "2026-10-14",
    ]);
    expect(combined.days[0]!.counters.totalTokens).toBe(0);
    expect(combined.days[1]!.counters.totalTokens).toBe(8);
    expect(combined.days[2]!.counters.cacheReadTokens).toBe(9);
    expect(combined.totals.totalTokens).toBe(11);
    expect(combined.totals.requests).toBe(2);
    expect(combined.agents).toHaveLength(2);
  });

  it("merges hourly buckets across agents into a 24-slot series", () => {
    const hour = (value: number, totalTokens: number): TokenUsageHour => ({
      hour: value,
      sessions: 1,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens,
      requests: 1,
    });
    const first: TokenUsageAgent = {
      ...agent([day("2026-10-14", {})]),
      hours: [hour(9, 5), hour(10, 2)],
    };
    const second: TokenUsageAgent = {
      ...agent([day("2026-10-14", {})]),
      hours: [hour(9, 3)],
    };

    const combined = combineAgentWindows([first, second], 1, NOW);

    expect(combined.hours).toHaveLength(24);
    expect(combined.hours[9]!.counters.totalTokens).toBe(8);
    expect(combined.hours[10]!.counters.totalTokens).toBe(2);
    expect(combined.hours[0]!.counters.totalTokens).toBe(0);
  });
});
