import path from "node:path";
import type { TokenUsageAgent } from "../types.js";
import type { TokenUsageCollectContext, TokenUsageCollector } from "../collector.js";
import { localDayKey } from "../day-window.js";
import { unavailableAgent, type UsageDelta, UsageAccumulator } from "../counters.js";
import type { TranscriptFile } from "../transcript-files.js";
import { firstNumber, listTranscriptFiles, parseJsonLine, readLines } from "../transcript-files.js";

interface CodebuddyRawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  prompt_cache_write_tokens?: number;
  completion_thinking_tokens?: number;
  credit?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
  prompt_tokens_details?: { cached_tokens?: number };
}

interface CodebuddyTranscriptEntry {
  timestamp?: number;
  providerData?: {
    model?: string;
    rawUsage?: CodebuddyRawUsage;
  };
}

/**
 * CodeBuddy keeps one JSONL transcript per session under `~/.codebuddy/projects`,
 * nested by working directory. Usage rides on the entries that made an LLM call.
 */
export class CodebuddyCollector implements TokenUsageCollector {
  readonly agentId = "codebuddy" as const;
  readonly displayName = "CodeBuddy";

  async collect(context: TokenUsageCollectContext): Promise<TokenUsageAgent> {
    const root = path.join(context.homeDir, ".codebuddy", "projects");
    const accumulator = new UsageAccumulator();

    let files: TranscriptFile[];
    try {
      files = await listTranscriptFiles(root);
    } catch (error) {
      return unavailableAgent({
        agentId: this.agentId,
        displayName: this.displayName,
        error: `No CodeBuddy transcripts at ${root}: ${describe(error)}`,
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
        // Most lines are tool output; the substring test keeps JSON.parse off them.
        if (!line.includes('"rawUsage"')) {
          continue;
        }
        const entry = parseJsonLine(line) as CodebuddyTranscriptEntry | undefined;
        const usage = entry?.providerData?.rawUsage;
        const timestamp = entry?.timestamp;
        if (!usage || typeof timestamp !== "number" || timestamp < context.cutoffMs) {
          continue;
        }
        accumulator.record({
          dayKey: localDayKey(timestamp),
          sessionId: path.relative(root, file.filePath),
          model: entry?.providerData?.model,
          delta: toUsageDelta(usage),
        });
        await context.gate.maybeYield();
      }
    }

    return accumulator.toAgent({
      agentId: this.agentId,
      displayName: this.displayName,
      status: "available",
    });
  }
}

function toUsageDelta(usage: CodebuddyRawUsage): UsageDelta {
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    reasoningTokens: firstNumber(
      usage.completion_tokens_details?.reasoning_tokens,
      usage.completion_thinking_tokens,
    ),
    cacheReadTokens: firstNumber(
      usage.prompt_cache_hit_tokens,
      usage.prompt_tokens_details?.cached_tokens,
      usage.cache_read_input_tokens,
    ),
    cacheWriteTokens: firstNumber(
      usage.prompt_cache_write_tokens,
      usage.cache_creation_input_tokens,
    ),
    // CodeBuddy bills in credits, not dollars, so this never lands in costUsd.
    costCredits: usage.credit,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
