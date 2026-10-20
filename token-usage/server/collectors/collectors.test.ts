import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { TokenUsageAgent } from "../types.js";
import { createYieldGate } from "../yield-gate.js";
import { windowCutoffMs } from "../day-window.js";
import { issueCutoffMs } from "../issues.js";
import { CodebuddyCollector } from "./codebuddy.js";
import { DevinCollector } from "./devin.js";
import { collectDevinRows as collectDevin } from "./devin-worker.js";
import { OpencodeCollector } from "./opencode.js";
import { PiCollector } from "./pi.js";
import { QoderCollector } from "./qoder.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "token-usage-fixtures-"));
const dataHome = path.join(tempRoot, "data");

beforeEach(() => {
  process.env.XDG_DATA_HOME = dataHome;
});

afterAll(() => {
  delete process.env.XDG_DATA_HOME;
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function makeContext(nowMs: number) {
  return {
    homeDir: tempRoot,
    nowMs,
    cutoffMs: windowCutoffMs(nowMs, 30),
    issueCutoffMs: issueCutoffMs(nowMs),
    todayStartMs: windowCutoffMs(nowMs, 1),
    windowDays: 30,
    logger: console,
    gate: createYieldGate(),
  };
}

/** Local (UTC in tests) midnight of `nowMs`, so day buckets are deterministic. */
function localMidnight(nowMs: number): number {
  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

interface SqliteTestModule {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean },
  ) => {
    exec(sql: string): void;
    prepare(sql: string): {
      run(...params: unknown[]): unknown;
    };
    close(): void;
  };
}

async function sqliteModule(): Promise<SqliteTestModule["DatabaseSync"]> {
  // @types/node@20 has no node:sqlite typings; hold the specifier in a variable.
  const specifier: string = "node:sqlite";
  const mod = (await import(specifier)) as unknown as SqliteTestModule & {
    default?: SqliteTestModule;
  };
  return mod.DatabaseSync ?? mod.default!.DatabaseSync;
}

describe("OpencodeCollector", () => {
  it("pages through assistant messages and rolls them into days", async () => {
    const dbDir = path.join(dataHome, "opencode");
    fs.mkdirSync(dbDir, { recursive: true });
    const Database = await sqliteModule();
    const db = new Database(path.join(dbDir, "opencode.db"));
    db.exec(`create table session_message (
      session_id text, id text, type text, time_created integer, data text)`);
    const nowMs = Date.now();
    const day1 = localMidnight(nowMs) + 3_600_000;
    const day2 = localMidnight(nowMs - 86_400_000) + 3_600_000;
    const insert = db.prepare("insert into session_message values (?, ?, 'assistant', ?, ?)");
    // Enough rows to cross the 500-row page size from both days.
    for (let i = 0; i < 300; i++) {
      insert.run(
        "s1",
        `a${i}`,
        day1 + i,
        JSON.stringify({
          tokens: { input: 2, output: 1 },
          cost: 0.001,
          model: { id: "test-model" },
        }),
      );
    }
    for (let i = 0; i < 250; i++) {
      insert.run(
        "s2",
        `b${i}`,
        day2 + i,
        JSON.stringify({
          tokens: { input: 1, output: 1, cache: { read: 5 } },
          cost: 0.002,
          model: { id: "test-model" },
        }),
      );
    }
    // Non-assistant rows must be skipped.
    db.prepare("insert into session_message values (?, ?, 'user', ?, ?)").run(
      "s1",
      "u1",
      day1,
      JSON.stringify({ tokens: { input: 999, output: 999 } }),
    );
    // 失败请求：token 维度为空，但要在 issues 里露出来。
    insert.run(
      "s1",
      "err1",
      day1 + 800,
      JSON.stringify({
        model: { id: "test-model" },
        error: { type: "provider.quota", message: "Go usage limit exceeded", status: 429 },
      }),
    );
    insert.run(
      "s1",
      "err2",
      day1 + 900,
      JSON.stringify({
        model: { id: "test-model" },
        error: { type: "aborted", message: "Step interrupted" },
      }),
    );
    // 昨天的失败：跨天后不再展示（即使仍在 24 小时内）。
    insert.run(
      "s2",
      "err0",
      day2 + 800,
      JSON.stringify({
        model: { id: "test-model" },
        error: { type: "provider.quota", message: "yesterday quota", status: 429 },
      }),
    );
    db.close();

    const agent = await new OpencodeCollector().collect(makeContext(nowMs));

    expect(agent.status).toBe("available");
    expect(agent.sessions).toBe(2);
    expect(agent.totals.inputTokens).toBe(300 * 2 + 250);
    expect(agent.totals.outputTokens).toBe(550);
    expect(agent.totals.cacheReadTokens).toBe(250 * 5);
    expect(agent.totals.costUsd).toBeCloseTo(300 * 0.001 + 250 * 0.002, 6);
    expect(agent.days.map((day) => day.date)).toHaveLength(2);
    // 失败行不影响 token 汇总，只进 issues；最近的排前面。
    expect(agent.issues.map((issue) => issue.kind)).toEqual(["aborted", "quota"]);
    expect(agent.issues[1]).toMatchObject({
      kind: "quota",
      httpStatus: 429,
      code: null,
      retryable: null,
      count: 1,
      sessionId: "s1",
      model: "test-model",
      resetAt: null,
    });
    expect(agent.issues[1].message).toBe("Go usage limit exceeded");
  });

  it("reports unavailable when the database is missing", async () => {
    // Use a data home without an opencode directory; sibling tests create real ones.
    process.env.XDG_DATA_HOME = path.join(tempRoot, "empty");
    try {
      const agent = await new OpencodeCollector().collect(makeContext(Date.now()));
      expect(agent.status).toBe("unavailable");
    } finally {
      process.env.XDG_DATA_HOME = dataHome;
    }
  });
});

describe("DevinCollector", () => {
  it("aggregates same-second session metrics with model attribution", async () => {
    const dbDir = path.join(dataHome, "devin", "cli");
    fs.mkdirSync(dbDir, { recursive: true });
    const Database = await sqliteModule();
    const db = new Database(path.join(dbDir, "sessions.db"));
    db.exec(`create table sessions (id text primary key, model text, last_activity_at integer);
      create table message_nodes (session_id text, created_at integer, chat_message text)`);
    const nowMs = Date.now();
    const createdSec = Math.floor((localMidnight(nowMs) + 3_600_000) / 1000);
    db.prepare("insert into sessions values (?, ?, ?)").run("s1", "devin-model", createdSec);
    const insert = db.prepare("insert into message_nodes values (?, ?, ?)");
    const metrics = (input: number, output: number) =>
      JSON.stringify({
        metadata: { metrics: { input_tokens: input, output_tokens: output, cache_read_tokens: 7 } },
      });
    insert.run("s1", createdSec, metrics(10, 1));
    insert.run("s1", createdSec, metrics(20, 2));
    insert.run("s1", createdSec, JSON.stringify({ metadata: {} }));
    insert.run("old-session", createdSec - 40 * 86400, metrics(999, 999));
    db.close();

    const result = await collectDevin({
      homeDir: tempRoot,
      cutoffMs: localMidnight(nowMs),
    });
    expect(result).toEqual([
      {
        sessionId: "s1",
        model: "devin-model",
        timestampSec: createdSec,
        requests: 2,
        inputTokens: 30,
        outputTokens: 3,
        cacheReadTokens: 14,
        cacheWriteTokens: 0,
      },
    ]);

    const agent = await new DevinCollector().collect(makeContext(nowMs));
    expect(agent.status).toBe("available");
    expect(agent.sessions).toBe(1);
    expect(agent.totals.requests).toBe(2);
    expect(agent.totals.inputTokens).toBe(30);
    expect(agent.models?.[0]?.model).toBe("devin-model");
  });

  it("buckets calls on the host-local calendar day", async () => {
    // A call at 18:24 in UTC+8: adding the timezone offset before localDayKey
    // (which applies it again) pushed it onto the following day.
    const previousTZ = process.env.TZ;
    const tzDataHome = path.join(tempRoot, "tz-data");
    process.env.TZ = "Asia/Shanghai";
    try {
      const dbDir = path.join(tzDataHome, "devin", "cli");
      fs.mkdirSync(dbDir, { recursive: true });
      const Database = await sqliteModule();
      const db = new Database(path.join(dbDir, "sessions.db"));
      db.exec(`create table sessions (id text primary key, model text, last_activity_at integer);
        create table message_nodes (session_id text, created_at integer, chat_message text)`);
      const createdSec = Math.floor(
        new Date("2026-10-17T18:24:25+08:00").getTime() / 1000,
      );
      db.prepare("insert into sessions values (?, ?, ?)").run("s1", "devin-model", createdSec);
      db.prepare("insert into message_nodes values (?, ?, ?)").run(
        "s1",
        createdSec,
        JSON.stringify({ metadata: { metrics: { input_tokens: 100, output_tokens: 5 } } }),
      );
      db.close();

      process.env.XDG_DATA_HOME = tzDataHome;
      const agent = await new DevinCollector().collect(
        makeContext(new Date("2026-10-18T12:00:00+08:00").getTime()),
      );

      expect(agent.days).toHaveLength(1);
      expect(agent.days[0].date).toBe("2026-10-17");
      expect(agent.days[0].inputTokens).toBe(100);
    } finally {
      if (previousTZ === undefined) delete process.env.TZ;
      else process.env.TZ = previousTZ;
      process.env.XDG_DATA_HOME = dataHome;
    }
  });
});

describe("CodebuddyCollector", () => {
  it("reads rawUsage entries from project transcripts", async () => {
    const projectsDir = path.join(tempRoot, ".codebuddy", "projects", "proj");
    fs.mkdirSync(projectsDir, { recursive: true });
    const nowMs = Date.now();
    const ts = localMidnight(nowMs) + 3_600_000;
    const rawUsage = (input: number, output: number) =>
      JSON.stringify({
        timestamp: ts,
        providerData: { rawUsage: { prompt_tokens: input, completion_tokens: output } },
      });
    fs.writeFileSync(
      path.join(projectsDir, "t1.jsonl"),
      [JSON.stringify({ other: true }), rawUsage(10, 5), "not json", rawUsage(1, 1)].join("\n"),
    );

    const agent: TokenUsageAgent = await new CodebuddyCollector().collect(makeContext(nowMs));

    expect(agent.status).toBe("available");
    expect(agent.totals.inputTokens).toBe(11);
    expect(agent.totals.outputTokens).toBe(6);
    expect(agent.sessions).toBe(1);
    // 01:00 当地时间的调用应落进小时桶。
    expect(agent.hours).toEqual([
      expect.objectContaining({ hour: 1, totalTokens: 17, requests: 2, sessions: 1 }),
    ]);
    expect(agent.issues).toEqual([]);
  });

  it("turns providerData.error entries into aggregated issues", async () => {
    // 独立 home，避免同目录其它用例的 transcript 混进 token 汇总。
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "token-usage-codebuddy-"));
    const projectsDir = path.join(isolated, ".codebuddy", "projects", "issues");
    fs.mkdirSync(projectsDir, { recursive: true });
    const nowMs = Date.now();
    const ts = localMidnight(nowMs) + 3_600_000;
    const rateLimited = (occurredAt: number) =>
      JSON.stringify({
        timestamp: occurredAt,
        providerData: {
          model: "deepseek-v4.1-flash",
          skipRun: true,
          error: {
            code: 6004,
            message:
              "429 您的使用量已超出频率限制，将在 2026-10-20 09:09:22 UTC+8 重置，您也可以切换其他模型继续使用。 (req-1/session-a)",
            requestID: "req-1",
            status: 429,
            isNetworkError: false,
            isStreamTimeout: false,
            isRetryable: false,
          },
        },
      });
    fs.writeFileSync(
      path.join(projectsDir, "t2.jsonl"),
      [
        rateLimited(ts),
        rateLimited(ts + 1_000),
        // 用户主动中断与限流不是一类。
        JSON.stringify({
          timestamp: ts,
          providerData: {
            error: {
              message: "Interrupted by user",
              isNetworkError: false,
              isStreamTimeout: false,
              isRetryable: false,
            },
          },
        }),
        // 昨晚（仍在 24 小时内但已跨天）：不算今天的失败。
        JSON.stringify({
          timestamp: localMidnight(nowMs) - 3_600_000,
          providerData: {
            error: {
              code: 6004,
              message: "429 昨天的频率限制，将在 2026-10-19 23:30:00 UTC+8 重置",
              status: 429,
              isRetryable: false,
            },
          },
        }),
        // 更早：同样不采集。
        rateLimited(nowMs - 25 * 60 * 60 * 1000),
      ].join("\n"),
    );

    const agent = await new CodebuddyCollector().collect({
      ...makeContext(nowMs),
      homeDir: isolated,
    });

    try {
      expect(agent.totals.totalTokens).toBe(0);
      expect(agent.issues).toHaveLength(2);
      const quota = agent.issues.find((issue) => issue.kind === "quota");
      expect(quota).toMatchObject({
        code: 6004,
        httpStatus: 429,
        retryable: false,
        count: 2,
        model: "deepseek-v4.1-flash",
        sessionId: path.join("issues", "t2.jsonl"),
      });
      expect(quota?.resetAt).toBe(new Date("2026-10-20T09:09:22+08:00").toISOString());
      expect(quota?.lastAt).toBe(new Date(ts + 1_000).toISOString());
      expect(quota?.firstAt).toBe(new Date(ts).toISOString());
      // 限定符 + requestID 留在原文里，便于回查。
      expect(quota?.message).toContain("req-1/session-a");
      expect(agent.issues.some((issue) => issue.kind === "aborted")).toBe(true);
    } finally {
      fs.rmSync(isolated, { recursive: true, force: true });
    }
  });
});

