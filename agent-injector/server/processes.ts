import { open, readFile, readdir, readlink } from "node:fs/promises";
import type {
  AgentProcessRow,
  ProcessOutput,
  ProcessOutputInput,
  ProcessesSnapshot,
} from "../shared/processes";

/** Linux 的 USER_HZ 固定为 100（/proc stat 的 starttime 单位）。 */
const CLOCK_TICKS_PER_SECOND = 100;
const ENV_NEEDLE = "PASEO_AGENT_ID=";
const MAX_ROWS_PER_AGENT = 64;
const MAX_COMMAND_LENGTH = 300;
const READ_BATCH = 64;

interface ProcInfo {
  pid: number;
  ppid: number;
  /** /proc stat 的第 3 个字段：R / S / D / Z … */
  state: string;
  startTicks: number;
}

/**
 * pid → 归属 agent。daemon 启动 agent CLI 时会注入 PASEO_AGENT_ID，
 * 子进程（Bash 命令、MCP server…）默认继承，所以按 env 认领比按 pid 匹配更准。
 * 缓存按 startTicks 失效，避免每次轮询重读全部 /proc/<pid>/environ。
 */
const envCache = new Map<number, { startTicks: number; agentId: string | null }>();

function parseStat(raw: string): { state: string; ppid: number; startTicks: number } | null {
  // comm 里可能有空格和括号，从最后一个 ")" 之后开始切字段。
  const close = raw.lastIndexOf(")");
  if (close < 0) return null;
  const fields = raw.slice(close + 2).trim().split(/\s+/);
  // 字段序（1-based）：3=state, 4=ppid, 22=starttime → 切片后 0、1、19。
  const state = fields[0];
  const ppid = Number(fields[1]);
  const startTicks = Number(fields[19]);
  if (!state || !Number.isFinite(ppid) || !Number.isFinite(startTicks)) return null;
  return { state, ppid, startTicks };
}

async function readProcTable(): Promise<Map<number, ProcInfo>> {
  const entries = await readdir("/proc");
  const pids = entries.filter((entry) => /^\d+$/.test(entry)).map(Number);
  const table = new Map<number, ProcInfo>();

  for (let index = 0; index < pids.length; index += READ_BATCH) {
    const batch = pids.slice(index, index + READ_BATCH);
    const parsed = await Promise.all(
      batch.map(async (pid) => {
        try {
          const stat = parseStat(await readFile(`/proc/${pid}/stat`, "utf8"));
          return stat ? ({ pid, ...stat } satisfies ProcInfo) : null;
        } catch {
          // 进程在两次读取之间退出是常态，忽略即可。
          return null;
        }
      }),
    );
    for (const info of parsed) if (info) table.set(info.pid, info);
  }

  return table;
}

/**
 * 同一 agent 的进程不一定连成一棵树：CodeBuddy 的 Bash 工具命令由 daemon 直接
 * spawn（ppid 是 daemon，不是 agent CLI），只是继承了 PASEO_AGENT_ID。
 * 因此把 env 命中的进程当成「同一 agent 的进程集合」，CLI 本体取其中启动最早的那个
 * （仅用于头部展示；列表本身只保留叶子）。
 */
function pickAgentRoot(owned: ReadonlySet<number>, table: Map<number, ProcInfo>): number | null {
  let best: { pid: number; startTicks: number } | null = null;
  for (const pid of owned) {
    const startTicks = table.get(pid)?.startTicks ?? Number.MAX_SAFE_INTEGER;
    if (!best || startTicks < best.startTicks || (startTicks === best.startTicks && pid < best.pid)) {
      best = { pid, startTicks };
    }
  }
  return best?.pid ?? null;
}

/** 只对「缓存里没有 / startTicks 变了」的 pid 读 environ。 */
async function resolveAgentIds(
  table: Map<number, ProcInfo>,
  wanted: ReadonlySet<string>,
): Promise<Map<string, number[]>> {
  for (const pid of envCache.keys()) {
    if (!table.has(pid)) envCache.delete(pid);
  }

  const pending: ProcInfo[] = [];
  for (const info of table.values()) {
    const cached = envCache.get(info.pid);
    if (!cached || cached.startTicks !== info.startTicks) pending.push(info);
  }

  for (let index = 0; index < pending.length; index += READ_BATCH) {
    const batch = pending.slice(index, index + READ_BATCH);
    await Promise.all(
      batch.map(async (info) => {
        let agentId: string | null = null;
        try {
          const env = await readFile(`/proc/${info.pid}/environ`, "utf8");
          for (const entry of env.split("\0")) {
            if (!entry.startsWith(ENV_NEEDLE)) continue;
            const value = entry.slice(ENV_NEEDLE.length).trim();
            if (value) agentId = value;
            break;
          }
        } catch {
          // 权限不足或进程已退出：当作无归属。
        }
        envCache.set(info.pid, { startTicks: info.startTicks, agentId });
      }),
    );
  }

  const matches = new Map<string, number[]>();
  for (const info of table.values()) {
    const agentId = envCache.get(info.pid)?.agentId;
    if (!agentId || !wanted.has(agentId)) continue;
    const list = matches.get(agentId);
    if (list) list.push(info.pid);
    else matches.set(agentId, [info.pid]);
  }
  return matches;
}

