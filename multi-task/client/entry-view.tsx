import type { PluginScreenProps } from "@getpaseo/plugin/client";
import type { ReactNode } from "react";
import { useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Markdown } from "./markdown";
import type { TimelineEntry, ToolDetail, ToolStatus } from "./timeline";

type Theme = PluginScreenProps["theme"];

const MONO = "monospace";
const MAX_BODY_LINES = 16;
/** 思考块的最大高度：内部滚动，避免把整条流一直往下推。 */
const REASONING_MAX_HEIGHT = 120;

const TOOL_STATUS_TEXT: Record<string, string> = {
  running: "执行中",
  completed: "完成",
  failed: "失败",
  canceled: "取消",
};

function toolStatusColor(status: ToolStatus, theme: Theme): string {
  switch (status) {
    case "running":
      return theme.colors.accent;
    case "failed":
      return theme.colors.statusDanger;
    case "canceled":
      return theme.colors.foregroundMuted;
    default:
      return theme.colors.statusSuccess;
  }
}

function useStyles(theme: Theme) {
  return useMemo(
    () => ({
      user: { color: theme.colors.foreground, fontSize: 14, lineHeight: 21, fontWeight: "600" as const },
      assistant: { color: theme.colors.foreground, fontSize: 14, lineHeight: 21 },
      reasoning: {
        color: theme.colors.foregroundMuted,
        fontSize: 13,
        lineHeight: 20,
        fontStyle: "italic" as const,
      },
      reasoningCard: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
        paddingHorizontal: 8,
        paddingVertical: 6,
        gap: 4,
      },
      reasoningHeader: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      reasoningCaret: { fontSize: 11, color: theme.colors.foregroundMuted },
      reasoningLabel: {
        fontSize: 12,
        fontWeight: "600" as const,
        color: theme.colors.foregroundMuted,
      },
      reasoningScroll: { maxHeight: REASONING_MAX_HEIGHT },
      error: { color: theme.colors.statusDanger, fontSize: 14, lineHeight: 21 },
      notice: { fontSize: 13, lineHeight: 20 },
      compaction: { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 20 },
      todo: { gap: 2 },
      todoItem: { color: theme.colors.foreground, fontSize: 14, lineHeight: 21 },
      todoDone: {
        color: theme.colors.foregroundMuted,
        fontSize: 14,
        lineHeight: 21,
        textDecorationLine: "line-through" as const,
      },
      toolCard: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
        paddingHorizontal: 8,
        paddingVertical: 6,
        gap: 4,
      },
      toolHeader: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      toolCaret: { fontSize: 11, color: theme.colors.foregroundMuted },
      toolTitle: { flex: 1, color: theme.colors.foreground, fontSize: 13, lineHeight: 18 },
      toolStatus: { fontSize: 11, fontWeight: "600" as const },
      toolBody: { gap: 2, paddingTop: 2 },
      mono: { fontFamily: MONO, fontSize: 13, lineHeight: 19 },
      bodyText: { fontSize: 13, lineHeight: 19 },
      bodyMuted: { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 19 },
    }),
    [theme],
  );
}

type Styles = ReturnType<typeof useStyles>;

function Lines({
  text,
  color,
  mono,
  styles,
  maxLines = MAX_BODY_LINES,
}: {
  text: string;
  color: string;
  mono?: boolean;
  styles: Styles;
  maxLines?: number;
}) {
  const lines = text.split("\n");
  const shown = lines.slice(0, maxLines);
  const hidden = lines.length - shown.length;
  return (
    <View>
      {shown.map((line, index) => (
        <Text key={index} style={[mono ? styles.mono : styles.bodyText, { color }]}>
          {line.length > 0 ? line : " "}
        </Text>
      ))}
      {hidden > 0 ? (
        <Text style={[styles.bodyText, { color }]}>…（另有 {hidden} 行）</Text>
      ) : null}
    </View>
  );
}

function Diff({ diff, theme, styles }: { diff: string; theme: Theme; styles: Styles }) {
  const all = diff.split("\n");
  const shown = all.slice(0, MAX_BODY_LINES);
  const hidden = all.length - shown.length;
  return (
    <View>
      {shown.map((line, index) => {
        const color = line.startsWith("+")
          ? theme.colors.statusSuccess
          : line.startsWith("-")
            ? theme.colors.statusDanger
            : line.startsWith("@@")
              ? theme.colors.accent
              : theme.colors.foregroundMuted;
        return (
          <Text key={index} style={[styles.mono, { color }]}>
            {line.length > 0 ? line : " "}
          </Text>
        );
      })}
      {hidden > 0 ? (
        <Text style={[styles.mono, { color: theme.colors.foregroundMuted }]}>
          …（另有 {hidden} 行）
        </Text>
      ) : null}
    </View>
  );
}

