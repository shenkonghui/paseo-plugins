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

export const tokenUsageAgentSchema = z.object({
  agentId: z.enum(["codebuddy", "pi", "opencode", "devin"]),
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
