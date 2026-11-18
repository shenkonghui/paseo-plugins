import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createHeartbeat, listHeartbeats, runHeartbeatAction, updateHeartbeat } from "./server/heartbeats";
import {
  heartbeatActionRpc,
  heartbeatCreateRpc,
  heartbeatListRpc,
  heartbeatUpdateRpc,
} from "./shared/heartbeats";

export default function contributeServer(server: PluginServerContext) {
  server.handle(heartbeatListRpc, async () => listHeartbeats());
  server.handle(heartbeatCreateRpc, async (input) => createHeartbeat(input));
  server.handle(heartbeatUpdateRpc, async (input) => updateHeartbeat(input));
  server.handle(heartbeatActionRpc, async (input) => runHeartbeatAction(input));
  return () => {};
}