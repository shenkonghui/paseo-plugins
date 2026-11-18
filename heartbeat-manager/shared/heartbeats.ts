import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const heartbeatStatusSchema = z.enum(["active", "paused", "completed"]);
export const heartbeatRunStatusSchema = z.enum(["running", "succeeded", "failed"]);

export type HeartbeatStatus = z.infer<typeof heartbeatStatusSchema>;
export type HeartbeatRunStatus = z.infer<typeof heartbeatRunStatusSchema>;

export const heartbeatRunSchema = z.object({
  id: z.string(),
  scheduledFor: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  status: heartbeatRunStatusSchema,
  agentId: z.string().nullable(),
  error: z.string().nullable(),
});

export type HeartbeatRun = z.infer<typeof heartbeatRunSchema>;

export const heartbeatSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  prompt: z.string(),
  cron: z.string(),
  timezone: z.string().nullable(),
  agentId: z.string(),
  status: heartbeatStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  maxRuns: z.number().nullable(),
  runs: z.array(heartbeatRunSchema),
});

export type Heartbeat = z.infer<typeof heartbeatSchema>;

const scheduleIdPattern = /^[A-Za-z0-9_-]{4,64}$/;
const agentIdPattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const timezonePattern = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;

export const scheduleIdField = z.string().trim().regex(scheduleIdPattern, "schedule id 格式不正确");
export const cronField = z
  .string()
  .trim()
  .min(1, "cron 不能为空")
  .max(200)
  .refine((value) => value.split(/\s+/).length === 5, "cron 需要 5 段（分 时 日 月 周）");
export const timezoneField = z.string().trim().max(64).regex(timezonePattern, "时区应形如 Asia/Shanghai");
export const expiresInField = z.string().trim().regex(/^\d+[smhd]$/, "过期时间形如 7d、12h、30m");
export const maxRunsField = z.number().int().positive().max(1_000_000);

export const heartbeatListRpc = defineRpc({
  name: "heartbeat-manager.list",
  input: z.object({}),
  output: z.object({
    error: z.string().nullable(),
    heartbeats: z.array(heartbeatSchema),
  }),
});

export const heartbeatCreateRpc = defineRpc({
  name: "heartbeat-manager.create",
  input: z.object({
    agentId: z.string().trim().regex(agentIdPattern, "agentId 必须是 UUID"),
    prompt: z.string().trim().min(1, "prompt 不能为空").max(20_000),
    cron: cronField,
    timezone: timezoneField.nullish(),
    name: z.string().trim().max(200).nullish(),
    maxRuns: maxRunsField.nullish(),
    expiresIn: expiresInField.nullish(),
  }),
  output: z.object({
    error: z.string().nullable(),
    heartbeat: heartbeatSchema.nullable(),
  }),
});

export const heartbeatUpdateRpc = defineRpc({
  name: "heartbeat-manager.update",
  input: z.object({
    id: scheduleIdField,
    cron: cronField,
    timezone: timezoneField.nullish(),
    /** null 表示清空名称，undefined 表示不改。 */
    name: z.string().trim().max(200).nullable().optional(),
    prompt: z.string().trim().min(1).max(20_000).optional(),
    /** null 表示清除上限。 */
    maxRuns: maxRunsField.nullable().optional(),
    /** null 表示清除过期时间。 */
    expiresIn: expiresInField.nullable().optional(),
  }),
  output: z.object({
    error: z.string().nullable(),
    heartbeat: heartbeatSchema.nullable(),
  }),
});

export const heartbeatActionRpc = defineRpc({
  name: "heartbeat-manager.action",
  input: z.object({
    id: scheduleIdField,
    action: z.enum(["pause", "resume", "run-once", "delete"]),
  }),
  output: z.object({
    error: z.string().nullable(),
  }),
});