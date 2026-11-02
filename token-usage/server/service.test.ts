import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { TokenUsageService } from "./service.js";
import type { TokenUsageCollectContext, TokenUsageCollector } from "./collector.js";
import { UsageAccumulator, type CollectedTokenUsage } from "./counters.js";
import { dayKeysBetween, localDayKey, windowCutoffMs } from "./day-window.js";
import type {
  AgentCleanupResult,
  AgentDiskUsage,
  StorageContext,
  TokenUsageStorageTarget,
} from "./storage/index.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "token-usage-service-"));
const cacheFile = path.join(tempRoot, "usage-cache.json");

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function usage(agentId: AgentDiskUsage["agentId"], totalBytes: number): AgentDiskUsage {
  return {
    agentId,
    displayName: agentId,
    status: "available",
    error: null,
    totalBytes,
    paths: [],
    sessionCount: 3,
    sessionBytes: 100,
    staleSessionCount: 1,
    staleSessionBytes: 50,
  };
}

function stubTarget(
  measure: (context: StorageContext) => Promise<AgentDiskUsage>,
  cleanup: (context: StorageContext) => Promise<AgentCleanupResult>,
): TokenUsageStorageTarget {
  return { agentId: "codebuddy", displayName: "CodeBuddy", measure, cleanup };
}

describe("TokenUsageService disk usage", () => {
  it("caches per threshold and re-measures after cleanup", async () => {
    let nowMs = 1_000_000;
    const measure = vi.fn(async (context: StorageContext) => usage("codebuddy", context.nowMs));
    const cleanup = vi.fn(
      async (): Promise<AgentCleanupResult> => ({
        agentId: "codebuddy",
        displayName: "CodeBuddy",
        status: "cleaned",
        removedSessions: 1,
        freedBytes: 500,
        error: null,
      }),
    );
    const service = new TokenUsageService({
      logger: console,
      collectors: [],
      storageTargets: [stubTarget(measure, cleanup)],
      homeDir: tempRoot,
      cacheFile,
      diskCacheTtlMs: 1000,
      now: () => nowMs,
    });

    const first = await service.diskUsage({ olderThanDays: 30 });
    expect(measure).toHaveBeenCalledTimes(1);
    expect(first.result.staleDays).toBe(30);

    // 命中缓存，不再遍历。
    await service.diskUsage({ olderThanDays: 30 });
    expect(measure).toHaveBeenCalledTimes(1);

    // 超过 TTL 后返回旧快照并标记 stale，但不重新统计。
    nowMs += 2000;
    const expired = await service.diskUsage({ olderThanDays: 30 });
    expect(expired.stale).toBe(true);
    expect(measure).toHaveBeenCalledTimes(1);

    // 强制刷新会重新统计。
    await service.diskUsage({ forceRefresh: true, olderThanDays: 30 });
    expect(measure).toHaveBeenCalledTimes(2);

    // 清理后重新统计一次，并返回清理结果。
    const outcome = await service.cleanupSessions({ olderThanDays: 30 });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(outcome.results[0]?.removedSessions).toBe(1);
    expect(measure).toHaveBeenCalledTimes(3);
  });

  it("only cleans the requested agents", async () => {
    const cleaned: string[] = [];
    const targets = (["codebuddy", "devin"] as const).map((agentId) => ({
      agentId,
      displayName: agentId,
      measure: async () => usage(agentId, 0),
      cleanup: async (): Promise<AgentCleanupResult> => {
        cleaned.push(agentId);
        return {
          agentId,
          displayName: agentId,
          status: "skipped",
          removedSessions: 0,
          freedBytes: 0,
          error: null,
        };
      },
    }));
    const service = new TokenUsageService({
      logger: console,
      collectors: [],
      storageTargets: targets,
      homeDir: tempRoot,
      cacheFile,
      now: () => 1_000_000,
    });

    const outcome = await service.cleanupSessions({ agentIds: ["devin"] });
    expect(cleaned).toEqual(["devin"]);
    expect(outcome.results).toHaveLength(1);
  });
});

