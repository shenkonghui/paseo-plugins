import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AgentRecord {
  id: string;
  provider: string;
  cwd: string;
  /** provider 原生会话 id（Qoder/CodeBuddy 都用它命名磁盘目录） */
  sessionId: string | null;
}

interface CacheEntry {
  at: number;
  record: AgentRecord | null;
}

const CACHE_TTL_MS = 5_000;
const cache = new Map<string, CacheEntry>();

export function paseoHome(): string {
  const fromEnv = process.env.PASEO_HOME?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), ".paseo");
}

/**
 * Paseo 把 agent 记录写成 `<PASEO_HOME>/agents/<cwd 编码>/<agentId>.json`。
 * 目录名按 cwd 编码，直接遍历比复现编码规则稳。
 */
export async function readAgentRecord(agentId: string): Promise<AgentRecord | null> {
  const now = Date.now();
  const cached = cache.get(agentId);
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.record;

  const record = await readAgentRecordUncached(agentId);
  cache.set(agentId, { at: now, record });
  return record;
}

async function readAgentRecordUncached(agentId: string): Promise<AgentRecord | null> {
  const root = join(paseoHome(), "agents");
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    let raw: string;
    try {
      raw = await readFile(join(root, dir, `${agentId}.json`), "utf8");
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as {
        id?: unknown;
        provider?: unknown;
        cwd?: unknown;
        persistence?: { sessionId?: unknown };
      };
      const sessionId =
        typeof parsed.persistence?.sessionId === "string" ? parsed.persistence.sessionId : null;
      return {
        id: typeof parsed.id === "string" ? parsed.id : agentId,
        provider: typeof parsed.provider === "string" ? parsed.provider : "",
        cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
        sessionId,
      };
    } catch {
      continue;
    }
  }
  return null;
}
