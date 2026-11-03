import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { SubagentsOutput } from "./shared/subagents";
import { subagentsRpc } from "./shared/subagents";
import { readAgentRecord } from "./server/agent-record";
import { pickAdapter } from "./server/stores";

export default function contributeServer(server: PluginServerContext) {
  server.handle(subagentsRpc, async ({ agentId }): Promise<SubagentsOutput> => {
    const record = await readAgentRecord(agentId);
    if (!record) {
      return {
        supported: false,
        provider: "",
        sessionId: null,
        source: null,
        rows: [],
        error: "agent 记录不存在（Paseo home 里找不到该 agent）",
      };
    }

    const adapter = pickAdapter(record.provider);
    if (!adapter) {
      return {
        supported: false,
        provider: record.provider,
        sessionId: record.sessionId,
        source: null,
        rows: [],
        error: null,
      };
    }

    if (!record.sessionId) {
      return {
        supported: true,
        provider: record.provider,
        sessionId: null,
        source: adapter.label,
        rows: [],
        error: "该 agent 还没有 provider 原生会话 id",
      };
    }

    try {
      const rows = await adapter.list(record.sessionId);
      return {
        supported: true,
        provider: record.provider,
        sessionId: record.sessionId,
        source: adapter.label,
        rows,
        error: null,
      };
    } catch (error) {
      return {
        supported: true,
        provider: record.provider,
        sessionId: record.sessionId,
        source: adapter.label,
        rows: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  return () => {};
}
