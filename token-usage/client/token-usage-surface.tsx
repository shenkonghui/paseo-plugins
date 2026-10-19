import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  useRpc,
  useSettings,
  type PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import { AgentSummary } from "./agent-summary";
import { DiskUsageEntry } from "./disk-usage";
import { TokenBarChart } from "./bar-chart";
import { formatCount, formatTokensDetailed, formatUsd } from "./format";
import { combineAgentWindows } from "./rollup";
import { TOKEN_USAGE_WINDOW_OPTIONS, type TokenUsageWindowDays } from "./types";
import { agentCollectionSettings } from "../shared/settings";
import { tokenUsageListRpc, type TokenUsageListOutput } from "../shared/rpc";

type Theme = PluginSurfaceProps["theme"];

export function TokenUsageSurface(props: PluginSurfaceProps) {
  const { theme } = props;
  const styles = useMemo(() => useStyles(theme), [theme]);
  const listUsage = useRpc(tokenUsageListRpc);
  // 默认展示当天用量（切换器仍可切到近 7 / 30 天）。
  const [windowDays, setWindowDays] = useState<TokenUsageWindowDays>(1);
  const agentSettings = useSettings(agentCollectionSettings);
  const disabledAgents = useMemo(
    () => new Set(agentSettings.status === "ready" ? agentSettings.values.disabled : []),
    [agentSettings],
  );

  const [payload, setPayload] = useState<TokenUsageListOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Recomputing on payload identity keeps a fetched snapshot stable across re-renders.
  const nowMs = useMemo(() => Date.now(), [payload]);

  const requestSeq = useRef(0);

  const fetchPayload = useCallback(
    (forceRefresh: boolean) => {
      const seq = ++requestSeq.current;
      setLoading(true);
      setError(null);
      listUsage({ forceRefresh, windowDays })
        .then((result) => {
          // 切换窗口时旧请求可能后到，丢弃它。
          if (seq !== requestSeq.current) {
            return;
          }
          setPayload(result);
          setLoading(false);
        })
        .catch((failure: unknown) => {
          if (seq !== requestSeq.current) {
            return;
          }
          setError(failure instanceof Error ? failure.message : String(failure));
          setLoading(false);
        });
    },
    [listUsage, windowDays],
  );

  const handleRetry = useCallback(() => {
    fetchPayload(false);
  }, [fetchPayload]);

  const handleRefresh = useCallback(() => {
    fetchPayload(true);
  }, [fetchPayload]);

  useEffect(() => {
    fetchPayload(false);
  }, [fetchPayload]);

  const combined = useMemo(
    () => (payload ? combineAgentWindows(payload.agents, windowDays, nowMs) : null),
    [payload, windowDays, nowMs],
  );

  // 「今天」按小时画（0 点 → 当前小时），其它窗口按天。
  const chartDays = useMemo(() => {
    if (!combined) {
      return [];
    }
    if (windowDays === 1) {
      const currentHour = new Date(nowMs).getHours();
      return combined.hours
        .filter((entry) => entry.hour <= currentHour)
        .map((entry) => ({
          date: `${`${entry.hour}`.padStart(2, "0")}:00`,
          totalTokens: entry.counters.totalTokens,
        }));
    }
    return combined.days.map((day) => ({ date: day.date, totalTokens: day.counters.totalTokens }));
  }, [combined, windowDays, nowMs]);

  const handleSelectWindow = useCallback((days: TokenUsageWindowDays) => {
    setWindowDays(days);
  }, []);

  // 开关写入宿主侧设置；关闭的 agent 服务端会跳过采集（仍返回占位条目）。
  const handleToggleAgent = useCallback(
    (agentId: TokenUsageListOutput["agents"][number]["agentId"], enabled: boolean) => {
      if (agentSettings.status !== "ready") {
        return;
      }
      const current = agentSettings.values.disabled;
      const next = enabled
        ? current.filter((id) => id !== agentId)
        : [...current.filter((id) => id !== agentId), agentId];
      void agentSettings.save({ disabled: next }, agentSettings.revision).then((ok) => {
        // 开关变化会改变缓存 key：重新取一次（新 key 没缓存就当场采集）。
        if (ok) {
          fetchPayload(false);
        }
      });
    },
    [agentSettings, fetchPayload],
  );

  if (loading && !payload) {
    return (
      <View style={styles.screen}>
        <View style={styles.centered}>
          <Text style={styles.muted}>正在读取 token 用量…</Text>
        </View>
      </View>
    );
  }

  if (error && !payload) {
    return (
      <View style={styles.screen}>
        <View style={styles.centered}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable onPress={handleRetry} style={styles.retryButton}>
            <Text style={styles.retryText}>重试</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (!payload || !combined) {
    return (
      <View style={styles.screen}>
        <View style={styles.centered}>
          <Text style={styles.muted}>暂无数据</Text>
        </View>
      </View>
    );
  }

  const totals = combined.totals;
  const availableAgents = combined.agents.filter((entry) => entry.agent.status === "available");

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.body}>
        <View style={styles.toolbar}>
          <View style={styles.windowSwitch}>
            {TOKEN_USAGE_WINDOW_OPTIONS.map((days) => (
              <WindowOption
                key={days}
                days={days}
                active={windowDays === days}
                onSelect={handleSelectWindow}
                styles={styles}
              />
            ))}
          </View>
          <View style={styles.refreshGroup}>
            {payload.stale ? <Text style={styles.staleText}>缓存已过期</Text> : null}
            <Text style={styles.fetchedAtText}>更新于 {formatFetchedAt(payload.fetchedAt)}</Text>
            <Pressable onPress={handleRefresh} hitSlop={8}>
              <Text style={styles.refreshText}>{loading ? "刷新中…" : "刷新"}</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.totalsCard}>
          <View style={styles.metricsRow}>
            <Metric styles={styles} label="总 tokens" value={formatTokensDetailed(totals.totalTokens)} />
            <Metric styles={styles} label="请求" value={formatCount(totals.requests)} />
            <Metric
              styles={styles}
              label="会话"
              value={formatCount(
                combined.agents.reduce((sum, entry) => sum + entry.window.sessions, 0),
              )}
            />
            {totals.costUsd !== null ? (
              <Metric styles={styles} label="成本" value={formatUsd(totals.costUsd)} />
            ) : null}
            {totals.costCredits !== null ? (
              <Metric styles={styles} label="积分" value={formatCount(totals.costCredits)} />
            ) : null}
          </View>
        </View>

        {availableAgents.length > 0 ? (
          <View style={styles.card}>
            <Text style={styles.muted}>{windowDays === 1 ? "今天 · 按小时" : "按天"}</Text>
            <TokenBarChart days={chartDays} theme={theme} />
          </View>
        ) : null}

        {combined.agents.map(({ agent, window }) => (
          <AgentSummary
            key={agent.agentId}
            agent={agent}
            window={window}
            theme={theme}
            enabled={!disabledAgents.has(agent.agentId)}
            onToggle={(enabled) => handleToggleAgent(agent.agentId, enabled)}
          />
        ))}

        <DiskUsageEntry theme={theme} />
      </ScrollView>
    </View>
  );
}

