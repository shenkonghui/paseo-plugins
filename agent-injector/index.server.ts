import type { PluginServerContext } from "@getpaseo/plugin/server";
import { applyInjection } from "./server/inject";
import { injectorSettings } from "./shared/settings";

export default function contributeServer(server: PluginServerContext) {
  const settings = server.registerSettings(injectorSettings);

  server.before("agent.create", async ({ request }) => {
    const state = await settings.read();
    if (state.status !== "ready") return request;
    return await applyInjection(state.values, request);
  });

  return () => {};
}