describe("QoderCollector", () => {
  it("merges the CN and intl transcripts, counts subagents, and dedupes requests", async () => {
    const nowMs = Date.now();
    const todayTs = new Date(localMidnight(nowMs) + 3_600_000).toISOString();
    const oldTs = new Date(nowMs - 40 * 86_400_000).toISOString();
    const line = (usage: object, options?: { sessionId?: string; timestamp?: string }) =>
      JSON.stringify({
        type: "assistant",
        timestamp: options?.timestamp ?? todayTs,
        sessionId: options?.sessionId ?? "session-a",
        message: { model: "dfmodel", usage },
      });

    const cnProjects = path.join(tempRoot, ".qoder-cn", "projects", "proj");
    const subagents = path.join(cnProjects, "session-a", "subagents");
    fs.mkdirSync(subagents, { recursive: true });
    fs.writeFileSync(
      path.join(cnProjects, "session-a.jsonl"),
      [
        JSON.stringify({ type: "user", timestamp: todayTs }),
        line({
          input_tokens: 100,
          output_tokens: 10,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 2,
          credits: 0.5,
          billable: true,
          request_id: "r1",
        }),
        // 免费模型：token 与请求照计，积分不计入账单口径。
        line({ input_tokens: 7, output_tokens: 1, credits: 0.9, billable: false, request_id: "r2" }),
        // 同一个 request_id 的重试行只算一次。
        line({ input_tokens: 100, output_tokens: 10, credits: 0.5, billable: true, request_id: "r1" }),
        // 窗口之外（40 天前）的调用必须跳过。
        line(
          { input_tokens: 999, output_tokens: 999, credits: 9, billable: true, request_id: "r-old" },
          { timestamp: oldTs },
        ),
      ].join("\n"),
    );
    // 子 agent 的 transcript 写父会话 id，用量计入同一个会话。
    fs.writeFileSync(
      path.join(subagents, "agent-aExplore-1.jsonl"),
      line({ input_tokens: 3, output_tokens: 2, credits: 0.1, billable: true, request_id: "r3" }),
    );
    // 国际版（~/.qoder）是另一个数据根，合并成同一个 agent。
    const intlProjects = path.join(tempRoot, ".qoder", "projects", "proj2");
    fs.mkdirSync(intlProjects, { recursive: true });
    fs.writeFileSync(
      path.join(intlProjects, "session-b.jsonl"),
      line(
        { input_tokens: 1, output_tokens: 1, credits: 0.2, billable: true, request_id: "r4" },
        { sessionId: "session-b" },
      ),
    );

    const agent = await new QoderCollector().collect(makeContext(nowMs));

    expect(agent.status).toBe("available");
    expect(agent.totals.inputTokens).toBe(111);
    expect(agent.totals.outputTokens).toBe(14);
    // Qoder 不写 total_tokens，按 input + output 汇总。
    expect(agent.totals.totalTokens).toBe(125);
    expect(agent.totals.cacheReadTokens).toBe(5);
    expect(agent.totals.cacheWriteTokens).toBe(2);
    expect(agent.totals.requests).toBe(4);
    // 只累计 billable 的 credits（0.5 + 0.1 + 0.2），免费模型的 0.9 不计入。
    expect(agent.totals.costCredits).toBeCloseTo(0.8, 6);
    expect(agent.sessions).toBe(2);
    expect(agent.models?.[0]?.model).toBe("dfmodel");
  });

  it("reports unavailable when neither data root exists", async () => {
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "token-usage-qoder-"));
    try {
      const agent = await new QoderCollector().collect({
        ...makeContext(Date.now()),
        homeDir: isolated,
      });
      expect(agent.status).toBe("unavailable");
    } finally {
      fs.rmSync(isolated, { recursive: true, force: true });
    }
  });
});

describe("PiCollector", () => {
  it("reads assistant message usage from session files", async () => {
    const sessionsDir = path.join(tempRoot, ".pi", "agent", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const nowMs = Date.now();
    const ts = localMidnight(nowMs) + 3_600_000;
    const line = (usage: object) =>
      JSON.stringify({
        type: "message",
        timestamp: new Date(ts).toISOString(),
        message: { role: "assistant", model: "pi-model", usage },
      });
    fs.writeFileSync(
      path.join(sessionsDir, "s1.jsonl"),
      [
        line({ input: 100, output: 10, cacheRead: 40, cost: { total: 0.5 } }),
        JSON.stringify({ type: "message", message: { role: "user" } }),
      ].join("\n"),
    );

    const agent = await new PiCollector().collect(makeContext(nowMs));

    expect(agent.status).toBe("available");
    expect(agent.totals.inputTokens).toBe(100);
    expect(agent.totals.outputTokens).toBe(10);
    expect(agent.totals.cacheReadTokens).toBe(40);
    expect(agent.totals.costUsd).toBeCloseTo(0.5, 6);
    expect(agent.models?.[0]?.model).toBe("pi-model");
  });
});
