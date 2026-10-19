import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { YieldGate } from "../yield-gate.js";

/** 递归统计目录占用；符号链接不跟随，读不到的条目跳过而不是让整次统计失败。 */
export async function directorySize(root: string, gate: YieldGate): Promise<number> {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) {
      continue;
    }
    for (const entry of entries) {
      await gate.maybeYield();
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        const info = await stat(fullPath).catch(() => null);
        if (info) {
          total += info.size;
        }
      }
    }
  }
  return total;
}

export async function fileBytes(filePath: string): Promise<number> {
  const info = await stat(filePath).catch(() => null);
  return info?.isFile() ? info.size : 0;
}

export async function pathExists(target: string): Promise<boolean> {
  return (await stat(target).catch(() => null)) !== null;
}

/** 一个会话的产物：主 transcript 文件 + 同名附属目录（CodeBuddy 的 tool-results）。 */
export interface SessionArtifact {
  mainPath: string;
  extraPaths: string[];
  bytes: number;
  mtimeMs: number;
}

/**
 * 递归列出会话文件，一个 `*.jsonl` 即一个会话。若同目录下存在同名目录
 * （CodeBuddy 把该会话的 tool-results / subagents 放在 `<uuid>/` 下），
 * 一并计入大小并随会话一起清理。
 */
export async function listSessionArtifacts(
  sessionsRoot: string,
  extension: string,
  includeSiblingDirs: boolean,
  gate: YieldGate,
): Promise<SessionArtifact[]> {
  const found: SessionArtifact[] = [];
  const stack = [sessionsRoot];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(extension)) {
        continue;
      }
      const info = await stat(fullPath).catch(() => null);
      if (!info) {
        continue;
      }
      let bytes = info.size;
      const extraPaths: string[] = [];
      if (includeSiblingDirs) {
        const sibling = path.join(dir, entry.name.slice(0, -extension.length));
        const siblingInfo = await stat(sibling).catch(() => null);
        if (siblingInfo?.isDirectory()) {
          extraPaths.push(sibling);
          bytes += await directorySize(sibling, gate);
        }
      }
      found.push({ mainPath: fullPath, extraPaths, bytes, mtimeMs: info.mtimeMs });
    }
  }
  return found;
}

export function resolveXdgDataHome(homeDir: string): string {
  return process.env.XDG_DATA_HOME || path.join(homeDir, ".local", "share");
}
