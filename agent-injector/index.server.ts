import type { PluginServerContext } from "@getpaseo/plugin/server";
import { applyInjection } from "./server/inject";
import { createSubagentTool } from "./server/subagent-tools";
import { injectorSettings } from "./shared/settings";
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

  return () => {};
}
