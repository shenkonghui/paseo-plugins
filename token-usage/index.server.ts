import type { PluginServerContext } from "@getpaseo/plugin/server";
import { TokenUsageService } from "./server/service";
import { agentCollectionSettings } from "./shared/settings";
import { tokenUsageListRpc } from "./shared/rpc";

export default function contributeServer(server: PluginServerContext) {
  const service = new TokenUsageService({ logger: console });
  const agentSettings = server.registerSettings(agentCollectionSettings);

  server.handle(tokenUsageListRpc, async (input) => {
    const settings = await agentSettings.read().catch(() => null);
    const disabledAgents = settings?.status === "ready" ? settings.values.disabled : [];
    const { result, stale } = await service.listUsage({
      forceRefresh: input.forceRefresh,
      windowDays: input.windowDays,
      disabledAgents,
    });
    return {
      fetchedAt: result.fetchedAt,
      rangeDays: result.rangeDays,
      agents: result.agents,
      stale,
    };
  });

  return () => {};
}
