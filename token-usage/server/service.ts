import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TokenUsageLogger } from "./types.js";
import type { TokenUsageAgent } from "./types.js";
import type { TokenUsageCollectContext, TokenUsageCollector } from "./collector.js";
import { CodebuddyCollector } from "./collectors/codebuddy.js";
import { DevinCollector } from "./collectors/devin.js";
import { OpencodeCollector } from "./collectors/opencode.js";
import { PiCollector } from "./collectors/pi.js";
import { QoderCollector } from "./collectors/qoder.js";
import { windowCutoffMs } from "./day-window.js";
import { unavailableAgent } from "./counters.js";
import { createYieldGate } from "./yield-gate.js";
import {
  createStorageTargets,
  staleCutoffMs,
  type AgentCleanupResult,
  type AgentDiskUsage,
  type StorageContext,
  type TokenUsageStorageTarget,
} from "./storage/index.js";

const DEFAULT_TOKEN_USAGE_CACHE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_TOKEN_USAGE_WINDOW_DAYS = 30;
const DEFAULT_TOKEN_USAGE_DISK_CACHE_TTL_MS = 60 * 1000;
const DEFAULT_STALE_DAYS = 30;

export function createTokenUsageCollectors(): TokenUsageCollector[] {
  return [
    new CodebuddyCollector(),
    new PiCollector(),
    new OpencodeCollector(),
    new DevinCollector(),
    new QoderCollector(),
  ];
}

export interface TokenUsageServiceOptions {
  logger: TokenUsageLogger;
  collectors?: TokenUsageCollector[];
  storageTargets?: TokenUsageStorageTarget[];
  homeDir?: string;
  cacheTtlMs?: number;
  diskCacheTtlMs?: number;
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
}

export interface TokenUsageListOutcome {
  result: TokenUsageListResult;
  /** True when the served snapshot is older than the TTL; refresh only on explicit forceRefresh. */
  stale: boolean;
}

export interface TokenUsageDiskResult {
  fetchedAt: string;
  /** 判定「过期会话」的天数，与清理阈值保持一致。 */
  staleDays: number;
  agents: AgentDiskUsage[];
}

export interface TokenUsageDiskOutcome {
  result: TokenUsageDiskResult;
  stale: boolean;
}

export interface TokenUsageCleanupOutcome {
  results: AgentCleanupResult[];
  /** 清理后重新统计的磁盘占用，供 UI 直接刷新。 */
  disk: TokenUsageDiskResult;
}

interface DiskCache {
  fetchedAtMs: number;
  /** 该快照覆盖的窗口（天）；旧版本没有这个字段，回退用 result.rangeDays。 */
  windowDays?: number;
  /** 采集时被关闭的 agent；旧版本没有这个字段，视为全部开启。 */
  disabled?: string[];
  result: TokenUsageListResult;
}

