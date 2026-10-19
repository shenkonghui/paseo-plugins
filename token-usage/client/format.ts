/** Compact but precise token formatting; keeps two significant decimals above 1k. */
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
