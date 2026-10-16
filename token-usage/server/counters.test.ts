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
});

function addAll(target: ReturnType<typeof emptyCounters>, deltas: UsageDelta[]): void {
  for (const delta of deltas) {
    addUsageTo(target, delta);
  }
}
