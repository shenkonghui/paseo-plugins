import path from "node:path";
import type { TokenUsageAgent } from "../types.js";
import { displaySourcePath, type TokenUsageCollectContext, type TokenUsageCollector } from "../collector.js";
import { localDayKey, localHourKey } from "../day-window.js";
import { unavailableAgent, type UsageDelta, UsageAccumulator } from "../counters.js";
import type { TranscriptFile } from "../transcript-files.js";
import { listTranscriptFiles, parseJsonLine, readLines } from "../transcript-files.js";

interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  totalTokens?: number;
  cost?: { total?: number };
}

interface PiTranscriptEntry {
  type?: string;
  timestamp?: string | number;
  message?: {
    role?: string;
    model?: string;
    usage?: PiUsage;
  };
}

/**
 * Pi writes one JSONL per session under `~/.pi/agent/sessions`, nested by working
 * directory, and stamps each entry with an ISO timestamp.
 */
export class PiCollector implements TokenUsageCollector {
  readonly agentId = "pi" as const;
  readonly displayName = "Pi";

  async collect(context: TokenUsageCollectContext): Promise<TokenUsageAgent> {
    const root = path.join(context.homeDir, ".pi", "agent", "sessions");
    const source = displaySourcePath(context.homeDir, root);
    const accumulator = new UsageAccumulator();

    let files: TranscriptFile[];
    try {
      files = await listTranscriptFiles(root);
    } catch (error) {
      return unavailableAgent({
        agentId: this.agentId,
        displayName: this.displayName,
        error: `No Pi sessions at ${source}: ${describe(error)}`,
        sources: [source],
      });
    }

    for (const file of files) {
      await context.gate.maybeYield();
      if (file.mtimeMs < context.cutoffMs) {
        continue;
      }
      // Transcripts rotate and get pruned while we read them; a vanished file is not an error.
      const lines = await readLines(file.filePath).catch(() => [] as string[]);
      for (const line of lines) {
        if (!line.includes('"usage"')) {
          continue;
        }
        const entry = parseJsonLine(line) as PiTranscriptEntry | undefined;
        if (
          entry?.type !== "message" ||
          entry.message?.role !== "assistant" ||
          !entry.message.usage
        ) {
          continue;
        }
        const timestampMs = toTimestampMs(entry.timestamp);
        if (timestampMs === undefined || timestampMs < context.cutoffMs) {
          continue;
        }
        accumulator.record({
          dayKey: localDayKey(timestampMs),
          hourKey: timestampMs >= context.todayStartMs ? localHourKey(timestampMs) : undefined,
          sessionId: path.relative(root, file.filePath),
          model: entry.message.model,
          delta: toUsageDelta(entry.message.usage),
        });
        await context.gate.maybeYield();
      }
    }

    return accumulator.toAgent({
      agentId: this.agentId,
      displayName: this.displayName,
      status: "available",
      sources: [source],
    });
  }
}

function toUsageDelta(usage: PiUsage): UsageDelta {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: usage.totalTokens,
    reasoningTokens: usage.reasoning,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    costUsd: usage.cost?.total,
  };
}

function toTimestampMs(timestamp: string | number | undefined): number | undefined {
  if (typeof timestamp === "number") {
    return Number.isFinite(timestamp) ? timestamp : undefined;
  }
  if (typeof timestamp !== "string") {
    return undefined;
  }
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
