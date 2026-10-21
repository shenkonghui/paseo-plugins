import type { TokenUsageAgent } from "../types.js";
import { displaySourcePath, type TokenUsageCollectContext, type TokenUsageCollector } from "../collector.js";
import { localDayKey, localHourKey } from "../day-window.js";
import { unavailableAgent, type UsageDelta, UsageAccumulator } from "../counters.js";
import { collectDevinRows, resolveDatabasePath, type DevinUsageRow } from "./devin-worker.js";

export class DevinCollector implements TokenUsageCollector {
  readonly agentId = "devin" as const;
  readonly displayName = "Devin";

  async collect(context: TokenUsageCollectContext): Promise<TokenUsageAgent> {
    const accumulator = new UsageAccumulator();
    const source = displaySourcePath(
      context.homeDir,
      resolveDatabasePath(context.homeDir),
    );

    let rows: DevinUsageRow[];
    try {
      rows = await collectDevinRows({
        homeDir: context.homeDir,
        cutoffMs: context.cutoffMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      context.logger.debug({ err: error }, "Failed to read Devin usage");
      return unavailableAgent({
        agentId: this.agentId,
        displayName: this.displayName,
        error: message,
        status: "unavailable",
        sources: [source],
      });
    }

    for (const row of rows) {
      applyRow(accumulator, row, context.todayStartMs);
      await context.gate.maybeYield();
    }

    return accumulator.toAgent({
      agentId: this.agentId,
      displayName: this.displayName,
      status: "available",
      sources: [source],
    });
  }
}

function applyRow(
  accumulator: UsageAccumulator,
  row: DevinUsageRow,
  todayStartMs: number,
): void {
  const timestampMs = row.timestampSec * 1000;
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
    dayKey: localDayKey(timestampMs),
    hourKey: timestampMs >= todayStartMs ? localHourKey(timestampMs) : undefined,
    sessionId: row.sessionId ?? undefined,
    model: row.model ?? undefined,
    delta,
  });
}
