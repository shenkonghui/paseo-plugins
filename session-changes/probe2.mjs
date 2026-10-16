import { readFileSync } from "node:fs";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPaseoApi } from "@getpaseo/client";

const token = readFileSync("/root/.paseo/local-credential", "utf8").trim();
const client = new DaemonClient({
  url: "ws://127.0.0.1:6767/ws",
  clientId: "probe-session-changes-2",
  clientType: "cli",
  appVersion: "probe",
  localCredential: () => token,
  connectTimeoutMs: 8000,
  reconnect: { enabled: false },
});
await client.connect();
const api = createPaseoApi(client);
const agentId = process.argv[2];
const page = await api.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 300 });

console.log("=== path 'file' records ===");
for (const entry of page.entries) {
  const item = entry.item;
  if (item.type !== "tool_call") continue;
  const d = item.detail;
  if (d?.type !== "edit" || d.filePath !== "file") continue;
  console.log("---- name:", item.name, "| callId:", item.callId.slice(0, 12), "| status:", item.status);
  console.log("metadata:", JSON.stringify(item.metadata ?? null).slice(0, 200));
  console.log("unified head:", JSON.stringify((d.unifiedDiff ?? "").split("\n").slice(0, 6)));
}

console.log("\n=== a real file edit (diff.ts) ===");
for (const entry of page.entries) {
  const item = entry.item;
  if (item.type !== "tool_call") continue;
  const d = item.detail;
  if (d?.type !== "edit" || !String(d.filePath).includes("diff.ts")) continue;
  console.log("---- name:", item.name, "| status:", item.status);
  console.log("unified:", JSON.stringify((d.unifiedDiff ?? "").split("\n").slice(0, 14), null, 0));
  break;
}
await client.close();
process.exit(0);
