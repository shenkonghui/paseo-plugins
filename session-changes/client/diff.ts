export type DiffRowKind = "ctx" | "add" | "del" | "gap";

export interface DiffRow {
  kind: DiffRowKind;
  /** 1-based line number in the old text; null for added rows. */
  oldNo: number | null;
  /** 1-based line number in the new text; null for removed rows. */
  newNo: number | null;
  text: string;
}

export interface DiffBlock {
  rows: DiffRow[];
  adds: number;
  dels: number;
  truncated: boolean;
}

export interface DiffCounts {
  adds: number;
  dels: number;
}

const MAX_LCS_CELLS = 400_000;
const DEFAULT_CONTEXT = 2;
const MAX_ROWS = 500;

export function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (normalized === "") return [];
  const lines = normalized.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

type Op = { kind: "same" | "del" | "add"; text: string };

function pushMiddle(ops: Op[], oldLines: string[], newLines: string[]): void {
  const m = oldLines.length;
  const n = newLines.length;
  if (m === 0) {
    for (const text of newLines) ops.push({ kind: "add", text });
    return;
  }
  if (n === 0) {
    for (const text of oldLines) ops.push({ kind: "del", text });
    return;
  }
  if (m * n > MAX_LCS_CELLS) {
    for (const text of oldLines) ops.push({ kind: "del", text });
    for (const text of newLines) ops.push({ kind: "add", text });
    return;
  }

  const width = n + 1;
  const table = new Uint32Array((m + 1) * width);
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      table[i * width + j] =
        oldLines[i] === newLines[j]
          ? table[(i + 1) * width + (j + 1)] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)]);
    }
  }

  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ kind: "same", text: oldLines[i] });
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
      ops.push({ kind: "del", text: oldLines[i] });
      i++;
    } else {
      ops.push({ kind: "add", text: newLines[j] });
      j++;
    }
  }
  while (i < m) {
    ops.push({ kind: "del", text: oldLines[i] });
    i++;
  }
  while (j < n) {
    ops.push({ kind: "add", text: newLines[j] });
    j++;
  }
}

function lineOps(oldLines: string[], newLines: string[]): Op[] {
  let head = 0;
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head++;
  let tail = 0;
  while (
    tail < oldLines.length - head &&
    tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) {
    tail++;
  }

  const ops: Op[] = [];
  for (let i = 0; i < head; i++) ops.push({ kind: "same", text: oldLines[i] });
  pushMiddle(ops, oldLines.slice(head, oldLines.length - tail), newLines.slice(head, newLines.length - tail));
  for (let i = oldLines.length - tail; i < oldLines.length; i++)
    ops.push({ kind: "same", text: oldLines[i] });
  return ops;
}

export function buildDiff(
  oldText: string | undefined,
  newText: string | undefined,
  context = DEFAULT_CONTEXT,
): DiffBlock {
  const ops = lineOps(splitLines(oldText ?? ""), splitLines(newText ?? ""));

  let oldNo = 1;
  let newNo = 1;
  const all: DiffRow[] = ops.map((op) => {
    if (op.kind === "same") {
      const row: DiffRow = { kind: "ctx", oldNo: oldNo++, newNo: newNo++, text: op.text };
      return row;
    }
    if (op.kind === "del") return { kind: "del", oldNo: oldNo++, newNo: null, text: op.text };
    return { kind: "add", oldNo: null, newNo: newNo++, text: op.text };
  });

  const keep = new Array<boolean>(all.length).fill(false);
  all.forEach((row, index) => {
    if (row.kind === "ctx") return;
    for (let k = Math.max(0, index - context); k <= Math.min(all.length - 1, index + context); k++) {
      keep[k] = true;
    }
  });

  const rows: DiffRow[] = [];
  let index = 0;
  while (index < all.length) {
    if (keep[index]) {
      rows.push(all[index]);
      index++;
      continue;
    }
    let end = index;
    while (end < all.length && !keep[end]) end++;
    rows.push({ kind: "gap", oldNo: null, newNo: null, text: `… 省略 ${end - index} 行 …` });
    index = end;
  }

  let adds = 0;
  let dels = 0;
  for (const row of all) {
    if (row.kind === "add") adds++;
    else if (row.kind === "del") dels++;
  }

  let truncated = false;
  if (rows.length > MAX_ROWS) {
    truncated = true;
    const hidden = rows.length - MAX_ROWS;
    rows.length = MAX_ROWS;
    rows.push({ kind: "gap", oldNo: null, newNo: null, text: `… 已折叠 ${hidden} 行 …` });
  }

  return { rows, adds, dels, truncated };
}

export function countUnifiedLines(unifiedDiff: string): DiffCounts {
  let adds = 0;
  let dels = 0;
  for (const line of unifiedDiff.replace(/\r\n?/g, "\n").split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) adds++;
    else if (line.startsWith("-")) dels++;
  }
  return { adds, dels };
}

export function rowsFromUnified(unifiedDiff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo: number | null = null;
  let newNo: number | null = null;
  for (const raw of unifiedDiff.replace(/\r\n?/g, "\n").split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      if (rows.length > 0 && rows[rows.length - 1].kind !== "gap") {
        rows.push({ kind: "gap", oldNo: null, newNo: null, text: "…" });
      }
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      continue;
    }
    if (raw.startsWith("diff ") || raw.startsWith("index ") || raw.startsWith("Index:")) continue;
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (raw.startsWith("\\")) continue;
    if (raw.startsWith("+")) {
      rows.push({ kind: "add", oldNo: null, newNo: newNo ?? null, text: raw.slice(1) });
      if (newNo !== null) newNo++;
    } else if (raw.startsWith("-")) {
      rows.push({ kind: "del", oldNo: oldNo ?? null, newNo: null, text: raw.slice(1) });
      if (oldNo !== null) oldNo++;
    } else if (raw.startsWith(" ") || raw === "") {
      rows.push({
        kind: "ctx",
        oldNo: oldNo ?? null,
        newNo: newNo ?? null,
        text: raw === "" ? "" : raw.slice(1),
      });
      if (oldNo !== null) oldNo++;
      if (newNo !== null) newNo++;
    }
  }
  return rows;
}
