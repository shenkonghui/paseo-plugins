import { useMemo } from "react";
import { Switch, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { formatCount, formatTokensDetailed, formatUsd } from "./format";
import type { AgentWindow } from "./rollup";
import type { TokenUsageAgent } from "../shared/rpc";

type Theme = PluginSurfaceProps["theme"];

interface AgentSummaryProps {
  agent: TokenUsageAgent;
  window: AgentWindow;
  theme: Theme;
  /** 该 agent 是否开启采集。 */
  enabled: boolean;
  onToggle(enabled: boolean): void;
}

export function AgentSummary({ agent, window, theme, enabled, onToggle }: AgentSummaryProps) {
  const styles = useMemo(() => useStyles(theme), [theme]);
  const totals = window.totals;
  return (
    <View style={[styles.card, enabled ? null : styles.cardPaused]}>
      <View style={styles.headerRow}>
        <View style={styles.headerLeft}>
          <Text style={styles.name}>{agent.displayName}</Text>
          {agent.status === "disabled" ? (
            <Text style={styles.pausedBadge}>已暂停采集</Text>
          ) : agent.status !== "available" ? (
            <Text style={styles.statusBadge}>不可用</Text>
          ) : null}
        </View>
        <Switch
          value={enabled}
          onValueChange={onToggle}
          accessibilityLabel={`${agent.displayName} 采集开关`}
        />
      </View>
      {agent.status !== "available" && agent.status !== "disabled" && agent.error ? (
        <Text style={styles.error}>{agent.error}</Text>
      ) : null}
      <View style={styles.metricsRow}>
        <Metric styles={styles} label="总 tokens" value={formatTokensDetailed(totals.totalTokens)} />
        <Metric styles={styles} label="请求" value={formatCount(totals.requests)} />
        <Metric styles={styles} label="会话" value={formatCount(window.sessions)} />
      </View>
      <View style={styles.metricsRow}>
        <Metric styles={styles} label="输入" value={formatTokensDetailed(totals.inputTokens)} />
        <Metric styles={styles} label="输出" value={formatTokensDetailed(totals.outputTokens)} />
        {totals.cacheReadTokens !== null ? (
          <Metric styles={styles} label="缓存读" value={formatTokensDetailed(totals.cacheReadTokens)} />
        ) : null}
        {totals.cacheWriteTokens !== null ? (
          <Metric styles={styles} label="缓存写" value={formatTokensDetailed(totals.cacheWriteTokens)} />
        ) : null}
        {totals.reasoningTokens !== null ? (
          <Metric styles={styles} label="思考" value={formatTokensDetailed(totals.reasoningTokens)} />
        ) : null}
        {totals.costUsd !== null ? (
          <Metric styles={styles} label="成本" value={formatUsd(totals.costUsd)} />
        ) : null}
        {totals.costCredits !== null ? (
          <Metric styles={styles} label="积分" value={formatCount(totals.costCredits)} />
        ) : null}
      </View>
    </View>
  );
}

type AgentSummaryStyles = ReturnType<typeof useStyles>;

function Metric({
  label,
  value,
  styles,
}: {
  label: string;
  value: string;
  styles: AgentSummaryStyles;
}) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricValue}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

function useStyles(theme: Theme) {
  return {
    card: {
      backgroundColor: theme.colors.surface1,
      borderColor: theme.colors.border,
      borderWidth: 1,
      borderRadius: 8,
      padding: 12,
      gap: 8,
    },
    cardPaused: {
      opacity: 0.6,
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
    pausedBadge: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
    },
    name: {
      color: theme.colors.foreground,
      fontSize: 14,
      fontWeight: "600" as const,
    },
    statusBadge: {
      color: theme.colors.statusWarning,
      fontSize: 12,
    },
    error: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
    },
    metricsRow: {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      gap: 12,
    },
    metric: {
      minWidth: 64,
    },
    metricValue: {
      color: theme.colors.foreground,
      fontSize: 14,
      fontWeight: "500" as const,
    },
    metricLabel: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
    },
  };
}
