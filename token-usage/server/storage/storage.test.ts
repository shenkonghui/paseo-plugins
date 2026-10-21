import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createYieldGate } from "../yield-gate.js";
import { createFileSessionStorage } from "./file-sessions.js";
import { createStorageTargets } from "./index.js";
import { createQoderStorage } from "./qoder-sessions.js";
import { DevinStorage, OpencodeStorage } from "./sqlite-sessions.js";
import type { StorageContext } from "./types.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "token-usage-storage-"));
const dataHome = path.join(tempRoot, "data");
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  process.env.XDG_DATA_HOME = dataHome;
});

afterAll(() => {
  delete process.env.XDG_DATA_HOME;
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function context(nowMs: number, olderThanDays = 30): StorageContext {
  return {
    homeDir: tempRoot,
    nowMs,
    staleCutoffMs: nowMs - olderThanDays * DAY_MS,
    logger: console,
    gate: createYieldGate(),
  };
}

/** 把文件时间戳拨到 `daysAgo` 天前，用来模拟过期会话。 */
function ageFile(target: string, daysAgo: number): void {
  const seconds = (Date.now() - daysAgo * DAY_MS) / 1000;
  fs.utimesSync(target, seconds, seconds);
}

interface SqliteTestModule {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean },
  ) => {
    exec(sql: string): void;
    prepare(sql: string): {
      run(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
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

describe("CodeBuddy file storage", () => {
  const storage = createFileSessionStorage({
    agentId: "codebuddy",
    displayName: "CodeBuddy",
    rootDir: (homeDir) => path.join(homeDir, ".codebuddy"),
    sessionsDir: (homeDir) => path.join(homeDir, ".codebuddy", "projects"),
    extension: ".jsonl",
    includeSiblingDirs: true,
  });

  it("counts session siblings and deletes only stale sessions", async () => {
    const projects = path.join(tempRoot, ".codebuddy", "projects", "proj");
    fs.mkdirSync(path.join(projects, "old", "tool-results"), { recursive: true });
    fs.mkdirSync(path.join(projects, "recent", "tool-results"), { recursive: true });
    fs.writeFileSync(path.join(projects, "old.jsonl"), "x".repeat(200));
    fs.writeFileSync(path.join(projects, "old", "tool-results", "r.txt"), "y".repeat(300));
    fs.writeFileSync(path.join(projects, "recent.jsonl"), "z".repeat(100));
    fs.writeFileSync(path.join(projects, "recent", "tool-results", "r.txt"), "w".repeat(50));
    ageFile(path.join(projects, "old.jsonl"), 40);
    ageFile(path.join(projects, "old", "tool-results", "r.txt"), 40);

    const nowMs = Date.now();
    const measured = await storage.measure(context(nowMs));
    expect(measured.status).toBe("available");
    expect(measured.sessionCount).toBe(2);
    expect(measured.staleSessionCount).toBe(1);
    // 会话占用含旧会话的附属目录（200 + 300 + 100 + 50）。
    expect(measured.sessionBytes).toBe(650);
    expect(measured.staleSessionBytes).toBe(500);
    expect(measured.totalBytes).toBeGreaterThanOrEqual(measured.sessionBytes);

    const result = await storage.cleanup(context(nowMs));
    expect(result.status).toBe("cleaned");
    expect(result.removedSessions).toBe(1);
    expect(result.freedBytes).toBe(500);
    expect(fs.existsSync(path.join(projects, "old.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(projects, "old"))).toBe(false);
    expect(fs.existsSync(path.join(projects, "recent.jsonl"))).toBe(true);

    const after = await storage.measure(context(Date.now()));
    expect(after.sessionCount).toBe(1);
    expect(after.staleSessionCount).toBe(0);
  });

  it("skips cleanup when nothing is stale", async () => {
    const result = await storage.cleanup(context(Date.now()));
    expect(result.status).toBe("skipped");
    expect(result.removedSessions).toBe(0);
  });
});

describe("CodeBuddy merged storage across Paseo homes", () => {
  const storage = createStorageTargets().find((target) => target.agentId === "codebuddy")!;

  it("counts and cleans the default home and Paseo-managed homes", async () => {
    // 国际版跑在 Paseo 的独立 home 下（~/.paseo/homes/*），与主目录各有一份数据。
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "token-usage-codebuddy-homes-"));
    try {
      const domesticRoot = path.join(isolated, ".codebuddy");
      const domestic = path.join(domesticRoot, "projects", "proj");
      const intlRoot = path.join(isolated, ".paseo", "homes", "codebuddy-intl", ".codebuddy");
      const intl = path.join(intlRoot, "projects", "proj");
      fs.mkdirSync(domestic, { recursive: true });
      fs.mkdirSync(intl, { recursive: true });
      fs.writeFileSync(path.join(domestic, "old.jsonl"), "x".repeat(200));
      fs.writeFileSync(path.join(intl, "old-intl.jsonl"), "y".repeat(100));
      ageFile(path.join(domestic, "old.jsonl"), 40);
      ageFile(path.join(intl, "old-intl.jsonl"), 40);

      const nowMs = Date.now();
      const base = { ...context(nowMs), homeDir: isolated };
      const measured = await storage.measure(base);
      expect(measured.status).toBe("available");
      expect(measured.paths).toEqual([domesticRoot, intlRoot]);
      expect(measured.sessionCount).toBe(2);
      expect(measured.staleSessionCount).toBe(2);
      expect(measured.staleSessionBytes).toBe(300);

      const result = await storage.cleanup(base);
      expect(result.status).toBe("cleaned");
      expect(result.removedSessions).toBe(2);
      expect(result.freedBytes).toBe(300);
      expect(fs.existsSync(path.join(domestic, "old.jsonl"))).toBe(false);
      expect(fs.existsSync(path.join(intl, "old-intl.jsonl"))).toBe(false);
    } finally {
      fs.rmSync(isolated, { recursive: true, force: true });
    }
  });
});

describe("Qoder merged file storage", () => {
  const storage = createQoderStorage();

  it("sums the CN and intl roots and cleans stale sessions in both", async () => {
    const cnRoot = path.join(tempRoot, ".qoder-cn");
    const cnProjects = path.join(cnRoot, "projects", "proj");
    const intlRoot = path.join(tempRoot, ".qoder");
    const intlProjects = path.join(intlRoot, "projects", "proj2");
    fs.mkdirSync(cnProjects, { recursive: true });
    fs.mkdirSync(intlProjects, { recursive: true });
    fs.writeFileSync(path.join(cnProjects, "old.jsonl"), "x".repeat(200));
    fs.writeFileSync(path.join(cnProjects, "recent.jsonl"), "z".repeat(100));
    fs.writeFileSync(path.join(intlProjects, "intl.jsonl"), "w".repeat(50));
    ageFile(path.join(cnProjects, "old.jsonl"), 40);

    const nowMs = Date.now();
    const measured = await storage.measure(context(nowMs));
    expect(measured.status).toBe("available");
    // 两个数据根都计入，并分别展示。
    expect(measured.paths).toEqual([cnRoot, intlRoot]);
    expect(measured.sessionCount).toBe(3);
    expect(measured.staleSessionCount).toBe(1);
    expect(measured.sessionBytes).toBe(350);
    expect(measured.staleSessionBytes).toBe(200);
    expect(measured.totalBytes).toBeGreaterThanOrEqual(350);

    const result = await storage.cleanup(context(nowMs));
    expect(result.status).toBe("cleaned");
    expect(result.removedSessions).toBe(1);
    expect(result.freedBytes).toBe(200);
    expect(fs.existsSync(path.join(cnProjects, "old.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(cnProjects, "recent.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(intlProjects, "intl.jsonl"))).toBe(true);
  });

  it("reports unavailable when neither data root exists", async () => {
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "token-usage-qoder-storage-"));
    try {
      const measured = await storage.measure({ ...context(Date.now()), homeDir: isolated });
      expect(measured.status).toBe("unavailable");
      expect(measured.paths).toHaveLength(2);
    } finally {
      fs.rmSync(isolated, { recursive: true, force: true });
    }
  });
});

describe("OpenCode sqlite storage", () => {
  it("cascades deleted sessions to messages and reports freed bytes", async () => {
    const dbDir = path.join(dataHome, "opencode");
    fs.mkdirSync(dbDir, { recursive: true });
    const Database = await sqliteModule();
    const db = new Database(path.join(dbDir, "opencode.db"));
    db.exec(`create table session_v2 (id text primary key, time_updated integer);
      create table session_message (
        id text primary key,
        session_id text references session_v2(id) on delete cascade,
        data text);
      create index idx_msg_session on session_message(session_id);`);
    const nowMs = Date.now();
    const insertSession = db.prepare("insert into session_v2 values (?, ?)");
    const insertMessage = db.prepare("insert into session_message values (?, ?, ?)");
    insertSession.run("old", nowMs - 40 * DAY_MS);
    insertSession.run("recent", nowMs);
    insertMessage.run("m1", "old", "a".repeat(5000));
    insertMessage.run("m2", "recent", "b".repeat(10));
    db.close();

    const storage = new OpencodeStorage();
    const measured = await storage.measure(context(nowMs));
    expect(measured.status).toBe("available");
    expect(measured.sessionCount).toBe(2);
    expect(measured.staleSessionCount).toBe(1);
    expect(measured.staleSessionBytes).toBeGreaterThan(0);

    const result = await storage.cleanup(context(nowMs));
    expect(result.status).toBe("cleaned");
    expect(result.removedSessions).toBe(1);

    const check = new Database(path.join(dbDir, "opencode.db"));
    expect(check.prepare("select count(*) as c from session_v2").all()).toEqual([
      { c: 1 },
    ]);
    expect(check.prepare("select count(*) as c from session_message").all()).toEqual([
      { c: 1 },
    ]);
    check.close();
  });
});

describe("Devin sqlite storage", () => {
  it("removes stale sessions and their child rows", async () => {
    const dbDir = path.join(dataHome, "devin", "cli");
    fs.mkdirSync(dbDir, { recursive: true });
    const Database = await sqliteModule();
    const db = new Database(path.join(dbDir, "sessions.db"));
    db.exec(`create table sessions (id text primary key, last_activity_at integer);
      create table message_nodes (session_id text, created_at integer, chat_message text);
      create table prompt_history (id integer primary key, session_id text, content text);
      create table tool_call_state (session_id text, tool_call_id text);
      create table subagent_heads (session_id text, agent_id text);
      create table rendered_commits (id integer primary key, session_id text);
      create index idx_sessions_activity on sessions(last_activity_at);`);
    const nowSec = Math.floor(Date.now() / 1000);
    const insertSession = db.prepare("insert into sessions values (?, ?)");
    insertSession.run("old", nowSec - 40 * 86400);
    insertSession.run("recent", nowSec);
    db.prepare("insert into message_nodes values (?, ?, ?)").run("old", nowSec, "x".repeat(1000));
    db.prepare("insert into message_nodes values (?, ?, ?)").run("recent", nowSec, "y");
    db.prepare("insert into prompt_history values (?, ?, ?)").run(1, "old", "p");
    db.prepare("insert into prompt_history values (?, ?, ?)").run(2, "recent", "q");
    db.prepare("insert into tool_call_state values (?, ?)").run("old", "t1");
    db.prepare("insert into subagent_heads values (?, ?)").run("old", "a1");
    db.prepare("insert into rendered_commits values (?, ?)").run(1, "old");
    db.close();

    const storage = new DevinStorage();
    const measured = await storage.measure(context(Date.now()));
    expect(measured.status).toBe("available");
    expect(measured.sessionCount).toBe(2);
    expect(measured.staleSessionCount).toBe(1);

    const result = await storage.cleanup(context(Date.now()));
    expect(result.status).toBe("cleaned");
    expect(result.removedSessions).toBe(1);

    const check = new Database(path.join(dbDir, "sessions.db"));
    expect(check.prepare("select id from sessions").all()).toEqual([{ id: "recent" }]);
    expect(check.prepare("select session_id from message_nodes").all()).toEqual([
      { session_id: "recent" },
    ]);
    expect(check.prepare("select session_id from prompt_history").all()).toEqual([
      { session_id: "recent" },
    ]);
    expect(check.prepare("select count(*) as c from tool_call_state").all()).toEqual([{ c: 0 }]);
    expect(check.prepare("select count(*) as c from subagent_heads").all()).toEqual([{ c: 0 }]);
    expect(check.prepare("select count(*) as c from rendered_commits").all()).toEqual([{ c: 0 }]);
    check.close();
  });
});

describe("missing data directories", () => {
  it("reports unavailable for a missing sqlite database", async () => {
    process.env.XDG_DATA_HOME = path.join(tempRoot, "empty");
    try {
      const measured = await new OpencodeStorage().measure(context(Date.now()));
      expect(measured.status).toBe("unavailable");
      expect(measured.totalBytes).toBe(0);
    } finally {
      process.env.XDG_DATA_HOME = dataHome;
    }
  });
});
