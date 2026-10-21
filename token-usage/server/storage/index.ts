import path from "node:path";
import { codebuddyHomes } from "../codebuddy-roots.js";
import { createFileSessionStorage, createMergedFileSessionStorage } from "./file-sessions.js";
import { createQoderStorage } from "./qoder-sessions.js";
import { DevinStorage, OpencodeStorage } from "./sqlite-sessions.js";
import type { TokenUsageStorageTarget } from "./types.js";

/** 与 createTokenUsageCollectors 一一对应的磁盘占用 / 清理目标。 */
export function createStorageTargets(): TokenUsageStorageTarget[] {
  return [
    // 国内版在主目录，国际版跑在 Paseo 的独立 home 下，可能有多个数据根。
    createMergedFileSessionStorage({
      agentId: "codebuddy",
      displayName: "CodeBuddy",
      roots: (homeDir) =>
        codebuddyHomes(homeDir).map((home) => ({
          rootDir: path.join(home, ".codebuddy"),
          sessionsDir: path.join(home, ".codebuddy", "projects"),
        })),
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
    createQoderStorage(),
  ];
}

export type { AgentCleanupResult, AgentDiskUsage, StorageContext, TokenUsageStorageTarget } from "./types.js";
export { staleCutoffMs } from "./types.js";
