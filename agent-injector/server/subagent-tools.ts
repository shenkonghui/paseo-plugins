import type { PaseoApi, PaseoAgent } from "@getpaseo/client";
import type { AgentToolResult } from "@getpaseo/plugin/server";
import { defineAgentTool } from "@getpaseo/plugin/server";
import { z } from "zod";
import {
  isInheritEntry,
  parseSubagentQueue,
  type InjectorValues,
  type SubagentQueueEntry,
} from "../shared/settings";
import { queueEntryKey } from "../shared/queue-status";
import { cooldownUntil, markEntryFailed, markPendingAgent } from "./queue-state";

export type ChildConfig = {
  provider: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
};

type ConfigSource = "inherit" | "custom";

const createSubagentInput = z.object({
  title: z.string().trim().min(1).max(60).describe("子代理的简短标题（<= 60 字）"),
  prompt: z.string().trim().min(1).describe("子代理创建后立即执行的第一个任务"),
  configMode: z
    .enum(["inherit", "custom"])
    .optional()
    .describe('配置来源：inherit 继承父 agent，custom 使用插件里配置的模型队列。默认取插件设置'),
  modeId: z.string().optional().describe("覆盖会话模式（仅在该 provider 支持时使用）"),
  thinkingOptionId: z.string().optional().describe("覆盖思考档位"),
});

function splitProviderModel(input: string): { provider: string; model?: string } {
  const index = input.indexOf("/");
  if (index < 0) return { provider: input };
  return { provider: input.slice(0, index), model: input.slice(index + 1) };
}

function featuresToValues(agent: PaseoAgent): Record<string, unknown> | undefined {
  const features = agent.features;
  if (!features || features.length === 0) return undefined;
  return Object.fromEntries(features.map((feature) => [feature.id, feature.value]));
}

/** 继承时直接复用父 agent 的 provider/model/mode/thinking/feature。 */
function inheritFromAgent(agent: PaseoAgent): ChildConfig {
  const provider = agent.model ? `${agent.provider}/${agent.model}` : agent.provider;
  return {
    provider,
    modeId: agent.currentModeId ?? undefined,
    thinkingOptionId: agent.effectiveThinkingOptionId ?? agent.thinkingOptionId ?? undefined,
    featureValues: featuresToValues(agent),
  };
}

/**
 * 思考档位是按模型变化的（qoder 的 dfmodel 不接受 xhigh 这类值），
 * 继承或队列里写死的档位在目标模型上不合法时回退到该模型默认值。
 */
async function validateThinkingOption(
  paseo: PaseoApi,
  providerId: string,
  modelId: string | undefined,
  requested: string | undefined,
): Promise<string | undefined> {
  if (!requested) return undefined;
  try {
    const result = await paseo.providers.listModels(providerId);
    const model = modelId ? result.models?.find((entry) => entry.id === modelId) : undefined;
    const options = model?.thinkingOptions ?? [];
    if (options.length === 0) return undefined;
    if (options.some((option) => option.id === requested)) return requested;
    return model?.defaultThinkingOptionId ?? options[0]?.id;
  } catch {
    return requested;
  }
}

/** 继承父 agent 时复用其 provider/model/mode/thinking/feature，并校验思考档位。 */
export async function resolveInheritedConfig(
  paseo: PaseoApi,
  parent: PaseoAgent,
): Promise<ChildConfig> {
  const inherited = inheritFromAgent(parent);
  const parsed = splitProviderModel(inherited.provider);
  const thinkingOptionId = await validateThinkingOption(
    paseo,
    parsed.provider,
    parsed.model,
    inherited.thinkingOptionId,
  );
  return { ...inherited, thinkingOptionId };
}

export type QueueEntryStatus = "ready" | "cooldown" | "unavailable";

