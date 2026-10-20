import { describe, expect, it } from "vitest";
import {
  addUsageTo,
  countersFromDelta,
  emptyCounters,
  type UsageDelta,
  UsageAccumulator,
} from "./counters.js";

describe("countersFromDelta", () => {
  it("keeps unreported dimensions at null instead of zero", () => {
    const counters = countersFromDelta({ inputTokens: 10, outputTokens: 5 });
    expect(counters).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      requests: 1,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: null,
      costCredits: null,
    });
  });

  it("defaults requests to one per delta and honors explicit counts", () => {
    const counters = emptyCounters();
    addAll(counters, [{ inputTokens: 1 }, { inputTokens: 2, requests: 3 }]);
    expect(counters.requests).toBe(4);
  });

  it("falls back to input + output when totalTokens is missing", () => {
    const counters = countersFromDelta({ inputTokens: 2, outputTokens: 3, totalTokens: 100 });
    expect(counters.totalTokens).toBe(100);
    const summed = countersFromDelta({ inputTokens: 2, outputTokens: 3 });
    expect(summed.totalTokens).toBe(5);
  });
});

describe("UsageAccumulator", () => {
  it("rolls records into per-day buckets with distinct sessions", () => {
    const accumulator = new UsageAccumulator();
    accumulator.record({
      dayKey: "2026-10-13",
      sessionId: "s1",
      model: "m1",
      delta: { inputTokens: 10, outputTokens: 5 },
    });
    accumulator.record({
      dayKey: "2026-10-13",
      sessionId: "s2",
      model: "m1",
      delta: { inputTokens: 1, requests: 2 },
    });
    accumulator.record({
      dayKey: "2026-10-14",
      sessionId: "s1",
      delta: { outputTokens: 7, cacheReadTokens: 100 },
    });

    const agent = accumulator.toAgent({
      agentId: "pi",
      displayName: "Pi",
      status: "available",
    });

    expect(agent.totals).toEqual({
      inputTokens: 11,
      outputTokens: 12,
      totalTokens: 23,
      requests: 4,
      cacheReadTokens: 100,
    });
    expect(agent.sessions).toBe(2);
    expect(agent.days.map((day) => [day.date, day.sessions, day.totalTokens])).toEqual([
      ["2026-10-13", 2, 16],
      ["2026-10-14", 1, 7],
    ]);
    expect(agent.models?.map((model) => [model.model, model.totalTokens])).toEqual([["m1", 16]]);
  });

  it("aggregates issues by kind/code/status/reset and keeps the latest message", () => {
    const accumulator = new UsageAccumulator();
    const recorded = (
      timestampMs: number,
      message: string,
      extra?: { sessionId?: string },
    ) => {
      accumulator.recordIssue({
        kind: "quota",
        message,
        timestampMs,
        code: 6004,
        httpStatus: 429,
        retryable: false,
        resetAtMs: 1_792_500_562_000,
        model: "deepseek-v4.1-flash",
        sessionId: extra?.sessionId,
      });
    };
    recorded(2_000, "429 … (req-1)", { sessionId: "s1" });
    recorded(1_000, "429 … (req-2)", { sessionId: "s2" });
    // 重置时间不同 = 另一轮额度，单独成条。
    accumulator.recordIssue({
      kind: "quota",
      message: "429 … 将在 2026-10-27 09:09:22 UTC+8 重置",
      timestampMs: 3_000,
      code: 6004,
      httpStatus: 429,
      resetAtMs: 1_793_100_562_000,
    });
    accumulator.recordIssue({
      kind: "aborted",
      message: "Interrupted by user",
      timestampMs: 4_000,
    });

    const agent = accumulator.toAgent({
      agentId: "codebuddy",
      displayName: "CodeBuddy",
      status: "available",
    });

    expect(agent.issues).toHaveLength(3);
    // 最近的排前面：aborted(4s) > 新一轮额度(3s) > 聚合的额度(2s)。
    expect(agent.issues.map((issue) => [issue.kind, issue.count])).toEqual([
      ["aborted", 1],
      ["quota", 1],
      ["quota", 2],
    ]);
    const merged = agent.issues[2]!;
    expect(merged.message).toBe("429 … (req-1)");
    expect(merged.sessionId).toBe("s1");
    expect(merged.firstAt).toBe(new Date(1_000).toISOString());
    expect(merged.lastAt).toBe(new Date(2_000).toISOString());
    expect(merged.resetAt).toBe(new Date(1_792_500_562_000).toISOString());
    expect(agent.issues[1]!.resetAt).toBe(new Date(1_793_100_562_000).toISOString());
    expect(agent.issues[0]!.code).toBeNull();
  });
});

function addAll(target: ReturnType<typeof emptyCounters>, deltas: UsageDelta[]): void {
  for (const delta of deltas) {
    addUsageTo(target, delta);
  }
}
