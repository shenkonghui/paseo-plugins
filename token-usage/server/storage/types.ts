import type { TokenUsageAgentId, TokenUsageLogger } from "../types.js";
import type { YieldGate } from "../yield-gate.js";

/** 测量与清理共用的上下文。 */
export interface StorageContext {
  homeDir: string;
  nowMs: number;
  /** 早于该时间且之后没有新活动的会话视为过期，可被清理。 */
  staleCutoffMs: number;
  logger: TokenUsageLogger;
  gate: YieldGate;
}

/** 一个 agent 在本机的磁盘占用快照。 */
export interface AgentDiskUsage {
  agentId: TokenUsageAgentId;
  displayName: string;
  status: "available" | "unavailable" | "error";
  error: string | null;
  /** 数据根目录的递归总占用（含日志、快照等，不只会话）。 */
  totalBytes: number;
  /** 数据根路径，仅用于展示。 */
  paths: string[];
  /** 会话总数。 */
  sessionCount: number;
  /** 会话数据占用；数据库型 agent 取库文件（db + wal + shm）大小。 */
  sessionBytes: number;
  /** 过期（默认 30 天前）会话数。 */
  staleSessionCount: number;
  /** 清理过期会话预计可释放的字节数；数据库型为按比例估算。 */
  staleSessionBytes: number;
}

export interface AgentCleanupResult {
  agentId: TokenUsageAgentId;
  displayName: string;
  status: "cleaned" | "skipped" | "error";
  removedSessions: number;
  /** 实际释放的字节数；数据库型为 VACUUM 前后库文件大小之差。 */
  freedBytes: number;
  error: string | null;
}

export interface TokenUsageStorageTarget {
  agentId: TokenUsageAgentId;
  displayName: string;
  measure(context: StorageContext): Promise<AgentDiskUsage>;
  /** 删除 staleCutoffMs 之前的会话；没有过期会话时返回 skipped。 */
  cleanup(context: StorageContext): Promise<AgentCleanupResult>;
}

/** 过期判定：默认 30 天前。 */
export function staleCutoffMs(nowMs: number, olderThanDays: number): number {
  const days = Math.max(1, Math.floor(olderThanDays));
  return nowMs - days * 24 * 60 * 60 * 1000;
}