interface TokenUsageStyles {
  screen: object;
  centered: object;
  body: object;
  muted: object;
  errorText: object;
  retryButton: object;
  retryText: object;
  refreshGroup: object;
  staleText: object;
  fetchedAtText: object;
  refreshText: object;
  toolbar: object;
  windowSwitch: object;
  windowOption: object;
  windowOptionActive: object;
  windowText: object;
  windowTextActive: object;
  totalsCard: object;
  headerRow: object;
  name: object;
  statusBadge: object;
  card: object;
  metricsRow: object;
  metric: object;
  metricValue: object;
  metricLabel: object;
}

function formatFetchedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const hh = `${date.getHours()}`.padStart(2, "0");
  const mm = `${date.getMinutes()}`.padStart(2, "0");
  return `${date.getMonth() + 1}/${date.getDate()} ${hh}:${mm}`;
}

interface WindowOptionProps {
  days: TokenUsageWindowDays;
  active: boolean;
  onSelect(days: TokenUsageWindowDays): void;
  styles: TokenUsageStyles;
}

function WindowOption({ days, active, onSelect, styles }: WindowOptionProps) {
  const handlePress = useCallback(() => {
    onSelect(days);
  }, [days, onSelect]);
  return (
    <Pressable
      onPress={handlePress}
      style={[styles.windowOption, active ? styles.windowOptionActive : null]}
    >
      <Text style={[styles.windowText, active ? styles.windowTextActive : null]}>
        {days === 1 ? "今天" : `近 ${days} 天`}
      </Text>
    </Pressable>
  );
}

function Metric({
  label,
  value,
  styles,
}: {
  label: string;
  value: string;
  styles: TokenUsageStyles;
}) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricValue}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

function useStyles(theme: Theme): TokenUsageStyles {
  return {
    screen: {
      flex: 1,
      backgroundColor: theme.colors.surface0,
    },
    centered: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      padding: 20,
    },
    body: {
      padding: 16,
      gap: 12,
    },
    muted: {
      color: theme.colors.foregroundMuted,
      fontSize: 14,
    },
    errorText: {
      color: theme.colors.foregroundMuted,
      fontSize: 14,
      textAlign: "center",
    },
    retryButton: {
      marginTop: 8,
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderRadius: 8,
      backgroundColor: theme.colors.surface2,
    },
    retryText: {
      color: theme.colors.foreground,
      fontSize: 14,
    },
    refreshGroup: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    staleText: {
      color: theme.colors.statusWarning,
      fontSize: 12,
    },
    fetchedAtText: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
    },
    refreshText: {
      color: theme.colors.accent,
      fontSize: 14,
    },
    toolbar: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    windowSwitch: {
      flexDirection: "row",
      backgroundColor: theme.colors.surface2,
      borderRadius: 8,
      padding: 2,
      gap: 2,
    },
    windowOption: {
      paddingHorizontal: 12,
      paddingVertical: 4,
      borderRadius: 6,
    },
    windowOptionActive: {
      backgroundColor: theme.colors.surface0,
    },
    windowText: {
      color: theme.colors.foregroundMuted,
      fontSize: 13,
    },
    windowTextActive: {
      color: theme.colors.foreground,
      fontWeight: "600",
    },
    totalsCard: {
      backgroundColor: theme.colors.surface1,
      borderColor: theme.colors.border,
      borderWidth: 1,
      borderRadius: 8,
      padding: 12,
    },
    headerRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    name: {
      color: theme.colors.foreground,
      fontSize: 14,
      fontWeight: "600",
    },
    statusBadge: {
      color: theme.colors.statusWarning,
      fontSize: 12,
    },
    card: {
      backgroundColor: theme.colors.surface1,
      borderColor: theme.colors.border,
      borderWidth: 1,
      borderRadius: 8,
      padding: 12,
    },
    metricsRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 16,
    },
    metric: {
      minWidth: 72,
    },
    metricValue: {
      color: theme.colors.foreground,
      fontSize: 14,
      fontWeight: "600",
    },
    metricLabel: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
    },
  };
}
