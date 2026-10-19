import path from "node:path";
import type { TokenUsageAgent } from "../types.js";
import type { TokenUsageCollectContext, TokenUsageCollector } from "../collector.js";
import { localDayKey, localHourKey } from "../day-window.js";
import { unavailableAgent, type UsageDelta, UsageAccumulator } from "../counters.js";
import type { TranscriptFile } from "../transcript-files.js";
import { listTranscriptFiles, parseJsonLine, readLines } from "../transcript-files.js";

/** Qoder 每个 LLM 调用的 usage 块（字段齐全，未开启 token 上报时 token 维度为 0）。 */
interface QoderRawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  credits?: number;
  /** 该请求是否计入用户的 Credits 用量；免费模型为 false。 */
  billable?: boolean;
  /** 每次调用唯一；用于跨文件（子 agent transcript）去重。 */
  request_id?: string;
}

interface QoderTranscriptEntry {
  type?: string;
  timestamp?: string;
  /** 子 agent 的 transcript 也写父会话 id，因此可直接作为会话归属。 */
  sessionId?: string;
  message?: {
    model?: string;
    usage?: QoderRawUsage;
  };
}

/**
 * Qoder 国内版（`~/.qoder-cn/projects`）与国际版（`~/.qoder/projects`）各留一份
 * 会话 transcript，按工作目录嵌套，一个 `.jsonl` 一个会话。子 agent 的 transcript
 * 在 `<uuid>/subagents/*.jsonl`，请求不重复（各自 request_id 唯一），一并计入。
 *
 * token 维度要靠 CLI 的 `QODERCN_EXPOSE_TOKEN_USAGE=1`（国际版 `QODER_EXPOSE_TOKEN_USAGE=1`）
 * 才会带真实值，否则 Qoder 只写 credits、token 全 0。
 */
export class QoderCollector implements TokenUsageCollector {
  readonly agentId = "qoder" as const;
  readonly displayName = "Qoder";

  async collect(context: TokenUsageCollectContext): Promise<TokenUsageAgent> {
    const roots = [
      path.join(context.homeDir, ".qoder-cn", "projects"),
      path.join(context.homeDir, ".qoder", "projects"),
    ];
    const accumulator = new UsageAccumulator();
    // 流式重试理论上可能把同一个 request_id 写成两行，按 id 兜底去重。
    const seenRequestIds = new Set<string>();
    const missingRoots: string[] = [];
    let readableRoots = 0;

    for (const root of roots) {
      let files: TranscriptFile[];
      try {
        files = await listTranscriptFiles(root);
      } catch {
        // 没装国内版 / 国际版都正常：只要有一个根存在就算可用。
        missingRoots.push(root);
        continue;
      }
      readableRoots += 1;

      for (const file of files) {
        await context.gate.maybeYield();
        if (file.mtimeMs < context.cutoffMs) {
          continue;
        }
        // Transcripts rotate and get pruned while we read them; a vanished file is not an error.
        const lines = await readLines(file.filePath).catch(() => [] as string[]);
        for (const line of lines) {
          // Most lines are tool output; the substring test keeps JSON.parse off them.
          if (!line.includes('"input_tokens"')) {
            continue;
          }
          const entry = parseJsonLine(line) as QoderTranscriptEntry | undefined;
          const usage = entry?.message?.usage;
          if (entry?.type !== "assistant" || !usage) {
            continue;
          }
          const timestampMs = toTimestampMs(entry.timestamp);
          if (timestampMs === undefined || timestampMs < context.cutoffMs) {
            continue;
          }
          const requestId = usage.request_id;
          if (requestId !== undefined) {
            if (seenRequestIds.has(requestId)) {
              continue;
            }
            seenRequestIds.add(requestId);
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

    if (readableRoots === 0) {
      return unavailableAgent({
        agentId: this.agentId,
        displayName: this.displayName,
        error: `No Qoder transcripts at ${roots.join(" or ")}`,
      });
    }

    return accumulator.toAgent({
      agentId: this.agentId,
      displayName: this.displayName,
      status: "available",
    });
  }
}

function toUsageDelta(usage: QoderRawUsage): UsageDelta {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    // Qoder 不写 total_tokens；缺省时由累加器按 input + output 补。
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheWriteTokens: usage.cache_creation_input_tokens,
    // 积分按账单口径：billable === false 的免费模型请求不计入（token / 请求数仍然计入）。
    costCredits: usage.billable === false ? undefined : usage.credits,
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
