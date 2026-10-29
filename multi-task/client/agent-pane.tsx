import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { usePaseo } from "@getpaseo/plugin/client";
import { TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Animated, Pressable, ScrollView, Text, View, type ViewStyle } from "react-native";
import type { MultiTaskView } from "../shared/settings";
import { EmbeddedAgent } from "./embedded-agent";
import { EntryView } from "./entry-view";
import { setFramesInteractive } from "./frame-pool";
import { STATUS_LABELS, useAgentTimeline } from "./timeline";

type Theme = PluginScreenProps["theme"];
type Navigation = PluginScreenProps["navigation"];

export interface AgentPaneInfo {
  workspaceLabel: string | null;
  agentTitle: string | null;
  agentStatus: string | null;
}

interface AgentPaneProps {
  view: MultiTaskView;
  info: AgentPaneInfo | null;
  /** 该 workspace 当前活跃的 agent；workspace 里没有 agent 时为 null。 */
  agentId: string | null;
  /** 由外层按任务数量平铺计算出的尺寸，保证内层消息列表可滚动。 */
  width: number;
  height: number;
  /** 内嵌视图的 URL；无 DOM 时为 null。workspace 没有 agent 时指向该 workspace 的「新建 agent」页。 */
  embedSrc: string | null;
  /** workspace / agent 列表还没到：先显示占位，别急着建 iframe（避免建完又废弃）。 */
  embedPending?: boolean;
  /** 是否为当前焦点面板（高亮显示）。 */
  active: boolean;
  theme: Theme;
  navigation: Navigation;
  onActivate: () => void;
  /** 折叠该面板到窗口顶部的最小化条。 */
  onToggleCollapse: () => void;
  /** 拖动头部结束后回调：给出相对起点的位移，由外层换算新的顺序。 */
  onDrop: (dx: number, dy: number) => void;
  /** 滚动视口容器（panesWrap）：内嵌 iframe 浮层要按它裁切。 */
  scrollClipRef?: RefObject<View | null>;
  /** 拖动过程中实时上报位移（null 表示结束），外层据此高亮落点格子。 */
  onDragState?: (state: { dx: number; dy: number } | null) => void;
  /** 当前面板是不是拖动的落点（高亮提示松手后会落在这里）。 */
  dropTarget?: boolean;
  onRemove: (viewId: string) => void;
}

/** 拖动用到的 DOM 事件/目标的最小结构，避免依赖 DOM 类型（插件 tsconfig 不带 lib.dom）。 */
interface PointerLike {
  button?: number;
  clientX?: number;
  clientY?: number;
  pointerId?: number;
  preventDefault?(): void;
  stopPropagation?(): void;
}

interface DomEventTarget {
  addEventListener(type: string, listener: (event: PointerLike) => void, capture?: boolean): void;
  removeEventListener(type: string, listener: (event: PointerLike) => void, capture?: boolean): void;
  setPointerCapture?(pointerId: number): void;
  releasePointerCapture?(pointerId: number): void;
}

export function statusColor(status: string | null, theme: Theme): string {
  switch (status) {
    case "running":
      return theme.colors.accent;
    case "error":
      return theme.colors.statusDanger;
    case "idle":
      return theme.colors.statusSuccess;
    case "initializing":
      return theme.colors.statusWarning;
    default:
      return theme.colors.foregroundMuted;
  }
}

