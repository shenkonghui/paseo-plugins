import type { PaseoAgent, PaseoWorkspace } from "@getpaseo/client";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { usePaseo, useSettings } from "@getpaseo/plugin/client";
import { Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { buildAgentDeepLinkRoute } from "@getpaseo/protocol/agent-deep-link";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View, type ViewStyle } from "react-native";
import {
  makeViewId,
  multiTaskSettings,
  type MultiTaskToolbarSize,
  type MultiTaskView,
} from "../shared/settings";
import { AgentPane, statusColor, type AgentPaneInfo } from "./agent-pane";
import { WorkspacePicker, workspaceLabel } from "./agent-picker";
import { ResizeHandle } from "./resize-handle";

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

function useStyles(theme: Theme, compact: boolean, toolbarSize: MultiTaskToolbarSize) {
  return useMemo(() => {
    const comfortable = toolbarSize === "comfortable";
    return {
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
        // 窄屏放不下时让按钮换行，否则「刷新」会被挤出可视区。
        flexWrap: compact ? ("wrap" as const) : ("nowrap" as const),
        gap: comfortable ? 8 : 6,
        paddingHorizontal: compact ? 12 : 20,
        paddingTop: comfortable ? (compact ? 12 : 20) : 8,
        paddingBottom: comfortable ? 10 : 6,
      },
      toolbarTitle: {
        color: theme.colors.foreground,
        fontSize: comfortable ? 14 : 13,
        fontWeight: "600" as const,
      },
      toolbarMeta: {
        color: theme.colors.foregroundMuted,
        fontSize: comfortable ? 12 : 11,
        flexShrink: 1,
      },
      spacer: { flex: 1 },
      ghostButton: {
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        paddingHorizontal: 10,
        paddingVertical: comfortable ? 6 : 4,
      },
      ghostButtonText: { color: theme.colors.foreground, fontSize: comfortable ? 13 : 12 },
      toolbarToggle: {
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        paddingHorizontal: 7,
        paddingVertical: comfortable ? 4 : 2,
      },
      toolbarToggleText: {
        color: theme.colors.foregroundMuted,
        fontSize: comfortable ? 13 : 12,
      },
      primaryButton: {
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: comfortable ? 7 : 4,
        backgroundColor: theme.colors.accent,
      },
      primaryButtonText: {
        color: theme.colors.accentForeground,
        fontSize: comfortable ? 13 : 12,
        fontWeight: "600" as const,
      },
      panesOuter: {
        flex: 1,
        paddingHorizontal: compact ? 12 : 20,
        paddingBottom: 12,
      },
      panesWrap: { flex: 1 },
      panesScroll: { flex: 1 },
      row: { flexDirection: "row" as const, justifyContent: "flex-start" as const },
      resizeShield: {
        position: "absolute" as const,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 20,
      },
      hiddenList: { gap: 6, paddingBottom: 8 },
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
      hiddenMain: {
        flex: 1,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        // react-native-web 里 flex item 默认 min-width:auto，不置 0 标题不会省略。
        minWidth: 0,
      },
      hiddenDot: { width: 8, height: 8, borderRadius: 4 },
      hiddenTitle: {
        color: theme.colors.foreground,
        fontSize: 13,
        fontWeight: "600" as const,
        flexShrink: 1,
      },
      hiddenMeta: { color: theme.colors.foregroundMuted, fontSize: 12, flexShrink: 1 },
      hiddenRemove: { paddingHorizontal: 2, paddingVertical: 2 },
      hiddenRemoveText: { color: theme.colors.statusDanger, fontSize: 12 },
      hiddenExpand: { color: theme.colors.accent, fontSize: 12 },
    };
  }, [theme, compact, toolbarSize]);
}

interface TileGrid {
  cols: number;
  rows: number;
  cellHeight: number;
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
  const naturalCellHeight = (height - gap * (rows - 1)) / rows;
  const cellHeight = Math.max(naturalCellHeight, minCellHeight);
  return { cols, rows, cellHeight };
}

