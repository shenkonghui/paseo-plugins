import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { formatBytes, formatCount } from "./format";
import {
  tokenUsageCleanupRpc,
  tokenUsageDiskRpc,
  type TokenUsageAgentId,
  type TokenUsageCleanupResult,
  type TokenUsageDiskAgent,
} from "../shared/rpc";

type Theme = PluginSurfaceProps["theme"];

/** 清理阈值固定 30 天；改这里即可同时调整展示与删除范围。 */
const STALE_DAYS = 30;
type CleanupScope = "all" | TokenUsageAgentId;

interface DiskSnapshot {
  fetchedAt: string;
  staleDays: number;
  agents: TokenUsageDiskAgent[];
  stale: boolean;
}

/**
 * 「本地磁盘占用 + 清理」区块：展示每个 agent 的数据目录占用，
 * 并支持手动删除 30 天前（且之后无活动）的会话。
 */
export function DiskUsageSection({ theme }: { theme: Theme }) {
  const styles = useMemo(() => useStyles(theme), [theme]);
  const fetchDisk = useRpc(tokenUsageDiskRpc);
  const runCleanup = useRpc(tokenUsageCleanupRpc);

  const [snapshot, setSnapshot] = useState<DiskSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<CleanupScope | null>(null);
  const [running, setRunning] = useState<CleanupScope | null>(null);
  const [notices, setNotices] = useState<Record<string, string>>({});

  const requestSeq = useRef(0);

  const load = useCallback(
    (forceRefresh: boolean) => {
      const seq = ++requestSeq.current;
      setLoading(true);
      setError(null);
      fetchDisk({ forceRefresh, olderThanDays: STALE_DAYS })
        .then((result) => {
          if (seq !== requestSeq.current) {
            return;
          }
          setSnapshot(result);
          setLoading(false);
        })
        .catch((failure: unknown) => {
          if (seq !== requestSeq.current) {
            return;
          }
          setError(messageOf(failure));
          setLoading(false);
        });
    },
    [fetchDisk],
  );

  useEffect(() => {
    load(false);
  }, [load]);

  const handleCleanup = useCallback(
    (scope: CleanupScope, agentId?: TokenUsageAgentId) => {
      setConfirming(null);
      setRunning(scope);
      setNotices((current) => ({ ...current, [scope]: "" }));
      runCleanup(
        agentId ? { olderThanDays: STALE_DAYS, agentIds: [agentId] } : { olderThanDays: STALE_DAYS },
      )
        .then((output) => {
          setSnapshot({ ...output.disk, stale: false });
          setNotices((current) => ({ ...current, [scope]: summarize(output.results) }));
        })
        .catch((failure: unknown) => {
          setNotices((current) => ({ ...current, [scope]: `清理失败：${messageOf(failure)}` }));
        })
        .finally(() => {
          setRunning(null);
        });
    },
    [runCleanup],
  );

  if (loading && !snapshot) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>本地磁盘占用</Text>
        <Text style={styles.muted}>正在统计各 agent 的本地占用…</Text>
      </View>
    );
  }

  if (error && !snapshot) {
    return (
      <View style={styles.card}>
        <View style={styles.headerRow}>
          <Text style={styles.title}>本地磁盘占用</Text>
          <Pressable onPress={() => load(false)} hitSlop={8}>
            <Text style={styles.actionText}>重试</Text>
          </Pressable>
        </View>
        <Text style={styles.muted}>{error}</Text>
      </View>
    );
  }

  if (!snapshot) {
    return null;
  }

  const staleDays = snapshot.staleDays || STALE_DAYS;
  const staleTotal = snapshot.agents.reduce((sum, agent) => sum + agent.staleSessionBytes, 0);
  const staleSessions = snapshot.agents.reduce((sum, agent) => sum + agent.staleSessionCount, 0);
  const busy = running !== null;

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <View style={styles.headerLeft}>
          <Text style={styles.title}>本地磁盘占用</Text>
          {snapshot.stale ? <Text style={styles.staleText}>缓存已过期</Text> : null}
        </View>
        <View style={styles.headerActions}>
          <Pressable onPress={() => load(true)} hitSlop={8} disabled={busy || loading}>
            <Text style={styles.actionText}>{loading ? "统计中…" : "重新统计"}</Text>
          </Pressable>
          {staleSessions > 0 ? (
            <Pressable onPress={() => setConfirming("all")} hitSlop={8} disabled={busy}>
              <Text style={styles.dangerText}>全部清理</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
      <Text style={styles.muted}>
        占用为该 agent 数据目录的递归大小；「可清理」指 {staleDays} 天前、之后无活动的会话。
      </Text>

      {confirming === "all" ? (
        <ConfirmRow
          styles={styles}
          label={`确认删除全部 ${staleSessions} 个过期会话（预计释放约 ${formatBytes(staleTotal)}）？删除后不可恢复。`}
          busy={busy}
          onCancel={() => setConfirming(null)}
          onConfirm={() => handleCleanup("all")}
        />
      ) : null}
      {notices.all ? <Text style={styles.noticeText}>{notices.all}</Text> : null}

      {snapshot.agents.map((agent) => (
        <AgentDiskRow
          key={agent.agentId}
          agent={agent}
          staleDays={staleDays}
          styles={styles}
          confirming={confirming === agent.agentId}
          running={running === agent.agentId}
          busy={busy}
          notice={notices[agent.agentId]}
          onAsk={() => setConfirming(agent.agentId)}
          onCancel={() => setConfirming(null)}
          onConfirm={() => handleCleanup(agent.agentId, agent.agentId)}
        />
      ))}
    </View>
  );
}