function useStyles(theme: Theme) {
  return useMemo(
    () => ({
      pane: {
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        overflow: "hidden" as const,
      },
      paneInner: { flex: 1 },
      // 拖动中的面板：浮到最上层并略微透明。
      paneDragging: { zIndex: 10, opacity: 0.9 },
      // 拖动落点：虚线 accent 描边 + 淡底色，松手后面板就落在这格。
      paneDropTarget: {
        borderColor: theme.colors.accent,
        borderStyle: "dashed" as const,
        borderWidth: 2,
        backgroundColor: theme.colors.surface2,
      },
      // 标题区（⠿ + 标题）：整条都可以按住拖动，右侧按钮除外。
      dragRegion: {
        flex: 1,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        minWidth: 0,
        // react-native 的类型只认 auto / pointer，这里直接用 CSS 光标。
        cursor: "grab",
        userSelect: "none" as const,
      } as unknown as ViewStyle,
      gripWrap: { paddingHorizontal: 3, paddingVertical: 6 },
      grip: { color: theme.colors.foregroundMuted, fontSize: 13 },
      // 当前焦点面板：accent 描边 + 一点辉光。
      paneActive: {
        borderColor: theme.colors.accent,
        shadowColor: theme.colors.accent,
        shadowOpacity: 0.35,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 0 },
      },
      header: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        // 头部用一层底色 + 加粗底边，多个面板并排时更容易区分。
        backgroundColor: theme.colors.surface2,
        borderBottomWidth: 2,
        borderBottomColor: theme.colors.border,
      },
      // 标题栏左侧的 accent 竖条，让标题栏一眼可见。
      headerBar: {
        width: 3,
        alignSelf: "stretch" as const,
        borderRadius: 2,
        backgroundColor: theme.colors.accent,
      },
      grow: { flex: 1, minWidth: 0 },
      titleRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      title: {
        color: theme.colors.foreground,
        fontSize: 14,
        fontWeight: "600" as const,
        flexShrink: 1,
      },
      meta: { color: theme.colors.foregroundMuted, fontSize: 12 },
      statusPill: {
        flexShrink: 0,
        borderWidth: 1,
        borderRadius: 999,
        paddingHorizontal: 6,
        paddingVertical: 1,
      },
      statusPillText: { fontSize: 10, fontWeight: "600" as const },
      iconButton: {
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        paddingHorizontal: 8,
        paddingVertical: 4,
      },
      iconButtonText: { color: theme.colors.foreground, fontSize: 12 },
      body: { flex: 1 },
      bodyContent: { padding: 12, gap: 10 },
      empty: {
        flex: 1,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        padding: 16,
      },
      emptyText: { color: theme.colors.foregroundMuted, fontSize: 14, textAlign: "center" as const },
      errorText: { color: theme.colors.statusDanger, fontSize: 13 },
      sendStatusBar: {
        paddingHorizontal: 10,
        paddingTop: 6,
      },
      sendStatusText: { color: theme.colors.foregroundMuted, fontSize: 12 },
      footer: {
        flexDirection: "row" as const,
        alignItems: "flex-end" as const,
        gap: 6,
        padding: 8,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
      },
      input: {
        flex: 1,
        minHeight: 34,
        maxHeight: 96,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        paddingHorizontal: 8,
        paddingVertical: 6,
        color: theme.colors.foreground,
        fontSize: 14,
      },
      sendButton: {
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        backgroundColor: theme.colors.accent,
      },
      sendButtonDisabled: {
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        backgroundColor: theme.colors.surface2,
      },
      sendText: { color: theme.colors.accentForeground, fontSize: 13, fontWeight: "600" as const },
      sendTextDisabled: { color: theme.colors.foregroundMuted, fontSize: 13 },
    }),
    [theme],
  );
}