interface PaneRow {
  views: MultiTaskView[];
  /** 该行每个面板的像素宽度（同一行内按 widthWeight 归一化）。 */
  widths: number[];
  /** 该行高度（所有行按 heightWeight 归一化）。 */
  height: number;
}

/** 按权重把总长度分给每一项；权重缺失 / 非法时退化为等分。 */
function distribute(weights: number[], total: number): number[] {
  const safe = weights.map((weight) =>
    Number.isFinite(weight) && weight > 0 ? weight : 1,
  );
  const sum = safe.reduce((acc, weight) => acc + weight, 0) || safe.length;
  return safe.map((weight) => Math.max(1, (total * weight) / sum));
}

/**
 * 在列数固定的前提下按权重计算每行宽度与行高：
 * 默认权重都是 1（等价于原来的均分平铺）；拖拽分隔条后使用持久化下来的权重。
 */
function computePaneRows(
  views: MultiTaskView[],
  cols: number,
  width: number,
  height: number,
  gap: number,
  minRowHeight: number,
): PaneRow[] {
  if (views.length === 0 || cols <= 0 || width <= 0) return [];
  const chunks: MultiTaskView[][] = [];
  for (let index = 0; index < views.length; index += cols) {
    chunks.push(views.slice(index, index + cols));
  }
  const rows = chunks.length;
  // 高度不够时保底最小行高，整体超出可用高度就由外层 ScrollView 滚动。
  const availableHeight = Math.max(height - gap * (rows - 1), minRowHeight * rows);
  const heights = distribute(
    chunks.map((chunk) => chunk[0]?.heightWeight ?? 1),
    availableHeight,
  );
  return chunks.map((chunk, rowIndex) => ({
    views: chunk,
    widths: distribute(
      chunk.map((view) => view.widthWeight ?? 1),
      width - gap * (chunk.length - 1),
    ),
    height: Math.max(minRowHeight, heights[rowIndex] ?? minRowHeight),
  }));
}

type ResizeSession =
  | { kind: "col"; rowIndex: number; columnIndex: number; startX: number; widths: number[] }
  | { kind: "row"; rowIndex: number; startY: number; heights: number[] };

