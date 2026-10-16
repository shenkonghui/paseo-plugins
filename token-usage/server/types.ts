/** Collection logging stays best-effort; the plugin process has no pino. */
export interface TokenUsageLogger {
  debug(...args: unknown[]): void;
}

/** Wire shape of one agent's usage snapshot. Mirrors shared/rpc.ts schemas. */
export type TokenUsageAgentId = "codebuddy" | "pi" | "opencode" | "devin";

export interface TokenUsageCounters {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requests: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  costCredits?: number;
}

export interface TokenUsageDay {
  date: string;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requests: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  costCredits?: number;
}

export interface TokenUsageModel {
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requests: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  costCredits?: number;
}

export interface TokenUsageAgent {
  agentId: TokenUsageAgentId;
  displayName: string;
  status: "available" | "unavailable" | "error";
  error: string | null;
  totals: TokenUsageCounters;
  sessions: number;
  days: TokenUsageDay[];
  models: TokenUsageModel[];
}
