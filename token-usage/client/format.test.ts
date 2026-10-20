import { describe, expect, it } from "vitest";
import { formatBytes, formatShortDateTime, issueKindLabel } from "./format";

describe("formatBytes", () => {
  it("scales through binary units with one decimal", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5 MB");
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe("1.5 GB");
  });

  it("drops the decimal above 100 units and clamps negatives", () => {
    expect(formatBytes(150 * 1024)).toBe("150 KB");
    expect(formatBytes(-1)).toBe("0 B");
  });
});

describe("issueKindLabel", () => {
  it("labels every kind the daemon can report", () => {
    expect(issueKindLabel("quota")).toBe("用量受限");
    expect(issueKindLabel("rate_limit")).toBe("限流");
    expect(issueKindLabel("aborted")).toBe("已中断");
    expect(issueKindLabel("unknown")).toBe("错误");
  });
});

describe("formatShortDateTime", () => {
  it("renders local M/D HH:mm", () => {
    const iso = new Date(2026, 9, 20, 9, 9, 22).toISOString();
    expect(formatShortDateTime(iso)).toBe("10/20 09:09");
  });

  it("passes unparseable input through", () => {
    expect(formatShortDateTime("not a date")).toBe("not a date");
  });
});
