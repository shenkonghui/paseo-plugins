import type { PluginServerContext } from "@getpaseo/plugin/server";
import { applyInjection } from "./server/inject";
import { createSubagentTool, evaluateQueue } from "./server/subagent-tools";
import {
  clearEntryFailure,
  clearFailures,
  markEntryFailed,
  takePendingAgent,
} from "./server/queue-state";
import { injectorSettings } from "./shared/settings";
import { queueStatusRpc, resetQueueFailuresRpc } from "./shared/queue-status";
import { providerAllowed } from "./server/inject";

export default function contributeServer(server: PluginServerContext) {
  const settings = server.registerSettings(injectorSettings);

  server.before("agent.create", async ({ request }) => {
    const state = await settings.read();
    if (state.status !== "ready") return request;
    return await applyInjection(state.values, request);
  });

  server.before("agent.session_open", async ({ request }) => {
    if (request.purpose === "history") return request;
    const state = await settings.read();
    if (state.status !== "ready") return request;
    const values = state.values;
    if (!values.enabled || !values.subagentEnabled || !values.subagentCreateTool) return request;
    if (!providerAllowed(values.providers, request.provider)) return request;
    if (request.tools.some((tool) => tool.name === "create_subagent")) return request;
    return { ...request, tools: [...request.tools, createSubagentTool(values)] };
  });

  // 设置页查询队列状态：当前会选中哪一项、哪些在冷却 / 不可用。
  server.handle(queueStatusRpc, async (input, context) => {
    const state = await settings.read();
    const cooldownHours = state.status === "ready" ? state.values.subagentFailureCooldownHours : 4;
    try {
      const evaluations = await evaluateQueue(context.paseo, null, input.entries, {
        cooldownHours,
      });
      const activeIndex = evaluations.findIndex((entry) => entry.state === "ready");
      return {
        error: null,
        activeIndex: activeIndex >= 0 ? activeIndex : null,
        entries: evaluations.map((entry) => ({
          key: entry.key,
          state: entry.state,
          detail: entry.detail,
          retryAt: entry.retryAt,
          failedAt: entry.failedAt,
        })),
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        activeIndex: null,
        entries: [],
      };
    }
  });

  // 手动清除失败冷却（单项或全部），让队列立即恢复按顺序选择。
  server.handle(resetQueueFailuresRpc, async (input) => ({
    cleared: clearFailures(input.keys),
  }));

  // 由 create_subagent 创建的子 agent 失败后，把失败归因到对应队列项并冷却。
  server.on("agent.turn_ended", ({ agent, outcome }) => {
    const key = takePendingAgent(agent.id);
    if (!key) return;
    if (outcome.kind === "failed") markEntryFailed(key);
    else if (outcome.kind === "completed") clearEntryFailure(key);
  });
  server.on("agent.closed", ({ agent }) => {
    takePendingAgent(agent.id);
  });
  server.on("agent.archived", ({ agent }) => {
    takePendingAgent(agent.id);
  });

  return () => {};
}
