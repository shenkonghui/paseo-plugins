import { usePaseo } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";

type UnknownRecord = Record<string, unknown>;

const MAX_ENTRIES = 300;

export const STATUS_LABELS: Record<string, string> = {
  running: "执行中",
  idle: "空闲",
  error: "出错",
  closed: "已关闭",
  initializing: "初始化",
};

export type ToolStatus = "running" | "completed" | "failed" | "canceled" | (string & {});

/** 结构化的工具调用细节，供面板按类型渲染。 */
export type ToolDetail =
  | { kind: "shell"; command: string; cwd?: string; output?: string; exitCode?: number | null }
  | { kind: "edit"; filePath: string; diff?: string; oldString?: string; newString?: string }
  | { kind: "write"; filePath: string; content?: string }
  | { kind: "read"; filePath: string; offset?: number; limit?: number }
  | {
      kind: "search";
      query: string;
      numMatches?: number;
      numFiles?: number;
      filePaths?: string[];
      webResults?: { title: string; url: string }[];
    }
  | { kind: "fetch"; url: string; code?: number; bytes?: number }
  | { kind: "text"; label?: string; text: string }
  | { kind: "log"; text: string }
  | { kind: "none" };

/** 同一条目可能被多次下发，`identity` 用于就地更新（流式文本增长、工具 running→completed）。 */
interface EntryBase {
  key: string;
  identity?: string;
}

export type TimelineEntry =
  | (EntryBase & { kind: "user"; text: string })
  | (EntryBase & { kind: "assistant"; text: string })
  | (EntryBase & { kind: "reasoning"; text: string })
  | (EntryBase & { kind: "error"; text: string })
  | (EntryBase & { kind: "notification"; text: string; level: "info" | "warning" | "error" })
  | (EntryBase & { kind: "compaction"; text: string })
  | (EntryBase & { kind: "todo"; items: { text: string; done: boolean }[] })
  | (EntryBase & {
      kind: "tool";
      name: string;
      status: ToolStatus;
      title: string;
      detail: ToolDetail;
    });

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" ? (value as UnknownRecord) : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((entry): entry is string => typeof entry === "string");
  return list.length > 0 ? list : undefined;
}

function describeTool(record: UnknownRecord): {
  title: string;
  status: ToolStatus;
  detail: ToolDetail;
} {
  const name = asString(record.name) ?? "工具";
  const status = (asString(record.status) ?? "completed") as ToolStatus;
  const detail = asRecord(record.detail);
  const type = detail ? asString(detail.type) : undefined;
  if (!detail || !type) return { title: name, status, detail: { kind: "none" } };

  switch (type) {
    case "shell": {
      const command = asString(detail.command) ?? "";
      return {
        title: `$ ${command}`.trim(),
        status,
        detail: {
          kind: "shell",
          command,
          cwd: asString(detail.cwd),
          output: asString(detail.output),
          exitCode: typeof detail.exitCode === "number" ? detail.exitCode : null,
        },
      };
    }
    case "edit": {
      const filePath = asString(detail.filePath) ?? "";
      return {
        title: `编辑 ${filePath}`.trim(),
        status,
        detail: {
          kind: "edit",
          filePath,
          diff: asString(detail.unifiedDiff),
          oldString: asString(detail.oldString),
          newString: asString(detail.newString),
        },
      };
    }
    case "write": {
      const filePath = asString(detail.filePath) ?? "";
      return {
        title: `写入 ${filePath}`.trim(),
        status,
        detail: { kind: "write", filePath, content: asString(detail.content) },
      };
    }
    case "read": {
      const filePath = asString(detail.filePath) ?? "";
      return {
        title: `读取 ${filePath}`.trim(),
        status,
        detail: {
          kind: "read",
          filePath,
          offset: asNumber(detail.offset),
          limit: asNumber(detail.limit),
        },
      };
    }
    case "search": {
      const query = asString(detail.query) ?? "";
      const numMatches = asNumber(detail.numMatches);
      const numFiles = asNumber(detail.numFiles);
      const webResults = Array.isArray(detail.webResults)
        ? detail.webResults
            .map((entry) => asRecord(entry))
            .filter((entry): entry is UnknownRecord => entry != null)
            .map((entry) => ({ title: asString(entry.title) ?? "", url: asString(entry.url) ?? "" }))
            .filter((entry) => entry.url)
        : undefined;
      const suffix = numMatches != null ? ` · ${numMatches} 处` : "";
      return {
        title: `搜索 ${query}${suffix}`.trim(),
        status,
        detail: {
          kind: "search",
          query,
          numMatches,
          numFiles,
          filePaths: asStringArray(detail.filePaths),
          webResults: webResults && webResults.length > 0 ? webResults : undefined,
        },
      };
    }
    case "fetch": {
      const url = asString(detail.url) ?? "";
      return {
        title: `抓取 ${url}`.trim(),
        status,
        detail: { kind: "fetch", url, code: asNumber(detail.code), bytes: asNumber(detail.bytes) },
      };
    }
    case "plain_text": {
      const label = asString(detail.label);
      const text = asString(detail.text) ?? "";
      return { title: label ?? name, status, detail: { kind: "text", label, text } };
    }
    case "plan": {
      return { title: "计划", status, detail: { kind: "text", text: asString(detail.text) ?? "" } };
    }
    case "sub_agent": {
      const label = asString(detail.subAgentType) ?? "子任务";
      return {
        title: label,
        status,
        detail: { kind: "log", text: asString(detail.log) ?? "" },
      };
    }
    case "worktree_setup": {
      const branch = asString(detail.branchName) ?? "";
      return {
        title: `Worktree ${branch}`.trim(),
        status,
        detail: { kind: "log", text: asString(detail.log) ?? "" },
      };
    }
    default:
      return { title: name, status, detail: { kind: "none" } };
  }
}

