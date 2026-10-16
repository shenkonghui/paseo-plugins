// 校验：用与 store.ts 相同的过滤/计数逻辑复算实时时间线，模拟 pill 展示结果
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

function looksLikePath(filePath) {
  if (/[/\\]/.test(filePath)) return true;
  return /^[^./\\]+\.[^./\\]+$/.test(filePath);
}

function countUnifiedLines(text) {
  let adds = 0, dels = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("+") && !line.startsWith("+++")) adds++;
    else if (line.startsWith("-") && !line.startsWith("---")) dels++;
  }
  return { adds, dels };
}

const records = [];
const dropped = [];
for (const entry of page.entries) {
  const item = entry.item;
  if (item.type !== "tool_call") continue;
  const d = item.detail;
  if (d?.type !== "edit" && d?.type !== "write") continue;
  const filePath = d.filePath?.trim();
  if (!filePath || !looksLikePath(filePath)) {
    dropped.push(`${d.type}:${JSON.stringify(filePath)}`);
    continue;
  }
  if (d.type === "edit") {
    let counts = { adds: 0, dels: 0 };
    if (d.oldString !== undefined || d.newString !== undefined) {
      counts = { adds: (d.newString ?? "").split(/\r?\n/).length, dels: (d.oldString ?? "").split(/\r?\n/).length }; // 近似：此处只需判断是否有行数
    } else if (d.unifiedDiff) counts = countUnifiedLines(d.unifiedDiff);
    records.push({ filePath, kind: "edit", ...counts, hasUnified: !!d.unifiedDiff });
  } else {
    records.push({ filePath, kind: "write", adds: 0, dels: 0, hasContent: d.content !== undefined });
  }
}

const files = new Map();
for (const r of records) {
  let f = files.get(r.filePath);
  if (!f) { f = { filePath: r.filePath, records: [], adds: 0, dels: 0 }; files.set(r.filePath, f); }
  f.records.push(r); f.adds += r.adds; f.dels += r.dels;
}

let adds = 0, dels = 0;
for (const f of files.values()) { adds += f.adds; dels += f.dels; }
const counts = [];
if (adds > 0) counts.push(`+${adds}`);
if (dels > 0) counts.push(`-${dels}`);
const pill = files.size === 0 ? "(隐藏)" : `${files.size} 文件${counts.length ? " " + counts.join(" ") : ""}`;

console.log("entries:", page.entries.length);
console.log("dropped(non-path):", dropped.length, dropped.slice(0, 8));
console.log("ingested records:", records.length);
console.log("pill label:", pill);
for (const f of files.values()) {
  console.log(`  ${f.records.length}x +${f.adds} -${f.dels}${f.records.some((r) => r.hasUnified) ? " [unified]" : ""} ${f.filePath}`);
}
await client.close();
process.exit(0);
