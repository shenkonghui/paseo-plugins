import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const editDetailSchema = z.object({
  callId: z.string(),
  filePath: z.string().optional(),
  diff: z.string().optional(),
  additions: z.number().optional(),
  deletions: z.number().optional(),
  oldText: z.string().optional(),
  newText: z.string().optional(),
  content: z.string().optional(),
});

export type EditDetailRecord = z.infer<typeof editDetailSchema>;

const agentIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);

const editDetailsInputSchema = z.object({
  agentId: agentIdSchema,
  callIds: z.array(z.string().max(128)).max(400),
});

const editDetailsOutputSchema = z.object({
  records: z.array(editDetailSchema),
});

export type EditDetailsInput = z.infer<typeof editDetailsInputSchema>;
export type EditDetailsOutput = z.infer<typeof editDetailsOutputSchema>;

export const editDetailsRpc = defineRpc({
  name: "session-changes.edit-details",
  input: editDetailsInputSchema,
  output: editDetailsOutputSchema,
});

const checkpointFileSchema = z.object({
  path: z.string(),
  version: z.number(),
  backupTime: z.string(),
  /** 缺省表示该记录点时尚不存在此文件（会话中新建） */
  backupFileName: z.string().optional(),
});

export type CheckpointFileRecord = z.infer<typeof checkpointFileSchema>;

const checkpointSchema = z.object({
  id: z.string(),
  at: z.string(),
  cwd: z.string(),
  files: z.array(checkpointFileSchema),
});

export type CheckpointRecord = z.infer<typeof checkpointSchema>;

const checkpointsInputSchema = z.object({ agentId: agentIdSchema });
const checkpointsOutputSchema = z.object({ checkpoints: z.array(checkpointSchema) });

export type CheckpointsInput = z.infer<typeof checkpointsInputSchema>;
export type CheckpointsOutput = z.infer<typeof checkpointsOutputSchema>;

export const checkpointsRpc = defineRpc({
  name: "session-changes.checkpoints",
  input: checkpointsInputSchema,
  output: checkpointsOutputSchema,
});

const restoreInputSchema = z.object({
  agentId: agentIdSchema,
  checkpointId: z.string().min(1).max(128),
});

const restoreOutputSchema = z.object({
  restored: z.array(z.object({ path: z.string(), bytes: z.number() })),
  skipped: z.array(z.object({ path: z.string(), reason: z.string() })),
});

export type RestoreInput = z.infer<typeof restoreInputSchema>;
export type RestoreOutput = z.infer<typeof restoreOutputSchema>;

export const restoreRpc = defineRpc({
  name: "session-changes.restore",
  input: restoreInputSchema,
  output: restoreOutputSchema,
});
