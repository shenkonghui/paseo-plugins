import type { PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { SubagentRow, SubagentStatus } from "../shared/subagents";
import {
  getSubagentsState,
  refreshSubagents,
  runningCount,
  subscribeSubagents,
} from "./store";

const POLL_OPEN_MS = 2_500;

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function formatClock(ms: number | null): string {
  if (ms === null) return "-";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "-";
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function formatDuration(row: SubagentRow): string {
  const start = row.startedAt;
  if (start === null) return "-";
  const end = row.completedAt ?? (row.status === "running" ? Date.now() : row.updatedAt);
  if (end === null) return "-";
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${pad2(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${pad2(minutes % 60)}m`;
}

function statusLabel(status: SubagentStatus): string {
  switch (status) {
    case "running":
      return "运行中";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
  }
}

export function SubagentsPanel({ agentId, theme, layout }: PluginAgentPanelProps) {
  const state = useSyncExternalStore(
    useCallback((listener) => subscribeSubagents(agentId, listener), [agentId]),
    useCallback(() => getSubagentsState(agentId), [agentId]),
  );

  useEffect(() => {
    void refreshSubagents(agentId);
    const timer = setInterval(() => {
      void refreshSubagents(agentId);
    }, POLL_OPEN_MS);
    return () => clearInterval(timer);
  }, [agentId]);

  const styles = useMemo(() => makeStyles(theme, layout.compact), [theme, layout.compact]);
  const running = runningCount(state);

  const statusColor = useCallback(
    (status: SubagentStatus): string => {
      switch (status) {
        case "running":
          return theme.colors.accent;
        case "completed":
          return theme.colors.statusSuccess;
        case "failed":
          return theme.colors.statusDanger;
        case "cancelled":
          return theme.colors.foregroundMuted;
      }
    },
    [theme],
  );

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>子任务</Text>
        <Text style={styles.subtitle}>
          {state.loading && state.fetchedAt === null
            ? "读取中…"
            : state.rows.length === 0
              ? "没有子任务"
              : `共 ${state.rows.length} 个${running > 0 ? ` · ${running} 个运行中` : ""}`}
        </Text>
        <Pressable onPress={() => void refreshSubagents(agentId)} style={styles.refresh}>
          <Text style={styles.refreshText}>刷新</Text>
        </Pressable>
      </View>

      {state.error ? <Text style={styles.error}>{state.error}</Text> : null}

      {!state.supported ? (
        <View style={styles.emptyBox}>
          <Text style={styles.emptyTitle}>该 provider 暂无子任务数据源</Text>
          <Text style={styles.emptyText}>
            当前 provider：{state.provider || "unknown"}。插件目前适配 Qoder 系 CLI
            的本地任务存储。
          </Text>
        </View>
      ) : state.rows.length === 0 ? (
        <View style={styles.emptyBox}>
          <Text style={styles.emptyTitle}>没有子任务</Text>
          <Text style={styles.emptyText}>
            agent 启动子任务后会出现在这里。数据来源：{state.provider} 的本地任务存储。
          </Text>
        </View>
      ) : (
        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          {state.rows.map((row) => (
            <View key={row.id} style={styles.row}>
              <View style={[styles.dot, { backgroundColor: statusColor(row.status) }]} />
              <View style={styles.rowMain}>
                <Text style={styles.rowTitle} numberOfLines={2}>
                  {row.name}
                </Text>
                <Text style={styles.rowMeta} numberOfLines={1}>
                  {statusLabel(row.status)} · {formatDuration(row)} · {formatClock(row.startedAt)}
                  {row.agentType ? ` · ${row.agentType}` : ""}
                </Text>
                {row.summary && row.summary !== row.name ? (
                  <Text style={styles.rowSummary} numberOfLines={2}>
                    {row.summary}
                  </Text>
                ) : null}
              </View>
              <Text style={styles.rowId} numberOfLines={1}>
                {row.id.slice(0, 8)}
              </Text>
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

function makeStyles(theme: PluginAgentPanelProps["theme"], compact: boolean) {
  return {
    screen: { flex: 1, backgroundColor: theme.colors.surface0 },
    header: {
      flexDirection: "row" as const,
      alignItems: "baseline" as const,
      gap: 8,
      paddingHorizontal: compact ? 12 : 16,
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderColor: theme.colors.border,
    },
    title: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" as const },
    subtitle: { color: theme.colors.foregroundMuted, fontSize: 12, flex: 1 },
    refresh: {
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 6,
      backgroundColor: theme.colors.surface2,
    },
    refreshText: { color: theme.colors.foreground, fontSize: 12 },
    error: {
      color: theme.colors.statusDanger,
      fontSize: 12,
      paddingHorizontal: compact ? 12 : 16,
      paddingVertical: 8,
    },
    emptyBox: { padding: compact ? 16 : 24, gap: 6 },
    emptyTitle: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
    emptyText: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 },
    list: { flex: 1 },
    listContent: { paddingVertical: 6 },
    row: {
      flexDirection: "row" as const,
      alignItems: "flex-start" as const,
      gap: 8,
      paddingHorizontal: compact ? 12 : 16,
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderColor: theme.colors.border,
    },
    dot: { width: 8, height: 8, borderRadius: 4, marginTop: 6 },
    rowMain: { flex: 1, gap: 2 },
    rowTitle: { color: theme.colors.foreground, fontSize: 13 },
    rowMeta: { color: theme.colors.foregroundMuted, fontSize: 11 },
    rowSummary: { color: theme.colors.foregroundMuted, fontSize: 11, fontStyle: "italic" as const },
    rowId: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
      fontFamily: "monospace",
      marginTop: 2,
    },
  };
}
