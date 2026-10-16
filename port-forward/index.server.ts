import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ForwardEngine } from "./server/engine";
import { listHostIps, scanListeningPorts } from "./server/scan";
import { forwardRulesDocument, restartRpc, scanRpc, statusRpc } from "./shared/rules";

export default function contributeServer(server: PluginServerContext) {
  const engine = new ForwardEngine();
  const settings = server.registerSettings(forwardRulesDocument);
  let disposed = false;

  const applyValues = (values: { rules: Parameters<ForwardEngine["sync"]>[0] }): void => {
    if (disposed) return;
    engine.sync(values.rules);
  };

  void settings
    .read()
    .then((state) => {
      if (state.status === "ready") applyValues(state.values);
      return undefined;
    })
    .catch((error: unknown) => {
      console.error("[port-forward] failed to read persisted rules", error);
    });

  settings.subscribe((state) => {
    if (state.status === "ready") applyValues(state.values);
  });

  server.handle(statusRpc, () => ({
    states: engine.states(),
    hostname: process.env.HOSTNAME ?? "",
    hostIps: listHostIps(),
  }));

  server.handle(scanRpc, async () => ({
    ports: await scanListeningPorts(),
  }));

  server.handle(restartRpc, ({ ruleId }) => ({
    restarted: engine.restart(ruleId),
  }));

  return () => {
    disposed = true;
    engine.dispose();
  };
}