interface AgentDiskRowProps {
  agent: TokenUsageDiskAgent;
  staleDays: number;
  styles: DiskUsageStyles;
  confirming: boolean;
  running: boolean;
  busy: boolean;
  notice: string | undefined;
  onAsk(): void;
  onCancel(): void;
  onConfirm(): void;
}

function AgentDiskRow({
  agent,
  staleDays,
  styles,
  confirming,
  running,
  busy,
  notice,
  onAsk,
  onCancel,
  onConfirm,
}: AgentDiskRowProps) {
  return (
    <View style={styles.row}>
      <View style={styles.rowHeader}>
        <View style={styles.headerLeft}>
          <Text style={styles.name}>{agent.displayName}</Text>
          {agent.status !== "available" ? (
            <Text style={styles.statusBadge}>{agent.status === "unavailable" ? "未安装" : "读取失败"}</Text>
          ) : null}
        </View>
        <Text style={styles.bytes}>{formatBytes(agent.totalBytes)}</Text>
      </View>

      {agent.error ? <Text style={styles.muted}>{agent.error}</Text> : null}

      {agent.status === "available" ? (
        <>
          <Text style={styles.muted}>
            会话 {formatCount(agent.sessionCount)} 个 · 会话数据 {formatBytes(agent.sessionBytes)}
          </Text>
          <View style={styles.rowActions}>
            <Text style={styles.staleText}>
              {staleDays} 天前可清理 {formatCount(agent.staleSessionCount)} 个 · 约{" "}
              {formatBytes(agent.staleSessionBytes)}
            </Text>
            {agent.staleSessionCount > 0 ? (
              <Pressable onPress={onAsk} hitSlop={8} disabled={busy}>
                <Text style={running ? styles.muted : styles.dangerText}>
                  {running ? "清理中…" : "清理"}
                </Text>
              </Pressable>
            ) : (
              <Text style={styles.muted}>无需清理</Text>
            )}
          </View>
        </>
      ) : null}

      {confirming ? (
        <ConfirmRow
          styles={styles}
          label={`确认删除 ${formatCount(agent.staleSessionCount)} 个过期会话（预计释放约 ${formatBytes(
            agent.staleSessionBytes,
          )}）？删除后不可恢复。`}
          busy={busy}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      ) : null}
      {notice ? <Text style={styles.noticeText}>{notice}</Text> : null}
    </View>
  );
}

function ConfirmRow({
  label,
  busy,
  styles,
  onCancel,
  onConfirm,
}: {
  label: string;
  busy: boolean;
  styles: DiskUsageStyles;
  onCancel(): void;
  onConfirm(): void;
}) {
  return (
    <View style={styles.confirmBox}>
      <Text style={styles.confirmText}>{label}</Text>
      <View style={styles.confirmActions}>
        <Pressable onPress={onCancel} hitSlop={8} disabled={busy}>
          <Text style={styles.muted}>取消</Text>
        </Pressable>
        <Pressable onPress={onConfirm} hitSlop={8} disabled={busy}>
          <Text style={styles.dangerText}>{busy ? "清理中…" : "确认删除"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function summarize(results: TokenUsageCleanupResult[]): string {
  const removed = results.reduce((sum, result) => sum + result.removedSessions, 0);
  const freed = results.reduce((sum, result) => sum + result.freedBytes, 0);
  const failed = results.filter((result) => result.status === "error");
  if (removed === 0 && failed.length === 0) {
    return "没有可清理的过期会话。";
  }
  const parts = [`已删除 ${formatCount(removed)} 个会话，释放约 ${formatBytes(freed)}`];
  const withError = results.find((result) => result.error);
  if (withError?.error) {
    parts.push(withError.error);
  }
  if (failed.length > 0) {
    parts.push(`${failed.length} 个 agent 清理失败`);
  }
  return parts.join("；");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type DiskUsageStyles = ReturnType<typeof useStyles>;

function useStyles(theme: Theme) {
  return {
    card: {
      backgroundColor: theme.colors.surface1,
      borderColor: theme.colors.border,
      borderWidth: 1,
      borderRadius: 8,
      padding: 12,
      gap: 10,
    },
    headerRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      gap: 8,
    },
    headerLeft: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      flexShrink: 1,
    },
    headerActions: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 12,
    },
    title: {
      color: theme.colors.foreground,
      fontSize: 14,
      fontWeight: "600" as const,
    },
    name: {
      color: theme.colors.foreground,
      fontSize: 14,
      fontWeight: "600" as const,
    },
    muted: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
    },
    staleText: {
      color: theme.colors.statusWarning,
      fontSize: 12,
    },
    statusBadge: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
    },
    actionText: {
      color: theme.colors.accent,
      fontSize: 12,
    },
    dangerText: {
      color: theme.colors.statusDanger,
      fontSize: 12,
      fontWeight: "600" as const,
    },
    bytes: {
      color: theme.colors.foreground,
      fontSize: 14,
      fontWeight: "600" as const,
    },
    noticeText: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
    },
    row: {
      borderTopColor: theme.colors.border,
      borderTopWidth: 1,
      paddingTop: 10,
      gap: 4,
    },
    rowHeader: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      gap: 8,
    },
    rowActions: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      gap: 8,
    },
    confirmBox: {
      backgroundColor: theme.colors.surface2,
      borderRadius: 6,
      padding: 8,
      gap: 6,
    },
    confirmText: {
      color: theme.colors.foreground,
      fontSize: 12,
    },
    confirmActions: {
      flexDirection: "row" as const,
      justifyContent: "flex-end" as const,
      gap: 16,
    },
  };
}
