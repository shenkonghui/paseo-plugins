import type { TokenUsageAgent } from "../types.js";
import type { TokenUsageCollectContext, TokenUsageCollector } from "../collector.js";
import { localDayKey } from "../day-window.js";
import { unavailableAgent, type UsageDelta, UsageAccumulator } from "../counters.js";
import { collectDevinRows, type DevinUsageRow } from "./devin-worker.js";

export class DevinCollector implements TokenUsageCollector {
  readonly agentId = "devin" as const;
  readonly displayName = "Devin";

  async collect(context: TokenUsageCollectContext): Promise<TokenUsageAgent> {
    const accumulator = new UsageAccumulator();

    // SQLite day math is UTC-only; shift each row into host-local time first. The
    // offset is fixed per run, so rows can land an hour off local midnight on the
    // two DST transition days a year. Daily totals stay complete.
    const tzOffsetSec = -new Date(context.nowMs).getTimezoneOffset() * 60;

    let rows: DevinUsageRow[];
    try {
      rows = await collectDevinRows({
        homeDir: context.homeDir,
        cutoffMs: context.cutoffMs,
        tzOffsetSec,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      context.logger.debug({ err: error }, "Failed to read Devin usage");
      return unavailableAgent({
        agentId: this.agentId,
        displayName: this.displayName,
        error: message,
        status: "unavailable",
      });
    }

    for (const row of rows) {
      applyRow(accumulator, row);
      await context.gate.maybeYield();
    }

    return accumulator.toAgent({
      agentId: this.agentId,
      displayName: this.displayName,
      status: "available",
    });
  }
}

function applyRow(accumulator: UsageAccumulator, row: DevinUsageRow): void {
  const delta: UsageDelta = {
    requests: row.requests,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    // Devin's metrics have no total; normalize to the full-dimension sum so
    // every agent's "total tokens" includes cache reads/writes.
    totalTokens:
      row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
  };
  accumulator.record({
    dayKey: localDayKey(row.hourIndex * 3600 * 1000),
    sessionId: row.sessionId ?? undefined,
    model: row.model ?? undefined,
    delta,
  });
}
