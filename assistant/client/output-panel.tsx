import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { usePaseo } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { getOutputTarget, subscribeOutputTarget, type OutputTarget } from "./output-store";

type LineKind = "user" | "assistant" | "reasoning" | "tool" | "error" | "info";

interface OutputLine {
  key: string;
  kind: LineKind;
  text: string;
}

const MAX_LINES = 400;
const MAX_CHARS = 4000;

export const OUTPUT_PANEL_ID = "assistant-output";

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function clip(text: string): string {
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n…（已截断）` : text;
}

function formatTool(item: Record<string, unknown>): string {
  const name = asString(item.name) ?? "工具";
  const detail = item.detail;
  if (!detail || typeof detail !== "object") return name;
  const record = detail as Record<string, unknown>;
  switch (asString(record.type)) {
    case "shell":
      return `$ ${asString(record.command) ?? ""}`.trim();
    case "read":
      return `读取 ${asString(record.filePath) ?? ""}`.trim();
    case "edit":
      return `编辑 ${asString(record.filePath) ?? ""}`.trim();
    case "write":
      return `写入 ${asString(record.filePath) ?? ""}`.trim();
    case "search":
      return `搜索 ${asString(record.query) ?? ""}`.trim();
    case "fetch":
      return `抓取 ${asString(record.url) ?? ""}`.trim();
    default:
      return name;
  }
}

function toLine(item: unknown, timestamp: string | undefined, index: number): OutputLine | null {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  const key = `${timestamp ?? ""}#${index}`;
  switch (asString(record.type)) {
    case "user_message":
      return { key, kind: "user", text: clip(String(record.text ?? "")) };
    case "assistant_message":
      return { key, kind: "assistant", text: clip(String(record.text ?? "")) };
    case "reasoning":
      return { key, kind: "reasoning", text: clip(String(record.text ?? "")) };
    case "tool_call":
      return { key, kind: "tool", text: clip(formatTool(record)) };
    case "error":
      return { key, kind: "error", text: clip(String(record.message ?? "未知错误")) };
    case "notification":
      return { key, kind: "info", text: clip(String(record.message ?? "")) };
    case "todo": {
      const items = Array.isArray(record.items) ? record.items : [];
      const text = items
        .map((entry) => {
          const task = (entry ?? {}) as Record<string, unknown>;
          const done = task.completed === true || task.status === "completed";
          return `${done ? "☑" : "☐"} ${String(task.text ?? "")}`;
        })
        .join("\n");
      return { key, kind: "tool", text: clip(text || "任务清单") };
    }
    case "compaction":
      return { key, kind: "info", text: `上下文压缩（${String(record.status ?? "")}）` };
    case "plugin":
      return { key, kind: "info", text: `[${String(record.kind ?? "plugin")}]` };
    default:
      return null;
  }
}

function toLines(
  entries: ReadonlyArray<{ item: unknown; timestamp?: string; seqStart?: number }>,
): OutputLine[] {
  const ordered = [...entries].sort((a, b) => (a.seqStart ?? 0) - (b.seqStart ?? 0));
  return ordered
    .map((entry, index) => toLine(entry.item, entry.timestamp, index))
    .filter((line): line is OutputLine => line !== null)
    .slice(-MAX_LINES);
}

const STATUS_LABELS: Record<string, string> = {
  running: "执行中",
  idle: "空闲",
  error: "出错",
  closed: "已关闭",
  initializing: "初始化",
};

