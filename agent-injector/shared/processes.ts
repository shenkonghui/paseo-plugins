import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const agentProcessRowSchema = z.object({
  pid: z.number().int(),
  ppid: z.number().int(),
  /** 相对 agent CLI 进程的层级：1 = 直接子进程。 */
  depth: z.number().int(),
  /** 命令行，空白已折叠，超长截断。 */
  command: z.string(),
  cwd: z.string().nullable(),
  /** /proc 里的单字母状态：R / S / D / Z… */
  state: z.string(),
  elapsedMs: z.number(),
  /** stdout / stderr 的原始指向：绝对路径、pipe:[…]、socket:[…]、/dev/null… */
  stdoutTarget: z.string().nullable(),
  stderrTarget: z.string().nullable(),
  /** 只有指向普通文件时才可读（管道 / socket 由 CLI 内部消费，插件拿不到）。 */
  stdoutPath: z.string().nullable(),
  stderrPath: z.string().nullable(),
  /** 实际用来读输出的 pid：自身 fd 不是文件时，会下探到第一个把输出重定向到文件的子进程。 */
  outputPid: z.number().int(),
});

export type AgentProcessRow = z.infer<typeof agentProcessRowSchema>;

export const agentProcessesSchema = z.object({
  /** agent CLI 进程的 pid；null 表示该 agent 当前没有进程（未启动 / 已退出）。 */
  rootPid: z.number().int().nullable(),
  rows: z.array(agentProcessRowSchema),
});

export type AgentProcesses = z.infer<typeof agentProcessesSchema>;

/**
 * 一次返回多个 agent 的进程树：客户端只有一个轮询定时器，
 * 服务端也只扫一遍 /proc，agent 再多也不会放大开销。
 */
export const processesSnapshotRpc = defineRpc({
  name: "agent-processes-snapshot",
  input: z.object({ agentIds: z.array(z.string()).max(128) }),
  output: z.object({
    /** 仅 Linux 支持（依赖 /proc）。 */
    supported: z.boolean(),
    error: z.string().nullable(),
    agents: z.record(z.string(), agentProcessesSchema),
  }),
});

export type ProcessesSnapshot = z.infer<typeof processesSnapshotRpc.output>;

/** 读取某个子进程 stdout / stderr 的尾部。 */
export const processOutputRpc = defineRpc({
  name: "agent-process-output",
  input: z.object({
    agentId: z.string(),
    pid: z.number().int(),
    stream: z.enum(["stdout", "stderr"]),
    /** 最多读多少字节，默认 32KB。 */
    maxBytes: z.number().int().min(1024).max(1024 * 1024).optional(),
  }),
  output: z.object({
    /** fd 的原始指向，便于解释「为什么读不到」。 */
    target: z.string().nullable(),
    path: z.string().nullable(),
    readable: z.boolean(),
    size: z.number(),
    content: z.string(),
    truncated: z.boolean(),
    error: z.string().nullable(),
  }),
});

export type ProcessOutput = z.infer<typeof processOutputRpc.output>;
export type ProcessOutputInput = z.infer<typeof processOutputRpc.input>;
