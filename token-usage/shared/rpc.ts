import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const tokenUsageCountersSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  requests: z.number(),
  reasoningTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  cacheWriteTokens: z.number().optional(),
  costUsd: z.number().optional(),
  costCredits: z.number().optional(),
});

export const tokenUsageDaySchema = z.object({
  date: z.string(),
  sessions: z.number().int(),
  ...tokenUsageCountersSchema.shape,
});

export const tokenUsageHourSchema = z.object({
  hour: z.number().int().min(0).max(23),
  sessions: z.number().int(),
  ...tokenUsageCountersSchema.shape,
});

export const tokenUsageModelSchema = z.object({
  model: z.string(),
  ...tokenUsageCountersSchema.shape,
});

export const tokenUsageAgentIdSchema = z.enum(["codebuddy", "pi", "opencode", "devin"]);

export const tokenUsageAgentSchema = z.object({
  agentId: tokenUsageAgentIdSchema,
  displayName: z.string(),
  status: z.enum(["available", "unavailable", "error", "disabled"]),
  error: z.string().nullable(),
  totals: tokenUsageCountersSchema,
  sessions: z.number().int(),
  days: z.array(tokenUsageDaySchema),
  /** 当天 0-23 点的用量；「今天」窗口的小时视图使用。 */
  hours: z.array(tokenUsageHourSchema).default([]),
  models: z.array(tokenUsageModelSchema),
});

export const tokenUsageListRpc = defineRpc({
  name: "token-usage.list",
  input: z.object({
    forceRefresh: z.boolean().default(false),
    /** 采集窗口（天）。按所选窗口采集，避免为了「今天」也去扫 30 天。 */
    windowDays: z.union([z.literal(1), z.literal(7), z.literal(30)]).default(30),
  }),
  output: z.object({
    fetchedAt: z.string(),
    /** Host-local days of history the snapshot covers, ending today. */
    rangeDays: z.number().int(),
    agents: z.array(tokenUsageAgentSchema),
    /** True when the served snapshot is older than the TTL. */
    stale: z.boolean().default(false),
  }),
});

export type TokenUsageCounters = z.output<typeof tokenUsageCountersSchema>;
export type TokenUsageDay = z.output<typeof tokenUsageDaySchema>;
export type TokenUsageHour = z.output<typeof tokenUsageHourSchema>;
export type TokenUsageModel = z.output<typeof tokenUsageModelSchema>;
export type TokenUsageAgent = z.output<typeof tokenUsageAgentSchema>;
export type TokenUsageListOutput = z.output<typeof tokenUsageListRpc.output>;

/** 单个 agent 的本地磁盘占用。 */
export const tokenUsageDiskAgentSchema = z.object({
  agentId: tokenUsageAgentIdSchema,
  displayName: z.string(),
  status: z.enum(["available", "unavailable", "error"]),
  error: z.string().nullable(),
  /** 数据根目录的递归总占用（字节）。 */
  totalBytes: z.number(),
  /** 数据根路径，仅用于展示。 */
  paths: z.array(z.string()),
  sessionCount: z.number().int(),
  /** 会话数据占用；数据库型 agent 取库文件大小。 */
  sessionBytes: z.number(),
  staleSessionCount: z.number().int(),
  /** 清理过期会话预计可释放的字节数；数据库型为估算值。 */
  staleSessionBytes: z.number(),
});

export const tokenUsageDiskRpc = defineRpc({
  name: "token-usage.disk",
  input: z.object({
    forceRefresh: z.boolean().default(false),
    /** 判定「过期会话」的天数，默认 30 天。 */
    olderThanDays: z.number().int().min(1).max(3650).default(30),
  }),
  output: z.object({
    fetchedAt: z.string(),
    staleDays: z.number().int(),
    agents: z.array(tokenUsageDiskAgentSchema),
    /** True when the served snapshot is older than the TTL. */
    stale: z.boolean().default(false),
  }),
});

export const tokenUsageCleanupResultSchema = z.object({
  agentId: tokenUsageAgentIdSchema,
  displayName: z.string(),
  status: z.enum(["cleaned", "skipped", "error"]),
  removedSessions: z.number().int(),
  /** 实际释放的字节数；数据库型为 VACUUM 前后的差值。 */
  freedBytes: z.number(),
  error: z.string().nullable(),
});

export const tokenUsageCleanupRpc = defineRpc({
  name: "token-usage.cleanup",
  input: z.object({
    olderThanDays: z.number().int().min(1).max(3650).default(30),
    /** 指定要清理的 agent；缺省或空数组表示全部。 */
    agentIds: z.array(tokenUsageAgentIdSchema).optional(),
  }),
  output: z.object({
    results: z.array(tokenUsageCleanupResultSchema),
    /** 清理后重新统计的磁盘占用。 */
    disk: z.object({
      fetchedAt: z.string(),
      staleDays: z.number().int(),
      agents: z.array(tokenUsageDiskAgentSchema),
    }),
  }),
});

export type TokenUsageAgentId = z.output<typeof tokenUsageAgentIdSchema>;
export type TokenUsageDiskAgent = z.output<typeof tokenUsageDiskAgentSchema>;
export type TokenUsageDiskOutput = z.output<typeof tokenUsageDiskRpc.output>;
export type TokenUsageCleanupResult = z.output<typeof tokenUsageCleanupResultSchema>;
export type TokenUsageCleanupOutput = z.output<typeof tokenUsageCleanupRpc.output>;
