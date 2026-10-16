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
console.log("connected");
const api = createPaseoApi(client);

const agentId = process.argv[2];
const page = await api.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 300 });
console.log("entries:", page.entries.length, "epoch:", page.epoch?.slice(0, 8));

const files = new Map();
for (const entry of page.entries) {
  const item = entry.item;
  if (item.type !== "tool_call") continue;
  const d = item.detail;
  if (d?.type !== "edit" && d?.type !== "write") continue;
  if (!d.filePath) continue;
  let f = files.get(d.filePath);
  if (!f) { f = { edits: 0, writes: 0, hasOld: 0, hasNew: 0, hasContent: 0, unified: 0 }; files.set(d.filePath, f); }
  if (d.type === "edit") {
    f.edits++;
    if (d.oldString !== undefined) f.hasOld++;
    if (d.newString !== undefined) f.hasNew++;
    if (d.unifiedDiff !== undefined) f.unified++;
  } else {
    f.writes++;
    if (d.content !== undefined) f.hasContent++;
  }
}
console.log("files:", files.size);
for (const [path, f] of files) console.log(JSON.stringify(f), path);
await client.close();
process.exit(0);