async function readUptimeMs(): Promise<number> {
  const raw = await readFile("/proc/uptime", "utf8");
  const seconds = Number(raw.trim().split(/\s+/)[0]);
  return Number.isFinite(seconds) ? seconds * 1000 : 0;
}

async function readCommand(pid: number): Promise<string> {
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`, "utf8");
    const command = raw
      .split("\0")
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (!command) return `[${pid}]`;
    return command.length > MAX_COMMAND_LENGTH
      ? `${command.slice(0, MAX_COMMAND_LENGTH - 1)}…`
      : command;
  } catch {
    return `[${pid}]`;
  }
}

async function readCwd(pid: number): Promise<string | null> {
  try {
    return await readlink(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

interface FdTarget {
  /** 原始指向：绝对路径、pipe:[…]、socket:[…]、/dev/null。 */
  target: string;
  /** 只有普通文件可读；管道 / socket / 空设备一律为 null。 */
  path: string | null;
}

async function readFdTarget(pid: number, fd: 1 | 2): Promise<FdTarget | null> {
  try {
    const target = await readlink(`/proc/${pid}/fd/${fd}`);
    const readable = target.startsWith("/") && target !== "/dev/null";
    return { target, path: readable ? target : null };
  } catch {
    return null;
  }
}


/**
 * 第一级进程常常是包装 shell（`bash -c python3 ... > log`），它自己的 stdout 是
 * 工具捕获用的 socket，真正写文件的是子进程。往下探一层找第一个重定向到文件的 fd。
 */
async function findOutputDescendant(
  pid: number,
  agentId: string,
  table: Map<number, ProcInfo>,
  childrenByParent: Map<number, number[]>,
): Promise<{ pid: number; stdout: FdTarget | null; stderr: FdTarget | null } | null> {
  const queue: Array<{ pid: number; depth: number }> = [{ pid, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= 6) continue;
    for (const child of childrenByParent.get(current.pid) ?? []) {
      const info = table.get(child);
      if (!info || info.state === "Z") continue;
      const owner = envCache.get(child)?.agentId;
      if (owner && owner !== agentId) continue;
      const [stdout, stderr] = await Promise.all([readFdTarget(child, 1), readFdTarget(child, 2)]);
      if (stdout?.path || stderr?.path) return { pid: child, stdout, stderr };
      queue.push({ pid: child, depth: current.depth + 1 });
    }
  }

  return null;
}

export async function readProcessesSnapshot(agentIds: string[]): Promise<ProcessesSnapshot> {
  if (process.platform !== "linux") {
    return { supported: false, error: null, agents: {} };
  }

  try {
    const [table, uptimeMs] = await Promise.all([readProcTable(), readUptimeMs()]);
    const matches = await resolveAgentIds(table, new Set(agentIds));

    const childrenByParent = new Map<number, number[]>();
    for (const info of table.values()) {
      const siblings = childrenByParent.get(info.ppid);
      if (siblings) siblings.push(info.pid);
      else childrenByParent.set(info.ppid, [info.pid]);
    }

    const agents: ProcessesSnapshot["agents"] = {};

    for (const agentId of agentIds) {
      const owned = new Set(matches.get(agentId) ?? []);
      if (owned.size === 0) {
        agents[agentId] = { rootPid: null, rows: [] };
        continue;
      }

      const rootPid = pickAgentRoot(owned, table);

      // 候选 = env 命中的全部进程 + 环境变量被清掉的子进程；CLI 本体不算后台进程。
      const candidates = new Set<number>(owned);
      if (rootPid !== null) candidates.delete(rootPid);

      const queue = [...owned];
      while (queue.length > 0) {
        const pid = queue.pop()!;
        for (const child of childrenByParent.get(pid) ?? []) {
          if (owned.has(child) || candidates.has(child)) continue;
          // 带别的 agentId 的进程（子 agent）不归到父 agent 名下。
          if (envCache.get(child)?.agentId) continue;
          const info = table.get(child);
          if (!info || info.state === "Z") continue;
          candidates.add(child);
          queue.push(child);
        }
      }

      // 只留第一级：CLI 的直接子进程，以及父进程不属于本 agent 的顶层进程
      // （CodeBuddy 的 Bash 命令由 daemon 直接 spawn，ppid 是 daemon）。
      // 更深层的 make / sh / ginkgo 等都不再展开。
      const firstLevel = [...candidates]
        .filter((pid) => {
          if (pid === rootPid) return false;
          const parent = table.get(pid)?.ppid;
          if (parent === undefined) return false;
          return parent === rootPid || !owned.has(parent);
        })
        .sort((a, b) => a - b)
        .slice(0, MAX_ROWS_PER_AGENT);

      const collectedRows: AgentProcessRow[] = await Promise.all(
        firstLevel.map(async (pid) => {
          const info = table.get(pid)!;
          const [command, cwd, stdout, stderr] = await Promise.all([
            readCommand(pid),
            readCwd(pid),
            readFdTarget(pid, 1),
            readFdTarget(pid, 2),
          ]);

          // 包装 shell 自己的 fd 是 socket 时，用真正写文件的子进程来读输出。
          let outputPid = pid;
          let outputStdout = stdout;
          let outputStderr = stderr;
          if (!stdout?.path && !stderr?.path) {
            const descendant = await findOutputDescendant(pid, agentId, table, childrenByParent);
            if (descendant) {
              outputPid = descendant.pid;
              outputStdout = descendant.stdout;
              outputStderr = descendant.stderr;
            }
          }

          return {
            pid,
            ppid: info.ppid,
            // 第一级列表是平的，固定为 1（客户端按 0 缩进）。
            depth: 1,
            command,
            cwd,
            state: info.state,
            elapsedMs: Math.max(0, uptimeMs - info.startTicks * (1000 / CLOCK_TICKS_PER_SECOND)),
            stdoutTarget: outputStdout?.target ?? null,
            stderrTarget: outputStderr?.target ?? null,
            stdoutPath: outputStdout?.path ?? null,
            stderrPath: outputStderr?.path ?? null,
            outputPid,
          };
        }),
      );

      // 过滤掉两类噪音：
      // 1. 常驻 helper（MCP server / CLI internal guard）；
      // 2. 前台命令——它们的输出由 CLI 通过 pipe/socket 捕获，读不到也不需要在这里看，
      //    只保留输出落到文件、能持续查看的后台任务。
      const rows = collectedRows.filter(
        (row) => !HELPER_COMMAND_PATTERN.test(row.command) && Boolean(row.stdoutPath ?? row.stderrPath),
      );

      agents[agentId] = { rootPid, rows };
    }

    return { supported: true, error: null, agents };
  } catch (error) {
    return {
      supported: true,
      error: error instanceof Error ? error.message : String(error),
      agents: {},
    };
  }
}

/** 常驻 helper（MCP server、CLI 内部守护进程）不算业务后台进程。 */
const HELPER_COMMAND_PATTERN = /(^|[/\s_.-])mcp([/\s_.-]|$)|internal-process-guard/i;

const DEFAULT_OUTPUT_BYTES = 32 * 1024;

async function processOwnedByAgent(pid: number, agentId: string): Promise<boolean> {
  try {
    const env = await readFile(`/proc/${pid}/environ`, "utf8");
    return env.split("\0").includes(`PASEO_AGENT_ID=${agentId}`);
  } catch {
    return false;
  }
}

/**
 * 读子进程 stdout / stderr 的尾部。
 * 只对「重定向到普通文件」的 fd 有效（Qoder 的后台任务就是这种）；
 * 接在 pipe / socket 上的输出由 CLI 自己消费，插件无法旁路读取。
 */
export async function readProcessOutput(input: ProcessOutputInput): Promise<ProcessOutput> {
  const empty: ProcessOutput = {
    target: null,
    path: null,
    readable: false,
    size: 0,
    content: "",
    truncated: false,
    error: null,
  };

  if (process.platform !== "linux") return { ...empty, error: "仅 Linux 支持" };
  if (!(await processOwnedByAgent(input.pid, input.agentId))) {
    return { ...empty, error: "进程不存在，或不属于该 agent" };
  }

  const fd = input.stream === "stdout" ? 1 : 2;
  const target = await readFdTarget(input.pid, fd);
  if (!target) return { ...empty, error: "读不到该进程的 fd" };
  if (!target.path) return { ...empty, target: target.target };

  try {
    const handle = await open(target.path, "r");
    try {
      const { size } = await handle.stat();
      const limit = input.maxBytes ?? DEFAULT_OUTPUT_BYTES;
      const length = Math.min(size, limit);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, size - length);
      return {
        target: target.target,
        path: target.path,
        readable: true,
        size,
        content: buffer.subarray(0, bytesRead).toString("utf8"),
        truncated: size > bytesRead,
        error: null,
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    return {
      ...empty,
      target: target.target,
      path: target.path,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
