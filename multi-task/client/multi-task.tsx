import type { PaseoAgent, PaseoWorkspace } from "@getpaseo/client";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { usePaseo, useSettings } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { buildAgentDeepLinkRoute } from "@getpaseo/protocol/agent-deep-link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  makeViewId,
  multiTaskSettings,
  type MultiTaskView,
  type MultiTaskViewMode,
} from "../shared/settings";
import { AgentPane, statusColor, type AgentPaneInfo } from "./agent-pane";
import { WorkspacePicker, workspaceLabel } from "./agent-picker";

type Theme = PluginScreenProps["theme"];
type Paseo = ReturnType<typeof usePaseo>;

interface DashboardData {
  workspaces: PaseoWorkspace[];
  agents: PaseoAgent[];
}

/** 一次性拉取 workspace / agent 列表，用于解析标题、状态与添加候选。 */
function useDashboardData(paseo: Paseo, nonce: number) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    Promise.all([
      paseo.workspaces.list({ page: { limit: 200 } }),
      paseo.agents.list({ page: { limit: 200 } }),
    ])
      .then(([workspaces, agents]) => {
        if (cancelled) return;
        setData({
          workspaces: workspaces.entries,
          agents: agents.entries.map((entry) => entry.agent),
        });
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [paseo, nonce]);

  return { data, error };
}

function useStyles(theme: Theme, compact: boolean) {
  return useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      centered: {
        flex: 1,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        gap: 12,
        padding: 24,
      },
      muted: { color: theme.colors.foregroundMuted, textAlign: "center" as const },
      error: { color: theme.colors.statusDanger, textAlign: "center" as const },
      toolbar: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingHorizontal: compact ? 12 : 20,
        paddingTop: compact ? 12 : 20,
        paddingBottom: 10,
      },
      toolbarTitle: {
        color: theme.colors.foreground,
        fontSize: 14,
        fontWeight: "600" as const,
      },
      toolbarMeta: { color: theme.colors.foregroundMuted, fontSize: 12 },
      spacer: { flex: 1 },
      ghostButton: {
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        paddingHorizontal: 10,
        paddingVertical: 6,
      },
      ghostButtonText: { color: theme.colors.foreground, fontSize: 13 },
      primaryButton: {
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 7,
        backgroundColor: theme.colors.accent,
      },
      primaryButtonText: {
        color: theme.colors.accentForeground,
        fontSize: 13,
        fontWeight: "600" as const,
      },
      panesOuter: {
        flex: 1,
        paddingHorizontal: compact ? 12 : 20,
        paddingBottom: 12,
      },
      panesWrap: { flex: 1 },
      panesScroll: { flex: 1 },
      row: { flexDirection: "row" as const, justifyContent: "center" as const },
      hiddenList: { gap: 6, paddingTop: 8 },
      hiddenRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
        paddingHorizontal: 10,
        paddingVertical: 6,
      },
      hiddenRowActive: { borderColor: theme.colors.accent },
      hiddenDot: { width: 8, height: 8, borderRadius: 4 },
      hiddenTitle: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
      hiddenMeta: { color: theme.colors.foregroundMuted, fontSize: 12, flexShrink: 1 },
      hiddenSpacer: { flex: 1 },
      hiddenExpand: { color: theme.colors.accent, fontSize: 12 },
    }),
    [theme, compact],
  );
}

interface TileGrid {
  cols: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  contentHeight: number;
}

/**
 * 按任务数量把可用区域平铺成网格：
 * - 列数限制在「单元格不窄于 minCellWidth」的范围内，并选最接近正方形的方案；
 * - 高度不够时保底 minCellHeight，整体超出可用高度时改为纵向滚动。
 */
