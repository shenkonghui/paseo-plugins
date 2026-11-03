import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SubagentRow, SubagentStatus } from "../shared/subagents";

/**
 * CLI 适配器契约：给定 provider 原生 session id，读出它落盘的子任务列表。
 * 新增一个 CLI 只需要实现这个接口并在 adapters 里注册。
 */
export interface SubagentStoreAdapter {
  /** 用于匹配 provider 的 id（Paseo 里的 provider 名） */
  matches(provider: string): boolean;
  /** 人可读的数据源说明 */
  readonly label: string;
  list(sessionId: string): Promise<SubagentRow[]>;
}

interface QoderTaskFile {
  taskId?: unknown;
  sessionId?: unknown;
  agentId?: unknown;
  agentType?: unknown;
  description?: unknown;
  status?: unknown;
  summary?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  completedAt?: unknown;
  outputPath?: unknown;
}

function qoderHome(): string {
  const fromEnv = process.env.QODER_HOME?.trim();
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(homedir(), ".qoder-cn");
}

function mapQoderStatus(status: unknown): SubagentStatus {
  switch (String(status ?? "").toLowerCase()) {
    case "completed":
    case "complete":
    case "success":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
    case "canceled":
    case "stopped":
      return "cancelled";
    case "running":
    case "pending":
    case "queued":
    default:
      return "running";
  }
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Qoder 把会话目录编码成 `<project root>/<sessionId>/subagents`，root 名由 cwd 生成，直接扫。 */
async function findSessionSubagentsDir(sessionId: string): Promise<string | null> {
  const projectsRoot = join(qoderHome(), "projects");
  let projects: string[];
  try {
    projects = await readdir(projectsRoot);
  } catch {
    return null;
  }
  for (const project of projects) {
    const candidate = join(projectsRoot, project, sessionId, "subagents");
    if (await exists(candidate)) return candidate;
  }
  return null;
}

export const qoderAdapter: SubagentStoreAdapter = {
  label: "qoder",
  matches(provider) {
    return provider === "qoder" || provider.startsWith("qoder-") || provider.startsWith("qoder");
  },
  async list(sessionId) {
    const dir = await findSessionSubagentsDir(sessionId);
    if (!dir) return [];

    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return [];
    }

    const rows: SubagentRow[] = [];
    for (const file of files) {
      if (!file.startsWith("task-") || !file.endsWith(".json")) continue;
      let parsed: QoderTaskFile;
      try {
        parsed = JSON.parse(await readFile(join(dir, file), "utf8")) as QoderTaskFile;
      } catch {
        continue;
      }
      const taskId = asString(parsed.taskId) ?? file.slice("task-".length, -".json".length);
      const agentId = asString(parsed.agentId) ?? taskId;
      const description = asString(parsed.description);
      rows.push({
        id: taskId,
        agentId,
        name: description ?? asString(parsed.agentType) ?? taskId,
        description,
        agentType: asString(parsed.agentType),
        status: mapQoderStatus(parsed.status),
        startedAt: asNumber(parsed.createdAt),
        updatedAt: asNumber(parsed.updatedAt),
        completedAt: asNumber(parsed.completedAt),
        summary: asString(parsed.summary),
        outputPath: asString(parsed.outputPath),
      });
    }
    rows.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    return rows;
  },
};

export const adapters: readonly SubagentStoreAdapter[] = [qoderAdapter];

export function pickAdapter(provider: string): SubagentStoreAdapter | null {
  return adapters.find((adapter) => adapter.matches(provider)) ?? null;
}