function AgentOutput({
  target,
  theme,
  layout,
  navigation,
}: {
  target: OutputTarget;
  theme: PluginWorkspacePanelProps["theme"];
  layout: PluginWorkspacePanelProps["layout"];
  navigation: PluginWorkspacePanelProps["navigation"];
}) {
  const paseo = usePaseo();
  const [lines, setLines] = useState<OutputLine[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    let disposed = false;
    let counter = 0;
    setLines([]);
    setError(null);
    setStatus(null);

    const handle = paseo.agents.ref(target.agentId);
    const reload = () => {
      handle.timeline
        .refetch({ direction: "tail", limit: 60, projection: "projected" })
        .then((page) => {
          if (!disposed) setLines(toLines(page.entries));
        })
        .catch((cause) => {
          if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
        });
    };
    const append = (item: unknown, timestamp: string | undefined) => {
      const line = toLine(item, timestamp ?? new Date().toISOString(), counter++);
      if (!line) return;
      setLines((current) => [...current, line].slice(-MAX_LINES));
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
        case "timeline":
          append(streamEvent.item, (streamEvent as { timestamp?: string }).timestamp);
          break;
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

    // Establishment failure releases the observation and rejects `ready`; don't let it go unhandled.
    void subscription.ready.catch(() => {});

    return () => {
      disposed = true;
      void subscription.release();
    };
  }, [paseo, target.agentId]);

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      header: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingHorizontal: layout.compact ? 12 : 16,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      },
      grow: { flex: 1, minWidth: 0 },
      title: { color: theme.colors.foreground, fontWeight: "600" as const },
      meta: { color: theme.colors.foregroundMuted, fontSize: 12 },
      openButton: {
        paddingVertical: 6,
        paddingHorizontal: 10,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
      },
      openButtonText: { color: theme.colors.foreground, fontSize: 12 },
      scroll: { flex: 1 },
      content: {
        padding: layout.compact ? 12 : 16,
        gap: 10,
      },
      empty: {
        flex: 1,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        gap: 8,
        padding: 20,
      },
      emptyText: { color: theme.colors.foregroundMuted, textAlign: "center" as const },
      line: { color: theme.colors.foreground, fontSize: 13, lineHeight: 19 },
      lineMuted: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 },
      lineTool: { color: theme.colors.accent, fontSize: 12, lineHeight: 18 },
      lineError: { color: theme.colors.statusDanger, fontSize: 12, lineHeight: 18 },
      lineUser: { color: theme.colors.foreground, fontWeight: "600" as const, fontSize: 13 },
    }),
    [theme, layout.compact],
  );

  const lineStyle = (kind: LineKind) => {
    switch (kind) {
      case "user":
        return styles.lineUser;
      case "tool":
        return styles.lineTool;
      case "error":
        return styles.lineError;
      case "reasoning":
      case "info":
        return styles.lineMuted;
      default:
        return styles.line;
    }
  };

  const statusLabel = status ? (STATUS_LABELS[status] ?? status) : "…";

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View style={styles.grow}>
          <Text numberOfLines={1} style={styles.title}>
            {target.agentTitle ?? target.agentId}
          </Text>
          <Text numberOfLines={1} style={styles.meta}>
            {target.workspaceName} · {statusLabel}
          </Text>
        </View>
        {navigation ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="打开完整会话"
            onPress={() => navigation.openAgent({ agentId: target.agentId })}
            style={styles.openButton}
          >
            <Text style={styles.openButtonText}>打开</Text>
          </Pressable>
        ) : null}
      </View>

      {error ? (
        <View style={styles.empty}>
          <Text style={styles.lineError}>{error}</Text>
        </View>
      ) : (
        <ScrollView
          ref={scrollRef}
          style={styles.scroll}
          contentContainerStyle={styles.content}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
        >
          {lines.length === 0 ? (
            <Text style={styles.emptyText}>等待输出…</Text>
          ) : (
            lines.map((line) => (
              <Text key={line.key} style={lineStyle(line.kind)}>
                {line.text}
              </Text>
            ))
          )}
        </ScrollView>
      )}
    </View>
  );
}

export function AssistantOutputPanel({
  theme,
  layout,
  navigation,
}: PluginWorkspacePanelProps) {
  const target = useSyncExternalStore(subscribeOutputTarget, getOutputTarget, getOutputTarget);

  if (!target) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          backgroundColor: theme.colors.surface0,
        }}
      >
        <Text style={{ color: theme.colors.foregroundMuted, textAlign: "center" }}>
          {"在任意会话输入 /send <workspace> <消息>，这里会实时显示目标 agent 的执行输出。"}
        </Text>
      </View>
    );
  }

  return <AgentOutput target={target} theme={theme} layout={layout} navigation={navigation} />;
}
