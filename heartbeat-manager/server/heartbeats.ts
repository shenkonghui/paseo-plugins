import { createHostClient } from "@getpaseo/client/node";
import type { RpcInput } from "@getpaseo/plugin";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
  Heartbeat,
  HeartbeatRun,
  HeartbeatRunStatus,
  heartbeatActionRpc,
  heartbeatCreateRpc,
  heartbeatUpdateRpc,
} from "../shared/heartbeats";

/**
 * 心跳即 target.type === "agent" 的 schedule。插件 server 由 daemon fork，
 * 跑在 daemon 同机同用户下，因此用官方 DaemonClient + 本地凭据直连本地 daemon，
 * 拿到 CLI 未开放的 scheduleList / pause / resume / run-once。
 */
type DaemonClient = ReturnType<typeof createHostClient>;

const APP_VERSION = "0.13.0";
const CONNECT_TIMEOUT_MS = 8_000;
const CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return input;
}

function paseoHome(): string {
  const raw = process.env.PASEO_HOME?.trim();
  return raw ? resolve(expandHome(raw)) : join(homedir(), ".paseo");
}

function readListenAddress(): { listen: string; localCredential: () => string | undefined } {
  const home = paseoHome();
  const lockPath = join(home, "paseo.pid");
  let lock: unknown;
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    throw new Error(`无法读取 Paseo daemon 的 pid 文件：${lockPath}（daemon 未运行？）`);
  }
  const listen = isRecord(lock) && typeof lock.listen === "string" ? lock.listen.trim() : "";
  if (!listen) throw new Error(`Paseo daemon 的 pid 文件缺少 listen 地址：${lockPath}`);
  return {
    listen,
    localCredential: () => {
      try {
        const token = readFileSync(join(home, "local-credential"), "utf8").trim();
        return CREDENTIAL_PATTERN.test(token) ? token : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

let clientSeq = 0;

/** 每次操作建一条短连接：daemon 侧处理完立即释放，避免长连接状态残留。 */
async function withClient<T>(run: (client: DaemonClient) => Promise<T>): Promise<T> {
  const { listen, localCredential } = readListenAddress();
  const password = process.env.PASEO_PASSWORD;
  const client = createHostClient(listen, {
    clientId: `heartbeat-manager-${process.pid}-${Date.now()}-${clientSeq++}`,
    clientType: "cli",
    appVersion: APP_VERSION,
    ...(password ? { password } : { localCredential }),
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    reconnect: { enabled: false },
  });
  try {
    await client.connect();
    return await run(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

function errorMessage(error: unknown): string {
  if (isRecord(error)) {
    const message = typeof error.message === "string" ? error.message : "";
    const details = typeof error.details === "string" ? error.details : "";
    if (message) return details ? `${message}（${details}）` : message;
    if (typeof error.code === "string") return error.code;
  }
  return error instanceof Error ? error.message : String(error);
}

const DURATION_UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function expiresAtFromDuration(value: string): string {
  const match = /^(\d+)([smhd])$/.exec(value);
  if (!match) throw new Error(`无法解析过期时间：${value}`);
  return new Date(Date.now() + Number(match[1]) * DURATION_UNIT_MS[match[2]]).toISOString();
}

const RUN_STATUSES: readonly HeartbeatRunStatus[] = ["running", "succeeded", "failed"];

function toRun(raw: unknown): HeartbeatRun | null {
  if (!isRecord(raw)) return null;
  const status = RUN_STATUSES.find((value) => value === raw.status);
  if (!status || typeof raw.scheduledFor !== "string" || typeof raw.startedAt !== "string") return null;
  return {
    id: typeof raw.id === "string" ? raw.id : `${raw.scheduledFor}`,
    scheduledFor: raw.scheduledFor,
    startedAt: raw.startedAt,
    endedAt: typeof raw.endedAt === "string" ? raw.endedAt : null,
    status,
    agentId: typeof raw.agentId === "string" ? raw.agentId : null,
    error: typeof raw.error === "string" ? raw.error : null,
  };
}

/** StoredSchedule → 视图模型；只接受 agent 目标（心跳）。 */
function toHeartbeat(raw: unknown): Heartbeat | null {
  if (!isRecord(raw)) return null;
  const target = isRecord(raw.target) ? raw.target : null;
  if (!target || target.type !== "agent" || typeof target.agentId !== "string") return null;

  const cadence = isRecord(raw.cadence) ? raw.cadence : null;
  const cron =
    cadence && cadence.type === "cron" && typeof cadence.expression === "string" ? cadence.expression : "";
  const timezone = cadence && typeof cadence.timezone === "string" ? cadence.timezone : null;
  const status =
    raw.status === "active" || raw.status === "paused" || raw.status === "completed" ? raw.status : "completed";
  const runs = Array.isArray(raw.runs)
    ? raw.runs.map(toRun).filter((run): run is HeartbeatRun => run !== null)
    : [];

  return {
    id: typeof raw.id === "string" ? raw.id : "",
    name: typeof raw.name === "string" ? raw.name : null,
    prompt: typeof raw.prompt === "string" ? raw.prompt : "",
    cron,
    timezone,
    agentId: target.agentId,
    status,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    nextRunAt: typeof raw.nextRunAt === "string" ? raw.nextRunAt : null,
    lastRunAt: typeof raw.lastRunAt === "string" ? raw.lastRunAt : null,
    expiresAt: typeof raw.expiresAt === "string" ? raw.expiresAt : null,
    maxRuns: typeof raw.maxRuns === "number" ? raw.maxRuns : null,
    runs,
  };
}

function sortHeartbeats(heartbeats: Heartbeat[]): Heartbeat[] {
  const rank = (heartbeat: Heartbeat): number =>
    heartbeat.status === "active" ? 0 : heartbeat.status === "paused" ? 1 : 2;
  return heartbeats.sort((left, right) => {
    const byStatus = rank(left) - rank(right);
    if (byStatus !== 0) return byStatus;
    const leftNext = left.nextRunAt ?? "9999";
    const rightNext = right.nextRunAt ?? "9999";
    if (leftNext !== rightNext) return leftNext < rightNext ? -1 : 1;
    return left.id.localeCompare(right.id);
  });
}

export async function listHeartbeats(): Promise<{
  error: string | null;
  heartbeats: Heartbeat[];
}> {
  try {
    return await withClient(async (client) => {
      const listed = await client.scheduleList();
      if (listed.error) throw new Error(listed.error);
      const summaries = (listed.schedules ?? []).filter(
        (schedule) => schedule.target?.type === "agent" && typeof schedule.id === "string",
      );
      const details = await Promise.all(
        summaries.map(async (summary) => {
          try {
            const inspected = await client.scheduleInspect({ id: summary.id });
            return toHeartbeat(inspected.schedule ?? summary);
          } catch {
            return toHeartbeat(summary);
          }
        }),
      );
      const heartbeats = details.filter((heartbeat): heartbeat is Heartbeat => heartbeat !== null);
      return { error: null, heartbeats: sortHeartbeats(heartbeats) };
    });
  } catch (error) {
    return { error: errorMessage(error), heartbeats: [] };
  }
}

export async function createHeartbeat(
  input: RpcInput<typeof heartbeatCreateRpc>,
): Promise<{ error: string | null; heartbeat: Heartbeat | null }> {
  try {
    return await withClient(async (client) => {
      const created = await client.scheduleCreate({
        prompt: input.prompt,
        cadence: {
          type: "cron",
          expression: input.cron,
          ...(input.timezone ? { timezone: input.timezone } : {}),
        },
        target: { type: "agent", agentId: input.agentId },
        ...(input.name ? { name: input.name } : {}),
        ...(input.maxRuns != null ? { maxRuns: input.maxRuns } : {}),
        ...(input.expiresIn ? { expiresAt: expiresAtFromDuration(input.expiresIn) } : {}),
      });
      if (created.error) throw new Error(created.error);
      return { error: null, heartbeat: created.schedule ? toHeartbeat(created.schedule) : null };
    });
  } catch (error) {
    return { error: errorMessage(error), heartbeat: null };
  }
}

export async function updateHeartbeat(
  input: RpcInput<typeof heartbeatUpdateRpc>,
): Promise<{ error: string | null; heartbeat: Heartbeat | null }> {
  try {
    return await withClient(async (client) => {
      const updated = await client.scheduleUpdate({
        id: input.id,
        cadence: {
          type: "cron",
          expression: input.cron,
          ...(input.timezone ? { timezone: input.timezone } : {}),
        },
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
        ...(input.maxRuns !== undefined ? { maxRuns: input.maxRuns } : {}),
        ...(input.expiresIn !== undefined
          ? { expiresAt: input.expiresIn === null ? null : expiresAtFromDuration(input.expiresIn) }
          : {}),
      });
      if (updated.error) throw new Error(updated.error);
      return { error: null, heartbeat: updated.schedule ? toHeartbeat(updated.schedule) : null };
    });
  } catch (error) {
    return { error: errorMessage(error), heartbeat: null };
  }
}

export async function runHeartbeatAction(
  input: RpcInput<typeof heartbeatActionRpc>,
): Promise<{ error: string | null }> {
  try {
    return await withClient(async (client) => {
      switch (input.action) {
        case "pause":
          return { error: (await client.schedulePause({ id: input.id })).error ?? null };
        case "resume":
          return { error: (await client.scheduleResume({ id: input.id })).error ?? null };
        case "run-once":
          return { error: (await client.scheduleRunOnce({ id: input.id })).error ?? null };
        case "delete":
          return { error: (await client.scheduleDelete({ id: input.id })).error ?? null };
      }
    });
  } catch (error) {
    return { error: errorMessage(error) };
  }
}