function toEntry(item: unknown, timestamp: string | undefined, index: number): TimelineEntry | null {
  const record = asRecord(item);
  if (!record) return null;
  const fallbackKey = `${timestamp ?? ""}#${index}`;
  const type = asString(record.type);
  switch (type) {
    case "user_message": {
      const messageId = asString(record.messageId);
      return {
        kind: "user",
        key: messageId ? `user:${messageId}` : fallbackKey,
        identity: messageId ? `user:${messageId}` : undefined,
        text: String(record.text ?? ""),
      };
    }
    case "assistant_message": {
      const messageId = asString(record.messageId);
      return {
        kind: "assistant",
        key: messageId ? `assistant:${messageId}` : fallbackKey,
        identity: messageId ? `assistant:${messageId}` : undefined,
        text: String(record.text ?? ""),
      };
    }
    case "reasoning":
      return { kind: "reasoning", key: fallbackKey, text: String(record.text ?? "") };
    case "tool_call": {
      const callId = asString(record.callId);
      const described = describeTool(record);
      return {
        kind: "tool",
        key: callId ? `tool:${callId}` : fallbackKey,
        identity: callId ? `tool:${callId}` : undefined,
        name: asString(record.name) ?? "工具",
        status: described.status,
        title: described.title,
        detail: described.detail,
      };
    }
    case "todo": {
      const items = Array.isArray(record.items) ? record.items : [];
      return {
        kind: "todo",
        key: fallbackKey,
        items: items.map((entry) => {
          const task = asRecord(entry) ?? {};
          const done = task.completed === true || task.status === "completed";
          return { text: String(task.text ?? ""), done };
        }),
      };
    }
    case "error":
      return { kind: "error", key: fallbackKey, text: String(record.message ?? "未知错误") };
    case "notification": {
      const level = asString(record.level);
      return {
        kind: "notification",
        key: fallbackKey,
        text: String(record.message ?? ""),
        level: level === "warning" || level === "error" ? level : "info",
      };
    }
    case "compaction": {
      const status = asString(record.status) ?? "";
      const trigger = asString(record.trigger);
      return {
        kind: "compaction",
        key: fallbackKey,
        text: `上下文压缩${trigger ? `（${trigger}）` : ""}${status ? ` · ${status}` : ""}`,
      };
    }
    case "plugin":
      return {
        kind: "notification",
        key: fallbackKey,
        text: `[${asString(record.kind) ?? "plugin"}]`,
        level: "info",
      };
    default:
      return null;
  }
}

/**
 * 合并两段思考文本，兼容两种下发方式：
 * - 累积式（新文本包含旧文本）→ 取新的；
 * - 增量式（片段）→ 直接拼接（对齐 daemon 的 `reasoning_merge` 合并语义）。
 */
function mergeReasoningText(previous: string, next: string): string {
  if (next.length === 0) return previous;
  if (previous.length === 0) return next;
  if (next.startsWith(previous)) return next;
  if (previous.endsWith(next)) return previous;
  return previous + next;
}

