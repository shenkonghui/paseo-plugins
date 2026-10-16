import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { PluginBeforeRequests } from "@getpaseo/plugin/server";
import { mcpServersSchema, unwrapMcpServers, type InjectorValues } from "../shared/settings";

type AgentCreateRequest = PluginBeforeRequests["agent.create"];
type McpServers = NonNullable<AgentCreateRequest["config"]["mcpServers"]>;

const RULES_HEADING = "## 全局规则";

function log(message: string): void {
  console.warn(`[agent-injector] ${message}`);
}

function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return path.join(homedir(), input.slice(2));
  return input;
}

function splitList(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** 空白名单表示所有 provider；同时支持 `provider` 和 `provider/model` 命中。 */
export function providerAllowed(raw: string, provider: string): boolean {
  const list = splitList(raw);
  if (list.length === 0) return true;
  return list.includes(provider) || list.includes(provider.split("/")[0] ?? provider);
}

export function parseMcpServers(raw: string): McpServers {
  const trimmed = raw.trim();
  if (!trimmed) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    log(`mcpServersJson 不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }

  const result = mcpServersSchema.safeParse(unwrapMcpServers(parsed));
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    log(`mcpServersJson 校验失败: ${detail}`);
    return {};
  }

  if (Object.hasOwn(result.data, "paseo")) {
    log('mcpServersJson 里定义了名为 "paseo" 的 server，会被 Paseo 内置 MCP 覆盖');
  }
  return result.data as McpServers;
}

/** 合并内联规则与规则文件内容，按出现顺序拼接。 */
export async function resolveRules(values: InjectorValues): Promise<string> {
  const parts: string[] = [];
  const inline = values.rules.trim();
  if (inline) parts.push(inline);

  for (const file of splitList(values.ruleFiles)) {
    try {
      const text = (await readFile(expandHome(file), "utf8")).trim();
      if (text) parts.push(text);
    } catch (error) {
      log(`无法读取规则文件 ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return parts.join("\n\n");
}

export function composeSystemPrompt(
  existing: string | undefined,
  rules: string,
  prepend: boolean,
): string {
  const block = `${RULES_HEADING}\n\n${rules}`;
  const base = existing?.trim() ?? "";
  if (!base) return block;
  return prepend ? `${block}\n\n${base}` : `${base}\n\n${block}`;
}

/**
 * 在 agent.create 阶段注入全局规则与 MCP server。
 * 只新建 agent 时生效；已存在的 agent 需重建或重载后才能拿到新配置。
 */
export async function applyInjection(
  values: InjectorValues,
  request: AgentCreateRequest,
): Promise<AgentCreateRequest> {
  if (!values.enabled) return request;
  // 跳过 daemon 内部工具 agent（如生成标题/commit message）
  if (request.config.internal === true) return request;
  if (!providerAllowed(values.providers, request.config.provider)) return request;

  const rules = await resolveRules(values);
  const mcpServers = parseMcpServers(values.mcpServersJson);

  const config: AgentCreateRequest["config"] = { ...request.config };
  const injectedServers = Object.keys(mcpServers);

  if (rules) {
    config.systemPrompt = composeSystemPrompt(request.config.systemPrompt, rules, values.prependRules);
  }
  if (injectedServers.length > 0) {
    config.mcpServers = { ...request.config.mcpServers, ...mcpServers };
  }

  if (rules || injectedServers.length > 0) {
    log(
      `provider=${request.config.provider} 注入规则 ${rules.length} 字` +
        (injectedServers.length > 0 ? `, MCP=[${injectedServers.join(", ")}]` : ""),
    );
  }

  return { ...request, config };
}
