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
