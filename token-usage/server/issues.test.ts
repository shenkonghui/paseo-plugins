import { describe, expect, it } from "vitest";
import { classifyIssue, issueCutoffMs, parseResetAt } from "./issues.js";

describe("classifyIssue", () => {
  it("treats a 429 with a reset time as a quota error", () => {
    expect(
      classifyIssue({
        message: "429 您的使用量已超出频率限制，将在 2026-10-20 09:09:22 UTC+8 重置",
        code: 6004,
        httpStatus: 429,
      }),
    ).toBe("quota");
  });

  it("treats a bare 429 as rate limiting", () => {
    expect(classifyIssue({ message: "Too many requests", httpStatus: 429 })).toBe("rate_limit");
  });

  it("separates user interrupts from failures", () => {
    expect(
      classifyIssue({
        message: "Interrupted by user",
        isNetworkError: false,
        isStreamTimeout: false,
      }),
    ).toBe("aborted");
    expect(classifyIssue({ message: "Step interrupted", type: "aborted" })).toBe("aborted");
  });

  it("classifies OpenCode provider errors", () => {
    expect(
      classifyIssue({ message: "Go usage limit exceeded", type: "provider.quota", httpStatus: 429 }),
    ).toBe("quota");
    expect(
      classifyIssue({
        message: "Streaming response failed: [router_error] model upstream is unavailable",
        type: "provider.internal",
        httpStatus: 200,
      }),
    ).toBe("upstream");
    expect(classifyIssue({ message: "invalid api key", httpStatus: 401 })).toBe("auth");
    expect(classifyIssue({ message: "fetch failed", isNetworkError: true })).toBe("network");
    expect(classifyIssue({ message: "request timed out", isStreamTimeout: true })).toBe("timeout");
    expect(classifyIssue({ message: "something odd" })).toBe("unknown");
  });
});

describe("parseResetAt", () => {
  it("reads the UTC offset form CodeBuddy uses", () => {
    const parsed = parseResetAt("…将在 2026-10-20 09:09:22 UTC+8 重置…");
    expect(parsed).toBe(new Date("2026-10-20T09:09:22+08:00").getTime());
  });

  it("reads an explicit ISO offset without a UTC label", () => {
    expect(parseResetAt("quota resets at 2026-10-20T09:09:22+08:00")).toBe(
      new Date("2026-10-20T09:09:22+08:00").getTime(),
    );
  });

  it("returns undefined when the text has no offset to trust", () => {
    expect(parseResetAt("将在 2026-10-20 09:09:22 重置")).toBeUndefined();
    expect(parseResetAt("Go usage limit exceeded")).toBeUndefined();
  });
});

describe("issueCutoffMs", () => {
  it("only looks back to the start of the host-local day", () => {
    const nowMs = new Date(2026, 9, 20, 9, 46, 0, 0).getTime();
    expect(issueCutoffMs(nowMs)).toBe(new Date(2026, 9, 20, 0, 0, 0, 0).getTime());
    // 零点刚过也不回退 24 小时，昨晚的错误不再算进来。
    const justAfterMidnight = new Date(2026, 9, 20, 0, 5, 0, 0).getTime();
    expect(issueCutoffMs(justAfterMidnight)).toBe(new Date(2026, 9, 20, 0, 0, 0, 0).getTime());
  });
});
