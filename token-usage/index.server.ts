import type { PluginServerContext } from "@getpaseo/plugin/server";
import { TokenUsageService } from "./server/service";
import { tokenUsageListRpc } from "./shared/rpc";

export default function contributeServer(server: PluginServerContext) {
  const service = new TokenUsageService({ logger: console });

  server.handle(tokenUsageListRpc, async (input) => {
    const { result, stale } = await service.listUsage({ forceRefresh: input.forceRefresh });
    return {
      fetchedAt: result.fetchedAt,
      rangeDays: result.rangeDays,
      agents: result.agents,
      qoderQuota: result.qoderQuota,
      stale,
    };
  });

  return () => {};
}
