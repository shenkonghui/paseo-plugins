import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** 支持的 agent（与 shared/rpc.ts 的 agentId 保持一致）。 */
export const TOKEN_USAGE_AGENT_IDS = ["codebuddy", "pi", "opencode", "devin", "qoder"] as const;

export type TokenUsageAgentId = (typeof TOKEN_USAGE_AGENT_IDS)[number];

/**
 * 关闭采集的 agent。默认空数组 = 全部开启；默认值取「关闭列表」而不是「开启列表」，
 * 这样以后新增的 agent 天然是开启状态。
 */
export const agentCollectionSettings = defineSettings({
  id: "agents",
  scope: "host",
  version: 1,
  schema: z.object({
    disabled: z.array(z.enum(TOKEN_USAGE_AGENT_IDS)).default([]),
  }),
});
