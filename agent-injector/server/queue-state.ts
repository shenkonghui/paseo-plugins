import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * create_subagent 的队列运行状态（失败冷却 + 子 agent 到队列项的映射）。
 * 只影响优先级选择，与用户设置分开存放，写失败也不阻断创建。
 */
type QueueState = {
  /** 队列项 key -> 最近一次失败时间（epoch 毫秒） */
  failedAt: Record<string, number>;
  /** 子 agent id -> 创建它的队列项 key，用于把运行失败归因回队列项 */
  pending: Record<string, string>;
};

const HOUR_MS = 3_600_000;

function statePath(): string {
  const home = process.env.PASEO_HOME?.trim() || join(homedir(), ".paseo");
  return join(home, "plugin-data", "agent-injector", "subagent-queue.json");
}

let cache: QueueState | null = null;

function load(): QueueState {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(readFileSync(statePath(), "utf8")) as Partial<QueueState>;
    cache = {
      failedAt:
        parsed.failedAt && typeof parsed.failedAt === "object" ? parsed.failedAt : {},
      pending: parsed.pending && typeof parsed.pending === "object" ? parsed.pending : {},
    };
  } catch {
    cache = { failedAt: {}, pending: {} };
  }
  return cache;
}

function save(state: QueueState): void {
  cache = state;
  try {
    const file = statePath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch {
    // 忽略：状态丢失最多让失败的项早一点被重试
  }
}

/** 返回冷却结束时间；已过期会顺手清掉记录。hours <= 0 表示不做冷却。 */
export function cooldownUntil(key: string, hours: number, now = Date.now()): number | null {
  if (!(hours > 0)) return null;
  const state = load();
  const failedAt = state.failedAt[key];
  if (typeof failedAt !== "number") return null;
  const until = failedAt + hours * HOUR_MS;
  if (until > now) return until;
  delete state.failedAt[key];
  save(state);
  return null;
}

export function markEntryFailed(key: string, now = Date.now()): void {
  const state = load();
  state.failedAt[key] = now;
  save(state);
}

export function clearEntryFailure(key: string): void {
  const state = load();
  if (!(key in state.failedAt)) return;
  delete state.failedAt[key];
  save(state);
}

/** 手动清除失败冷却：keys 省略表示全部清除。返回清除的条数。 */
export function clearFailures(keys?: string[]): number {
  const state = load();
  let cleared = 0;
  if (keys) {
    for (const key of keys) {
      if (!(key in state.failedAt)) continue;
      delete state.failedAt[key];
      cleared += 1;
    }
  } else {
    cleared = Object.keys(state.failedAt).length;
    state.failedAt = {};
  }
  if (cleared > 0) save(state);
  return cleared;
}

export function markPendingAgent(agentId: string, key: string): void {
  const state = load();
  state.pending[agentId] = key;
  save(state);
}

/** 取出并移除某个子 agent 的队列项映射。 */
export function takePendingAgent(agentId: string): string | null {
  const state = load();
  const key = state.pending[agentId];
  if (!key) return null;
  delete state.pending[agentId];
  save(state);
  return key;
}
