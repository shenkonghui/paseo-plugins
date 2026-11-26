import path from "node:path";
import { displaySourcePath, collectionOf, type TokenUsageCollectContext, type TokenUsageCollector } from "../collector.js";
import { claudeRoots } from "../claude-roots.js";
import { localDayKey, localHourKey } from "../day-window.js";
import {
  unavailableAgent,
  UsageAccumulator,
  type CollectedTokenUsage,
  type UsageDelta,
} from "../counters.js";
import { classifyIssue, parseResetAt } from "../issues.js";
import type { TranscriptFile } from "../transcript-files.js";
import { listTranscriptFiles, parseJsonLine, readLines } from "../transcript-files.js";

/** Claude 每次 API 调用的 usage；缓存读写与输入分开计量，总量要把三者都算上。 */
interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens_details?: { thinking_tokens?: number } | null;
}

/** `system`/`api_error` 条目里的结构化失败信息（每次重试一条）。 */
interface ClaudeApiError {
  message?: string;
  /** 整理过的单行文案（「502 prompt is too long…」），比原始 message 更适合展示。 */
  formatted?: string;
  status?: number;
  /** 连接层失败时带上（StreamTruncated 等），是成功重试前也会出现的瞬态错误。 */
  connection?: { code?: string; message?: string } | null;
  isNetworkDown?: boolean;
}

interface ClaudeTranscriptEntry {
  type?: string;
  subtype?: string;
  timestamp?: string;
  sessionId?: string;
  /** 失败请求的用户可见替身（model 为 `<synthetic>`、usage 全 0），不是真实 API 调用。 */
  isApiErrorMessage?: boolean;
  /** 计划重试的毫秒数；条目带它说明这次失败被判定为可重试。 */
  retryInMs?: number;
  error?: ClaudeApiError;
  message?: {
    id?: string;
    model?: string;
    usage?: ClaudeUsage;
  };
}

/**
 * Claude Code 一个 `.jsonl` 一个会话，按工作目录嵌套在 `<config>/projects` 下。
 * usage 挂在 assistant 条目的 `message.usage`；同一条 API 响应会按 content block
 * 拆成多行（message.id 相同、usage 相同），按 id 去重——跨文件也要去，fork 会话
 * 会把历史复制进新文件。`isSidechain` 的子代理调用是独立 API 调用，照计。
 *
 * 失败请求写在 `system`/`api_error` 条目（重试每次一条）；`isApiErrorMessage`
 * 的 assistant 替身没有结构化错误、usage 全 0，直接跳过。
 */
export class ClaudeCollector implements TokenUsageCollector {
  readonly agentId = "claude" as const;
  readonly displayName = "Claude";

  async collect(context: TokenUsageCollectContext): Promise<CollectedTokenUsage> {
    const roots = claudeRoots(context.homeDir).map((home) => path.join(home, "projects"));
    const sources = roots.map((root) => displaySourcePath(context.homeDir, root));
    const accumulator = new UsageAccumulator();
    const seenMessageIds = new Set<string>();
    const readableRoots: string[] = [];

    // 失败事件只看当天 0 点以来，可能比 7 / 30 天用量窗口更晚；文件级过滤取两者更早的那个。
    const scanCutoffMs = Math.min(context.cutoffMs, context.issueCutoffMs);

    for (const root of roots) {
      let files: TranscriptFile[];
      try {
        files = await listTranscriptFiles(root);
      } catch {
        // CLAUDE_CONFIG_DIR 未指向真实目录也正常：只要有一个根存在就算可用。
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
          const hasUsage = line.includes('"usage"');
          const hasError = line.includes('"api_error"');
          if (!hasUsage && !hasError) {
            continue;
          }
          const entry = parseJsonLine(line) as ClaudeTranscriptEntry | undefined;
          const timestampMs = toTimestampMs(entry?.timestamp);
          if (timestampMs === undefined) {
            continue;
          }
          if (entry?.type === "system" && entry.subtype === "api_error") {
            if (timestampMs >= context.issueCutoffMs) {
              recordIssue(
                accumulator,
                entry,
                timestampMs,
                entry.sessionId ?? path.relative(root, file.filePath),
              );
            }
            await context.gate.maybeYield();
            continue;
          }
          const usage = entry?.message?.usage;
          if (
            entry?.type !== "assistant" ||
            entry.isApiErrorMessage === true ||
            !usage ||
            timestampMs < context.cutoffMs
          ) {
            continue;
          }
          const messageId = entry.message?.id;
          if (messageId !== undefined) {
            if (seenMessageIds.has(messageId)) {
              continue;
            }
            seenMessageIds.add(messageId);
          }
          accumulator.record({
            dayKey: localDayKey(timestampMs),
            hourKey: timestampMs >= context.todayStartMs ? localHourKey(timestampMs) : undefined,
            sessionId: entry.sessionId ?? path.relative(root, file.filePath),
            model: entry.message?.model,
            delta: toUsageDelta(usage),
          });
          await context.gate.maybeYield();
        }
      }
    }

    if (readableRoots.length === 0) {
      return collectionOf(
        unavailableAgent({
          agentId: this.agentId,
          displayName: this.displayName,
          error: `No Claude transcripts at ${sources.join(" or ")}`,
          sources,
        }),
      );
    }

    return accumulator.toCollectedAgent({
      agentId: this.agentId,
      displayName: this.displayName,
      status: "available",
      sources: readableRoots.map((root) => displaySourcePath(context.homeDir, root)),
      todayMs: context.todayStartMs,
    });
  }
}

function recordIssue(
  accumulator: UsageAccumulator,
  entry: ClaudeTranscriptEntry,
  timestampMs: number,
  sessionId: string,
): void {
  const error = entry.error;
  const message = (error?.formatted ?? error?.message)?.trim();
  if (!message) {
    // 没有原文就无法归类，也没有可展示的内容。
    return;
  }
  accumulator.recordIssue({
    kind: classifyIssue({
      message,
      httpStatus: error?.status,
      isNetworkError: error?.isNetworkDown === true || error?.connection != null,
    }),
    message,
    timestampMs,
    httpStatus: error?.status,
    retryable: typeof entry.retryInMs === "number" ? true : undefined,
    resetAtMs: parseResetAt(message),
    sessionId,
  });
}

function toUsageDelta(usage: ClaudeUsage): UsageDelta {
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    // Claude 的 input_tokens 不含缓存读写；与 OpenCode 口径一致，总量按完整维度求和。
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    reasoningTokens: usage.output_tokens_details?.thinking_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheWriteTokens: usage.cache_creation_input_tokens,
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
