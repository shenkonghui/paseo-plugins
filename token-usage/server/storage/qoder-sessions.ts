import path from "node:path";
import { createMergedFileSessionStorage } from "./file-sessions.js";
import type { TokenUsageStorageTarget } from "./types.js";

/**
 * Qoder 国内版（`~/.qoder-cn`）与国际版（`~/.qoder`）是两个数据根，却共用同一个
 * agentId，所以把两个文件型目标合并成一个：占用相加、清理合并，面板上只出现一张卡片。
 */
export function createQoderStorage(): TokenUsageStorageTarget {
  return createMergedFileSessionStorage({
    agentId: "qoder",
    displayName: "Qoder",
    roots: (homeDir) =>
      [".qoder-cn", ".qoder"].map((dir) => ({
        rootDir: path.join(homeDir, dir),
        sessionsDir: path.join(homeDir, dir, "projects"),
      })),
    extension: ".jsonl",
    includeSiblingDirs: true,
  });
}