/** agent 的最近活跃时间，用来在一个 workspace 里挑「当前」的 agent。 */
function agentActivityTime(agent: PaseoAgent): number {
  const raw = agent.lastUserMessageAt ?? agent.updatedAt;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

interface RemoveConfirmProps {
  open: boolean;
  label: string;
  theme: Theme;
  onCancel: () => void;
  onConfirm: () => void;
}

/** 移除面板前的确认弹窗：面板一旦移除只能重新添加，不静默删除。 */
function RemoveConfirm({ open, label, theme, onCancel, onConfirm }: RemoveConfirmProps) {
  const styles = useMemo(
    () => ({
      body: { color: theme.colors.foreground, fontSize: 14, lineHeight: 20 },
      actions: { flexDirection: "row" as const, justifyContent: "flex-end" as const, gap: 8 },
      cancel: {
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        paddingHorizontal: 12,
        paddingVertical: 7,
      },
      cancelText: { color: theme.colors.foreground, fontSize: 13 },
      confirm: {
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 7,
        backgroundColor: theme.colors.statusDanger,
      },
      confirmText: { color: theme.colors.accentForeground, fontSize: 13, fontWeight: "600" as const },
    }),
    [theme],
  );

  return (
    <Modal title="移除面板" open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <Modal.Content>
        <Text style={styles.body}>确定要从多任务窗口移除「{label}」吗？移除后需要重新添加才能看回。</Text>
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="取消移除"
            onPress={onCancel}
            style={styles.cancel}
          >
            <Text style={styles.cancelText}>取消</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="确认移除"
            onPress={onConfirm}
            style={styles.confirm}
          >
            <Text style={styles.confirmText}>移除</Text>
          </Pressable>
        </View>
      </Modal.Content>
    </Modal>
  );
}

export function MultiTaskScreen({ theme, layout, host, navigation }: PluginScreenProps) {
  const paseo = usePaseo();
  const toast = useToast();
  const settings = useSettings(multiTaskSettings);
  const [nonce, setNonce] = useState(0);
  const [picking, setPicking] = useState(false);
  // 当前焦点面板（点击 / 键盘聚焦时更新），用于高亮。
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  // 待移除的面板：先弹窗确认再真正删掉。
  const [pendingRemovalId, setPendingRemovalId] = useState<string | null>(null);
  // 工具栏收起后只留一个小图标，点它再展开（纯界面状态，不持久化）。
  const [toolbarCollapsed, setToolbarCollapsed] = useState(false);

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
  const toolbarSize = settings.status === "ready" ? settings.values.toolbarSize : "compact";
  const styles = useStyles(theme, layout.compact, toolbarSize);

  const views = settings.status === "ready" ? settings.values.views : [];

  // 隐藏的面板不占格子：展开的铺满主区域，隐藏的在顶部收成整行标题条。
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

  const pendingRemovalLabel = useMemo(() => {
    if (!pendingRemovalId) return "";
    const view = views.find((item) => item.id === pendingRemovalId);
    if (!view) return "";
    return workspaceLabels.get(view.workspaceId) ?? view.workspaceId;
  }, [pendingRemovalId, views, workspaceLabels]);

  const existingWorkspaceIds = useMemo(
    () => new Set(views.map((view) => view.workspaceId)),
    [views],
  );

  const persist = useCallback(
    async (next: typeof views) => {
      if (settings.status !== "ready") return;
      try {
        const ok = await settings.save({ ...settings.values, views: next }, settings.revision);
        if (!ok) toast.show("保存失败，请重试", { variant: "error" });
      } catch (cause) {
        toast.show(cause instanceof Error ? cause.message : String(cause), { variant: "error" });
      }
    },
    [settings, toast],
  );

  const addView = useCallback(
    (workspaceId: string) => {
      if (existingWorkspaceIds.has(workspaceId)) {
        setPicking(false);
        return;
      }
      const id = makeViewId();
      // 面板只保留内嵌原生视图；没有 DOM（原生客户端）时面板内部自动退化为自绘对话流。
      void persist([...views, { id, workspaceId, collapsed: false }]);
      setActiveViewId(id);
    },
    [existingWorkspaceIds, views, persist],
  );

  const requestRemove = useCallback((viewId: string) => {
    setPendingRemovalId(viewId);
  }, []);

  const confirmRemove = useCallback(() => {
    if (!pendingRemovalId) return;
    void persist(views.filter((view) => view.id !== pendingRemovalId));
    setActiveViewId((current) => (current === pendingRemovalId ? null : current));
    setPendingRemovalId(null);
  }, [pendingRemovalId, views, persist]);

  const agentIdFor = useCallback(
    (view: MultiTaskView): string | null => agentForWorkspace(view.workspaceId)?.id ?? null,
    [agentForWorkspace],
  );

  // 用相对路由：iframe 会基于当前文档解析，避免自定义 scheme / 拿不到 origin 的问题。
  // 没有 agent 时打开该 workspace 的「新建 agent」草稿页（app 会把 draft:new 换成新草稿）。
  const embedSrcFor = useCallback(
    (view: MultiTaskView): string | null => {
      if (!canEmbed) return null;
      const agentId = agentIdFor(view);
      if (agentId) return buildAgentDeepLinkRoute({ serverId: host.id, agentId });
      return `/h/${encodeURIComponent(host.id)}/workspace/${encodeURIComponent(view.workspaceId)}?open=${encodeURIComponent("draft:new")}`;
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
  const minPaneWidth = layout.compact ? 150 : 190;
  const minRowHeight = layout.compact ? 200 : 220;
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

  // 每行铺满可用宽度、按权重分配行高：默认均分，拖拽分隔条后按保存的权重渲染。
  const layoutRows = useMemo(
    () =>
      grid
        ? computePaneRows(expandedViews, grid.cols, paneArea.width, paneArea.height, gap, minRowHeight)
        : [],
    [grid, expandedViews, paneArea.width, paneArea.height, gap, minRowHeight],
  );

  const setViewCollapsed = useCallback(
    (viewId: string, collapsed: boolean) => {
      void persist(
        views.map((view) => (view.id === viewId ? { ...view, collapsed } : view)),
      );
    },
    [views, persist],
  );

  const [resizePreview, setResizePreview] = useState<ResizeSession | null>(null);
  // 遮罩只覆盖「正在拖拽」的时段；预览会多保留一会儿，等持久化后的权重生效。
  const [resizing, setResizing] = useState(false);
  const resizeRef = useRef<ResizeSession | null>(null);

  // 拖拽行内分隔条：只改相邻两个面板的宽度，两者总宽不变。
  const startColumnResize = useCallback(
    (rowIndex: number, columnIndex: number, x: number) => {
      const row = layoutRows[rowIndex];
      if (!row) return;
      const session: ResizeSession = {
        kind: "col",
        rowIndex,
        columnIndex,
        startX: x,
        widths: row.widths.slice(),
      };
      resizeRef.current = session;
      setResizePreview(session);
      setResizing(true);
    },
    [layoutRows],
  );

  // 拖拽行间分隔条：只改相邻两行的高度，两者总高不变。
  const startRowResize = useCallback(
    (rowIndex: number, y: number) => {
      if (layoutRows.length <= 1) return;
      const session: ResizeSession = {
        kind: "row",
        rowIndex,
        startY: y,
        heights: layoutRows.map((row) => row.height),
      };
      resizeRef.current = session;
      setResizePreview(session);
      setResizing(true);
    },
    [layoutRows],
  );

  const moveResize = useCallback(
    (x: number, y: number) => {
      const session = resizeRef.current;
      if (!session) return;
      if (session.kind === "col") {
        const widths = session.widths.slice();
        const index = session.columnIndex;
        const before = widths[index - 1] ?? 0;
        const total = before + (widths[index] ?? 0);
        const min = Math.min(minPaneWidth, total / 2);
        const next = Math.min(total - min, Math.max(min, before + (x - session.startX)));
        widths[index - 1] = next;
        widths[index] = total - next;
        const preview: ResizeSession = { ...session, widths };
        resizeRef.current = preview;
        setResizePreview(preview);
        return;
      }
      const heights = session.heights.slice();
      const index = session.rowIndex;
      const before = heights[index - 1] ?? 0;
      const total = before + (heights[index] ?? 0);
      const min = Math.min(minRowHeight, total / 2);
      const next = Math.min(total - min, Math.max(min, before + (y - session.startY)));
      heights[index - 1] = next;
      heights[index] = total - next;
      const preview: ResizeSession = { ...session, heights };
      resizeRef.current = preview;
      setResizePreview(preview);
    },
    [minPaneWidth, minRowHeight],
  );

  const endResize = useCallback(() => {
    const session = resizeRef.current;
    resizeRef.current = null;
    setResizing(false);
    if (!session) return;
    // 兜底：写失败 / 长时间没回时，把预览清掉，回到实际生效的布局。
    globalThis.setTimeout(() => {
      setResizePreview((current) => (current === session ? null : current));
    }, 1200);
    if (session.kind === "col") {
      const row = layoutRows[session.rowIndex];
      if (!row) return;
      // 只是点了一下分隔条、没真的拖动：不写设置，避免把均分布局误标成「手动调整」。
      const moved = row.widths.some(
        (width, index) => Math.abs(width - (session.widths[index] ?? width)) >= 0.5,
      );
      if (!moved) return;
      const weights = new Map(row.views.map((view, index) => [view.id, session.widths[index] ?? 1]));
      void persist(
        views.map((view) => {
          const weight = weights.get(view.id);
          return weight == null ? view : { ...view, widthWeight: Math.max(1, weight) };
        }),
      );
      return;
    }
    // 行高权重是跨行归一化的：一次拖拽后把所有行都写成当前像素高度，保持单位一致。
    const moved = layoutRows.some(
      (row, index) => Math.abs(row.height - (session.heights[index] ?? row.height)) >= 0.5,
    );
    if (!moved) return;
    const rowIndexById = new Map<string, number>();
    layoutRows.forEach((row, index) => row.views.forEach((view) => rowIndexById.set(view.id, index)));
    void persist(
      views.map((view) => {
        const index = rowIndexById.get(view.id);
        if (index == null) return view;
        return { ...view, heightWeight: Math.max(1, session.heights[index] ?? 1) };
      }),
    );
  }, [layoutRows, persist, views]);

  // 拖拽过程中用预览尺寸渲染；松手后由持久化的权重接管。
  const displayRows = useMemo(() => {
    if (!resizePreview) return layoutRows;
    if (resizePreview.kind === "col") {
      return layoutRows.map((row, index) =>
        index === resizePreview.rowIndex ? { ...row, widths: resizePreview.widths } : row,
      );
    }
    return layoutRows.map((row, index) => ({
      ...row,
      height: resizePreview.heights[index] ?? row.height,
    }));
  }, [layoutRows, resizePreview]);

  const hasManualLayout = useMemo(
    () => views.some((view) => view.widthWeight != null || view.heightWeight != null),
    [views],
  );

  // 预览保留到持久化后的权重渲染到位（避免松手瞬间闪回旧尺寸）。
  useEffect(() => {
    if (!resizePreview || resizing) return;
    if (resizePreview.kind === "col") {
      const row = layoutRows[resizePreview.rowIndex];
      if (!row) {
        setResizePreview(null);
        return;
      }
      const same = row.widths.every(
        (width, index) => Math.abs(width - (resizePreview.widths[index] ?? width)) < 1,
      );
      if (same) setResizePreview(null);
      return;
    }
    const same = layoutRows.every(
      (row, index) => Math.abs(row.height - (resizePreview.heights[index] ?? row.height)) < 1,
    );
    if (same) setResizePreview(null);
  }, [layoutRows, resizePreview, resizing]);

  const resetLayout = useCallback(() => {
    void persist(
      views.map((view) => ({ ...view, widthWeight: undefined, heightWeight: undefined })),
    );
  }, [views, persist]);

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
      const originRowIndex = Math.floor(originExpanded / cols);
      const originRow = layoutRows[originRowIndex];
      const rowWidth = originRow
        ? originRow.widths.reduce((total, width) => total + width, 0) +
          gap * (originRow.widths.length - 1)
        : paneArea.width;
      const nextCol = clamp(
        (originExpanded % cols) + Math.round(dx / Math.max(1, rowWidth)),
        0,
        cols - 1,
      );
      const nextRow = clamp(
        originRowIndex + Math.round(dy / Math.max(1, originRow?.height ?? minRowHeight)),
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
    [grid, expandedViews, views, persist, layoutRows, gap, paneArea.width, minRowHeight],
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
      {toolbarCollapsed ? (
        <View style={styles.toolbar}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="展开工具栏"
            onPress={() => setToolbarCollapsed(false)}
            style={styles.toolbarToggle}
          >
            <Text style={styles.toolbarToggleText}>▾</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.toolbar}>
          <Text style={styles.toolbarTitle}>多任务</Text>
          <Text style={styles.toolbarMeta}>{views.length > 0 ? `${views.length} 个 workspace` : ""}</Text>
          <View style={styles.spacer} />
          {hasManualLayout ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="重置面板布局"
              onPress={resetLayout}
              style={styles.ghostButton}
            >
              <Text style={styles.ghostButtonText}>重置布局</Text>
            </Pressable>
          ) : null}
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
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="收起工具栏"
            onPress={() => setToolbarCollapsed(true)}
            style={styles.toolbarToggle}
          >
            <Text style={styles.toolbarToggleText}>▴</Text>
          </Pressable>
        </View>
      )}

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
            {toolbarCollapsed
              ? "还没有 workspace。点击左上角图标展开工具栏，再添加 workspace。"
              : "还没有 workspace。点击右上角「+ 添加 workspace」，挑选 workspace 即可并排查看它们当前会话。"}
          </Text>
        </View>
      ) : (
        <View style={styles.panesOuter}>
          {collapsedViews.length > 0 ? (
            <View style={styles.hiddenList}>
              {collapsedViews.map((view) => {
                const info = resolveInfo(view);
                const label = info.workspaceLabel ?? view.workspaceId;
                const expand = () => {
                  setActiveViewId(view.id);
                  setViewCollapsed(view.id, false);
                };
                return (
                  <View
                    key={view.id}
                    style={[
                      styles.hiddenRow,
                      view.id === activeViewId ? styles.hiddenRowActive : null,
                    ]}
                  >
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`展开 ${label}`}
                      onPress={expand}
                      style={styles.hiddenMain}
                    >
                      <View
                        style={[
                          styles.hiddenDot,
                          { backgroundColor: statusColor(info.agentStatus, theme) },
                        ]}
                      />
                      <Text numberOfLines={1} style={styles.hiddenTitle}>
                        {label}
                      </Text>
                      {info.agentTitle ? (
                        <Text numberOfLines={1} style={styles.hiddenMeta}>
                          {info.agentTitle}
                        </Text>
                      ) : null}
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`移除 ${label}`}
                      onPress={() => requestRemove(view.id)}
                      hitSlop={4}
                      style={styles.hiddenRemove}
                    >
                      <Text style={styles.hiddenRemoveText}>移除</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`展开 ${label}`}
                      onPress={expand}
                      hitSlop={4}
                    >
                      <Text style={styles.hiddenExpand}>展开</Text>
                    </Pressable>
                  </View>
                );
              })}
            </View>
          ) : null}
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
              <ScrollView style={styles.panesScroll}>
                {displayRows.map((row, rowIndex) => (
                  <View key={row.views[0]?.id ?? rowIndex}>
                    {rowIndex > 0 ? (
                      <ResizeHandle
                        orientation="horizontal"
                        size={gap}
                        color={theme.colors.border}
                        hoverColor={theme.colors.accent}
                        onStart={({ y }) => startRowResize(rowIndex, y)}
                        onMove={(position) => moveResize(position.x, position.y)}
                        onEnd={endResize}
                      />
                    ) : null}
                    <View style={[styles.row, { height: row.height }]}>
                      {row.views.map((view, columnIndex) => (
                        <Fragment key={view.id}>
                          {columnIndex > 0 ? (
                            <ResizeHandle
                              orientation="vertical"
                              size={gap}
                              color={theme.colors.border}
                              hoverColor={theme.colors.accent}
                              onStart={({ x }) => startColumnResize(rowIndex, columnIndex, x)}
                              onMove={(position) => moveResize(position.x, position.y)}
                              onEnd={endResize}
                            />
                          ) : null}
                          <AgentPane
                            view={view}
                            info={resolveInfo(view)}
                            agentId={agentIdFor(view)}
                            width={row.widths[columnIndex] ?? 0}
                            height={row.height}
                            embedSrc={embedSrcFor(view)}
                            active={view.id === activeViewId}
                            theme={theme}
                            navigation={navigation}
                            onActivate={() => setActiveViewId(view.id)}
                            onToggleCollapse={() => setViewCollapsed(view.id, !view.collapsed)}
                            onDrop={(dx, dy) => handleDrop(view.id, dx, dy)}
                            onRemove={requestRemove}
                          />
                        </Fragment>
                      ))}
                    </View>
                  </View>
                ))}
              </ScrollView>
            ) : (
              <View style={styles.centered}>
                <Text style={styles.muted}>全部面板已隐藏。</Text>
              </View>
            )}
          </View>
        </View>
      )}

      {resizing && resizePreview ? (
        <View
          style={[
            styles.resizeShield,
            {
              cursor: resizePreview.kind === "col" ? "col-resize" : "row-resize",
            } as unknown as ViewStyle,
          ]}
        />
      ) : null}

      <RemoveConfirm
        open={pendingRemovalId != null}
        label={pendingRemovalLabel}
        theme={theme}
        onCancel={() => setPendingRemovalId(null)}
        onConfirm={confirmRemove}
      />

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
