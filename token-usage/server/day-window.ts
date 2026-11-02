/** `YYYY-MM-DD` in the host's local calendar, the bucket key the chart draws. */
export function localDayKey(timestampMs: number): string {
  const date = new Date(timestampMs);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** `YYYY-MM-DDTHH` in the host's local calendar，用于「今天」的小时桶。 */
export function localHourKey(timestampMs: number): string {
  const hour = `${new Date(timestampMs).getHours()}`.padStart(2, "0");
  return `${localDayKey(timestampMs)}T${hour}`;
}

/** Start of the host-local day containing `timestampMs`. */
export function localDayStartMs(timestampMs: number): number {
  const date = new Date(timestampMs);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Start of the oldest day in a window of `days` calendar days ending today. */
export function windowCutoffMs(nowMs: number, days: number): number {
  const date = new Date(localDayStartMs(nowMs));
  date.setDate(date.getDate() - (Math.max(1, days) - 1));
  return date.getTime();
}

/** Every host-local day key from the day containing `startMs` through `endMs`, inclusive. */
export function dayKeysBetween(startMs: number, endMs: number): string[] {
  const keys: string[] = [];
  const cursor = new Date(localDayStartMs(startMs));
  const end = localDayStartMs(endMs);
  // 按本地日历逐天推进：夏令时切换那天不会因为 ±24h 的整数倍而跳天。
  while (cursor.getTime() <= end) {
    keys.push(localDayKey(cursor.getTime()));
    cursor.setDate(cursor.getDate() + 1);
  }
  return keys;
}
