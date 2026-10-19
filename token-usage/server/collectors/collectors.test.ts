import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { TokenUsageAgent } from "../types.js";
import { createYieldGate } from "../yield-gate.js";
import { windowCutoffMs } from "../day-window.js";
import { CodebuddyCollector } from "./codebuddy.js";
import { DevinCollector } from "./devin.js";
import { collectDevinRows as collectDevin } from "./devin-worker.js";
import { OpencodeCollector } from "./opencode.js";
import { PiCollector } from "./pi.js";

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
    db.close();

    const agent = await new OpencodeCollector().collect(makeContext(nowMs));

    expect(agent.status).toBe("available");
    expect(agent.sessions).toBe(2);
    expect(agent.totals.inputTokens).toBe(300 * 2 + 250);
    expect(agent.totals.outputTokens).toBe(550);
    expect(agent.totals.cacheReadTokens).toBe(250 * 5);
    expect(agent.totals.costUsd).toBeCloseTo(300 * 0.001 + 250 * 0.002, 6);
    expect(agent.days.map((day) => day.date)).toHaveLength(2);
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
