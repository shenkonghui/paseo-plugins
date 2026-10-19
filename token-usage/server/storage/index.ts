import path from "node:path";
import { createFileSessionStorage } from "./file-sessions.js";
import { DevinStorage, OpencodeStorage } from "./sqlite-sessions.js";
import type { TokenUsageStorageTarget } from "./types.js";

/** 与 createTokenUsageCollectors 一一对应的磁盘占用 / 清理目标。 */
export function createStorageTargets(): TokenUsageStorageTarget[] {
  return [
    createFileSessionStorage({
      agentId: "codebuddy",
      displayName: "CodeBuddy",
      rootDir: (homeDir) => path.join(homeDir, ".codebuddy"),
      sessionsDir: (homeDir) => path.join(homeDir, ".codebuddy", "projects"),
      extension: ".jsonl",
      // CodeBuddy 把会话的 tool-results / subagents 放在同名的 <uuid>/ 目录里。
      includeSiblingDirs: true,
    }),
    createFileSessionStorage({
      agentId: "pi",
      displayName: "Pi",
      rootDir: (homeDir) => path.join(homeDir, ".pi"),
      sessionsDir: (homeDir) => path.join(homeDir, ".pi", "agent", "sessions"),
      extension: ".jsonl",
      includeSiblingDirs: false,
    }),
    new OpencodeStorage(),
    new DevinStorage(),
  ];
}

export type { AgentCleanupResult, AgentDiskUsage, StorageContext, TokenUsageStorageTarget } from "./types.js";
export { staleCutoffMs } from "./types.js";
