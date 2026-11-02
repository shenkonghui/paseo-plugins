import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TokenUsageLogger, TokenUsageAgent, TokenUsageAgentId } from "./types.js";
import type { TokenUsageCollectContext, TokenUsageCollector } from "./collector.js";
import { CodebuddyCollector } from "./collectors/codebuddy.js";
import { DevinCollector } from "./collectors/devin.js";
import { OpencodeCollector } from "./collectors/opencode.js";
import { PiCollector } from "./collectors/pi.js";
import { QoderCollector } from "./collectors/qoder.js";
import { dayKeysBetween, localDayKey, windowCutoffMs } from "./day-window.js";
import { issueCutoffMs } from "./issues.js";
import { unavailableAgent, type CollectedTokenUsage } from "./counters.js";
import { createYieldGate } from "./yield-gate.js";
import {
  composeWindow,
  emptyAgentCache,
  mergeCollection,
  missingDayStartMs,
  parseCaches,
  serializeCaches,
  type AgentUsageCache,
} from "./usage-cache.js";
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

/**
 * Reads token usage out of the agent CLIs' own local stores. Collection is
 * deliberately sequential: every collector walks hundreds of megabytes with
 * synchronous steps, and a yield gate keeps each step inside the event-loop budget.
 *
 * 缓存按「天」存：每天一份桶，1 / 7 / 30 天窗口都由这些天拼出来。只有「今天」
 * 会变，所以刷新只重采今天；历史桶直接复用，落盘后重启也不用重扫。
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
  private readonly agentCaches = new Map<TokenUsageAgentId, AgentUsageCache>();
  /** 同一 agent、同一采集起点并发时只扫一遍。 */
  private readonly inFlight = new Map<string, Promise<CollectedTokenUsage>>();
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
    const forceRefresh = options?.forceRefresh === true;
    const nowMs = this.now();
    const startMs = windowCutoffMs(nowMs, days);
    const todayStartMs = windowCutoffMs(nowMs, 1);
    // 1 / 7 / 30 天共用一份按天缓存，只保留最长窗口，切短窗口不会丢数据。
    const pruneBeforeMs = windowCutoffMs(nowMs, Math.max(this.windowDays, days));

    const agents: TokenUsageAgent[] = [];
    let stale = false;
    let changed = false;

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

      const cached = this.agentCaches.get(collector.agentId);
      const missingStartMs = cached ? missingDayStartMs(cached, startMs, nowMs) : startMs;
      if (cached && missingStartMs === undefined && !forceRefresh) {
        if (nowMs - cached.collectedAtMs >= this.cacheTtlMs) {
          stale = true;
        }
        agents.push(
          composeWindow({
            agentId: collector.agentId,
            displayName: collector.displayName,
            cache: cached,
            startMs,
            nowMs,
          }),
        );
        continue;
      }

      // 缺哪天就从哪天补：首次是整窗，跨天只补今天，刷新在覆盖完整时也只重采今天。
      const collectStartMs = missingStartMs ?? todayStartMs;
      try {
        const collected = await this.collectAgent(collector, collectStartMs, nowMs);
        // 采集期间可能有别的窗口也在补同一天的桶，合并时以最新缓存为底。
        const next = mergeCollection({
          cache: this.agentCaches.get(collector.agentId) ?? emptyAgentCache(),
          collected,
          startMs: collectStartMs,
          nowMs,
          collectedAtMs: nowMs,
          pruneBeforeMs,
        });
        this.agentCaches.set(collector.agentId, next);
        changed = true;
        agents.push(
          composeWindow({
            agentId: collector.agentId,
            displayName: collector.displayName,
            cache: next,
            startMs,
            nowMs,
          }),
        );
      } catch (error) {
        this.logger.debug(
          { err: error, agentId: collector.agentId },
          "Token usage collector failed",
        );
        // 丢掉今天：下次请求重试，而不是把失败藏在一个「看起来还新鲜」的快照后面。
        this.agentCaches.get(collector.agentId)?.days.delete(localDayKey(nowMs));
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

    if (changed) {
      this.persistCache();
    }

    return {
      result: { fetchedAt: new Date(nowMs).toISOString(), rangeDays: days, agents },
      stale,
    };
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

    // 会话被删掉后按天缓存不再可信：清掉涉及 agent 的用量缓存，下次重新采集。
    for (const target of targets) {
      this.agentCaches.delete(target.agentId);
    }
    this.inFlight.clear();
    this.persistCache();

    // 数据变了：丢掉该阈值的磁盘缓存，重新统计一次。
    this.diskCaches.delete(days);
    this.diskInFlight.delete(days);
    const disk = await this.collectDiskOnce(days);
    return { results, disk };
  }

  private collectAgent(
    collector: TokenUsageCollector,
    cutoffMs: number,
    nowMs: number,
  ): Promise<CollectedTokenUsage> {
    const key = `${collector.agentId}|${localDayKey(cutoffMs)}`;
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }
    const context: TokenUsageCollectContext = {
      homeDir: this.homeDir,
      nowMs,
      cutoffMs,
      issueCutoffMs: issueCutoffMs(nowMs),
      todayStartMs: windowCutoffMs(nowMs, 1),
      windowDays: dayKeysBetween(cutoffMs, nowMs).length,
      logger: this.logger,
      gate: createYieldGate(),
    };
    const request = collector.collect(context);
    this.inFlight.set(key, request);
    const settle = () => {
      if (this.inFlight.get(key) === request) {
        this.inFlight.delete(key);
      }
    };
    request.then(settle, settle);
    return request;
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

  private loadDiskCache(): void {
    try {
      const caches = parseCaches(fs.readFileSync(this.cacheFile, "utf8"));
      if (!caches) {
        return;
      }
      for (const [agentId, cache] of caches) {
        this.agentCaches.set(agentId, cache);
      }
    } catch {
      // First run or unreadable snapshot; start cold.
    }
  }

  private persistCache(): void {
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      fs.writeFileSync(this.cacheFile, serializeCaches(this.agentCaches));
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
