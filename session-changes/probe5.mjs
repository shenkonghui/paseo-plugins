// 完整打印最近若干 tool_call 条目的全部字段，确认插件可见的数据面
import { readFileSync } from "node:fs";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPaseoApi } from "@getpaseo/client";

const token = readFileSync("/root/.paseo/local-credential", "utf8").trim();
const client = new DaemonClient({
  url: "ws://127.0.0.1:6767/ws",
  clientId: "probe-session-changes",
  clientType: "cli",
  appVersion: "probe",
  localCredential: () => token,
  connectTimeoutMs: 8000,
  reconnect: { enabled: false },
});
await client.connect();
const api = createPaseoApi(client);

const agentId = process.argv[2];
const limit = Number(process.argv[3] ?? 8);
const page = await api.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 300 });

const calls = [];
for (const entry of page.entries) {
  if (entry.item.type !== "tool_call") continue;
  const d = entry.item.detail;
  if (d?.type !== "edit" && d?.type !== "write") continue;
  calls.push(entry);
}
for (const entry of calls.slice(-limit)) {
  console.log("=== callId:", entry.item.callId, "name:", entry.item.name, "status:", entry.item.status);
  console.log(JSON.stringify(entry, null, 2).slice(0, 4000));
}
await client.close();
process.exit(0);
