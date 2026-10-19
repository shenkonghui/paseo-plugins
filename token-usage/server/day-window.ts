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

/** Start of the oldest day in a window of `days` calendar days ending today. */
export function windowCutoffMs(nowMs: number, days: number): number {
  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - (Math.max(1, days) - 1));
  return date.getTime();
}
