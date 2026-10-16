import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type {
  CheckpointRecord,
  EditDetailRecord,
  RestoreOutput,
} from "../shared/edit-details";

interface ToolCallData {
  filePath?: string;
  diff?: string;
  additions?: number;
  deletions?: number;
  oldText?: string;
  newText?: string;
  content?: string;
}

interface SnapshotFileData {
  backupFileName?: string;
  version: number;
  backupTime: string;
}

interface SnapshotData {
  id: string;
  at: string;
  cwd: string;
  files: Map<string, SnapshotFileData>;
}

interface ParsedTranscript {
  calls: Map<string, ToolCallData>;
  snapshots: Map<string, SnapshotData>;
}

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const BACKUP_RE = /^[0-9a-f-]{36}@v\d{1,6}$/;
const MAX_CACHE_ENTRIES = 8;

const transcriptCache = new Map<string, { key: string; parsed: ParsedTranscript }>();

function messageIdTime(messageId: string): string | null {
  const match = /^msg_(\d{10,16})_/.exec(messageId);
  if (!match) return null;
  const ms = Number(match[1]);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function parseSnapshot(entry: {
  type?: unknown;
  messageId?: unknown;
  snapshot?: unknown;
}): SnapshotData | null {
  if (entry.type !== "file-history-snapshot") return null;
  const snap = entry.snapshot;
  if (!snap || typeof snap !== "object") return null;
  const snapshot = snap as {
    messageId?: unknown;
    trackedFileBackups?: unknown;
    timestamp?: unknown;
    cwd?: unknown;
  };
  const id =
    typeof snapshot.messageId === "string"
      ? snapshot.messageId
      : typeof entry.messageId === "string"
        ? entry.messageId
        : null;
  if (!id) return null;
  const files = new Map<string, SnapshotFileData>();
  if (snapshot.trackedFileBackups && typeof snapshot.trackedFileBackups === "object") {
    for (const [filePath, info] of Object.entries(
      snapshot.trackedFileBackups as Record<string, unknown>,
    )) {
      if (filePath === "" || !info || typeof info !== "object") continue;
      const value = info as Record<string, unknown>;
      const file: SnapshotFileData = {
        version: typeof value.version === "number" ? value.version : 0,
        backupTime: typeof value.backupTime === "string" ? value.backupTime : "",
      };
      // backupFileName 为 null 表示该记录点时尚无此文件（会话中新建）
      if (typeof value.backupFileName === "string") file.backupFileName = value.backupFileName;
      files.set(filePath, file);
    }
  }
  const at =
    typeof snapshot.timestamp === "string" ? snapshot.timestamp : (messageIdTime(id) ?? "");
  return { id, at, cwd: typeof snapshot.cwd === "string" ? snapshot.cwd : "", files };
}

function parseTranscript(text: string): ParsedTranscript {
  const calls = new Map<string, ToolCallData>();
  const snapshots = new Map<string, SnapshotData>();
  for (const line of text.split("\n")) {
    if (line === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const record = entry as {
      type?: unknown;
      messageId?: unknown;
      snapshot?: unknown;
      message?: { content?: unknown };
      toolUseResult?: Record<string, unknown>;
    };
    if (record.type === "file-history-snapshot") {
      const snapshot = parseSnapshot(record);
      // 同一 messageId 的后续条目是累积更新（超集），保留最后一条即该记录点的完整状态
      if (snapshot) snapshots.set(snapshot.id, snapshot);
      continue;
    }
    const content = record.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block?.type === "tool_use" && typeof block.id === "string") {
        const input = (block.input ?? {}) as Record<string, unknown>;
        const data = calls.get(block.id) ?? {};
        if (typeof input.file_path === "string") data.filePath = input.file_path;
        if (typeof input.old_string === "string") data.oldText = input.old_string;
        if (typeof input.new_string === "string") data.newText = input.new_string;
        if (typeof input.content === "string") data.content = input.content;
        calls.set(block.id, data);
        continue;
      }
      if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
        const result = record.toolUseResult;
        if (!result || typeof result !== "object") continue;
        const data = calls.get(block.tool_use_id) ?? {};
        if (typeof result.file_path === "string") data.filePath = result.file_path;
        if (typeof result.diff === "string") data.diff = result.diff;
        if (typeof result.additions === "number") data.additions = result.additions;
        if (typeof result.deletions === "number") data.deletions = result.deletions;
        calls.set(block.tool_use_id, data);
      }
    }
  }
  return { calls, snapshots };
}

async function loadTranscript(path: string): Promise<ParsedTranscript> {
  const info = await stat(path);
  const key = `${info.size}:${info.mtimeMs}`;
  const cached = transcriptCache.get(path);
  if (cached && cached.key === key) return cached.parsed;
  const parsed = parseTranscript(await readFile(path, "utf8"));
  if (transcriptCache.size >= MAX_CACHE_ENTRIES) transcriptCache.clear();
  transcriptCache.set(path, { key, parsed });
  return parsed;
}

async function resolveAgentSession(
  agentId: string,
): Promise<{ sessionId: string; cwd: string } | null> {
  if (!ID_RE.test(agentId)) return null;
  const paseoHome = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  const agentsDir = join(paseoHome, "agents");
  let shards: string[];
  try {
    shards = readdirSync(agentsDir);
  } catch {
    return null;
  }
  for (const shard of shards) {
    let raw: string;
    try {
      raw = await readFile(join(agentsDir, shard, `${agentId}.json`), "utf8");
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as {
        cwd?: unknown;
        persistence?: { sessionId?: unknown; metadata?: { cwd?: unknown } };
        runtimeInfo?: { sessionId?: unknown };
      };
      const sessionId = parsed.persistence?.sessionId ?? parsed.runtimeInfo?.sessionId;
      const cwd = typeof parsed.cwd === "string" ? parsed.cwd : parsed.persistence?.metadata?.cwd;
      if (
        typeof sessionId === "string" &&
        ID_RE.test(sessionId) &&
        typeof cwd === "string" &&
        cwd !== ""
      ) {
        return { sessionId, cwd };
      }
    } catch {
      continue;
    }
  }
  return null;
}

