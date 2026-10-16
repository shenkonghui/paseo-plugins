// 端到端验证：通过 daemon 的 plugin RPC 通道调用 session-changes.edit-details
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

const page = await api.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 300 });
const callIds = [];
for (const entry of page.entries) {
  if (entry.item.type !== "tool_call") continue;
  const d = entry.item.detail;
  if (d?.type !== "edit" && d?.type !== "write") continue;
  if (typeof d.filePath !== "string" || !d.filePath.includes("/")) continue;
  callIds.push(entry.item.callId);
}
console.log("edit/write records in tail:", callIds.length);

const result = await client.invokePluginRpc("session-changes", "session-changes.edit-details", {
  agentId,
  callIds: callIds.slice(0, 400),
});
const records = result?.records ?? [];
let withDiff = 0;
let withOldNew = 0;
let withContent = 0;
for (const r of records) {
  if (r.diff) withDiff++;
  if (r.oldText !== undefined || r.newText !== undefined) withOldNew++;
  if (r.content !== undefined) withContent++;
}
console.log("rpc records:", records.length, { withDiff, withOldNew, withContent });

const sampleEdit = records.find((r) => r.diff);
if (sampleEdit) {
  console.log(
    "sample edit:",
    sampleEdit.callId,
    sampleEdit.filePath,
    `+${sampleEdit.additions} -${sampleEdit.deletions}`,
  );
  console.log(sampleEdit.diff.split("\n").slice(0, 7).join("\n"));
}
const sampleWrite = records.find((r) => r.content !== undefined);
if (sampleWrite) {
  console.log(
    "sample write:",
    sampleWrite.callId,
    sampleWrite.filePath,
    "content chars:",
    sampleWrite.content.length,
  );
}
await client.close();
process.exit(0);