/** 每天 10 input / 5 output，同一会话跨天续用。 */
function buildUsage(context: TokenUsageCollectContext): CollectedTokenUsage {
  const todayKey = localDayKey(windowCutoffMs(context.nowMs, 1));
  const accumulator = new UsageAccumulator();
  for (const key of dayKeysBetween(context.cutoffMs, context.nowMs)) {
    accumulator.record({
      dayKey: key,
      hourKey: key === todayKey ? `${key}T09` : undefined,
      sessionId: "session-1",
      model: "model-1",
      delta: { inputTokens: 10, outputTokens: 5 },
    });
  }
  return accumulator.toCollectedAgent({
    agentId: "codebuddy",
    displayName: "CodeBuddy",
    status: "available",
    sources: [],
    todayMs: windowCutoffMs(context.nowMs, 1),
  });
}

interface StubCollector extends TokenUsageCollector {
  calls: TokenUsageCollectContext[];
}

function stubCollector(collect: (context: TokenUsageCollectContext) => CollectedTokenUsage): StubCollector {
  const calls: TokenUsageCollectContext[] = [];
  return {
    agentId: "codebuddy",
    displayName: "CodeBuddy",
    calls,
    async collect(context) {
      calls.push(context);
      return collect(context);
    },
  };
}

describe("TokenUsageService day cache", () => {
  function makeService(input: {
    now: () => number;
    collector: StubCollector;
    cacheFile: string;
    storageTargets?: TokenUsageStorageTarget[];
  }) {
    return new TokenUsageService({
      logger: console,
      collectors: [input.collector],
      storageTargets: input.storageTargets ?? [],
      homeDir: tempRoot,
      cacheFile: input.cacheFile,
      now: input.now,
    });
  }

  it("拼装窗口不重扫，刷新只重采今天", async () => {
    let nowMs = new Date(2026, 10, 2, 12, 0, 0).getTime();
    const collector = stubCollector(buildUsage);
    const service = makeService({
      now: () => nowMs,
      collector,
      cacheFile: path.join(tempRoot, "window-cache.json"),
    });

    const wide = await service.listUsage({ windowDays: 30 });
    expect(collector.calls).toHaveLength(1);
    expect(collector.calls[0]?.cutoffMs).toBe(windowCutoffMs(nowMs, 30));
    expect(wide.result.agents[0]?.days).toHaveLength(30);
    expect(wide.result.agents[0]?.totals.inputTokens).toBe(300);

    // 切到 7 天：从缓存拼装，不再采集。
    const narrow = await service.listUsage({ windowDays: 7 });
    expect(collector.calls).toHaveLength(1);
    expect(narrow.stale).toBe(false);
    expect(narrow.result.agents[0]?.days).toHaveLength(7);
    expect(narrow.result.agents[0]?.totals.inputTokens).toBe(70);

    // 「今天」仍能给出小时视图。
    const today = await service.listUsage({ windowDays: 1 });
    expect(today.result.agents[0]?.hours).toHaveLength(1);

    // 强制刷新只重采今天，历史天原样复用（不会把今天的量叠加两次）。
    await service.listUsage({ windowDays: 30, forceRefresh: true });
    expect(collector.calls).toHaveLength(2);
    expect(collector.calls[1]?.cutoffMs).toBe(windowCutoffMs(nowMs, 1));

    const refreshed = await service.listUsage({ windowDays: 30 });
    expect(refreshed.result.agents[0]?.totals.inputTokens).toBe(300);
    expect(refreshed.result.agents[0]?.days).toHaveLength(30);
  });

  it("过期只标记 stale，跨天只补新的一天", async () => {
    let nowMs = new Date(2026, 10, 2, 12, 0, 0).getTime();
    const collector = stubCollector(buildUsage);
    const service = makeService({
      now: () => nowMs,
      collector,
      cacheFile: path.join(tempRoot, "stale-cache.json"),
    });

    await service.listUsage({ windowDays: 7 });
    expect(collector.calls).toHaveLength(1);

    // TTL 内是 fresh；超过 1 小时后只标记 stale，不自动重采。
    nowMs += 30 * 60 * 1000;
    expect((await service.listUsage({ windowDays: 7 })).stale).toBe(false);
    nowMs += 40 * 60 * 1000;
    const stale = await service.listUsage({ windowDays: 7 });
    expect(stale.stale).toBe(true);
    expect(collector.calls).toHaveLength(1);

    // 跨天后昨天的桶保留，只补新的一天。
    nowMs = new Date(2026, 10, 3, 9, 0, 0).getTime();
    const rolled = await service.listUsage({ windowDays: 7 });
    expect(collector.calls).toHaveLength(2);
    expect(collector.calls[1]?.cutoffMs).toBe(windowCutoffMs(nowMs, 1));
    expect(rolled.stale).toBe(false);
    expect(rolled.result.agents[0]?.days).toHaveLength(7);
    // 同一会话跨天续用只算一次。
    expect(rolled.result.agents[0]?.sessions).toBe(1);
  });

  it("窗口扩大时只补缺口", async () => {
    const nowMs = new Date(2026, 10, 2, 12, 0, 0).getTime();
    const collector = stubCollector(buildUsage);
    const service = makeService({
      now: () => nowMs,
      collector,
      cacheFile: path.join(tempRoot, "gap-cache.json"),
    });

    await service.listUsage({ windowDays: 7 });
    const wide = await service.listUsage({ windowDays: 30 });
    expect(collector.calls).toHaveLength(2);
    expect(collector.calls[1]?.cutoffMs).toBe(windowCutoffMs(nowMs, 30));
    expect(wide.result.agents[0]?.days).toHaveLength(30);
    expect(wide.result.agents[0]?.totals.inputTokens).toBe(300);
  });

  it("重启后直接读回落盘缓存", async () => {
    const nowMs = new Date(2026, 10, 2, 12, 0, 0).getTime();
    const cacheFile = path.join(tempRoot, "restart-cache.json");
    const first = stubCollector(buildUsage);
    await makeService({ now: () => nowMs, collector: first, cacheFile }).listUsage({
      windowDays: 30,
    });
    expect(first.calls).toHaveLength(1);

    const restarted = stubCollector(buildUsage);
    const served = await makeService({ now: () => nowMs, collector: restarted, cacheFile }).listUsage(
      { windowDays: 30 },
    );
    expect(restarted.calls).toHaveLength(0);
    expect(served.result.agents[0]?.days).toHaveLength(30);
    expect(served.result.agents[0]?.totals.inputTokens).toBe(300);
  });

  it("清理会话后按天缓存失效", async () => {
    const nowMs = new Date(2026, 10, 2, 12, 0, 0).getTime();
    const collector = stubCollector(buildUsage);
    const target = stubTarget(
      async () => usage("codebuddy", 0),
      async (): Promise<AgentCleanupResult> => ({
        agentId: "codebuddy",
        displayName: "CodeBuddy",
        status: "cleaned",
        removedSessions: 1,
        freedBytes: 100,
        error: null,
      }),
    );
    const service = makeService({
      now: () => nowMs,
      collector,
      cacheFile: path.join(tempRoot, "cleanup-cache.json"),
      storageTargets: [target],
    });

    await service.listUsage({ windowDays: 7 });
    expect(collector.calls).toHaveLength(1);

    await service.cleanupSessions({ olderThanDays: 7 });

    await service.listUsage({ windowDays: 7 });
    expect(collector.calls).toHaveLength(2);
    expect(collector.calls[1]?.cutoffMs).toBe(windowCutoffMs(nowMs, 7));
  });
});
