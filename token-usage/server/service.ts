import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TokenUsageLogger } from "./types.js";
import type { TokenUsageAgent } from "./types.js";
import type { TokenUsageQoderQuota } from "../shared/rpc.js";
import type { TokenUsageCollectContext, TokenUsageCollector } from "./collector.js";
import { CodebuddyCollector } from "./collectors/codebuddy.js";
import { DevinCollector } from "./collectors/devin.js";
import { OpencodeCollector } from "./collectors/opencode.js";
import { PiCollector } from "./collectors/pi.js";
import { windowCutoffMs } from "./day-window.js";
import { unavailableAgent } from "./counters.js";
import { collectQoderQuota } from "./qoder-quota.js";
import { createYieldGate } from "./yield-gate.js";

const DEFAULT_TOKEN_USAGE_CACHE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_TOKEN_USAGE_WINDOW_DAYS = 30;

export function createTokenUsageCollectors(): TokenUsageCollector[] {
  return [
    new CodebuddyCollector(),
    new PiCollector(),
    new OpencodeCollector(),
    new DevinCollector(),
  ];
}

export interface TokenUsageServiceOptions {
  logger: TokenUsageLogger;
  collectors?: TokenUsageCollector[];
  homeDir?: string;
  cacheTtlMs?: number;
  windowDays?: number;
  now?: () => number;
  /** Overrides the on-disk snapshot location; defaults to $PASEO_HOME/plugin-cache/token-usage. */
  cacheFile?: string;
}

export interface TokenUsageListResult {
  fetchedAt: string;
  /** Host-local days of history the snapshot covers, ending today. */
  rangeDays: number;
  agents: TokenUsageAgent[];
  qoderQuota: TokenUsageQoderQuota | null;
}

export interface TokenUsageListOutcome {
  result: TokenUsageListResult;
  /** True when the served snapshot is older than the TTL; refresh only on explicit forceRefresh. */
  stale: boolean;
}

interface DiskCache {
  fetchedAtMs: number;
  result: TokenUsageListResult;
}

/**
 * Reads token usage out of the agent CLIs' own local stores. Collection is
 * deliberately sequential: every collector walks hundreds of megabytes with
 * synchronous steps, and a yield gate keeps each step inside the event-loop budget.
 * The last successful snapshot is also persisted, so a restart serves stale data
 * instantly; collection only runs on an explicit refresh request.
 */
export class TokenUsageService {
  private readonly logger: TokenUsageLogger;
  private readonly collectors: TokenUsageCollector[];
  private readonly homeDir: string;
  private readonly cacheTtlMs: number;
  private readonly windowDays: number;
  private readonly now: () => number;
  private readonly cacheFile: string;
  private cached: { fetchedAtMs: number; result: TokenUsageListResult } | null = null;
  private inFlight: Promise<TokenUsageListResult> | null = null;

  constructor(options: TokenUsageServiceOptions) {
    this.logger = options.logger;
    this.collectors = options.collectors ?? createTokenUsageCollectors();
    this.homeDir = options.homeDir ?? os.homedir();
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_TOKEN_USAGE_CACHE_TTL_MS;
    this.windowDays = options.windowDays ?? DEFAULT_TOKEN_USAGE_WINDOW_DAYS;
    this.now = options.now ?? Date.now;
    this.cacheFile =
      options.cacheFile ?? defaultCacheFilePath(options.homeDir ?? os.homedir());
    this.loadDiskCache();
  }

  async listUsage(options?: { forceRefresh?: boolean }): Promise<TokenUsageListOutcome> {
    const nowMs = this.now();
    if (options?.forceRefresh) {
      return { result: await this.collectOnce(), stale: false };
    }
    if (this.cached && nowMs - this.cached.fetchedAtMs < this.cacheTtlMs) {
      return { result: this.cached.result, stale: false };
    }
    if (this.cached) {
      return { result: this.cached.result, stale: true };
    }
    return { result: await this.collectOnce(), stale: false };
  }

  private collectOnce(): Promise<TokenUsageListResult> {
    if (this.inFlight) {
      return this.inFlight;
    }
    const request = this.collectFresh(this.now());
    this.inFlight = request;
    void request.finally(() => {
      if (this.inFlight === request) {
        this.inFlight = null;
      }
    });
    return request;
  }

  private async collectFresh(nowMs: number): Promise<TokenUsageListResult> {
    const context: TokenUsageCollectContext = {
      homeDir: this.homeDir,
      nowMs,
      cutoffMs: windowCutoffMs(nowMs, this.windowDays),
      windowDays: this.windowDays,
      logger: this.logger,
      gate: createYieldGate(),
    };

    const agents: TokenUsageAgent[] = [];
    for (const collector of this.collectors) {
      try {
        agents.push(await collector.collect(context));
      } catch (error) {
        this.logger.debug(
          { err: error, agentId: collector.agentId },
          "Token usage collector failed",
        );
        agents.push(
          unavailableAgent({
            agentId: collector.agentId,
            displayName: collector.displayName,
            error: error instanceof Error ? error.message : String(error),
            status: "error",
          }),
        );
      }
    }

    const qoderQuota = this.collectQoderQuotaSafely();

    const result: TokenUsageListResult = {
      fetchedAt: new Date(nowMs).toISOString(),
      rangeDays: this.windowDays,
      agents,
      qoderQuota,
    };
    this.cached = { fetchedAtMs: nowMs, result };
    this.persistDiskCache();
    return result;
  }

  private collectQoderQuotaSafely(): TokenUsageQoderQuota | null {
    try {
      return collectQoderQuota(this.homeDir, this.logger);
    } catch (error) {
      this.logger.debug({ err: error }, "Qoder quota collection failed");
      return null;
    }
  }

  private loadDiskCache(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cacheFile, "utf8")) as Partial<DiskCache>;
      if (
        typeof parsed.fetchedAtMs === "number" &&
        parsed.result &&
        Array.isArray(parsed.result.agents)
      ) {
        this.cached = {
          fetchedAtMs: parsed.fetchedAtMs,
          result: { ...parsed.result, qoderQuota: parsed.result.qoderQuota ?? null },
        };
      }
    } catch {
      // First run or unreadable snapshot; start cold.
    }
  }

  private persistDiskCache(): void {
    if (!this.cached) {
      return;
    }
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      const payload = JSON.stringify({
        fetchedAtMs: this.cached.fetchedAtMs,
        result: this.cached.result,
      } satisfies DiskCache);
      fs.writeFileSync(this.cacheFile, payload);
    } catch (error) {
      this.logger.debug({ err: error }, "Failed to persist token usage cache");
    }
  }
}

function defaultCacheFilePath(homeDir: string): string {
  const paseoHome = process.env.PASEO_HOME || path.join(homeDir, ".paseo");
  return path.join(paseoHome, "plugin-cache", "token-usage", "usage-cache.json");
}
