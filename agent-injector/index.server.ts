import type { PluginServerContext } from "@getpaseo/plugin/server";
import { applyInjection } from "./server/inject";
import { handleAutoTitleTurnEnded, handleHelperPermissionRequest } from "./server/auto-title";
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

  // 标题助手只为调用 update_agent 而生：自动放行该权限，其它请求直接拒绝。
  // 否则助手会停在 permission 状态，本回合不结束，后续自动标题也会被占位挡住。
  server.on("agent.permission_requested", async (event, context) => {
    try {
      await handleHelperPermissionRequest(context, event.agent, event.request);
    } catch (error) {
      console.warn(
        `[agent-injector] 处理标题助手权限失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  // 子代理失败后把失败归因到对应队列项并冷却；同时按设置触发自动标题。
  server.on("agent.turn_ended", async (event, context) => {
    const key = takePendingAgent(event.agent.id);
    if (key) {
      if (event.outcome.kind === "failed") markEntryFailed(key);
      else if (event.outcome.kind === "completed") clearEntryFailure(key);
    }

    const state = await settings.read();
    if (state.status !== "ready") return;
    try {
      await handleAutoTitleTurnEnded(context, state.values, event.agent, event.outcome);
    } catch (error) {
      console.warn(
        `[agent-injector] 自动标题处理失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
  server.on("agent.closed", ({ agent }) => {
    takePendingAgent(agent.id);
  });
  server.on("agent.archived", ({ agent }) => {
    takePendingAgent(agent.id);
  });

  return () => {};
}
