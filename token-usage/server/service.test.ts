import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { TokenUsageService } from "./service.js";
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
