/** Collection logging stays best-effort; the plugin process has no pino. */
export interface TokenUsageLogger {
  debug(...args: unknown[]): void;
}

/** Wire shape of one agent's usage snapshot. Mirrors shared/rpc.ts schemas. */
export type TokenUsageAgentId = "codebuddy" | "pi" | "opencode" | "devin" | "qoder";

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

/** 当天按小时的桶（只在「今天」窗口有值）。 */
export interface TokenUsageHour extends TokenUsageCounters {
  hour: number;
  sessions: number;
}

/** 一次失败的请求（限流、额度、鉴权、网络等）的归类；拿不到维度时留 null。 */
export type TokenUsageIssueKind =
  | "rate_limit"
  | "quota"
  | "auth"
  | "network"
  | "timeout"
  | "upstream"
  | "aborted"
  | "unknown";

/**
 * 结构化后的失败事件。同 kind / 同 code / 同重置时间的记录聚合成一条，
 * `message` 保留最近一次的原文，不做翻译。
 */
export interface TokenUsageIssue {
  kind: TokenUsageIssueKind;
  /** provider 自己的错误码（如 CodeBuddy 的 6004）。 */
  code: number | null;
  httpStatus: number | null;
  retryable: boolean | null;
  message: string;
  model: string | null;
  sessionId: string | null;
  firstAt: string;
  lastAt: string;
  count: number;
  /** 从文案里解析出的额度重置时间；解析不出即为 null。 */
  resetAt: string | null;
}

export interface TokenUsageAgent {
  agentId: TokenUsageAgentId;
  displayName: string;
  status: "available" | "unavailable" | "error" | "disabled";
  error: string | null;
  totals: TokenUsageCounters;
  sessions: number;
  days: TokenUsageDay[];
  /** 当天 0-23 点的用量；只记录窗口内的「今天」。 */
  hours: TokenUsageHour[];
  models: TokenUsageModel[];
  /** 本机当天 0 点以来的失败事件，与 7 / 30 天用量窗口不联动。 */
  issues: TokenUsageIssue[];
}
