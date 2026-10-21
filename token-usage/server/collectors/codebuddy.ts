import path from "node:path";
import type { TokenUsageAgent } from "../types.js";
import { displaySourcePath, type TokenUsageCollectContext, type TokenUsageCollector } from "../collector.js";
import { codebuddyHomes } from "../codebuddy-roots.js";
import { localDayKey, localHourKey } from "../day-window.js";
import { unavailableAgent, type UsageDelta, UsageAccumulator } from "../counters.js";
import { classifyIssue, parseResetAt, type RawIssue } from "../issues.js";
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

/** 失败请求的原文：`providerData.error`（成功时该字段不存在）。 */
interface CodebuddyError {
  message?: string;
  code?: number;
  status?: number;
  /** 注意：CodeBuddy 的字段名是 `isRetryable`，不是 `retryable`。 */
  isRetryable?: boolean;
  isNetworkError?: boolean;
  isStreamTimeout?: boolean;
}

interface CodebuddyTranscriptEntry {
  timestamp?: number;
  providerData?: {
    model?: string;
    rawUsage?: CodebuddyRawUsage;
    error?: CodebuddyError;
  };
}

/**
 * CodeBuddy keeps one JSONL transcript per session under `~/.codebuddy/projects`,
 * nested by working directory. Usage rides on the entries that made an LLM call,
 * and failed calls carry `providerData.error` instead.
 *
 * 国际版跑在 Paseo 的独立 HOME 下（`~/.paseo/homes/*`），数据格式相同；这里把所有
 * 找到的 CodeBuddy home 一起扫，面板上仍是一张 CodeBuddy 卡片。
 */
export class CodebuddyCollector implements TokenUsageCollector {
  readonly agentId = "codebuddy" as const;
  readonly displayName = "CodeBuddy";

  async collect(context: TokenUsageCollectContext): Promise<TokenUsageAgent> {
    const roots = codebuddyHomes(context.homeDir).map((home) =>
      path.join(home, ".codebuddy", "projects"),
    );
    const sources = roots.map((root) => displaySourcePath(context.homeDir, root));
    const accumulator = new UsageAccumulator();
    const readableRoots: string[] = [];

    // 失败事件只看当天 0 点以来，可能比 7 / 30 天用量窗口更晚；文件级过滤取两者更早的那个。
    const scanCutoffMs = Math.min(context.cutoffMs, context.issueCutoffMs);

    for (const root of roots) {
      let files: TranscriptFile[];
      try {
        files = await listTranscriptFiles(root);
      } catch {
        // 没装国际版 / 国际版还没产生会话都正常：只要有一个根存在就算可用。
        continue;
      }
      readableRoots.push(root);

      for (const file of files) {
        await context.gate.maybeYield();
        if (file.mtimeMs < scanCutoffMs) {
          continue;
        }
        // Transcripts rotate and get pruned while we read them; a vanished file is not an error.
        const lines = await readLines(file.filePath).catch(() => [] as string[]);
        for (const line of lines) {
          // Most lines are tool output; the substring test keeps JSON.parse off them.
          const hasUsage = line.includes('"rawUsage"');
          const hasError = line.includes('"isRetryable"');
          if (!hasUsage && !hasError) {
            continue;
          }
          const entry = parseJsonLine(line) as CodebuddyTranscriptEntry | undefined;
          const timestamp = entry?.timestamp;
          if (typeof timestamp !== "number") {
            continue;
          }
          const usage = entry?.providerData?.rawUsage;
          if (usage) {
            if (timestamp < context.cutoffMs) {
              continue;
            }
            accumulator.record({
              dayKey: localDayKey(timestamp),
              hourKey: timestamp >= context.todayStartMs ? localHourKey(timestamp) : undefined,
              sessionId: path.relative(root, file.filePath),
              model: entry?.providerData?.model,
              delta: toUsageDelta(usage),
            });
            await context.gate.maybeYield();
            continue;
          }
          const error = entry?.providerData?.error;
          if (!error || timestamp < context.issueCutoffMs) {
            continue;
          }
          recordIssue(accumulator, {
            error,
            timestampMs: timestamp,
            model: entry?.providerData?.model,
            sessionId: path.relative(root, file.filePath),
          });
          await context.gate.maybeYield();
        }
      }
    }

    if (readableRoots.length === 0) {
      return unavailableAgent({
        agentId: this.agentId,
        displayName: this.displayName,
        error: `No CodeBuddy transcripts at ${sources.join(" or ")}`,
        sources,
      });
    }

    return accumulator.toAgent({
      agentId: this.agentId,
      displayName: this.displayName,
      status: "available",
      sources: readableRoots.map((root) => displaySourcePath(context.homeDir, root)),
    });
  }
}

function recordIssue(
  accumulator: UsageAccumulator,
  input: {
    error: CodebuddyError;
    timestampMs: number;
    model?: string;
    sessionId?: string;
  },
): void {
  const message = input.error.message?.trim();
  if (!message) {
    // 没有原文就无法归类，也没有可展示的内容。
    return;
  }
  const raw: RawIssue = {
    message,
    code: input.error.code,
    httpStatus: input.error.status,
    retryable: input.error.isRetryable,
    isNetworkError: input.error.isNetworkError,
    isStreamTimeout: input.error.isStreamTimeout,
  };
  accumulator.recordIssue({
    kind: classifyIssue(raw),
    message,
    timestampMs: input.timestampMs,
    code: raw.code,
    httpStatus: raw.httpStatus,
    retryable: raw.retryable,
    resetAtMs: parseResetAt(message),
    model: input.model,
    sessionId: input.sessionId,
  });
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
