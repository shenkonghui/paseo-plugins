import { describe, expect, it } from "vitest";
import { columnFor, formatRelativeTime, groupAgents, type KanbanAgent } from "./board";

function agent(overrides: Partial<KanbanAgent>): KanbanAgent {
  return {
    id: "agent-1",
    title: null,
    provider: "claude",
    cwd: "/repos/app",
    status: "idle",
    lastUserMessageAt: "2026-09-21T09:00:00.000Z",
    updatedAt: "2026-09-21T10:00:00.000Z",
    ...overrides,
  };
}

describe("columnFor", () => {
  it("routes archived agents to closed before anything else", () => {
    expect(columnFor(agent({ archivedAt: "2026-09-21T11:00:00.000Z" }))).toBe("closed");
    expect(columnFor(agent({ archivedAt: "x", status: "running" }))).toBe("closed");
    expect(
      columnFor(agent({ archivedAt: "x", requiresAttention: true, pendingPermissions: [{}] })),
    ).toBe("closed");
  });

  it("routes never-started agents to todo", () => {
    expect(columnFor(agent({ status: "initializing" }))).toBe("todo");
    expect(columnFor(agent({ status: "idle", lastUserMessageAt: null }))).toBe("todo");
    expect(columnFor(agent({ status: "closed", lastUserMessageAt: null }))).toBe("todo");
  });

  it("routes running and permission-waiting agents to running", () => {
    expect(columnFor(agent({ status: "running" }))).toBe("running");
    expect(columnFor(agent({ status: "idle", pendingPermissions: [{}] }))).toBe("running");
    expect(columnFor(agent({ status: "idle", attentionReason: "permission" }))).toBe("running");
  });

  it("routes finished and errored agents to done", () => {
    expect(columnFor(agent({ status: "idle" }))).toBe("done");
    expect(columnFor(agent({ status: "closed" }))).toBe("done");
    expect(columnFor(agent({ status: "error" }))).toBe("done");
    expect(columnFor(agent({ status: "idle", attentionReason: "finished" }))).toBe("done");
  });
});

describe("groupAgents", () => {
  it("resolves card titles from title, workspace name, then cwd", () => {
    const workspaces = new Map([["ws-1", "paseo-app"]]);
    const board = groupAgents(
      [
        agent({ id: "titled", title: "修复登录" }),
        agent({ id: "workspaced", workspaceId: "ws-1" }),
        agent({ id: "plain", cwd: "/repos/api" }),
      ],
      workspaces,
    );
    const titles = (id: string) => [...board.values()].flat().find((card) => card.id === id)?.title;
    expect(titles("titled")).toBe("修复登录");
    expect(titles("workspaced")).toBe("paseo-app");
    expect(titles("plain")).toBe("api");
  });

  it("sorts each column by most recent activity", () => {
    const board = groupAgents(
      [
        agent({ id: "old", status: "idle", updatedAt: "2026-09-21T08:00:00.000Z" }),
        agent({ id: "new", status: "idle", updatedAt: "2026-09-21T10:00:00.000Z" }),
      ],
      new Map(),
    );
    expect(board.get("done")?.map((card) => card.id)).toEqual(["new", "old"]);
  });

  it("surfaces pendingPrompt from labels only before the first prompt", () => {
    const board = groupAgents(
      [
        agent({
          id: "pending",
          lastUserMessageAt: null,
          labels: { "agent-kanban.prompt": "修复登录页样式" },
        }),
        agent({
          id: "started",
          lastUserMessageAt: "2026-09-21T09:00:00.000Z",
          labels: { "agent-kanban.prompt": "修复登录页样式" },
        }),
      ],
      new Map(),
    );
    const all = [...board.values()].flat();
    expect(all.find((card) => card.id === "pending")?.pendingPrompt).toBe("修复登录页样式");
    expect(all.find((card) => card.id === "started")?.pendingPrompt).toBeNull();
  });

  it("badges permission waits as warnings and errors as danger", () => {
    const board = groupAgents(
      [
        agent({ id: "perm", status: "running", attentionReason: "permission" }),
        agent({ id: "fail", status: "error" }),
      ],
      new Map(),
    );
    const all = [...board.values()].flat();
    const perm = all.find((card) => card.id === "perm");
    const fail = all.find((card) => card.id === "fail");
    expect(perm).toMatchObject({ badgeLabel: "需要授权", badgeTone: "warning" });
    expect(fail).toMatchObject({ badgeLabel: "出错", badgeTone: "danger" });
  });
});

describe("formatRelativeTime", () => {
  const now = Date.parse("2026-09-21T12:00:00.000Z");
  it("formats seconds, minutes, hours, and days in Chinese", () => {
    expect(formatRelativeTime("2026-09-21T11:59:30.000Z", now)).toBe("刚刚");
    expect(formatRelativeTime("2026-09-21T11:45:00.000Z", now)).toBe("15 分钟前");
    expect(formatRelativeTime("2026-09-21T09:00:00.000Z", now)).toBe("3 小时前");
    expect(formatRelativeTime("2026-09-19T12:00:00.000Z", now)).toBe("2 天前");
  });
});
