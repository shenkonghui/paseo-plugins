import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
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
 * 点「清理」时定格的清理目标：确认步骤要显示打开那一刻的数字，
 * 不能因为快照刷新而跳变。
 */
interface CleanupTarget {
  scope: CleanupScope;
  /** 指定 agent 时透传给清理 RPC；「全部」为 undefined。 */
  agentId?: TokenUsageAgentId;
  headline: string;
  detail: string;
}

/**
 * 面板底部的入口行：磁盘占用默认不采集也不展示，点开才在弹窗里统计 + 清理，
 * 避免每次打开面板都去遍历 GB 级的数据目录。
 */
export function DiskUsageEntry({ theme }: { theme: Theme }) {
  const styles = useMemo(() => useStyles(theme), [theme]);
  const [open, setOpen] = useState(false);

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="查看本地磁盘占用并清理旧会话"
        onPress={() => setOpen(true)}
        style={styles.entryCard}
      >
        <View style={styles.entryLeft}>
          <Icon name="HardDrive" size={16} color={theme.colors.foregroundMuted} />
          <View style={styles.entryText}>
            <Text style={styles.title}>本地磁盘占用</Text>
            <Text style={styles.muted}>查看各 agent 数据目录占用，清理 {STALE_DAYS} 天前的旧会话</Text>
          </View>
        </View>
        <Text style={styles.actionText}>查看</Text>
      </Pressable>

      <DiskUsageModal theme={theme} open={open} onOpenChange={setOpen} />
    </>
  );
}

/**
 * 磁盘占用弹窗：先列出各 agent 的占用，再按需进入「确认清理」步骤。
 * 占用在弹窗打开时才统计（宿主的磁盘快照还有 60 秒缓存）。
 */
function DiskUsageModal({
  open,
  theme,
  onOpenChange,
}: {
  open: boolean;
  theme: Theme;
  onOpenChange(open: boolean): void;
}) {
  const styles = useMemo(() => useStyles(theme), [theme]);
  const fetchDisk = useRpc(tokenUsageDiskRpc);
  const runCleanup = useRpc(tokenUsageCleanupRpc);

  const [snapshot, setSnapshot] = useState<DiskSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<"list" | "confirm">("list");
  const [target, setTarget] = useState<CleanupTarget | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notices, setNotices] = useState<Record<string, string>>({});

  const load = useCallback(
    (forceRefresh: boolean) => {
      setLoading(true);
      setError(null);
      fetchDisk({ forceRefresh, olderThanDays: STALE_DAYS })
        .then((result) => {
          setSnapshot(result);
          setLoading(false);
        })
        .catch((cause: unknown) => {
          setError(messageOf(cause));
          setLoading(false);
        });
    },
    [fetchDisk],
  );

  // 每次打开都回到列表步骤，并用宿主缓存取一次最新占用。
  useEffect(() => {
    if (!open) {
      return;
    }
    setStep("list");
    setTarget(null);
    setFailure(null);
    setNotices({});
    load(false);
  }, [open, load]);

  const askCleanup = useCallback((next: CleanupTarget) => {
    setTarget(next);
    setFailure(null);
    setStep("confirm");
  }, []);

  const handleConfirm = useCallback(async () => {
    if (!target || submitting) {
      return;
    }
    setSubmitting(true);
    setFailure(null);
    try {
      const output = await runCleanup(
        target.agentId
          ? { olderThanDays: STALE_DAYS, agentIds: [target.agentId] }
          : { olderThanDays: STALE_DAYS },
      );
      setSnapshot({ ...output.disk, stale: false });
      setNotices((current) => ({ ...current, [target.scope]: summarize(output.results) }));
      setStep("list");
      setTarget(null);
    } catch (cause: unknown) {
      // 失败就留在确认步骤，把原因写在弹窗里，可直接重试。
      setFailure(messageOf(cause));
    } finally {
      setSubmitting(false);
    }
  }, [target, submitting, runCleanup]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      // 清理进行中不让遮罩 / Esc / 返回键把它关掉。
      if (!next && submitting) {
        return;
      }
      if (!next) {
        setStep("list");
      }
      onOpenChange(next);
    },
    [onOpenChange, submitting],
  );

  const staleDays = snapshot?.staleDays || STALE_DAYS;
  const staleSessions =
    snapshot?.agents.reduce((sum, agent) => sum + agent.staleSessionCount, 0) ?? 0;
  const staleTotal = snapshot?.agents.reduce((sum, agent) => sum + agent.staleSessionBytes, 0) ?? 0;

  return (
    <Modal
      title="本地磁盘占用"
      icon={<Icon name="HardDrive" size={18} color={theme.colors.foregroundMuted} />}
      open={open}
      onOpenChange={handleOpenChange}
    >
      <Modal.Content>
        {step === "confirm" && target ? (
          <>
            <Text style={styles.modalHeadline}>{target.headline}</Text>
            <Text style={styles.modalHint}>
              {target.detail}只删除 {staleDays}{" "}
              天前且之后没有新活动的会话，删除后不可恢复；正在进行的会话不受影响。
            </Text>
            {failure ? <Text style={styles.modalError}>清理失败：{failure}</Text> : null}
            <View style={styles.modalActions}>
              <Pressable
                accessibilityRole="button"
                onPress={() => setStep("list")}
                disabled={submitting}
                style={styles.actionButtonSecondary}
              >
                <Text style={styles.actionButtonSecondaryText}>取消</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="确认删除过期会话"
                onPress={handleConfirm}
                disabled={submitting}
                style={styles.actionButtonDanger}
              >
                <Text style={styles.actionButtonDangerText}>
                  {submitting ? "清理中…" : "确认删除"}
                </Text>
              </Pressable>
            </View>
          </>
        ) : (
          <>
            <Text style={styles.muted}>
              占用为该 agent 数据目录的递归大小；「可清理」指 {staleDays} 天前、之后无活动的会话。
            </Text>
            <View style={styles.modalActionRow}>
              <Pressable onPress={() => load(true)} hitSlop={8} disabled={loading}>
                <Text style={styles.actionText}>{loading ? "统计中…" : "重新统计"}</Text>
              </Pressable>
              {staleSessions > 0 ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="清理全部 agent 的过期会话"
                  onPress={() =>
                    askCleanup({
                      scope: "all",
                      headline: `确认删除全部 agent 的 ${formatCount(staleSessions)} 个过期会话？`,
                      detail: `预计释放约 ${formatBytes(staleTotal)}。`,
                    })
                  }
                  hitSlop={8}
                >
                  <Text style={styles.dangerText}>
                    全部清理（{formatCount(staleSessions)} 个 · 约 {formatBytes(staleTotal)}）
                  </Text>
                </Pressable>
              ) : null}
            </View>

            {error ? <Text style={styles.modalError}>{error}</Text> : null}
            {snapshot?.stale ? <Text style={styles.staleText}>占用为缓存结果</Text> : null}
            {notices.all ? <Text style={styles.noticeText}>{notices.all}</Text> : null}

            {snapshot?.agents.map((agent) => (
              <AgentDiskRow
                key={agent.agentId}
                agent={agent}
                staleDays={staleDays}
                styles={styles}
                notice={notices[agent.agentId]}
                onAsk={() =>
                  askCleanup({
                    scope: agent.agentId,
                    agentId: agent.agentId,
                    headline: `确认删除 ${agent.displayName} 的 ${formatCount(
                      agent.staleSessionCount,
                    )} 个过期会话？`,
                    detail: `预计释放约 ${formatBytes(agent.staleSessionBytes)}。`,
                  })
                }
              />
            ))}

            {!snapshot && loading ? <Text style={styles.muted}>正在统计各 agent 的本地占用…</Text> : null}
          </>
        )}
      </Modal.Content>
    </Modal>
  );
}

