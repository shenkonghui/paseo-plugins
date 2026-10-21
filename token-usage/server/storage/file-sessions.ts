import { rm } from "node:fs/promises";
import path from "node:path";
import type { TokenUsageAgentId, TokenUsageLogger } from "../types.js";
import type {
  AgentCleanupResult,
  AgentDiskUsage,
  StorageContext,
  TokenUsageStorageTarget,
} from "./types.js";
import { directorySize, listSessionArtifacts, pathExists } from "./shared.js";

export interface FileSessionStorageOptions {
  agentId: TokenUsageAgentId;
  displayName: string;
  /** 数据根目录：用于统计「本地总占用」。 */
  rootDir(homeDir: string): string;
  /** 会话文件所在目录。 */
  sessionsDir(homeDir: string): string;
  extension: string;
  /** 是否把同名附属目录一并计入并清理（CodeBuddy）。 */
  includeSiblingDirs: boolean;
}

/**
 * 文件型 agent（CodeBuddy / Pi）：一个 `.jsonl` 就是一个会话，过期清理即删文件。
 * 总占用统计整个数据根，会话占用只统计会话文件与其附属目录。
 */
export function createFileSessionStorage(
  options: FileSessionStorageOptions,
): TokenUsageStorageTarget {
  const { agentId, displayName, extension, includeSiblingDirs } = options;

  async function measure(context: StorageContext): Promise<AgentDiskUsage> {
    const root = options.rootDir(context.homeDir);
    if (!(await pathExists(root))) {
      return unavailable(agentId, displayName, root);
    }

    const totalBytes = await directorySize(root, context.gate);
    const artifacts = await listSessionArtifacts(
      options.sessionsDir(context.homeDir),
      extension,
      includeSiblingDirs,
      context.gate,
    );
    const stale = artifacts.filter((artifact) => artifact.mtimeMs < context.staleCutoffMs);

    return {
      agentId,
      displayName,
      status: "available",
      error: null,
      totalBytes,
      paths: [root],
      sessionCount: artifacts.length,
      sessionBytes: sum(artifacts, (artifact) => artifact.bytes),
      staleSessionCount: stale.length,
      staleSessionBytes: sum(stale, (artifact) => artifact.bytes),
    };
  }

  async function cleanup(context: StorageContext): Promise<AgentCleanupResult> {
    const root = options.rootDir(context.homeDir);
    if (!(await pathExists(root))) {
      return {
        agentId,
        displayName,
        status: "error",
        removedSessions: 0,
        freedBytes: 0,
        error: `未找到数据目录 ${root}`,
      };
    }

    const artifacts = await listSessionArtifacts(
      options.sessionsDir(context.homeDir),
      extension,
      includeSiblingDirs,
      context.gate,
    );
    const stale = artifacts.filter((artifact) => artifact.mtimeMs < context.staleCutoffMs);
    if (stale.length === 0) {
      return {
        agentId,
        displayName,
        status: "skipped",
        removedSessions: 0,
        freedBytes: 0,
        error: null,
      };
    }

    let removedSessions = 0;
    let freedBytes = 0;
    const failures: string[] = [];
    for (const artifact of stale) {
      await context.gate.maybeYield();
      try {
        for (const target of [artifact.mainPath, ...artifact.extraPaths]) {
          await rm(target, { recursive: true, force: true });
        }
        removedSessions += 1;
        freedBytes += artifact.bytes;
      } catch (error) {
        failures.push(`${path.basename(artifact.mainPath)}: ${messageOf(error)}`);
      }
    }

    if (removedSessions === 0 && failures.length > 0) {
      return {
        agentId,
        displayName,
        status: "error",
        removedSessions: 0,
        freedBytes: 0,
        error: failures.slice(0, 3).join("; "),
      };
    }
    return {
      agentId,
      displayName,
      status: "cleaned",
      removedSessions,
      freedBytes,
      error: failures.length > 0 ? `${failures.length} 个会话删除失败：${failures[0]}` : null,
    };
  }

  return { agentId, displayName, measure, cleanup };
}

export interface FileSessionRoot {
  /** 数据根目录：用于统计「本地总占用」。 */
  rootDir: string;
  /** 会话文件所在目录。 */
  sessionsDir: string;
}

export interface MergedFileSessionStorageOptions {
  agentId: TokenUsageAgentId;
  displayName: string;
  /** 同一 agent 的多个数据根（国内 / 国际版、Paseo 独立 home……）。 */
  roots(homeDir: string): FileSessionRoot[];
  extension: string;
  includeSiblingDirs: boolean;
}

/**
 * 多个数据根共用一个 agentId：占用相加、清理合并，面板上只出现一张卡片。
 * 与单个数据根一样，会话的附属目录（`<uuid>/`）一并计入并清理。
 */
export function createMergedFileSessionStorage(
  options: MergedFileSessionStorageOptions,
): TokenUsageStorageTarget {
  const { agentId, displayName } = options;

  function targetsFor(homeDir: string): TokenUsageStorageTarget[] {
    return options.roots(homeDir).map((root) =>
      createFileSessionStorage({
        agentId,
        displayName,
        rootDir: () => root.rootDir,
        sessionsDir: () => root.sessionsDir,
        extension: options.extension,
        includeSiblingDirs: options.includeSiblingDirs,
      }),
    );
  }

  return {
    agentId,
    displayName,

    async measure(context: StorageContext): Promise<AgentDiskUsage> {
      const results = await Promise.all(
        targetsFor(context.homeDir).map((target) => target.measure(context)),
      );
      const available = results.filter((result) => result.status === "available");
      if (available.length === 0) {
        // 所有根都不存在时才算「未安装」；只有部分根存在时按存在的那份统计。
        const status = results.some((result) => result.status === "error") ? "error" : "unavailable";
        return {
          agentId,
          displayName,
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
        agentId,
        displayName,
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
      for (const target of targetsFor(context.homeDir)) {
        results.push(await target.cleanup(context));
      }
      const removedSessions = sum(results, (result) => result.removedSessions);
      const freedBytes = sum(results, (result) => result.freedBytes);
      const hasError = results.some((result) => result.status === "error");
      return {
        agentId,
        displayName,
        status: removedSessions > 0 ? "cleaned" : hasError ? "error" : "skipped",
        removedSessions,
        freedBytes,
        error: joinErrors(results.map((result) => result.error)) ?? null,
      };
    },
  };
}

function joinErrors(errors: readonly (string | null)[]): string | undefined {
  const present = errors.filter((error): error is string => !!error);
  return present.length > 0 ? present.slice(0, 3).join("; ") : undefined;
}

function sum<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}

export function unavailable(
  agentId: TokenUsageAgentId,
  displayName: string,
  root: string,
): AgentDiskUsage {
  return {
    agentId,
    displayName,
    status: "unavailable",
    error: `未找到数据目录 ${root}`,
    totalBytes: 0,
    paths: [root],
    sessionCount: 0,
    sessionBytes: 0,
    staleSessionCount: 0,
    staleSessionBytes: 0,
  };
}

export function errorUsage(
  agentId: TokenUsageAgentId,
  displayName: string,
  logger: TokenUsageLogger,
  error: unknown,
  paths: string[],
): AgentDiskUsage {
  logger.debug({ err: error, agentId }, "Token usage disk measurement failed");
  return {
    agentId,
    displayName,
    status: "error",
    error: messageOf(error),
    totalBytes: 0,
    paths,
    sessionCount: 0,
    sessionBytes: 0,
    staleSessionCount: 0,
    staleSessionBytes: 0,
  };
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
