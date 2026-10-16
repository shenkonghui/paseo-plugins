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
  }),
});

export type InjectorValues = z.infer<typeof injectorSettings.schema>;

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
