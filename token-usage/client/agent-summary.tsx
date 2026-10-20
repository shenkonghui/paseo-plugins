import { useMemo } from "react";
import { Switch, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { formatCount, formatShortDateTime, formatTokensDetailed, formatUsd, issueKindLabel } from "./format";
import type { AgentWindow } from "./rollup";
import type { TokenUsageAgent, TokenUsageIssue } from "../shared/rpc";

type Theme = PluginSurfaceProps["theme"];

/** 一张卡片最多展开几条失败事件，其余折叠成一行计数。 */
const MAX_VISIBLE_ISSUES = 3;

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
  const issues = agent.issues ?? [];
  const visibleIssues = issues.slice(0, MAX_VISIBLE_ISSUES);
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
      {visibleIssues.length > 0 ? (
        <View style={styles.issues}>
          {visibleIssues.map((issue) => (
            <IssueRow key={issueKey(issue)} issue={issue} styles={styles} />
          ))}
          {issues.length > visibleIssues.length ? (
            <Text style={styles.issueMore}>
              另有 {issues.length - visibleIssues.length} 类失败事件
            </Text>
          ) : null}
        </View>
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

/** 一条失败事件：标题是归类 + 状态码 + 次数 + 重置时间，下面保留原文。 */
function IssueRow({
  issue,
  styles,
}: {
  issue: TokenUsageIssue;
  styles: AgentSummaryStyles;
}) {
  const facets = [
    issue.httpStatus === null ? null : `HTTP ${issue.httpStatus}`,
    issue.code === null ? null : `code ${issue.code}`,
    issue.count > 1 ? `${issue.count} 次` : null,
  ].filter((facet): facet is string => facet !== null);
  return (
    <View style={styles.issueRow}>
      <Text style={styles.issueTitle}>
        {issueKindLabel(issue.kind)}
        {facets.length > 0 ? ` · ${facets.join(" · ")}` : ""}
      </Text>
      {issue.resetAt !== null ? (
        <Text style={styles.issueReset}>{formatShortDateTime(issue.resetAt)} 重置</Text>
      ) : null}
      {issue.lastAt ? (
        <Text style={styles.issueMeta}>最近一次 {formatShortDateTime(issue.lastAt)}</Text>
      ) : null}
      <Text style={styles.issueMessage} numberOfLines={2}>
        {issue.message}
      </Text>
    </View>
  );
}

function issueKey(issue: TokenUsageIssue): string {
  return [issue.kind, issue.code, issue.httpStatus, issue.resetAt, issue.firstAt].join("|");
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
    issues: {
      backgroundColor: theme.colors.surface2,
      borderRadius: 6,
      padding: 8,
      gap: 6,
    },
    issueRow: {
      gap: 2,
    },
    issueTitle: {
      color: theme.colors.statusDanger,
      fontSize: 12,
      fontWeight: "600" as const,
    },
    issueReset: {
      color: theme.colors.statusWarning,
      fontSize: 12,
    },
    issueMeta: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
    },
    issueMessage: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
    },
    issueMore: {
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
