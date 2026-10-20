import type { TokenUsageLogger } from "./types.js";
import type { TokenUsageAgent, TokenUsageAgentId } from "./types.js";
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
  collect(context: TokenUsageCollectContext): Promise<TokenUsageAgent>;
}