function findTranscript(sessionId: string, cwd: string): string | null {
  const roots = [
    join(homedir(), ".qoder-cn", "projects"),
    join(homedir(), ".qoder", "projects"),
  ];
  const slug = cwd.replace(/[/\\]/g, "-");
  for (const root of roots) {
    const direct = join(root, slug, `${sessionId}.jsonl`);
    if (existsSync(direct)) return direct;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = join(root, entry, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export async function extractEditDetails(
  agentId: string,
  callIds: string[],
): Promise<EditDetailRecord[]> {
  const session = await resolveAgentSession(agentId);
  if (!session) return [];
  const path = findTranscript(session.sessionId, session.cwd);
  if (!path) return [];
  let calls: Map<string, ToolCallData>;
  try {
    calls = (await loadTranscript(path)).calls;
  } catch {
    return [];
  }
  const records: EditDetailRecord[] = [];
  for (const callId of callIds) {
    const data = calls.get(callId);
    if (!data) continue;
    if (
      data.diff === undefined &&
      data.oldText === undefined &&
      data.newText === undefined &&
      data.content === undefined
    ) {
      continue;
    }
    const record: EditDetailRecord = { callId };
    if (data.filePath !== undefined) record.filePath = data.filePath;
    if (data.diff !== undefined) record.diff = data.diff;
    if (data.additions !== undefined) record.additions = data.additions;
    if (data.deletions !== undefined) record.deletions = data.deletions;
    if (data.oldText !== undefined) record.oldText = data.oldText;
    if (data.newText !== undefined) record.newText = data.newText;
    if (data.content !== undefined) record.content = data.content;
    records.push(record);
  }
  return records;
}

async function loadSessionTranscript(
  agentId: string,
): Promise<{ session: { sessionId: string; cwd: string }; parsed: ParsedTranscript } | null> {
  const session = await resolveAgentSession(agentId);
  if (!session) return null;
  const path = findTranscript(session.sessionId, session.cwd);
  if (!path) return null;
  try {
    return { session, parsed: await loadTranscript(path) };
  } catch {
    return null;
  }
}

export async function extractCheckpoints(agentId: string): Promise<CheckpointRecord[]> {
  const loaded = await loadSessionTranscript(agentId);
  if (!loaded) return [];
  const checkpoints: CheckpointRecord[] = [];
  for (const snapshot of loaded.parsed.snapshots.values()) {
    if (snapshot.files.size === 0) continue;
    checkpoints.push({
      id: snapshot.id,
      at: snapshot.at,
      cwd: snapshot.cwd || loaded.session.cwd,
      files: [...snapshot.files.entries()].map(([path, file]) => {
        const record: CheckpointRecord["files"][number] = {
          path,
          version: file.version,
          backupTime: file.backupTime,
        };
        if (file.backupFileName !== undefined) record.backupFileName = file.backupFileName;
        return record;
      }),
    });
  }
  checkpoints.sort((a, b) => a.at.localeCompare(b.at));
  return checkpoints;
}

function findFileHistoryDir(sessionId: string): string | null {
  const roots = [
    join(homedir(), ".qoder-cn", "file-history"),
    join(homedir(), ".qoder", "file-history"),
  ];
  for (const root of roots) {
    const dir = join(root, sessionId);
    if (existsSync(dir)) return dir;
  }
  return null;
}

export async function restoreCheckpoint(
  agentId: string,
  checkpointId: string,
): Promise<RestoreOutput> {
  const loaded = await loadSessionTranscript(agentId);
  if (!loaded) throw new Error("无法定位该会话的本地转录");
  const snapshot = loaded.parsed.snapshots.get(checkpointId);
  if (!snapshot) throw new Error("未找到该记录点");
  const historyDir = findFileHistoryDir(loaded.session.sessionId);
  const base = resolve(snapshot.cwd || loaded.session.cwd);
  const restored: RestoreOutput["restored"] = [];
  const skipped: RestoreOutput["skipped"] = [];

  for (const [filePath, file] of snapshot.files) {
    if (file.backupFileName === undefined) {
      skipped.push({ path: filePath, reason: "该记录点时尚无此文件（会话中新建），跳过以免删除" });
      continue;
    }
    if (!BACKUP_RE.test(file.backupFileName)) {
      skipped.push({ path: filePath, reason: "备份标识无效" });
      continue;
    }
    const target = resolve(base, filePath);
    if (!target.startsWith(base + sep)) {
      skipped.push({ path: filePath, reason: "路径越出工作目录" });
      continue;
    }
    if (!historyDir) {
      skipped.push({ path: filePath, reason: "未找到文件历史备份目录" });
      continue;
    }
    let content: Buffer;
    try {
      content = await readFile(join(historyDir, file.backupFileName));
    } catch {
      skipped.push({ path: filePath, reason: "备份文件缺失" });
      continue;
    }
    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
      restored.push({ path: filePath, bytes: content.byteLength });
    } catch (error) {
      skipped.push({
        path: filePath,
        reason: error instanceof Error ? error.message : "写入失败",
      });
    }
  }
  return { restored, skipped };
}