interface AgentDiskRowProps {
  agent: TokenUsageDiskAgent;
  staleDays: number;
  styles: DiskUsageStyles;
  notice: string | undefined;
  onAsk(): void;
}

function AgentDiskRow({ agent, staleDays, styles, notice, onAsk }: AgentDiskRowProps) {
  return (
    <View style={styles.row}>
      <View style={styles.rowHeader}>
        <View style={styles.headerLeft}>
          <Text style={styles.name}>{agent.displayName}</Text>
          {agent.status !== "available" ? (
            <Text style={styles.statusBadge}>
              {agent.status === "unavailable" ? "未安装" : "读取失败"}
            </Text>
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
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`清理 ${agent.displayName} 的过期会话`}
                onPress={onAsk}
                hitSlop={8}
              >
                <Text style={styles.dangerText}>清理</Text>
              </Pressable>
            ) : (
              <Text style={styles.muted}>无需清理</Text>
            )}
          </View>
        </>
      ) : null}

      {notice ? <Text style={styles.noticeText}>{notice}</Text> : null}
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
    entryCard: {
      backgroundColor: theme.colors.surface1,
      borderColor: theme.colors.border,
      borderWidth: 1,
      borderRadius: 8,
      padding: 12,
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      gap: 12,
    },
    entryLeft: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 10,
      flexShrink: 1,
    },
    entryText: {
      gap: 2,
      flexShrink: 1,
    },
    modalActionRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      gap: 12,
    },
    headerLeft: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      flexShrink: 1,
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
    modalHeadline: {
      color: theme.colors.foreground,
      fontSize: 15,
      fontWeight: "600" as const,
    },
    modalHint: {
      color: theme.colors.foregroundMuted,
      fontSize: 13,
      lineHeight: 19,
    },
    modalError: {
      color: theme.colors.statusDanger,
      fontSize: 13,
    },
    modalActions: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "flex-end" as const,
      gap: 12,
      marginTop: 4,
    },
    actionButtonSecondary: {
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 7,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface2,
    },
    actionButtonSecondaryText: {
      color: theme.colors.foreground,
      fontSize: 13,
      fontWeight: "600" as const,
    },
    actionButtonDanger: {
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 7,
      borderWidth: 1,
      borderColor: theme.colors.statusDanger,
    },
    actionButtonDangerText: {
      color: theme.colors.statusDanger,
      fontSize: 13,
      fontWeight: "600" as const,
    },
  };
}
