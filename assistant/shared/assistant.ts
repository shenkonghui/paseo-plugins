import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * 助理只维护一个会话：同一个目录(~/.paseo/default)下的同一个 agent。
 * ensure 会复用已存在的会话，只有在不存在时才创建。
 */
const assistantRefSchema = z.object({
  agentId: z.string(),
  workspaceId: z.string(),
  created: z.boolean(),
});

export const ensureAssistantRpc = defineRpc({
  name: "assistant.ensure",
  input: z.object({}),
  output: assistantRefSchema,
});

/** 结束当前会话并新建一个，用于会话过大或想重开时。 */
export const resetAssistantRpc = defineRpc({
  name: "assistant.reset",
  input: z.object({}),
  output: assistantRefSchema,
});

/**
 * `/send`：把内容发到自动挑选的 workspace 里自动挑中的 agent。
 * 整个 args 作为消息；excludeWorkspaceId / excludeAgentId 用于“发给别人”，即尽量不选当前所在的会话。
 */
export const dispatchAssistantRpc = defineRpc({
  name: "assistant.dispatch",
  input: z.object({
    args: z.string().min(1),
    excludeWorkspaceId: z.string().min(1).optional(),
    excludeAgentId: z.string().min(1).optional(),
  }),
  output: z.object({
    agentId: z.string(),
    agentTitle: z.string().nullable(),
    workspaceId: z.string(),
    workspaceName: z.string(),
    agentCount: z.number().int().nonnegative(),
  }),
});

export type AssistantRef = z.infer<typeof assistantRefSchema>;
export type DispatchAssistantInput = z.infer<typeof dispatchAssistantRpc.input>;
export type DispatchResult = z.infer<typeof dispatchAssistantRpc.output>;
