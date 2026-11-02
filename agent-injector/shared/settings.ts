import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * MCP server 配置，与 `@getpaseo/protocol` 的 `McpServerConfig` 结构一致。
 * 放在 shared 里，client 端可以在保存前做校验。
 */
export const mcpServerConfigSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stdio"),
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    alwaysLoad: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("http"),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    alwaysLoad: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("sse"),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    alwaysLoad: z.boolean().optional(),
  }),
]);

export const mcpServersSchema = z.record(z.string(), mcpServerConfigSchema);

/**
 * 自定义子代理模型队列的一项。provider 可以是 `provider` 或 `provider/model`；
 * 队列按数组顺序作为优先级，创建子代理时取第一个可用的组合。
 */
export const subagentModelEntrySchema = z.object({
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1).optional(),
  modeId: z.string().trim().min(1).optional(),
  thinkingOptionId: z.string().trim().min(1).optional(),
});

/** 队列里显式选择「继承父 agent 配置」的一项。 */
export const subagentInheritEntrySchema = z.object({
  inherit: z.literal(true),
});

export const subagentQueueEntrySchema = z.union([
  subagentInheritEntrySchema,
  subagentModelEntrySchema,
]);

export const subagentModelQueueSchema = z.array(subagentQueueEntrySchema);

export type SubagentModelEntry = z.infer<typeof subagentModelEntrySchema>;
export type SubagentInheritEntry = z.infer<typeof subagentInheritEntrySchema>;
export type SubagentQueueEntry = SubagentModelEntry | SubagentInheritEntry;

export function isInheritEntry(entry: SubagentQueueEntry): entry is SubagentInheritEntry {
  return "inherit" in entry && entry.inherit === true;
}

export const SUBAGENT_CONFIG_MODES = ["inherit", "custom"] as const;

export const injectorSettings = defineSettings({
  id: "injector",
  scope: "host",
  version: 1,
  schema: z.object({
    /** 总开关 */
    enabled: z.boolean().default(true),
    /** provider id 白名单，逗号/换行分隔；留空表示所有 provider */
    providers: z.string().default(""),
    /** 全局规则（markdown），注入到 systemPrompt */
    rules: z.string().default(""),
    /** 规则文件路径，每行一个（也支持逗号分隔），支持 ~，按顺序拼接 */
    ruleFiles: z.string().default(""),
    /** MCP server 映射 JSON，形如 {"name":{"type":"stdio","command":"..."}} */
    mcpServersJson: z.string().default("{}"),
    /** true 表示把规则块放到 systemPrompt 最前面，false 追加到末尾 */
    prependRules: z.boolean().default(false),
    /** 子代理工具总开关 */
    subagentEnabled: z.boolean().default(true),
    /** 是否暴露 create_subagent 工具 */
    subagentCreateTool: z.boolean().default(true),
    /** 子代理默认配置来源：继承父 agent，或按自定义队列 */
    subagentConfigMode: z.enum(SUBAGENT_CONFIG_MODES).default("inherit"),
    /** 自定义队列 JSON（数组，按优先级从上到下） */
    subagentModelQueue: z.string().default("[]"),
    /** 队列项失败后的冷却时长（小时）；0 表示失败后不跳过 */
    subagentFailureCooldownHours: z.number().min(0).max(720).default(4),
    /** 根据对话内容自动更新 agent 标题 */
    autoTitleEnabled: z.boolean().default(false),
    /** 每隔多少个已完成的回合跑一次标题助手（首轮完成后总会先跑一次） */
    autoTitleTurns: z.number().int().min(1).max(100).default(5),
    /** 两次自动标题之间的最小间隔（分钟） */
    autoTitleIntervalMinutes: z.number().int().min(0).max(1440).default(10),
    /** 自动标题时同步更新所在 workspace 的标题 */
    autoTitleWorkspace: z.boolean().default(false),
    /** 自定义标题要求，替换内置的「要求：中文，不超过30字…」；留空用默认值 */
    autoTitlePrompt: z.string().default(""),
  }),
});

export type InjectorValues = z.infer<typeof injectorSettings.schema>;

/**
 * 解析子代理模型队列。非法 JSON 返回空队列与错误信息，服务端按继承模式兜底。
 */
export function parseSubagentQueue(raw: string): {
  entries: SubagentQueueEntry[];
  error: string | null;
} {
  const trimmed = raw.trim();
  if (!trimmed) return { entries: [], error: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { entries: [], error: "不是合法 JSON" };
  }
  const result = subagentModelQueueSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    return { entries: [], error: detail };
  }
  return { entries: result.data, error: null };
}

/**
 * 兼容两种写法：
 * - 直接的 server 映射：{ "name": { "type": ... } }
 * - 带包裹的客户端配置：{ "mcpServers": { "name": { ... } } }
 */
export function unwrapMcpServers(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  const nested = record.mcpServers;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested;
  return input;
}
