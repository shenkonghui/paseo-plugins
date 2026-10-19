import path from "node:path";
import { createFileSessionStorage } from "./file-sessions.js";
import type {
  AgentCleanupResult,
  AgentDiskUsage,
  StorageContext,
  TokenUsageStorageTarget,
} from "./types.js";

/**
 * Qoder 国内版（`~/.qoder-cn`）与国际版（`~/.qoder`）是两个数据根，却共用同一个
 * agentId，所以把两个文件型目标合成一个：占用相加、清理合并，面板上只出现一张卡片。
 * 与本插件其它 agent 一样，会话的附属目录（`<uuid>/`，含 `subagents/`）一并计入并清理。
 */
export function createQoderStorage(): TokenUsageStorageTarget {
  const targets = [".qoder-cn", ".qoder"].map((dir) =>
    createFileSessionStorage({
      agentId: "qoder",
      displayName: "Qoder",
      rootDir: (homeDir) => path.join(homeDir, dir),
      sessionsDir: (homeDir) => path.join(homeDir, dir, "projects"),
      extension: ".jsonl",
      includeSiblingDirs: true,
    }),
  );

  return {
    agentId: "qoder",
    displayName: "Qoder",

    async measure(context: StorageContext): Promise<AgentDiskUsage> {
      const results = await Promise.all(targets.map((target) => target.measure(context)));
      const available = results.filter((result) => result.status === "available");
      if (available.length === 0) {
        // 两个根都不存在时才算「未安装」；只有一个根时按存在的那份统计。
        const status = results.some((result) => result.status === "error") ? "error" : "unavailable";
        return {
          agentId: "qoder",
          displayName: "Qoder",
          status,
          error: joinErrors(results.map((result) => result.error)) ?? null,
          totalBytes: 0,
          paths: results.flatMap((result) => result.paths),
          sessionCount: 0,
          sessionBytes: 0,
          staleSessionCount: 0,
          staleSessionBytes: 0,
        };
      }
      return {
        agentId: "qoder",
        displayName: "Qoder",
        status: "available",
        error: null,
        totalBytes: sum(available, (result) => result.totalBytes),
        paths: available.flatMap((result) => result.paths),
        sessionCount: sum(available, (result) => result.sessionCount),
        sessionBytes: sum(available, (result) => result.sessionBytes),
        staleSessionCount: sum(available, (result) => result.staleSessionCount),
        staleSessionBytes: sum(available, (result) => result.staleSessionBytes),
      };
    },

    async cleanup(context: StorageContext): Promise<AgentCleanupResult> {
      const results: AgentCleanupResult[] = [];
      for (const target of targets) {
        results.push(await target.cleanup(context));
      }
      const removedSessions = sum(results, (result) => result.removedSessions);
      const freedBytes = sum(results, (result) => result.freedBytes);
      const errors = results.map((result) => result.error);
      const hasError = results.some((result) => result.status === "error");
      return {
        agentId: "qoder",
        displayName: "Qoder",
        status: removedSessions > 0 ? "cleaned" : hasError ? "error" : "skipped",
        removedSessions,
        freedBytes,
        error: joinErrors(errors) ?? null,
      };
    },
  };
}

function sum<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}

function joinErrors(errors: readonly (string | null)[]): string | undefined {
  const present = errors.filter((error): error is string => !!error);
  return present.length > 0 ? present.slice(0, 3).join("; ") : undefined;
}
