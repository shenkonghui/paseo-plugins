// 端到端验证：通过 daemon 的 plugin RPC 通道调用 session-changes.checkpoints
// 注意：绝不在真实会话上调用 restore（会覆盖工作区文件），仅验证列表与未找到报错
import { readFileSync } from "node:fs";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

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
const agentId = process.argv[2];

const result = await client.invokePluginRpc("session-changes", "session-changes.checkpoints", {
  agentId,
});
const checkpoints = result?.checkpoints ?? [];
console.log("checkpoints:", checkpoints.length);
for (const checkpoint of checkpoints) {
  const newFiles = checkpoint.files.filter((f) => !f.backupFileName).length;
  console.log(
    " ",
    checkpoint.at,
    checkpoint.id,
    `${checkpoint.files.length} files`,
    newFiles ? `(${newFiles} new)` : "",
  );
}
const last = checkpoints[checkpoints.length - 1];
if (last) {
  console.log("latest sample files:", last.files.slice(0, 4).map((f) => f.path).join(", "));
}

try {
  await client.invokePluginRpc("session-changes", "session-changes.restore", {
    agentId,
    checkpointId: "msg_does_not_exist_probe",
  });
  console.log("UNEXPECTED: unknown checkpoint did not throw");
} catch (error) {
  console.log("unknown checkpoint error:", String(error?.message ?? error).slice(0, 120));
}

await client.close();
process.exit(0);
