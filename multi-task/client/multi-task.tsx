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
import { setFramesHidden, setKnownSources } from "./frame-pool";
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
      // 下拉列表打开时的按钮高亮。
      ghostButtonActive: {
        borderColor: theme.colors.accent,
        backgroundColor: theme.colors.surface2,
      },
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
      resizeGhostVertical: {
        position: "absolute" as const,
        top: 0,
        bottom: 0,
        width: 2,
        backgroundColor: theme.colors.accent,
      },
      resizeGhostHorizontal: {
        position: "absolute" as const,
        left: 0,
        right: 0,
        height: 2,
        backgroundColor: theme.colors.accent,
      },
      // 「已隐藏」下拉浮层：点外面任何地方关掉，列表自己滚动。
      menuBackdrop: {
        position: "absolute" as const,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 25,
      },
      hiddenMenu: {
        position: "absolute" as const,
        right: compact ? 12 : 20,
        zIndex: 26,
        minWidth: 280,
        maxWidth: 420,
        maxHeight: 360,
        gap: 4,
        paddingVertical: 8,
        paddingHorizontal: 8,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        shadowColor: "#000000",
        shadowOpacity: 0.28,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: 8 },
      },
      hiddenMenuTitle: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        paddingHorizontal: 4,
        paddingBottom: 2,
      },
      hiddenMenuHint: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        paddingHorizontal: 4,
        paddingTop: 4,
      },
      hiddenMenuList: { flexGrow: 0, flexShrink: 1 },
      hiddenMenuListContent: { gap: 4 },
      hiddenRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
        paddingHorizontal: 10,
        paddingVertical: 6,
      },
      hiddenRowActive: { borderColor: theme.colors.accent },
      hiddenMain: {
        flex: 1,
        // workspace 名一行、agent 名一行；下拉宽度有限时不容易被挤成碎片。
        gap: 1,
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
      hiddenAction: { paddingHorizontal: 6, paddingVertical: 4, borderRadius: 6 },
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
 * 单行铺满时单元格允许的最大瘦高比（高 / 宽）。
 * 3 个以内尽量一行铺满（窄一点也还能用）；4 个以上一行会把每个面板压成细条，
 * 不如退回更接近方形的网格，所以门槛收紧。
 */
const maxSingleRowAspect = (count: number) => (count <= 3 ? 3 : 2.4);

/**
 * 按任务数量把可用区域平铺成网格：
 * - 优先「一行铺满」：只要每格仍不窄于 minCellWidth、也不会被拉成瘦高条，
 *   就让 N 个任务并排成 N 列（3 个任务就是 3 竖列，而不是 2+1 再让底下一个通栏）；
 * - 装不下一行时，列数限制在「单元格不窄于 minCellWidth」的范围内，并选最接近正方形的方案；
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
  const singleRowCellWidth = (width - gap * (count - 1)) / count;
  if (
    singleRowCellWidth >= minCellWidth &&
    height / singleRowCellWidth <= maxSingleRowAspect(count)
  ) {
    return { cols: count, rows: 1, cellHeight: Math.max(height, minCellHeight) };
  }
  const maxCols = Math.max(1, Math.min(count, Math.floor((width + gap) / (minCellWidth + gap))));
  let cols = 1;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let candidate = 1; candidate <= maxCols; candidate++) {
    const rows = Math.ceil(count / candidate);
    const ratio = width / candidate / (height / rows);
    const empty = candidate * rows - count;
    // 越接近 1:1 越好；空位给一点惩罚，尽量铺满行（4 个任务会优先 2×2 而不是 3+1）。
    const score = Math.abs(Math.log(ratio)) + empty * 0.3;
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

/** 权重是否有效（只有正数才参与分配）。 */
function isValidWeight(weight: number | undefined): weight is number {
  return typeof weight === "number" && Number.isFinite(weight) && weight > 0;
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
 * 不满一行的尾行：只有 1 个面板时不再拉成整条通栏（沿用满行的单元格宽度，剩余空间留在右侧）；
 * 有 2 个以上则仍然等分铺满本行，不至于留一大块空白。
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
  // 行高同理：所有行都带 weight 才按权重分，否则等分。
  const rowHeightsWeighted = chunks.every((chunk) => isValidWeight(chunk[0]?.heightWeight));
  const heights = distribute(
    chunks.map((chunk) => (rowHeightsWeighted ? chunk[0]!.heightWeight! : 1)),
    availableHeight,
  );
  // 满行时的单元格宽度：尾行只剩 1 个面板时按它铺，避免变成整条通栏。
  const cellWidth = Math.max(1, (width - gap * (cols - 1)) / cols);
  return chunks.map((chunk, rowIndex) => {
    // 只有一个面板的尾行用满行单元格宽度，其余情况按本行面板数量铺满。
    const rowWidth = chunk.length > 1 ? width - gap * (chunk.length - 1) : cellWidth;
    // 权重是像素量纲（拖拽时的实际宽高），缺省值又是 1：一旦同一行里只有部分面板带权重，
    // 没权重的会被压成 1px。所以「全有权重才用权重，否则整行等分」。
    const rowWeighted = chunk.every((view) => isValidWeight(view.widthWeight));
    return {
      views: chunk,
      widths: distribute(
        chunk.map((view) => (rowWeighted ? view.widthWeight! : 1)),
        rowWidth,
      ),
      height: Math.max(minRowHeight, heights[rowIndex] ?? minRowHeight),
    };
  });
}

interface MeasurableElement {
  getBoundingClientRect(): { left: number; top: number };
}

interface SlotSpan {
  start: number;
  end: number;
}

/** 把一行（或一列）的尺寸换算成每个格子的起止区间，间隙算在两格之间。 */
function slotSpans(sizes: number[], gap: number): SlotSpan[] {
  let offset = 0;
  return sizes.map((size) => {
    const start = offset;
    offset = start + size + gap;
    return { start, end: start + size };
  });
}

/**
 * 找出坐标 value 落在第几个格子里（超出两端时夹到首 / 尾格）。
 * 格子之间有间隙，所以「进入相邻格」= 越过两个格子的边界线（不是相邻格的中线）：
 * 面板中心越过边界即换位，拖半个面板宽度就能跟邻居互换。
 */
function slotIndexAt(spans: SlotSpan[], value: number): number {
  for (let index = 0; index < spans.length; index++) {
    if (value < (spans[index]?.end ?? 0)) return index;
  }
  return Math.max(0, spans.length - 1);
}
interface GhostElementLike {
  style: { left?: string; top?: string };
}

type ResizeSession =
  | {
      kind: "col";
      rowIndex: number;
      columnIndex: number;
      startX: number;
      /** 预览线初始横坐标（相对屏幕根视图）。 */
      ghostStart: number;
      widths: number[];
    }
  | {
      kind: "row";
      rowIndex: number;
      startY: number;
      /** 预览线初始纵坐标（相对屏幕根视图）。 */
      ghostStart: number;
      heights: number[];
    };

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
  // 「已隐藏」下拉是否展开，以及工具栏高度（下拉浮层要贴在工具栏下方）。
  const [hiddenMenuOpen, setHiddenMenuOpen] = useState(false);
  const [toolbarHeight, setToolbarHeight] = useState(0);

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

  // 隐藏的面板不占格子：展开的铺满主区域，隐藏的收进右上角「已隐藏」下拉。
  const expandedViews = useMemo(() => views.filter((view) => !view.collapsed), [views]);
  const collapsedViews = useMemo(() => views.filter((view) => view.collapsed), [views]);

  // 隐藏项被全部恢复 / 移除后，自动收起下拉。
  useEffect(() => {
    if (collapsedViews.length === 0) setHiddenMenuOpen(false);
  }, [collapsedViews.length]);


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
        if (ok) return;
        // save 返回 false = revision 过期（其他窗口改过）或数据不合法，SDK 不区分。
        // 先重读一次，让下一次操作带上最新 revision，用户重试即可成功。
        toast.show("保存失败：配置可能已被其他窗口改动，请重试", { variant: "error" });
        await settings.reload();
      } catch (cause) {
        toast.show(cause instanceof Error ? cause.message : String(cause), { variant: "error" });
        await settings.reload().catch(() => {});
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
      // workspace / agent 列表还没到时先别建 iframe：否则会先按「新建 agent 草稿页」建一个
      // 完整 app 实例，数据到了再换成会话深链——那批草稿实例白占内存和一条 websocket。
      if (!data) return null;
      const agentId = agentIdFor(view);
      if (agentId) return buildAgentDeepLinkRoute({ serverId: host.id, agentId });
      return `/h/${encodeURIComponent(host.id)}/workspace/${encodeURIComponent(view.workspaceId)}?open=${encodeURIComponent("draft:new")}`;
    },
    [canEmbed, data, host.id, agentIdFor],
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

  // 通知 iframe 池：只保留这些 src（当前面板列表真正用到的），其余空闲实例当场销毁。
  const knownFrameSources = useMemo(() => {
    const sources: string[] = [];
    for (const view of views) {
      const src = embedSrcFor(view);
      if (src) sources.push(src);
    }
    return sources;
  }, [views, embedSrcFor]);
  useEffect(() => {
    setKnownSources(knownFrameSources);
  }, [knownFrameSources]);

  // 「已隐藏」下拉是界面内浮层，打开时先藏起常驻 iframe，免得它盖住菜单（拖动排序同理，
  // 见下面的 draggingPane）。
  useEffect(() => () => setFramesHidden(false), []);

  const setViewCollapsed = useCallback(
    (viewId: string, collapsed: boolean) => {
      void persist(
        views.map((view) => (view.id === viewId ? { ...view, collapsed } : view)),
      );
    },
    [views, persist],
  );

  // 从「已隐藏」下拉里恢复一个面板：回平铺网格并设成当前焦点。
  const restoreView = useCallback(
    (viewId: string) => {
      setActiveViewId(viewId);
      setViewCollapsed(viewId, false);
      setHiddenMenuOpen(false);
    },
    [setViewCollapsed],
  );

  const screenRef = useRef<View>(null);
  // 平铺区域的滚动视口：常驻 iframe 浮层要按它裁切。
  const panesClipRef = useRef<View>(null);
  const ghostRef = useRef<View>(null);
  const resizeRef = useRef<ResizeSession | null>(null);
  // 拖动期间只渲染一条预览线，面板尺寸保持不变；松手后才一次性应用。
  // 内嵌面板是完整的 Paseo 实例，逐帧改 iframe 尺寸既卡又容易把内嵌页拖白。
  const [dragOverlay, setDragOverlay] = useState<{
    kind: "col" | "row";
    left: number;
    top: number;
  } | null>(null);

  const screenRect = useCallback(() => {
    const node = screenRef.current as unknown as MeasurableElement | null;
    if (!node || typeof node.getBoundingClientRect !== "function") return { left: 0, top: 0 };
    return node.getBoundingClientRect();
  }, []);

  // 直接改 DOM 位置，避免每次 pointermove 都触发 React 渲染。
  const moveGhost = useCallback((kind: "col" | "row", left: number, top: number) => {
    const ghost = ghostRef.current as unknown as GhostElementLike | null;
    if (!ghost?.style) return;
    if (kind === "col") ghost.style.left = `${left}px`;
    else ghost.style.top = `${top}px`;
  }, []);

  const startColumnResize = useCallback(
    (rowIndex: number, columnIndex: number, position: { x: number; y: number }) => {
      const row = layoutRows[rowIndex];
      if (!row) return;
      const rect = screenRect();
      const ghostStart = position.x - rect.left;
      resizeRef.current = {
        kind: "col",
        rowIndex,
        columnIndex,
        startX: position.x,
        ghostStart,
        widths: row.widths.slice(),
      };
      setDragOverlay({ kind: "col", left: ghostStart, top: position.y - rect.top });
    },
    [layoutRows, screenRect],
  );

  const startRowResize = useCallback(
    (rowIndex: number, position: { x: number; y: number }) => {
      if (layoutRows.length <= 1) return;
      const rect = screenRect();
      const ghostStart = position.y - rect.top;
      resizeRef.current = {
        kind: "row",
        rowIndex,
        startY: position.y,
        ghostStart,
        heights: layoutRows.map((row) => row.height),
      };
      setDragOverlay({ kind: "row", left: position.x - rect.left, top: ghostStart });
    },
    [layoutRows, screenRect],
  );

  const moveResize = useCallback(
    (position: { x: number; y: number }) => {
      const session = resizeRef.current;
      if (!session) return;
      if (session.kind === "col") {
        const before = session.widths[session.columnIndex - 1] ?? 0;
        const total = before + (session.widths[session.columnIndex] ?? 0);
        // 预览线也按最小宽度夹一下，松手时不会突然跳到限制位置。
        const min = Math.min(minPaneWidth, total / 2);
        const delta = Math.max(
          min - before,
          Math.min(total - min - before, position.x - session.startX),
        );
        moveGhost("col", session.ghostStart + delta, 0);
        return;
      }
      const before = session.heights[session.rowIndex - 1] ?? 0;
      const total = before + (session.heights[session.rowIndex] ?? 0);
      const min = Math.min(minRowHeight, total / 2);
      const delta = Math.max(
        min - before,
        Math.min(total - min - before, position.y - session.startY),
      );
      moveGhost("row", 0, session.ghostStart + delta);
    },
    [moveGhost, minPaneWidth, minRowHeight],
  );

  const endResize = useCallback(
    (position: { x: number; y: number }) => {
      const session = resizeRef.current;
      resizeRef.current = null;
      setDragOverlay(null);
      if (!session) return;
      if (session.kind === "col") {
        const row = layoutRows[session.rowIndex];
        if (!row) return;
        const widths = session.widths.slice();
        const index = session.columnIndex;
        const before = widths[index - 1] ?? 0;
        const total = before + (widths[index] ?? 0);
        const min = Math.min(minPaneWidth, total / 2);
        const next = Math.min(total - min, Math.max(min, before + (position.x - session.startX)));
        // 只是点了一下分隔条、没真的拖动：不写设置，避免把均分布局误标成「手动调整」。
        if (Math.abs(next - before) < 0.5) return;
        widths[index - 1] = next;
        widths[index] = total - next;
        const weights = new Map(
          row.views.map((view, rowColumn) => [view.id, widths[rowColumn] ?? 1]),
        );
        void persist(
          views.map((view) => {
            const weight = weights.get(view.id);
            return weight == null ? view : { ...view, widthWeight: Math.max(1, weight) };
          }),
        );
        return;
      }
      // 行高权重是跨行归一化的：一次拖拽后把所有行都写成当前像素高度，保持单位一致。
      const heights = session.heights.slice();
      const index = session.rowIndex;
      const before = heights[index - 1] ?? 0;
      const total = before + (heights[index] ?? 0);
      const min = Math.min(minRowHeight, total / 2);
      const next = Math.min(total - min, Math.max(min, before + (position.y - session.startY)));
      if (Math.abs(next - before) < 0.5) return;
      heights[index - 1] = next;
      heights[index] = total - next;
      const rowIndexById = new Map<string, number>();
      layoutRows.forEach((row, rowIndex) =>
        row.views.forEach((view) => rowIndexById.set(view.id, rowIndex)),
      );
      void persist(
        views.map((view) => {
          const rowIndex = rowIndexById.get(view.id);
          if (rowIndex == null) return view;
          return { ...view, heightWeight: Math.max(1, heights[rowIndex] ?? 1) };
        }),
      );
    },
    [layoutRows, persist, views, minPaneWidth, minRowHeight],
  );

  const hasManualLayout = useMemo(
    () => views.some((view) => view.widthWeight != null || view.heightWeight != null),
    [views],
  );

  // 重置布局：把拖拽出来的 widthWeight / heightWeight 整个键删掉。
  // 注意不能写成 `widthWeight: undefined`：设置写入要过 z.json() 校验，
  // undefined 不是合法 JSON 值，整个 save 会被判 invalid（表现为「保存失败」）。
  const resetLayout = useCallback(() => {
    void persist(
      views.map((view) => {
        const { widthWeight: _widthWeight, heightWeight: _heightWeight, ...rest } = view;
        return rest;
      }),
    );
  }, [views, persist]);

  // 拖动落点：把面板从原位置的**中心**拖到哪儿，就落到那块格子。
  // 逐格比较边界：面板中心越过格子边界（进入相邻格）即换位，拖半个面板宽度就能互换；
  // 支持各行宽度不同 / 多行布局。
  const resolveDropTarget = useCallback(
    (viewId: string, dx: number, dy: number): MultiTaskView | null => {
      if (!grid || layoutRows.length === 0) return null;
      const origin = expandedViews.findIndex((view) => view.id === viewId);
      if (origin < 0) return null;
      const cols = Math.max(1, grid.cols);
      const originRowIndex = Math.floor(origin / cols);
      const row = layoutRows[originRowIndex];
      if (!row) return null;

      const colSpans = slotSpans(row.widths, gap);
      const originCol = origin % cols;
      const originX =
        (colSpans[originCol]?.start ?? 0) + (row.widths[originCol] ?? 0) / 2;
      const targetCol = slotIndexAt(colSpans, originX + dx);

      const rowSpans = slotSpans(
        layoutRows.map((layoutRow) => layoutRow.height),
        gap,
      );
      const originY = (rowSpans[originRowIndex]?.start ?? 0) + row.height / 2;
      const targetRow = slotIndexAt(rowSpans, originY + dy);

      const index = Math.min(
        Math.max(targetRow * cols + targetCol, 0),
        expandedViews.length - 1,
      );
      return expandedViews[index] ?? null;
    },
    [grid, expandedViews, layoutRows, gap],
  );

  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  // 是否有面板正在被拖动：拖动中要把常驻 iframe 全藏起来（原因见下面的 effect）。
  const [draggingPane, setDraggingPane] = useState(false);

  // 界面内浮层（「已隐藏」下拉、拖动中的面板）压不过 #overlay-root 里的常驻 iframe：
  // 面板的祖先几乎都是 position: relative; z-index: 0，各自形成层叠上下文，面板自己的
  // z-index 抬不出这层，而 iframe 在 overlay-root（z-index 1）里、整体高于界面内容。
  // 结果就是指针落到 iframe 上——它是独立文档，捕获指针也收不到它的事件，拖动会卡死。
  // 所以这些时候直接把 iframe 藏起来（visibility: hidden + pointer-events: none）。
  useEffect(() => {
    setFramesHidden(hiddenMenuOpen || draggingPane);
  }, [hiddenMenuOpen, draggingPane]);

  // 拖动中实时高亮落点格：坐标没跨格就不写 state，避免每次 pointermove 都重渲染。
  const handleDragState = useCallback(
    (viewId: string, state: { dx: number; dy: number } | null) => {
      // 值没变时 React 会跳过重渲染，不用自己判重。
      setDraggingPane(state != null);
      if (!state) {
        setDropTargetId(null);
        return;
      }
      const target = resolveDropTarget(viewId, state.dx, state.dy);
      const nextId = target && target.id !== viewId ? target.id : null;
      setDropTargetId((current) => (current === nextId ? current : nextId));
    },
    [resolveDropTarget],
  );

  const handleDrop = useCallback(
    (viewId: string, dx: number, dy: number) => {
      setDropTargetId(null);
      const targetView = resolveDropTarget(viewId, dx, dy);
      if (!targetView || targetView.id === viewId) return;
      const origin = views.findIndex((view) => view.id === viewId);
      const target = views.findIndex((view) => view.id === targetView.id);
      if (origin < 0 || target < 0) return;
      const next = views.slice();
      const [moved] = next.splice(origin, 1);
      if (!moved) return;
      next.splice(target, 0, moved);
      void persist(next);
    },
    [resolveDropTarget, views, persist],
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
    <View style={styles.screen} ref={screenRef}>
      {toolbarCollapsed ? (
        <View
          style={styles.toolbar}
          onLayout={(event) => setToolbarHeight(event.nativeEvent.layout.height)}
        >
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
        <View
          style={styles.toolbar}
          onLayout={(event) => setToolbarHeight(event.nativeEvent.layout.height)}
        >
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
          {collapsedViews.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`已隐藏 ${collapsedViews.length} 个面板，点击可恢复或移除`}
              onPress={() => setHiddenMenuOpen((open) => !open)}
              style={[styles.ghostButton, hiddenMenuOpen ? styles.ghostButtonActive : null]}
            >
              <Text style={styles.ghostButtonText}>
                {`已隐藏 ${collapsedViews.length} ${hiddenMenuOpen ? "▴" : "▾"}`}
              </Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="收起工具栏"
            onPress={() => {
              setHiddenMenuOpen(false);
              setToolbarCollapsed(true);
            }}
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
          <View
            ref={panesClipRef}
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
                {layoutRows.map((row, rowIndex) => (
                  <View key={row.views[0]?.id ?? rowIndex}>
                    {rowIndex > 0 ? (
                      <ResizeHandle
                        orientation="horizontal"
                        size={gap}
                        color={theme.colors.border}
                        hoverColor={theme.colors.accent}
                        onStart={(position) => startRowResize(rowIndex, position)}
                        onMove={moveResize}
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
                              onStart={(position) => startColumnResize(rowIndex, columnIndex, position)}
                              onMove={moveResize}
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
                            embedPending={canEmbed && data == null}
                            active={view.id === activeViewId}
                            dropTarget={view.id === dropTargetId}
                            scrollClipRef={panesClipRef}
                            theme={theme}
                            navigation={navigation}
                            onActivate={() => setActiveViewId(view.id)}
                            onToggleCollapse={() => setViewCollapsed(view.id, !view.collapsed)}
                            onDrop={(dx, dy) => handleDrop(view.id, dx, dy)}
                            onDragState={(state) => handleDragState(view.id, state)}
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
                <Text style={styles.muted}>
                  {collapsedViews.length > 0
                    ? "全部面板已隐藏。点右上角「已隐藏」可恢复或移除。"
                    : "全部面板已隐藏。"}
                </Text>
              </View>
            )}
          </View>
        </View>
      )}

      {/* 「已隐藏」下拉：浮在工具栏下方，点外面关掉；每项可以恢复或移除。 */}
      {hiddenMenuOpen && collapsedViews.length > 0 ? (
        <>
          <Pressable
            accessibilityRole="none"
            accessibilityLabel="关闭已隐藏列表"
            onPress={() => setHiddenMenuOpen(false)}
            style={styles.menuBackdrop}
          />
          <View style={[styles.hiddenMenu, { top: toolbarHeight }]}>
            <Text style={styles.hiddenMenuTitle}>已隐藏的面板</Text>
            <ScrollView style={styles.hiddenMenuList} contentContainerStyle={styles.hiddenMenuListContent}>
              {collapsedViews.map((view) => {
                const info = resolveInfo(view);
                const label = info.workspaceLabel ?? view.workspaceId;
                return (
                  <View
                    key={view.id}
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
                    <View style={styles.hiddenMain}>
                      <Text numberOfLines={1} style={styles.hiddenTitle}>
                        {label}
                      </Text>
                      {info.agentTitle ? (
                        <Text numberOfLines={1} style={styles.hiddenMeta}>
                          {info.agentTitle}
                        </Text>
                      ) : null}
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`恢复 ${label}`}
                      onPress={() => restoreView(view.id)}
                      style={styles.hiddenAction}
                    >
                      <Text style={styles.hiddenExpand}>恢复</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`移除 ${label}`}
                      onPress={() => requestRemove(view.id)}
                      style={styles.hiddenAction}
                    >
                      <Text style={styles.hiddenRemoveText}>移除</Text>
                    </Pressable>
                  </View>
                );
              })}
            </ScrollView>
            <Text style={styles.hiddenMenuHint}>恢复后回到平铺网格；移除会先弹窗确认。</Text>
          </View>
        </>
      ) : null}

      {dragOverlay ? (
        <View
          style={[
            styles.resizeShield,
            {
              cursor: dragOverlay.kind === "col" ? "col-resize" : "row-resize",
            } as unknown as ViewStyle,
          ]}
        >
          <View
            ref={ghostRef}
            style={[
              dragOverlay.kind === "col" ? styles.resizeGhostVertical : styles.resizeGhostHorizontal,
              dragOverlay.kind === "col" ? { left: dragOverlay.left } : { top: dragOverlay.top },
            ]}
          />
        </View>
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
