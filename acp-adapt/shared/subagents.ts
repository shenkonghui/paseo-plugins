import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * 与具体 CLI 无关的子任务状态。
 * - running: 正在跑（含 pending，CLI 会在真正启动前短暂处于该状态）
 * - completed / failed / cancelled: 终态
 */
export const subagentStatusSchema = z.enum(["running", "completed", "failed", "cancelled"]);
export type SubagentStatus = z.infer<typeof subagentStatusSchema>;

export const subagentRowSchema = z.object({
  /** CLI 自己的任务 id（Qoder: task-<id>.json 的文件名主体） */
  id: z.string(),
  /** CLI 内部的子 agent id（Qoder: ageneral-purpose-xxxx） */
  agentId: z.string(),
  /** 展示名，优先用 description */
  name: z.string(),
  description: z.string().nullable(),
  agentType: z.string().nullable(),
  status: subagentStatusSchema,
  startedAt: z.number().nullable(),
  updatedAt: z.number().nullable(),
  completedAt: z.number().nullable(),
  summary: z.string().nullable(),
  /** CLI 写在本地磁盘上的任务产物路径（可能是 jsonl 转录） */
  outputPath: z.string().nullable(),
});

export type SubagentRow = z.infer<typeof subagentRowSchema>;

export const subagentsInputSchema = z.object({
  agentId: z.string().min(1).max(80),
});

export const subagentsOutputSchema = z.object({
  /** 该 provider 是否在适配范围内 */
  supported: z.boolean(),
  provider: z.string(),
  /** 适配器识别到的 CLI 会话 id */
  sessionId: z.string().nullable(),
  /** 数据来源（用于排查） */
  source: z.string().nullable(),
  rows: z.array(subagentRowSchema),
  error: z.string().nullable(),
});

export type SubagentsInput = z.infer<typeof subagentsInputSchema>;
export type SubagentsOutput = z.infer<typeof subagentsOutputSchema>;

export const subagentsRpc = defineRpc({
  name: "acp-adapt.subagents",
  input: subagentsInputSchema,
  output: subagentsOutputSchema,
});
