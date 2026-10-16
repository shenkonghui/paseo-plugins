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

export const tokenUsageModelSchema = z.object({
  model: z.string(),
  ...tokenUsageCountersSchema.shape,
});

export const tokenUsageAgentSchema = z.object({
  agentId: z.enum(["codebuddy", "pi", "opencode", "devin"]),
  displayName: z.string(),
  status: z.enum(["available", "unavailable", "error"]),
  error: z.string().nullable(),
  totals: tokenUsageCountersSchema,
  sessions: z.number().int(),
  days: z.array(tokenUsageDaySchema),
  models: z.array(tokenUsageModelSchema),
});

export const tokenUsageQuotaBucketSchema = z.object({
  total: z.number(),
  used: z.number(),
  remaining: z.number(),
  percentage: z.number().nullable(),
});

export const tokenUsageQoderQuotaSchema = z.object({
  userType: z.string(),
  usageType: z.string(),
  isQuotaExceeded: z.boolean(),
  totalUsagePercentage: z.number().nullable(),
  /** Plan expiry, ISO string parsed from the API's epoch millis. */
  expiresAt: z.string().nullable(),
  plan: tokenUsageQuotaBucketSchema,
  addOn: tokenUsageQuotaBucketSchema.nullable(),
  /** ISO mtime of the log file the snapshot was parsed from. */
  observedAt: z.string(),
});

export const tokenUsageListRpc = defineRpc({
  name: "token-usage.list",
  input: z.object({
    forceRefresh: z.boolean().default(false),
  }),
  output: z.object({
    fetchedAt: z.string(),
    /** Host-local days of history the snapshot covers, ending today. */
    rangeDays: z.number().int(),
    agents: z.array(tokenUsageAgentSchema),
    /** Qoder subscription credits quota, parsed from the qoder-cn CLI's own logs; null when unknown. */
    qoderQuota: tokenUsageQoderQuotaSchema.nullable().default(null),
    /** True when the served snapshot is older than the TTL. */
    stale: z.boolean().default(false),
  }),
});

export type TokenUsageCounters = z.output<typeof tokenUsageCountersSchema>;
export type TokenUsageDay = z.output<typeof tokenUsageDaySchema>;
export type TokenUsageModel = z.output<typeof tokenUsageModelSchema>;
export type TokenUsageAgent = z.output<typeof tokenUsageAgentSchema>;
export type TokenUsageQoderQuota = z.output<typeof tokenUsageQoderQuotaSchema>;
export type TokenUsageListOutput = z.output<typeof tokenUsageListRpc.output>;
