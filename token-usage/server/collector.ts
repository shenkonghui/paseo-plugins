import path from "node:path";
import type { TokenUsageLogger } from "./types.js";
import type { TokenUsageAgent, TokenUsageAgentId } from "./types.js";
import type { CollectedTokenUsage } from "./counters.js";
import type { YieldGate } from "./yield-gate.js";

export interface TokenUsageCollectContext {
  homeDir: string;
  nowMs: number;
  /** Start of the oldest day inside the window, host-local. */
  cutoffMs: number;
  /** 失败事件的回看下界（本机当天 0 点），与 7 / 30 天用量窗口无关。 */
  issueCutoffMs: number;
  /** Start of today (host-local)，用来决定是否记录小时桶。 */
  todayStartMs: number;
  windowDays: number;
  logger: TokenUsageLogger;
  gate: YieldGate;
}

export interface TokenUsageCollector {
  agentId: TokenUsageAgentId;
  displayName: string;
  collect(context: TokenUsageCollectContext): Promise<CollectedTokenUsage>;
}

/**
 * 采集不到数据（数据源缺失、读取失败）时的结果：只保留 agent 占位，
 * 没有按天明细，本次采集范围内落成空桶。
 */
export function collectionOf(agent: TokenUsageAgent): CollectedTokenUsage {
  return { agent, days: new Map() };
}

/** 数据源路径的展示形式：home 下缩成 `~/...`，其余保留绝对路径。 */
export function displaySourcePath(homeDir: string, target: string): string {
  const relative = path.relative(homeDir, target);
  if (relative.length === 0) {
    return "~";
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return target;
  }
  return `~/${relative.split(path.sep).join("/")}`;
}
