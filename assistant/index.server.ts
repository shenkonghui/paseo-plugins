import type { PluginServerContext } from "@getpaseo/plugin/server";
import { dispatchToWorkspace, ensureAssistant, resetAssistant } from "./server/assistant";
import { dispatchAssistantRpc, ensureAssistantRpc, resetAssistantRpc } from "./shared/assistant";

export default function contribute(server: PluginServerContext) {
  server.handle(ensureAssistantRpc, async (_input, { paseo }) => ensureAssistant(paseo));
  server.handle(resetAssistantRpc, async (_input, { paseo }) => resetAssistant(paseo));
  server.handle(dispatchAssistantRpc, async (input, { paseo }) => dispatchToWorkspace(paseo, input));
  return () => {};
}
