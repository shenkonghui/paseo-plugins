import { setImmediate } from "node:timers/promises";

/** How long a collector may hold the event loop before it must hand it back. */
const YIELD_BUDGET_MS = 8;

export interface YieldGate {
  maybeYield(): Promise<void>;
}

export interface YieldGateOptions {
  budgetMs?: number;
  now?: () => number;
}

/**
 * Token collectors read hundreds of megabytes with synchronous work per file and
 * per SQLite page. Yielding on every record would starve throughput, so the gate
 * only hands the loop back once the budget is actually spent.
 */
export function createYieldGate(options: YieldGateOptions = {}): YieldGate {
  const budgetMs = options.budgetMs ?? YIELD_BUDGET_MS;
  const now = options.now ?? (() => performance.now());
  let lastYield = now();

  return {
    async maybeYield(): Promise<void> {
      if (now() - lastYield < budgetMs) {
        return;
      }
      await setImmediate();
      lastYield = now();
    },
  };
}