export function AgentPane({
  view,
  info,
  agentId,
  width,
  height,
  embedSrc,
  embedPending,
  active,
  theme,
  navigation,
  onActivate,
  onToggleCollapse,
  onDrop,
  onDragState,
  dropTarget,
  scrollClipRef,
  onRemove,
}: AgentPaneProps) {
  const paseo = usePaseo();
  const toast = useToast();
  const styles = useStyles(theme);
  // 面板只保留内嵌原生视图；没有 DOM（拿不到内嵌地址）时自动退化为自绘对话流。
  const embedded = embedSrc != null;
  const { entries, status, error } = useAgentTimeline(agentId ?? "", !embedded && agentId != null);
  const scrollRef = useRef<ScrollView>(null);
  // 只在贴近底部时自动跟随新内容；用户往上翻时不打断。
  const stickToBottom = useRef(true);
  const [draft, setDraft] = useState("");
  // 待发送队列：发送中再次发送就排队，逐个发出。
  const [queue, setQueue] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  // agent 正在跑当前回合时也算忙：这条消息先排队，等它空闲再发。
  // 想要「忙时也立刻投递（steering）」的话，把 agentRunning 从 busy 里去掉即可。
  const agentRunning = (status ?? info?.agentStatus) === "running";
  const busy = sending || agentRunning;

  // 拖动头部把手调整顺序：用 DOM 层 pointer 事件（RN responder 在宿主里会被外层抢走）。
  const dragXY = useRef(new Animated.ValueXY()).current;
  const [dragging, setDragging] = useState(false);
  const gripRef = useRef<View>(null);
  const dropRef = useRef(onDrop);
  const dragStateRef = useRef(onDragState);
  useEffect(() => {
    dropRef.current = onDrop;
    dragStateRef.current = onDragState;
  }, [onDrop, onDragState]);

  useEffect(() => {
    const grip = gripRef.current as unknown as DomEventTarget | null;
    const globalTarget = globalThis as unknown as DomEventTarget;
    if (
      !grip ||
      typeof grip.addEventListener !== "function" ||
      typeof globalTarget.addEventListener !== "function"
    ) {
      return;
    }
    let startX = 0;
    let startY = 0;
    let active = false;
    let moved = false;
    let pointerId: number | null = null;

    const onMove = (event: PointerLike) => {
      if (!active) return;
      const dx = (event.clientX ?? 0) - startX;
      const dy = (event.clientY ?? 0) - startY;
      if (!moved) {
        // 超过阈值才算拖动，单纯点一下不触发。
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        moved = true;
        setDragging(true);
      }
      dragXY.setValue({ x: dx, y: dy });
      // 落点高亮：外层按位移换算出目标格，只在格子变化时才重渲染。
      dragStateRef.current?.({ dx, dy });
    };
    const finish = (event: PointerLike) => {
      if (!active) return;
      active = false;
      globalTarget.removeEventListener("pointermove", onMove, true);
      globalTarget.removeEventListener("pointerup", finish, true);
      globalTarget.removeEventListener("pointercancel", finish, true);
      if (pointerId != null) {
        try {
          grip.releasePointerCapture?.(pointerId);
        } catch {
          // 指针已被系统释放时再释放会抛错，忽略即可。
        }
        pointerId = null;
      }
      dragStateRef.current?.(null);
      setFramesInteractive(true);
      if (!moved) return;
      const dx = (event.clientX ?? 0) - startX;
      const dy = (event.clientY ?? 0) - startY;
      dragXY.setValue({ x: 0, y: 0 });
      setDragging(false);
      dropRef.current(dx, dy);
    };
    const onDown = (event: PointerLike) => {
      if (event.button != null && event.button !== 0) return;
      // 阻止选中文字，并避免触发外层 Pressable 的激活。
      event.preventDefault?.();
      event.stopPropagation?.();
      active = true;
      moved = false;
      pointerId = event.pointerId ?? null;
      startX = event.clientX ?? 0;
      startY = event.clientY ?? 0;
      // 捕获指针：拖出窗口再松手也能收到 pointerup（否则面板会永远停在偏移位置）。
      // 指针落到内嵌 iframe 上的情况由外层拖动期间隐藏 iframe 解决——事件进了 iframe 文档，
      // 父页面的捕获管不到。
      if (pointerId != null) {
        try {
          grip.setPointerCapture?.(pointerId);
        } catch {
          // 拿不到捕获时退回普通拖拽（只在面板内有效）。
        }
      }
      globalTarget.addEventListener("pointermove", onMove, true);
      globalTarget.addEventListener("pointerup", finish, true);
      globalTarget.addEventListener("pointercancel", finish, true);
      // 按下的瞬间就让常驻 iframe 不再接收指针事件：指针一旦落进 iframe 的独立文档，
      // 父页面就收不到后续 pointermove / pointerup（拖动会卡住、松手也不换位）。
      // 这里同步生效，不等 React 的下一次渲染——快速拖动时松手事件可能就在同一帧里发出来。
      setFramesInteractive(false);
    };

    grip.addEventListener("pointerdown", onDown);
    return () => {
      grip.removeEventListener("pointerdown", onDown);
      globalTarget.removeEventListener("pointermove", onMove, true);
      globalTarget.removeEventListener("pointerup", finish, true);
      globalTarget.removeEventListener("pointercancel", finish, true);
      setFramesInteractive(true);
    };
  }, [dragXY]);

  const handleScroll = useCallback(
    (event: {
      nativeEvent: {
        contentOffset: { y: number };
        contentSize: { height: number };
        layoutMeasurement: { height: number };
      };
    }) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const distance = contentSize.height - (contentOffset.y + layoutMeasurement.height);
      stickToBottom.current = distance < 48;
    },
    [],
  );

  // 「打开」：在 app 主界面打开该 workspace（不要求有 agent，内嵌 / 退化视图都能用）。
  const handleOpen = useCallback(() => {
    onActivate();
    navigation?.openWorkspace?.({ workspaceId: view.workspaceId });
  }, [onActivate, navigation, view.workspaceId]);

  const handleRemove = useCallback(() => {
    onActivate();
    onRemove(view.id);
  }, [onActivate, onRemove, view.id]);

  // 入队：清空输入框并把消息排到队尾；发送中再发即排队。
  const enqueue = useCallback(() => {
    const text = draft.trim();
    if (text.length === 0 || !agentId) return;
    setDraft("");
    setQueue((current) => [...current, text]);
  }, [draft, agentId]);

  // 队列逐个发出：空闲时取队首发送，忙（发送中 / 回合进行中）则等待。
  useEffect(() => {
    if (busy || queue.length === 0 || !agentId) return;
    const [next, ...rest] = queue;
    if (next == null) return;
    setQueue(rest);
    setSending(true);
    paseo.agents
      .ref(agentId)
      .send(next)
      .catch((cause) => {
        toast.show(cause instanceof Error ? cause.message : String(cause), { variant: "error" });
      })
      .finally(() => setSending(false));
  }, [busy, queue, agentId, paseo, toast]);

  // Enter 发送，Shift+Enter 换行（web 上 nativeEvent 带 shiftKey；取不到时就等同 Enter 发送）。
  const handleKeyPress = useCallback(
    (event: { preventDefault(): void; nativeEvent: { key: string; shiftKey?: boolean } }) => {
      if (event.nativeEvent.key !== "Enter" || event.nativeEvent.shiftKey === true) return;
      event.preventDefault();
      enqueue();
    },
    [enqueue],
  );

  const workspaceTitle = info?.workspaceLabel ?? view.workspaceId;
  // 内嵌 iframe 的尺寸冻结：拖动窗口时每个面板都是一整套 Paseo app，
  // 逐帧改 iframe 尺寸会让它们反复重排（卡死 + 容易拖白）；
  // 外框（本组件 width/height）实时跟随，iframe 等尺寸稳定 180ms 后再更新一次。
  const [contentSize, setContentSize] = useState({ width, height });
  useEffect(() => {
    if (contentSize.width === width && contentSize.height === height) return;
    const timer = setTimeout(() => setContentSize({ width, height }), 180);
    return () => clearTimeout(timer);
  }, [width, height, contentSize.width, contentSize.height]);
  // 主标题用 workspace 名做分组，agent 名放副标题，状态由右侧胶囊展示。
  const secondaryTitle = agentId == null ? "无 agent" : (info?.agentTitle ?? agentId);
  const effectiveStatus = status ?? info?.agentStatus ?? null;
  const statusLabel = effectiveStatus ? (STATUS_LABELS[effectiveStatus] ?? effectiveStatus) : null;
  const canSend = draft.trim().length > 0 && agentId != null;

  // 发送状态提示：发送中 / 排队中。
  const pending = queue.length;
  const sendStatus =
    sending && pending > 0
      ? `发送中…（排队 ${pending}）`
      : sending
        ? "发送中…"
        : pending > 0
          ? `排队中 · ${pending}`
          : null;

  return (
    <Animated.View
      style={[
        styles.pane,
        { width, height },
        active ? styles.paneActive : null,
        dropTarget ? styles.paneDropTarget : null,
        dragging ? styles.paneDragging : null,
        { transform: dragXY.getTranslateTransform() },
      ]}
    >
      <Pressable accessibilityRole="none" onPress={onActivate} style={styles.paneInner}>
      <View style={styles.header}>
        <View style={styles.headerBar} />
        <View ref={gripRef} style={styles.dragRegion}>
          <View style={styles.gripWrap}>
            <Text style={styles.grip}>⠿</Text>
          </View>
          <View style={styles.grow}>
            <View style={styles.titleRow}>
              <Text numberOfLines={1} style={styles.title}>
                {workspaceTitle}
              </Text>
              {statusLabel ? (
                <View
                  style={[styles.statusPill, { borderColor: statusColor(effectiveStatus, theme) }]}
                >
                  <Text
                    style={[
                      styles.statusPillText,
                      { color: statusColor(effectiveStatus, theme) },
                    ]}
                  >
                    {statusLabel}
                  </Text>
                </View>
              ) : null}
            </View>
            <Text numberOfLines={1} style={styles.meta}>
              {secondaryTitle}
            </Text>
          </View>
        </View>
        {navigation ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="打开 workspace"
            onPress={handleOpen}
            style={styles.iconButton}
          >
            <Text style={styles.iconButtonText}>打开</Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="隐藏该面板"
          onPress={() => {
            onActivate();
            onToggleCollapse();
          }}
          style={styles.iconButton}
        >
          <Text style={styles.iconButtonText}>隐藏</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="移出多任务窗口"
          onPress={handleRemove}
          style={styles.iconButton}
        >
          <Text style={styles.iconButtonText}>移除</Text>
        </Pressable>
      </View>

      {embedded && embedSrc ? (
        <EmbeddedAgent src={embedSrc} theme={theme} onActivate={onActivate} clipRef={scrollClipRef} />
      ) : embedPending ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>正在加载会话…</Text>
        </View>
      ) : agentId == null ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>该 workspace 暂无 agent。</Text>
        </View>
      ) : error ? (
        <View style={styles.empty}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : (
        <ScrollView
          ref={scrollRef}
          style={styles.body}
          contentContainerStyle={styles.bodyContent}
          onScroll={handleScroll}
          scrollEventThrottle={16}
          onContentSizeChange={() => {
            if (stickToBottom.current) scrollRef.current?.scrollToEnd({ animated: false });
          }}
        >
          {entries.length === 0 ? (
            <Text style={styles.emptyText}>等待输出…</Text>
          ) : (
            entries.map((entry) => <EntryView key={entry.key} entry={entry} theme={theme} />)
          )}
        </ScrollView>
      )}

      {embedded || agentId == null ? null : (
      <>
      {sendStatus ? (
        <View style={styles.sendStatusBar}>
          <Text style={styles.sendStatusText}>{sendStatus}</Text>
        </View>
      ) : null}
      <View style={styles.footer}>
        <TextInput
          accessibilityLabel="发送消息"
          value={draft}
          multiline
          placeholder="发送消息…（Enter 发送，Shift+Enter 换行）"
          placeholderTextColor={theme.colors.foregroundMuted}
          onChangeText={setDraft}
          onFocus={onActivate}
          onKeyPress={handleKeyPress}
          style={styles.input}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="发送"
          disabled={!canSend}
          onPress={enqueue}
          style={canSend ? styles.sendButton : styles.sendButtonDisabled}
        >
          <Text style={canSend ? styles.sendText : styles.sendTextDisabled}>发送</Text>
        </Pressable>
      </View>
      </>
      )}
      </Pressable>
    </Animated.View>
  );
}