function computeTileGrid(
  count: number,
  width: number,
  height: number,
  minCellWidth: number,
  minCellHeight: number,
  gap: number,
): TileGrid | null {
  if (count <= 0 || width <= 0 || height <= 0) return null;
  const maxCols = Math.max(1, Math.min(count, Math.floor((width + gap) / (minCellWidth + gap))));
  let cols = 1;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let candidate = 1; candidate <= maxCols; candidate++) {
    const rows = Math.ceil(count / candidate);
    const ratio = width / candidate / (height / rows);
    const empty = candidate * rows - count;
    // 越接近 1:1 越好；空位给一点惩罚，尽量铺满行。
    const score = Math.abs(Math.log(ratio)) + empty * 0.12;
    if (score < bestScore) {
      bestScore = score;
      cols = candidate;
    }
  }
  const rows = Math.ceil(count / cols);
  const cellWidth = (width - gap * (cols - 1)) / cols;
  const naturalCellHeight = (height - gap * (rows - 1)) / rows;
  const cellHeight = Math.max(naturalCellHeight, minCellHeight);
  const contentHeight = cellHeight * rows + gap * (rows - 1);
  return { cols, rows, cellWidth, cellHeight, contentHeight };
}

/** agent 的最近活跃时间，用来在一个 workspace 里挑「当前」的 agent。 */
function agentActivityTime(agent: PaseoAgent): number {
  const raw = agent.lastUserMessageAt ?? agent.updatedAt;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function MultiTaskScreen({ theme, layout, host, navigation }: PluginScreenProps) {
  const paseo = usePaseo();
  const toast = useToast();
  const settings = useSettings(multiTaskSettings);
  const [nonce, setNonce] = useState(0);
  const [picking, setPicking] = useState(false);
  // 当前焦点面板（点击 / 键盘聚焦时更新），用于高亮。
  const [activeViewId, setActiveViewId] = useState<string | null>(null);

  // 能否内嵌只看有没有 DOM（浏览器 / Electron 桌面 App 都有），不依赖布局上报的 platform。
  const canEmbed = useMemo(() => {
    const doc = (globalThis as { document?: { createElement?: unknown } }).document;
    return typeof doc?.createElement === "function";
  }, []);
  const [paneArea, setPaneArea] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });
  const { data, error } = useDashboardData(paseo, nonce);
  const styles = useStyles(theme, layout.compact);

  const views = settings.status === "ready" ? settings.values.views : [];
  const revision = settings.status === "ready" ? settings.revision : null;

  // 隐藏的面板不占格子：展开的铺满主区域，隐藏的在底部收成整行标题条。
  const expandedViews = useMemo(() => views.filter((view) => !view.collapsed), [views]);
  const collapsedViews = useMemo(() => views.filter((view) => view.collapsed), [views]);


  // 每个 workspace 下未归档的 agent，用于把「workspace 面板」解析到当前活跃的 agent。
  const agentsByWorkspace = useMemo(() => {
    const map = new Map<string, PaseoAgent[]>();
    for (const agent of data?.agents ?? []) {
      if (agent.archivedAt != null || !agent.workspaceId) continue;
      const list = map.get(agent.workspaceId);
      if (list) list.push(agent);
      else map.set(agent.workspaceId, [agent]);
    }
    return map;
  }, [data]);

  const workspaceLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const workspace of data?.workspaces ?? []) map.set(workspace.id, workspaceLabel(workspace));
    return map;
  }, [data]);

  const agentForWorkspace = useCallback(
    (workspaceId: string): PaseoAgent | null => {
      const list = agentsByWorkspace.get(workspaceId);
      if (!list || list.length === 0) return null;
      return [...list].sort((a, b) => agentActivityTime(b) - agentActivityTime(a))[0] ?? null;
    },
    [agentsByWorkspace],
  );

  const existingWorkspaceIds = useMemo(
    () => new Set(views.map((view) => view.workspaceId)),
    [views],
  );

  const persist = useCallback(
    async (next: typeof views) => {
      if (!revision) return;
      try {
        const ok = await settings.save({ views: next }, revision);
        if (!ok) toast.show("保存失败，请重试", { variant: "error" });
      } catch (cause) {
        toast.show(cause instanceof Error ? cause.message : String(cause), { variant: "error" });
      }
    },
    [settings, revision, toast],
  );

  const addView = useCallback(
    (workspaceId: string) => {
      if (existingWorkspaceIds.has(workspaceId)) {
        setPicking(false);
        return;
      }
      const id = makeViewId();
      void persist([
        ...views,
        {
          id,
          workspaceId,
          // 有 DOM 时默认内嵌原生会话；原生平台只能自绘。
          mode: canEmbed ? "embedded" : "stream",
          collapsed: false,
        },
      ]);
      setActiveViewId(id);
    },
    [existingWorkspaceIds, views, persist, canEmbed],
  );

  const removeView = useCallback(
    (viewId: string) => {
      void persist(views.filter((view) => view.id !== viewId));
      setActiveViewId((current) => (current === viewId ? null : current));
    },
    [views, persist],
  );

  const setViewMode = useCallback(
    (viewId: string, mode: MultiTaskViewMode) => {
      void persist(views.map((view) => (view.id === viewId ? { ...view, mode } : view)));
    },
    [views, persist],
  );

  const agentIdFor = useCallback(
    (view: MultiTaskView): string | null => agentForWorkspace(view.workspaceId)?.id ?? null,
    [agentForWorkspace],
  );

  // 用相对路由：iframe 会基于当前文档解析，避免自定义 scheme / 拿不到 origin 的问题。
  const embedSrcFor = useCallback(
    (view: MultiTaskView): string | null => {
      const agentId = agentIdFor(view);
      return canEmbed && agentId ? buildAgentDeepLinkRoute({ serverId: host.id, agentId }) : null;
    },
    [canEmbed, host.id, agentIdFor],
  );

  const resolveInfo = useCallback(
    (view: MultiTaskView): AgentPaneInfo => {
      const agent = agentForWorkspace(view.workspaceId);
      return {
        workspaceLabel: workspaceLabels.get(view.workspaceId) ?? null,
        agentTitle: agent?.title ?? null,
        agentStatus: agent?.status ?? null,
      };
    },
    [agentForWorkspace, workspaceLabels],
  );

  const gap = layout.compact ? 10 : 14;
  // 只按展开的面板铺网格——隐藏的不占空间，其余自动变大。
  const grid = useMemo(
    () =>
      computeTileGrid(
        expandedViews.length,
        paneArea.width,
        paneArea.height,
        layout.compact ? 180 : 240,
        layout.compact ? 200 : 220,
        gap,
      ),
    [expandedViews.length, paneArea.width, paneArea.height, layout.compact, gap],
  );

  const tileRows = useMemo(() => {
    if (!grid) return [];
    const rows: (typeof views)[] = [];
    for (let index = 0; index < expandedViews.length; index += grid.cols) {
      rows.push(expandedViews.slice(index, index + grid.cols));
    }
    return rows;
  }, [grid, expandedViews]);

  const setViewCollapsed = useCallback(
    (viewId: string, collapsed: boolean) => {
      void persist(
        views.map((view) => (view.id === viewId ? { ...view, collapsed } : view)),
      );
    },
    [views, persist],
  );

  // 拖动结束后按位移换算目标格（只数展开的面板），再映射回完整顺序持久化。
  const handleDrop = useCallback(
    (viewId: string, dx: number, dy: number) => {
      if (!grid) return;
      const originExpanded = expandedViews.findIndex((view) => view.id === viewId);
      if (originExpanded < 0) return;
      const cols = Math.max(1, grid.cols);
      const rows = Math.max(1, grid.rows);
      const clamp = (value: number, low: number, high: number) =>
        Math.min(high, Math.max(low, value));
      const nextCol = clamp(
        (originExpanded % cols) + Math.round(dx / Math.max(1, grid.cellWidth)),
        0,
        cols - 1,
      );
      const nextRow = clamp(
        Math.floor(originExpanded / cols) + Math.round(dy / Math.max(1, grid.cellHeight)),
        0,
        rows - 1,
      );
      const targetExpanded = clamp(nextRow * cols + nextCol, 0, expandedViews.length - 1);
      if (targetExpanded === originExpanded) return;
      const targetView = expandedViews[targetExpanded];
      if (!targetView) return;
      const origin = views.findIndex((view) => view.id === viewId);
      const target = views.findIndex((view) => view.id === targetView.id);
      if (origin < 0 || target < 0) return;
      const next = views.slice();
      const [moved] = next.splice(origin, 1);
      if (!moved) return;
      next.splice(target, 0, moved);
      void persist(next);
    },
    [grid, expandedViews, views, persist],
  );

  const retry = useCallback(() => setNonce((value) => value + 1), []);
  const openPicker = useCallback(() => setPicking(true), []);

  if (settings.status === "loading") {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>正在加载…</Text>
      </View>
    );
  }
  if (settings.status === "invalid") {
    return (
      <View style={styles.centered}>
        <Text style={styles.error}>面板配置无效：{settings.error}</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.toolbar}>
        <Text style={styles.toolbarTitle}>多任务</Text>
        <Text style={styles.toolbarMeta}>{views.length > 0 ? `${views.length} 个 workspace` : ""}</Text>
        <View style={styles.spacer} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="刷新 workspace 信息"
          onPress={retry}
          style={styles.ghostButton}
        >
          <Text style={styles.ghostButtonText}>刷新</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="添加 workspace"
          onPress={openPicker}
          style={styles.primaryButton}
        >
          <Text style={styles.primaryButtonText}>+ 添加 workspace</Text>
        </Pressable>
      </View>

      {error ? (
        <View style={styles.centered}>
          <Text style={styles.error}>{error}</Text>
          <Pressable accessibilityRole="button" onPress={retry}>
            <Text style={styles.muted}>重试</Text>
          </Pressable>
        </View>
      ) : views.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.muted}>
            {"还没有 workspace。点击右上角「+ 添加 workspace」，挑选 workspace 即可并排查看它们当前会话。"}
          </Text>
        </View>
      ) : (
        <View style={styles.panesOuter}>
          <View
            style={styles.panesWrap}
            onLayout={(event) =>
              setPaneArea({
                width: event.nativeEvent.layout.width,
                height: event.nativeEvent.layout.height,
              })
            }
          >
            {grid ? (
              <ScrollView style={styles.panesScroll} contentContainerStyle={{ gap }}>
                {tileRows.map((row, rowIndex) => (
                  <View key={rowIndex} style={[styles.row, { gap }]}>
                    {row.map((view) => (
                      <AgentPane
                        key={view.id}
                        view={view}
                        info={resolveInfo(view)}
                        agentId={agentIdFor(view)}
                        width={grid.cellWidth}
                        height={grid.cellHeight}
                        embedSrc={embedSrcFor(view)}
                        active={view.id === activeViewId}
                        theme={theme}
                        navigation={navigation}
                        onActivate={() => setActiveViewId(view.id)}
                        onToggleCollapse={() => setViewCollapsed(view.id, !view.collapsed)}
                        onDrop={(dx, dy) => handleDrop(view.id, dx, dy)}
                        onRemove={removeView}
                        onSetMode={(mode) => setViewMode(view.id, mode)}
                      />
                    ))}
                  </View>
                ))}
              </ScrollView>
            ) : (
              <View style={styles.centered}>
                <Text style={styles.muted}>全部面板已隐藏。</Text>
              </View>
            )}
          </View>
          {collapsedViews.length > 0 ? (
            <View style={styles.hiddenList}>
              {collapsedViews.map((view) => {
                const info = resolveInfo(view);
                return (
                  <Pressable
                    key={view.id}
                    accessibilityRole="button"
                    accessibilityLabel={`展开 ${info.workspaceLabel ?? view.workspaceId}`}
                    onPress={() => {
                      setActiveViewId(view.id);
                      setViewCollapsed(view.id, false);
                    }}
                    style={[
                      styles.hiddenRow,
                      view.id === activeViewId ? styles.hiddenRowActive : null,
                    ]}
                  >
                    <View
                      style={[
                        styles.hiddenDot,
                        { backgroundColor: statusColor(info.agentStatus, theme) },
                      ]}
                    />
                    <Text numberOfLines={1} style={styles.hiddenTitle}>
                      {info.workspaceLabel ?? view.workspaceId}
                    </Text>
                    {info.agentTitle ? (
                      <Text numberOfLines={1} style={styles.hiddenMeta}>
                        {info.agentTitle}
                      </Text>
                    ) : null}
                    <View style={styles.hiddenSpacer} />
                    <Text style={styles.hiddenExpand}>展开</Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}
        </View>
      )}

      <WorkspacePicker
        open={picking}
        onOpenChange={setPicking}
        theme={theme}
        workspaces={data?.workspaces ?? null}
        agents={data?.agents ?? null}
        existingWorkspaceIds={existingWorkspaceIds}
        onAdd={addView}
      />
    </View>
  );
}
