import type { PluginServerContext } from "@getpaseo/plugin/server";
import { extractCheckpoints, extractEditDetails, restoreCheckpoint } from "./server/transcript";
import { checkpointsRpc, editDetailsRpc, restoreRpc } from "./shared/edit-details";

export default function contributeServer(server: PluginServerContext) {
  server.handle(editDetailsRpc, async (input) => {
    const records = await extractEditDetails(input.agentId, input.callIds);
    return { records };
  });
  server.handle(checkpointsRpc, async (input) => {
    const checkpoints = await extractCheckpoints(input.agentId);
    return { checkpoints };
  });
  server.handle(restoreRpc, async (input) => {
    return await restoreCheckpoint(input.agentId, input.checkpointId);
  });
  return () => {};
}
