import type { TokenUsageLogger } from "./types.js";
import type { TokenUsageAgent, TokenUsageAgentId } from "./types.js";
import type { YieldGate } from "./yield-gate.js";

export interface TokenUsageCollectContext {
  homeDir: string;
  nowMs: number;
  /** Start of the oldest day inside the window, host-local. */
  cutoffMs: number;
  windowDays: number;
  logger: TokenUsageLogger;
  gate: YieldGate;
}

export interface TokenUsageCollector {
  agentId: TokenUsageAgentId;
  displayName: string;
  collect(context: TokenUsageCollectContext): Promise<TokenUsageAgent>;
}