export type QueueEntryEvaluation = {
  index: number;
  key: string;
  state: QueueEntryStatus;
  detail: string | null;
  retryAt: number | null;
  /** 最近一次失败时间；仅冷却中的项有值。 */
  failedAt: number | null;
  source: ConfigSource;
  /** 仅在 state === "ready" 时有值；设置页查询状态（parent 为 null）时为 null。 */
  config: ChildConfig | null;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 逐项评估队列：冷却中的项直接跳过；其余按 provider 可用性与模型是否存在判断。
 */
export async function evaluateQueue(
  paseo: PaseoApi,
  parent: PaseoAgent | null,
  entries: readonly SubagentQueueEntry[],
  options: { cooldownHours: number; now?: number },
): Promise<QueueEntryEvaluation[]> {
  const now = options.now ?? Date.now();

  let available: Set<string> | null = null;
  let availabilityError: string | null = null;
  try {
    const result = await paseo.providers.listAvailable();
    available = new Set(
      result.providers.filter((entry) => entry.available).map((entry) => entry.provider),
    );
  } catch (error) {
    availabilityError = `获取 provider 可用状态失败：${errorMessage(error)}`;
  }

  const evaluations: QueueEntryEvaluation[] = [];

  for (const [index, entry] of entries.entries()) {
    const key = queueEntryKey(entry);
    const source: ConfigSource = isInheritEntry(entry) ? "inherit" : "custom";
    const retryAt = cooldownUntil(key, options.cooldownHours, now);
    if (retryAt) {
      evaluations.push({
        index,
        key,
        state: "cooldown",
        detail: null,
        retryAt,
        failedAt: retryAt - options.cooldownHours * 3_600_000,
        source,
        config: null,
      });
      continue;
    }

    if (isInheritEntry(entry)) {
      const config = parent ? await resolveInheritedConfig(paseo, parent) : null;
      evaluations.push({
        index,
        key,
        state: "ready",
        detail: parent ? null : "创建时读取父 agent 的实时配置",
        retryAt: null,
        failedAt: null,
        source,
        config,
      });
      continue;
    }

    const parsed = splitProviderModel(entry.provider);
    const providerId = parsed.provider;
    const modelId = entry.model ?? parsed.model;

    if (!available) {
      evaluations.push({
        index,
        key,
        state: "unavailable",
        detail: availabilityError ?? "无法获取 provider 可用状态",
        retryAt: null,
        failedAt: null,
        source,
        config: null,
      });
      continue;
    }
    if (!available.has(providerId)) {
      evaluations.push({
        index,
        key,
        state: "unavailable",
        detail: "provider 当前不可用",
        retryAt: null,
        failedAt: null,
        source,
        config: null,
      });
      continue;
    }

    let model: string | undefined;
    if (modelId) {
      try {
        const result = await paseo.providers.listModels(providerId);
        const found = result.models?.find(
          (candidate) => candidate.id === modelId && candidate.isSelectable !== false,
        );
        if (!found) {
          evaluations.push({
            index,
            key,
            state: "unavailable",
            detail: "模型不存在或不可选",
            retryAt: null,
            failedAt: null,
            source,
            config: null,
          });
          continue;
        }
        model = found.id;
      } catch (error) {
        evaluations.push({
          index,
          key,
          state: "unavailable",
          detail: `查询模型失败：${errorMessage(error)}`,
          retryAt: null,
          failedAt: null,
          source,
          config: null,
        });
        continue;
      }
    }

    const thinkingOptionId = await validateThinkingOption(
      paseo,
      providerId,
      model,
      entry.thinkingOptionId,
    );

    evaluations.push({
      index,
      key,
      state: "ready",
      detail: null,
      retryAt: null,
      failedAt: null,
      source,
      config: {
        provider: model ? `${providerId}/${model}` : providerId,
        modeId: entry.modeId,
        thinkingOptionId,
      },
    });
  }

  return evaluations;
}

async function resolveQueueEntry(
  paseo: PaseoApi,
  parent: PaseoAgent,
  entries: SubagentQueueEntry[],
  cooldownHours: number,
): Promise<{
  config: ChildConfig;
  source: ConfigSource;
  key: string;
  skipped: number;
} | null> {
  const evaluations = await evaluateQueue(paseo, parent, entries, { cooldownHours });
  const picked = evaluations.find((entry) => entry.state === "ready" && entry.config);
  if (!picked?.config) return null;
  return {
    config: picked.config,
    source: picked.source,
    key: picked.key,
    skipped: evaluations.filter((entry) => entry.state !== "ready").length,
  };
}

async function resolveChildConfig(
  paseo: PaseoApi,
  parent: PaseoAgent,
  values: InjectorValues,
  requestedMode: "inherit" | "custom" | undefined,
): Promise<{
  config: ChildConfig;
  source: ConfigSource;
  /** 命中队列项的 key；继承兜底时为 null，不参与失败冷却。 */
  key: string | null;
  skipped: number;
}> {
  const mode = requestedMode ?? values.subagentConfigMode;

  if (mode === "custom") {
    const { entries } = parseSubagentQueue(values.subagentModelQueue);
    if (entries.length > 0) {
      try {
        const picked = await resolveQueueEntry(
          paseo,
          parent,
          entries,
          values.subagentFailureCooldownHours,
        );
        if (picked) return picked;
      } catch {
        // 队列解析失败时退回继承
      }
    }
  }

  return {
    config: await resolveInheritedConfig(paseo, parent),
    source: "inherit",
    key: null,
    skipped: 0,
  };
}

export function createSubagentTool(values: InjectorValues) {
  return defineAgentTool({
    name: "create_subagent",
    title: "Create subagent",
    description:
      "Create a subagent that inherits your provider/model/mode/thinking/features by default. " +
      "The plugin may instead use a priority-ordered model queue. Provide title and prompt; " +
      "configMode/modeId/thinkingOptionId are optional overrides. Returns immediately.",
    input: createSubagentInput,
    async execute(input, context): Promise<AgentToolResult> {
      const parentHandle = context.paseo.agents.ref(context.agent.id);
      const parent =
        (await parentHandle.refresh().catch(() => null))?.agent ?? parentHandle.current();
      if (!parent) {
        return { text: `找不到父 agent ${context.agent.id} 的当前配置`, isError: true };
      }

      const { config, source, key, skipped } = await resolveChildConfig(
        context.paseo,
        parent,
        values,
        input.configMode,
      );
      if (input.modeId) config.modeId = input.modeId;
      if (input.thinkingOptionId) {
        const parsed = splitProviderModel(config.provider);
        config.thinkingOptionId =
          (await validateThinkingOption(
            context.paseo,
            parsed.provider,
            parsed.model,
            input.thinkingOptionId,
          )) ?? undefined;
      }

      try {
        const child = await context.paseo.agents.create({
          cwd: context.agent.cwd,
          parent: context.agent.id,
          title: input.title,
          prompt: input.prompt,
          config,
        });
        if (key) markPendingAgent(child.id, key);
        const sourceLabel = source === "custom" ? "自定义队列" : "继承父 agent";
        return {
          text:
            `已创建子 agent ${child.id}（配置来源：${sourceLabel}，provider=${config.provider}` +
            (config.thinkingOptionId ? `，thinking=${config.thinkingOptionId}` : "") +
            (skipped > 0 ? `，已跳过 ${skipped} 项冷却中或不可用的配置` : "") +
            "）。完成或失败不会主动通知你，用 get_agent_status / get_agent_activity 查看进度；" +
            "失败会自动把该队列项冷却一段时间。",
          structuredContent: {
            agentId: child.id,
            provider: config.provider,
            source,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (key) markEntryFailed(key);
        return {
          text: `创建子 agent 失败：${message}` + (key ? "（该队列项已进入失败冷却）" : ""),
          isError: true,
        };
      }
    },
  });
}
