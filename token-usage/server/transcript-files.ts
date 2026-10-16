import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export interface TranscriptFile {
  filePath: string;
  /** One file is one session in every agent that stores JSONL transcripts. */
  sessionId: string;
  mtimeMs: number;
}

export async function listTranscriptFiles(
  root: string,
  extension = ".jsonl",
): Promise<TranscriptFile[]> {
  const found: TranscriptFile[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(extension)) {
        continue;
      }
      // A dangling entry must not void the whole transcript tree.
      const info = await stat(fullPath).catch(() => null);
      if (!info) {
        continue;
      }
      found.push({
        filePath: fullPath,
        sessionId: entry.name.slice(0, -extension.length),
        mtimeMs: info.mtimeMs,
      });
    }
  }

  return found;
}

export async function readLines(filePath: string): Promise<string[]> {
  const text = await readFile(filePath, "utf8");
  return text.split("\n");
}

/** Transcripts are append-only logs from other tools: a malformed line is skipped, not fatal. */
export function parseJsonLine(line: string): unknown {
  if (!line) {
    return undefined;
  }
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

export function firstNumber(...values: readonly (number | undefined)[]): number | undefined {
  return values.find((value) => value !== undefined && Number.isFinite(value));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