function detailBody(detail: ToolDetail, theme: Theme, styles: Styles): ReactNode {
  switch (detail.kind) {
    case "shell":
      return detail.output ? (
        <Lines text={detail.output} color={theme.colors.foregroundMuted} mono styles={styles} />
      ) : null;
    case "edit":
      return detail.diff ? <Diff diff={detail.diff} theme={theme} styles={styles} /> : null;
    case "write":
      return detail.content ? (
        <Lines text={detail.content} color={theme.colors.foregroundMuted} mono styles={styles} />
      ) : null;
    case "read":
      return detail.offset != null || detail.limit != null ? (
        <Text style={styles.bodyMuted}>
          行 {detail.offset ?? 0}–{(detail.offset ?? 0) + (detail.limit ?? 0)}
        </Text>
      ) : null;
    case "search": {
      const parts: string[] = [];
      if (detail.numMatches != null) parts.push(`${detail.numMatches} 处匹配`);
      if (detail.numFiles != null) parts.push(`${detail.numFiles} 个文件`);
      if (detail.filePaths && detail.filePaths.length > 0) {
        parts.push(detail.filePaths.slice(0, 8).join("\n"));
      }
      if (detail.webResults && detail.webResults.length > 0) {
        parts.push(detail.webResults.slice(0, 5).map((result) => result.title || result.url).join("\n"));
      }
      return parts.length > 0 ? <Text style={styles.bodyMuted}>{parts.join("\n")}</Text> : null;
    }
    case "fetch": {
      const parts: string[] = [];
      if (detail.code != null) parts.push(`HTTP ${detail.code}`);
      if (detail.bytes != null) parts.push(`${detail.bytes} B`);
      return parts.length > 0 ? <Text style={styles.bodyMuted}>{parts.join(" · ")}</Text> : null;
    }
    case "text":
    case "log":
      return detail.text.length > 0 ? (
        <Lines text={detail.text} color={theme.colors.foregroundMuted} mono styles={styles} />
      ) : null;
    default:
      return null;
  }
}

function ToolEntry({ entry, theme, styles }: { entry: Extract<TimelineEntry, { kind: "tool" }>; theme: Theme; styles: Styles }) {
  const [open, setOpen] = useState(entry.status === "failed");
  const body = detailBody(entry.detail, theme, styles);

  return (
    <View style={styles.toolCard}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${open ? "收起" : "展开"} ${entry.title}`}
        disabled={body == null}
        onPress={() => setOpen((value) => !value)}
        style={styles.toolHeader}
      >
        <Text style={styles.toolCaret}>{body != null ? (open ? "▾" : "▸") : "•"}</Text>
        <Text numberOfLines={2} style={styles.toolTitle}>
          {entry.title}
        </Text>
        <Text style={[styles.toolStatus, { color: toolStatusColor(entry.status, theme) }]}>
          {TOOL_STATUS_TEXT[entry.status] ?? entry.status}
        </Text>
      </Pressable>
      {body != null && open ? <View style={styles.toolBody}>{body}</View> : null}
    </View>
  );
}

/**
 * 思考块：限高 + 内部滚动（内部只跟随最新思考，不影响外层流），可折叠。
 * 尽量贴近原生 thinking 的呈现——不把整条对话一直往下推。
 */
function ReasoningEntry({ text, theme, styles }: { text: string; theme: Theme; styles: Styles }) {
  const [open, setOpen] = useState(true);
  const scrollRef = useRef<ScrollView>(null);

  return (
    <View style={styles.reasoningCard}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={open ? "收起思考" : "展开思考"}
        onPress={() => setOpen((value) => !value)}
        style={styles.reasoningHeader}
      >
        <Text style={styles.reasoningCaret}>{open ? "▾" : "▸"}</Text>
        <Text style={styles.reasoningLabel}>思考</Text>
      </Pressable>
      {open ? (
        <ScrollView
          ref={scrollRef}
          style={styles.reasoningScroll}
          nestedScrollEnabled
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
        >
          <Markdown text={text} theme={theme} baseStyle={styles.reasoning} />
        </ScrollView>
      ) : null}
    </View>
  );
}

export function EntryView({ entry, theme }: { entry: TimelineEntry; theme: Theme }) {
  const styles = useStyles(theme);

  switch (entry.kind) {
    case "user":
      return <Markdown text={entry.text} theme={theme} baseStyle={styles.user} />;
    case "assistant":
      return <Markdown text={entry.text} theme={theme} baseStyle={styles.assistant} />;
    case "reasoning":
      return <ReasoningEntry text={entry.text} theme={theme} styles={styles} />;
    case "error":
      return <Text style={styles.error}>{entry.text}</Text>;
    case "notification": {
      const color =
        entry.level === "error"
          ? theme.colors.statusDanger
          : entry.level === "warning"
            ? theme.colors.statusWarning
            : theme.colors.foregroundMuted;
      const icon = entry.level === "error" ? "✕" : entry.level === "warning" ? "!" : "ℹ";
      return (
        <Text style={[styles.notice, { color }]}>
          {icon} {entry.text}
        </Text>
      );
    }
    case "compaction":
      return <Text style={styles.compaction}>{entry.text}</Text>;
    case "todo":
      return (
        <View style={styles.todo}>
          {entry.items.map((item, index) => (
            <Text key={index} style={item.done ? styles.todoDone : styles.todoItem}>
              {item.done ? "☑" : "☐"} {item.text}
            </Text>
          ))}
        </View>
      );
    case "tool":
      return <ToolEntry entry={entry} theme={theme} styles={styles} />;
    default:
      return null;
  }
}
