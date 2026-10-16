import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { collectQoderQuota } from "./qoder-quota.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-quota-"));
const logger = { debug: () => {} };

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

/** Logs under 2 KB are treated as empty startup shells and skipped, so pad bodies. */
const PAD = "x".repeat(17 * 1024);

function writeRun(name: string, body: string): string {
  const dir = path.join(tempRoot, ".qoder-cn", "logs", "runs", name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "qodercli.log");
  fs.writeFileSync(file, `${body}\n${PAD}\n`);
  return file;
}

const QUOTA_RESPONSE =
  '{"userId":"u1","userType":"personal_standard","usageType":"credits","totalUsagePercentage":0.27,' +
  '"isQuotaExceeded":false,"expiresAt":1791468491298,"userQuota":{"total":300,"used":268,"remaining":32,' +
  '"percentage":0.9,"unit":"credits"},"addOnQuota":{"total":700,"used":0,"remaining":700,"percentage":0,' +
  '"unit":"credits"},"isPlanQuotaProrated":false}';

describe("collectQoderQuota", () => {
  it("returns null when the qoder-cn log tree does not exist", () => {
    const missing = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-missing-"));
    try {
      expect(collectQoderQuota(missing, logger)).toBeNull();
    } finally {
      fs.rmSync(missing, { recursive: true, force: true });
    }
  });

  it("parses the quota response line", () => {
    writeRun(
      "2026-10-08T09-41-06",
      `noise\n[qoderApi] GET https://openapi.qoder.com.cn/api/v2/quota/usage response: ${QUOTA_RESPONSE}\nmore noise`,
    );
    const quota = collectQoderQuota(tempRoot, logger);
    expect(quota).not.toBeNull();
    expect(quota?.userType).toBe("personal_standard");
    expect(quota?.plan).toEqual({ total: 300, used: 268, remaining: 32, percentage: 0.9 });
    expect(quota?.addOn).toEqual({ total: 700, used: 0, remaining: 700, percentage: 0 });
    expect(quota?.expiresAt).toBe(new Date(1791468491298).toISOString());
    expect(quota?.isQuotaExceeded).toBe(false);
    expect(quota?.observedAt).toEqual(
      new Date(
        fs.statSync(
          path.join(tempRoot, ".qoder-cn", "logs", "runs", "2026-10-08T09-41-06", "qodercli.log"),
        ).mtimeMs,
      ).toISOString(),
    );
  });

  it("prefers the newest-mtime run and the last valid response within a log", () => {
    writeRun("2026-10-08T09-41-06", `[qoderApi] GET .../quota/usage response: ${QUOTA_RESPONSE}`);
    const newerResponse = QUOTA_RESPONSE.replace('"total":300', '"total":500');
    writeRun(
      "2026-10-09T10-00-00",
      `irrelevant line\n[qoderApi] GET .../quota/usage response: {"userQuota":{"total":1,"used":1,"remaining":0}}\n` +
        `[qoderApi] GET .../quota/usage response: ${newerResponse}`,
    );
    const quota = collectQoderQuota(tempRoot, logger);
    expect(quota?.plan.total).toBe(500);
  });

  it("ignores shell-echoed marker mentions that are not JSON responses", () => {
    const newerResponse = QUOTA_RESPONSE.replace('"total":300', '"total":777');
    writeRun(
      "2026-10-10T10-00-00",
      `grep -c "quota/usage response:" ${QUOTA_RESPONSE.slice(0, 80)}\n` +
        `[qoderApi] GET .../quota/usage response: ${newerResponse}`,
    );
    const quota = collectQoderQuota(tempRoot, logger);
    expect(quota?.plan.total).toBe(777);
  });

  it("returns null when runs exist but contain no quota line", () => {
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-empty-"));
    try {
      fs.mkdirSync(path.join(isolated, ".qoder-cn", "logs", "runs", "2026-10-01T00-00-00"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(isolated, ".qoder-cn", "logs", "runs", "2026-10-01T00-00-00", "qodercli.log"),
        `no usage lines here\n${PAD}\n`,
      );
      expect(collectQoderQuota(isolated, logger)).toBeNull();
    } finally {
      fs.rmSync(isolated, { recursive: true, force: true });
    }
  });

  it("skips run logs below the 16 KB empty-shell threshold", () => {
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-shell-"));
    try {
      fs.mkdirSync(path.join(isolated, ".qoder-cn", "logs", "runs", "2026-10-01T00-00-00"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(isolated, ".qoder-cn", "logs", "runs", "2026-10-01T00-00-00", "qodercli.log"),
        `[qoderApi] GET .../quota/usage response: ${QUOTA_RESPONSE}\n`,
      );
      expect(collectQoderQuota(isolated, logger)).toBeNull();
    } finally {
      fs.rmSync(isolated, { recursive: true, force: true });
    }
  });
});
