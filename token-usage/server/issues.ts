import { windowCutoffMs } from "./day-window.js";
import type { TokenUsageIssueKind } from "./types.js";

/**
 * 失败事件只看「当天」：本机时区今天 0 点以来，跨零点就从头算。
 * 切到 7 天 / 30 天窗口也不回溯更早的失败——历史失败不代表当前是否被卡住，
 * 混进来只会让卡片越看越长。
 */
export function issueCutoffMs(nowMs: number): number {
  return windowCutoffMs(nowMs, 1);
}

/** 各 agent 的原始错误字段，两边取交集后归一化。 */
export interface RawIssue {
  message: string;
  /** provider 自己的错误码。 */
  code?: number;
  /** HTTP 状态码。 */
  httpStatus?: number;
  /** provider 的错误类型标识（如 OpenCode 的 `provider.quota`）。 */
  type?: string;
  retryable?: boolean;
  isNetworkError?: boolean;
  isStreamTimeout?: boolean;
}

/**
 * 归类到固定的 kind 上，顺序即优先级：更具体的判据先匹配，
 * 例如带重置时间的 429 归「额度」而不是泛泛的「限流」。
 */
export function classifyIssue(raw: RawIssue): TokenUsageIssueKind {
  const message = raw.message;
  if (raw.isNetworkError === true || /network|econnrefused|econnreset|enotfound|socket hang up|fetch failed|\bdns\b/i.test(message)) {
    return "network";
  }
  if (raw.isStreamTimeout === true || /timeout|timed out|超时/i.test(message)) {
    return "timeout";
  }
  if (/^aborted$|interrupt|中断|已停止/i.test(raw.type ?? "") || /interrupted by user|已中断|interrupted/i.test(message)) {
    return "aborted";
  }
  if (raw.httpStatus === 401 || raw.httpStatus === 403 || /unauthor|invalid api key|authentication|鉴权|认证失败/i.test(message)) {
    return "auth";
  }
  if (
    parseResetAt(message) !== undefined ||
    /usage limit|quota|额度|使用量|频率限制|limit exceeded|out of credits|insufficient/i.test(message)
  ) {
    return "quota";
  }
  if (raw.httpStatus === 429) {
    return "rate_limit";
  }
  if ((raw.httpStatus ?? 0) >= 500 || /upstream|server_error|unavailable|overloaded|bad gateway/i.test(message)) {
    return "upstream";
  }
  return "unknown";
}

const RESET_AT_UTC = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\s*UTC\s*([+-])(\d{1,2})(?::?(\d{2}))?/i;
const RESET_AT_ISO = /\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})/;

/**
 * 从错误文案里解析「额度何时重置」。只认带时区的写法，解析不出就返回 undefined——
 * 宁可少一个字段，也不要按主机时区猜出一个错的时刻。
 *
 * CodeBuddy: `…将在 2026-10-20 09:09:22 UTC+8 重置…`
 */
export function parseResetAt(message: string): number | undefined {
  const utc = RESET_AT_UTC.exec(message);
  if (utc) {
    const [, year, month, day, time, sign, hours, minutes] = utc;
    const normalized = time.length === 5 ? `${time}:00` : time;
    const offset = `${sign}${hours.padStart(2, "0")}:${minutes ?? "00"}`;
    return parseTimestamp(`${year}-${month}-${day}T${normalized}${offset}`);
  }
  const iso = RESET_AT_ISO.exec(message);
  if (iso) {
    return parseTimestamp(iso[0]);
  }
  return undefined;
}

function parseTimestamp(text: string): number | undefined {
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? undefined : parsed;
}
