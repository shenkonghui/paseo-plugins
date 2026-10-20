/** Compact but precise token formatting; keeps two significant decimals above 1k. */
import type { TokenUsageIssueKind } from "../shared/rpc";

export function formatTokensDetailed(value: number): string {
  if (value >= 1_000_000_000) {
    return `${trimZeros((value / 1_000_000_000).toFixed(2))}b`;
  }
  if (value >= 1_000_000) {
    return `${trimZeros((value / 1_000_000).toFixed(1))}m`;
  }
  if (value >= 1_000) {
    return `${trimZeros((value / 1_000).toFixed(1))}k`;
  }
  return Math.round(value).toString();
}

function trimZeros(text: string): string {
  return text.replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function formatCount(value: number): string {
  return value.toLocaleString();
}

/** 失败事件的固定名称；未知 kind 兜底成「错误」，不让界面出现空标签。 */
const ISSUE_KIND_LABELS: Partial<Record<TokenUsageIssueKind, string>> = {
  rate_limit: "限流",
  quota: "用量受限",
  auth: "鉴权失败",
  network: "网络错误",
  timeout: "超时",
  upstream: "上游异常",
  aborted: "已中断",
  unknown: "错误",
};

export function issueKindLabel(kind: TokenUsageIssueKind): string {
  return ISSUE_KIND_LABELS[kind] ?? "错误";
}

/** ISO 时刻按本机时区展示成 `M/D HH:mm`；解析不出就原样返回。 */
export function formatShortDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const hh = `${date.getHours()}`.padStart(2, "0");
  const mm = `${date.getMinutes()}`.padStart(2, "0");
  return `${date.getMonth() + 1}/${date.getDate()} ${hh}:${mm}`;
}

/** 1024 进制的人类可读体积；用于展示 agent 的本地磁盘占用。 */
export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  const text = unit === 0 || scaled >= 100 ? `${Math.round(scaled)}` : trimZeros(scaled.toFixed(1));
  return `${text} ${units[unit]}`;
}