/** 把相邻的 reasoning 条目并成一个，避免连续思考渲染成多张卡片。 */
function mergeAdjacentReasoning(entries: TimelineEntry[]): TimelineEntry[] {
  const merged: TimelineEntry[] = [];
  for (const entry of entries) {
    const last = merged[merged.length - 1];
    if (entry.kind === "reasoning" && last && last.kind === "reasoning") {
      merged[merged.length - 1] = { ...last, text: mergeReasoningText(last.text, entry.text) };
      continue;
    }
    merged.push(entry);
  }
  return merged;
}

function toEntries(
  rawEntries: ReadonlyArray<{ item: unknown; timestamp?: string; seqStart?: number }>,
): TimelineEntry[] {
  const ordered = [...rawEntries].sort((a, b) => (a.seqStart ?? 0) - (b.seqStart ?? 0));
  const result: TimelineEntry[] = [];
  const byIdentity = new Map<string, number>();
  ordered.forEach((entry, index) => {
    const next = toEntry(entry.item, entry.timestamp, index);
    if (!next) return;
    if (next.identity) {
      const existing = byIdentity.get(next.identity);
      if (existing != null) {
        result[existing] = next;
        return;
      }
      byIdentity.set(next.identity, result.length);
    }
    result.push(next);
  });
  return mergeAdjacentReasoning(result).slice(-MAX_ENTRIES);
}

/**
 * 订阅某个 agent 的实时 timeline：先 refetch 历史，再吃流式事件。
 * 与原生会话使用同一份 `projected` 投影，输出结构化条目供面板渲染。
 */
export function useAgentTimeline(
  agentId: string,
  enabled = true,
): {
  entries: TimelineEntry[];
  status: string | null;
  error: string | null;
} {
  const paseo = usePaseo();
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // 内嵌原生视图时不需要自绘流，避免同时建立两套订阅。
    if (!enabled) {
      setEntries([]);
      setStatus(null);
      setError(null);
      return;
    }
    let disposed = false;
    let counter = 0;
    setEntries([]);
    setError(null);
    setStatus(null);

    const handle = paseo.agents.ref(agentId);
    const reload = () => {
      handle.timeline
        .refetch({ direction: "tail", limit: 60, projection: "projected" })
        .then((page) => {
          if (!disposed) setEntries(toEntries(page.entries));
        })
        .catch((cause) => {
          if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
        });
    };
    // 同一条目可能被多次下发（流式文本增长、工具 running→completed），按 identity 就地更新。
    const upsert = (entry: TimelineEntry) => {
      setEntries((current) => {
        if (entry.identity) {
          const index = current.findIndex((item) => item.identity === entry.identity);
          if (index >= 0) {
            const next = current.slice();
            next[index] = entry;
            return next;
          }
        }
        // 连续的思考并进上一张思考卡片（保留其 key，避免折叠状态被重置）。
        if (entry.kind === "reasoning") {
          const last = current[current.length - 1];
          if (last && last.kind === "reasoning") {
            const next = current.slice();
            next[next.length - 1] = {
              ...last,
              text: mergeReasoningText(last.text, entry.text),
            };
            return next;
          }
        }
        return [...current, entry].slice(-MAX_ENTRIES);
      });
    };

    reload();
    handle
      .refresh()
      .then((result) => {
        if (!disposed && result) setStatus(result.agent.status);
      })
      .catch(() => {});

    const subscription = handle.timeline.subscribe((event) => {
      const streamEvent = event.event;
      switch (streamEvent.type) {
        case "timeline": {
          const next = toEntry(
            streamEvent.item,
            (streamEvent as { timestamp?: string }).timestamp,
            counter++,
          );
          if (next) upsert(next);
          break;
        }
        case "replacement":
          reload();
          break;
        case "subscription_restored":
          reload();
          break;
        case "turn_started":
          setStatus("running");
          break;
        case "turn_completed":
        case "turn_failed":
        case "turn_canceled":
          setStatus("idle");
          break;
        default:
          break;
      }
    });

    // 建立失败会释放观察并 reject `ready`；不要让它变成未处理的 Promise。
    void subscription.ready.catch(() => {});

    return () => {
      disposed = true;
      void subscription.release();
    };
  }, [paseo, agentId, enabled]);

  return { entries, status, error };
}
