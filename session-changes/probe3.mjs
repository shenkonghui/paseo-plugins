import { readFileSync } from "node:fs";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPaseoApi } from "@getpaseo/client";

const token = readFileSync("/root/.paseo/local-credential", "utf8").trim();
const client = new DaemonClient({
  url: "ws://127.0.0.1:6767/ws",
  clientId: "probe-session-changes-3",
  clientType: "cli",
  appVersion: "probe",
  localCredential: () => token,
  connectTimeoutMs: 8000,
  reconnect: { enabled: false },
});
await client.connect();
const api = createPaseoApi(client);
const page = await api.agents.ref(process.argv[2]).timeline.refetch({ direction: "tail", limit: 300 });

for (const entry of page.entries) {
  const item = entry.item;
  if (item.type !== "tool_call") continue;
  const d = item.detail;
  if (d?.type !== "edit" || !String(d.filePath).includes("panel.tsx") && !String(d.filePath).includes("index.client")) continue;
  console.log("==== name:", item.name, "| path:", d.filePath, "| status:", item.status);
  const lines = (d.unifiedDiff ?? "").split("\n");
  console.log("unified line count:", lines.length);
  console.log(lines.slice(0, 10).map(l => JSON.stringify(l)).join("\n"));
  console.log("");
}
await client.close();
process.exit(0);