/** 缓存 key：窗口 + 关闭采集的 agent 集合。 */
function cacheKeyFor(days: number, disabled: ReadonlySet<string>): string {
  return `${days}|${[...disabled].sort().join(",")}`;
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
  private readonly storageTargets: TokenUsageStorageTarget[];
  private readonly homeDir: string;
  private readonly cacheTtlMs: number;
  private readonly diskCacheTtlMs: number;
  private readonly windowDays: number;
  private readonly now: () => number;
  private readonly cacheFile: string;
  /** 按「窗口 + 关闭采集的 agent 集合」分别缓存。 */
  private readonly caches = new Map<string, { fetchedAtMs: number; result: TokenUsageListResult }>();
  private readonly inFlight = new Map<string, Promise<TokenUsageListResult>>();
  /** 磁盘占用按「过期天数」缓存，避免每次打开面板都遍历数据目录。 */
  private readonly diskCaches = new Map<number, { fetchedAtMs: number; result: TokenUsageDiskResult }>();
  private readonly diskInFlight = new Map<number, Promise<TokenUsageDiskResult>>();

  constructor(options: TokenUsageServiceOptions) {
    this.logger = options.logger;
    this.collectors = options.collectors ?? createTokenUsageCollectors();
    this.storageTargets = options.storageTargets ?? createStorageTargets();
    this.homeDir = options.homeDir ?? os.homedir();
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_TOKEN_USAGE_CACHE_TTL_MS;
    this.diskCacheTtlMs = options.diskCacheTtlMs ?? DEFAULT_TOKEN_USAGE_DISK_CACHE_TTL_MS;
    this.windowDays = options.windowDays ?? DEFAULT_TOKEN_USAGE_WINDOW_DAYS;
    this.now = options.now ?? Date.now;
    this.cacheFile =
      options.cacheFile ?? defaultCacheFilePath(options.homeDir ?? os.homedir());
    this.loadDiskCache();
  }

  async listUsage(options?: {
    forceRefresh?: boolean;
    windowDays?: number;
    /** 这些 agent 跳过采集（仍会返回一个 status="disabled" 的占位条目）。 */
    disabledAgents?: readonly string[];
  }): Promise<TokenUsageListOutcome> {
    const days = options?.windowDays ?? this.windowDays;
    const disabled = new Set(options?.disabledAgents ?? []);
    const cacheKey = cacheKeyFor(days, disabled);
    const nowMs = this.now();
    if (options?.forceRefresh) {
      return { result: await this.collectOnce(cacheKey, days, disabled), stale: false };
    }
    const cached = this.caches.get(cacheKey);
    if (cached && nowMs - cached.fetchedAtMs < this.cacheTtlMs) {
      return { result: cached.result, stale: false };
    }
    if (cached) {
      return { result: cached.result, stale: true };
    }
    return { result: await this.collectOnce(cacheKey, days, disabled), stale: false };
  }

  /**
   * 每个 agent 的本地磁盘占用。遍历数据目录 + 读会话数，按「过期天数」缓存，
   * 面板打开时通常直接命中缓存。
   */
  async diskUsage(options?: {
    forceRefresh?: boolean;
    olderThanDays?: number;
  }): Promise<TokenUsageDiskOutcome> {
    const days = normalizeStaleDays(options?.olderThanDays);
    const nowMs = this.now();
    if (options?.forceRefresh) {
      return { result: await this.collectDiskOnce(days), stale: false };
    }
    const cached = this.diskCaches.get(days);
    if (cached && nowMs - cached.fetchedAtMs < this.diskCacheTtlMs) {
      return { result: cached.result, stale: false };
    }
    if (cached) {
      return { result: cached.result, stale: true };
    }
    return { result: await this.collectDiskOnce(days), stale: false };
  }

  /** 手动清理：删除过期会话，然后重新统计磁盘占用（绕过缓存）。 */
  async cleanupSessions(options?: {
    olderThanDays?: number;
    agentIds?: readonly string[];
  }): Promise<TokenUsageCleanupOutcome> {
    const days = normalizeStaleDays(options?.olderThanDays);
    const selected = new Set(options?.agentIds ?? []);
    const targets =
      selected.size > 0
        ? this.storageTargets.filter((target) => selected.has(target.agentId))
        : this.storageTargets;
    const context = this.storageContext(this.now(), days);

    const results: AgentCleanupResult[] = [];
    for (const target of targets) {
      try {
        results.push(await target.cleanup(context));
      } catch (error) {
        this.logger.debug(
          { err: error, agentId: target.agentId },
          "Token usage session cleanup failed",
        );
        results.push({
          agentId: target.agentId,
          displayName: target.displayName,
          status: "error",
          removedSessions: 0,
          freedBytes: 0,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // 数据变了：丢掉该阈值的磁盘缓存，重新统计一次。
    this.diskCaches.delete(days);
    this.diskInFlight.delete(days);
    const disk = await this.collectDiskOnce(days);
    return { results, disk };
  }

  private collectDiskOnce(days: number): Promise<TokenUsageDiskResult> {
    const existing = this.diskInFlight.get(days);
    if (existing) {
      return existing;
    }
    const request = this.measureDisk(this.now(), days);
    this.diskInFlight.set(days, request);
    void request.finally(() => {
      if (this.diskInFlight.get(days) === request) {
        this.diskInFlight.delete(days);
      }
    });
    return request;
  }

  private async measureDisk(nowMs: number, days: number): Promise<TokenUsageDiskResult> {
    const context = this.storageContext(nowMs, days);
    const agents: AgentDiskUsage[] = [];
    for (const target of this.storageTargets) {
      try {
        agents.push(await target.measure(context));
      } catch (error) {
        this.logger.debug(
          { err: error, agentId: target.agentId },
          "Token usage disk measurement failed",
        );
        agents.push(diskUsageError(target, error));
      }
    }
    const result: TokenUsageDiskResult = {
      fetchedAt: new Date(nowMs).toISOString(),
      staleDays: days,
      agents,
    };
    this.diskCaches.set(days, { fetchedAtMs: nowMs, result });
    return result;
  }

  private storageContext(nowMs: number, days: number): StorageContext {
    return {
      homeDir: this.homeDir,
      nowMs,
      staleCutoffMs: staleCutoffMs(nowMs, days),
      logger: this.logger,
      gate: createYieldGate(),
    };
  }

  private collectOnce(
    cacheKey: string,
    days: number,
    disabled: ReadonlySet<string>,
  ): Promise<TokenUsageListResult> {
    const existing = this.inFlight.get(cacheKey);
    if (existing) {
      return existing;
    }
    const request = this.collectFresh(this.now(), days, disabled);
    this.inFlight.set(cacheKey, request);
    void request.finally(() => {
      if (this.inFlight.get(cacheKey) === request) {
        this.inFlight.delete(cacheKey);
      }
    });
    return request;
  }

  private async collectFresh(
    nowMs: number,
    days: number,
    disabled: ReadonlySet<string>,
  ): Promise<TokenUsageListResult> {
    const context: TokenUsageCollectContext = {
      homeDir: this.homeDir,
      nowMs,
      cutoffMs: windowCutoffMs(nowMs, days),
      todayStartMs: windowCutoffMs(nowMs, 1),
      windowDays: days,
      logger: this.logger,
      gate: createYieldGate(),
    };

    const agents: TokenUsageAgent[] = [];
    for (const collector of this.collectors) {
      if (disabled.has(collector.agentId)) {
        // 关闭采集：不碰数据源，但仍返回占位条目，保证 UI 上还能再打开开关。
        agents.push(
          unavailableAgent({
            agentId: collector.agentId,
            displayName: collector.displayName,
            error: "已关闭采集",
            status: "disabled",
          }),
        );
        continue;
      }
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

    const result: TokenUsageListResult = {
      fetchedAt: new Date(nowMs).toISOString(),
      rangeDays: days,
      agents,
    };
    this.caches.set(cacheKeyFor(days, disabled), { fetchedAtMs: nowMs, result });
    this.persistDiskCache(days, disabled, result, nowMs);
    return result;
  }

  private loadDiskCache(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cacheFile, "utf8")) as Partial<DiskCache>;
      if (
        typeof parsed.fetchedAtMs === "number" &&
        parsed.result &&
        Array.isArray(parsed.result.agents)
      ) {
        const result: TokenUsageListResult = { ...parsed.result };
        const days =
          typeof result.rangeDays === "number" ? result.rangeDays : parsed.windowDays;
        // 旧快照没有 hours 字段（小时视图上线前），忽略它，让首次请求重新采集。
        const hasHours = result.agents.every((agent) => Array.isArray(agent.hours));
        if (typeof days === "number" && hasHours) {
          const disabled = new Set(Array.isArray(parsed.disabled) ? parsed.disabled : []);
          this.caches.set(cacheKeyFor(days, disabled), {
            fetchedAtMs: parsed.fetchedAtMs,
            result,
          });
        }
      }
    } catch {
      // First run or unreadable snapshot; start cold.
    }
  }

  private persistDiskCache(
    days: number,
    disabled: ReadonlySet<string>,
    result: TokenUsageListResult,
    fetchedAtMs: number,
  ): void {
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      const payload = JSON.stringify({
        fetchedAtMs,
        windowDays: days,
        disabled: [...disabled],
        result,
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

function normalizeStaleDays(days: number | undefined): number {
  if (days === undefined || !Number.isFinite(days)) {
    return DEFAULT_STALE_DAYS;
  }
  return Math.max(1, Math.floor(days));
}

function diskUsageError(
  target: TokenUsageStorageTarget,
  error: unknown,
): AgentDiskUsage {
  return {
    agentId: target.agentId,
    displayName: target.displayName,
    status: "error",
    error: error instanceof Error ? error.message : String(error),
    totalBytes: 0,
    paths: [],
    sessionCount: 0,
    sessionBytes: 0,
    staleSessionCount: 0,
    staleSessionBytes: 0,
  };
}
