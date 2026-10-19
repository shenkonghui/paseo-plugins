import type { PluginServerContext } from "@getpaseo/plugin/server";
import { TokenUsageService } from "./server/service";
import { agentCollectionSettings } from "./shared/settings";
import {
  tokenUsageCleanupRpc,
  tokenUsageDiskRpc,
  tokenUsageListRpc,
} from "./shared/rpc";

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

  server.handle(tokenUsageDiskRpc, async (input) => {
    const { result, stale } = await service.diskUsage({
      forceRefresh: input.forceRefresh,
      olderThanDays: input.olderThanDays,
    });
    return { ...result, stale };
  });

  // 删除的是 30 天前的会话，属显式手动操作；这里不做额外保护，UI 负责二次确认。
  server.handle(tokenUsageCleanupRpc, async (input) => {
    const { results, disk } = await service.cleanupSessions({
      olderThanDays: input.olderThanDays,
      agentIds: input.agentIds,
    });
    return { results, disk };
  });

  return () => {};
}
