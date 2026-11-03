import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, Loading } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useAgentList } from "./agent-data";
import { useLiveOutput } from "./live-output";
import {
  RANGE_OPTIONS,
  axisTicks,
  clampZoomSpan,
  colorsFor,
  dayCenter,
  edgeLabel,
  formatClock,
  formatDuration,
  formatFull,
  formatRelative,
  formatSpan,
  groupByStatus,
  statusLabel,
  tickLabel,
  timePercent,
  toAgentEntry,
  windowDomain,
  workspaceLabel,
  type AgentEntry,
  type Domain,
} from "./timeline-model";
import { useWorkspaceTimeline } from "./workspace-data";

const NOW_REFRESH_MS = 30_000;
const TICK_COUNT = 6;
const DEFAULT_SPAN = 24 * 60 * 60_000;

type PluginTheme = PluginScreenProps["theme"];

interface PointerLike {
  button?: number;
  clientX?: number;
  clientY?: number;
  deltaY?: number;
  deltaMode?: number;
  shiftKey?: boolean;
  preventDefault?(): void;
}

type DomListener = (event: PointerLike) => void;

interface DomEventTarget {
  addEventListener(
    type: string,
    listener: DomListener,
    options?: boolean | { capture?: boolean; passive?: boolean },
  ): void;
  removeEventListener(
    type: string,
    listener: DomListener,
    options?: boolean | { capture?: boolean; passive?: boolean },
  ): void;
  getBoundingClientRect?(): { left: number; top: number; width: number };
}

function laneStyles(
  theme: PluginTheme,
  compact: boolean,
  rowHeight: number,
  boxMinWidth: number,
  boxHeight: number,
) {
  return {
    screen: {
      flex: 1,
      backgroundColor: theme.colors.surface0,
      paddingHorizontal: compact ? 12 : 20,
      paddingTop: compact ? 12 : 18,
      paddingBottom: compact ? 8 : 14,
      gap: compact ? 8 : 12,
    },
    header: { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: 12 },
    title: { color: theme.colors.foreground, fontSize: compact ? 18 : 21, fontWeight: "600" as const },
    meta: { color: theme.colors.foregroundMuted, fontSize: 13, marginTop: 2 },
    controls: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 6,
      flexWrap: "wrap" as const,
    },
    pill: {
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    pillActive: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
    pillLabel: { color: theme.colors.foreground, fontSize: 13 },
    pillLabelActive: { color: theme.colors.accentForeground, fontSize: 13 },
    iconButton: {
      height: 30,
      minWidth: 30,
      paddingHorizontal: 8,
      borderRadius: 8,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      backgroundColor: theme.colors.surface1,
    },
    timelineArea: { flex: 1 },
    panGroup: { flexDirection: "row" as const, alignItems: "center" as const, gap: 4 },
    panIcon: { color: theme.colors.foreground, fontSize: 14 },
    axis: { height: 20, justifyContent: "flex-end" as const },
    axisLabel: { position: "absolute" as const, bottom: 0, fontSize: 11 },
    scroll: { flex: 1 },
    canvas: { position: "relative" as const },
    grid: { position: "absolute" as const, left: 0, right: 0, top: 0, bottom: 0 },
    gridLine: {
      position: "absolute" as const,
      top: 0,
      bottom: 0,
      width: 1,
      backgroundColor: theme.colors.border,
    },
    nowLine: {
      position: "absolute" as const,
      top: 0,
      bottom: 0,
      width: 1,
      backgroundColor: theme.colors.accent,
      opacity: 0.7,
    },
    row: { height: rowHeight, justifyContent: "center" as const },
    rowCanvas: {
      flex: 1,
      height: rowHeight,
      justifyContent: "center" as const,
      overflow: "hidden" as const,
    },
    /** 时间条最小宽度：跨度不足时向左延展，右端仍精确对准更新时间。 */
    boxMinWidth,
    box: {
      position: "absolute" as const,
      top: (rowHeight - boxHeight) / 2,
      height: boxHeight,
      borderRadius: 8,
      borderWidth: 2,
      paddingHorizontal: 8,
      paddingVertical: compact ? 4 : 5,
      gap: 1,
      justifyContent: "center" as const,
    },
    boxName: {
      color: theme.colors.foreground,
      fontSize: compact ? 12 : 13,
      fontWeight: "600" as const,
      textAlign: "right" as const,
    },
    boxAgent: {
      color: theme.colors.foregroundMuted,
      fontSize: compact ? 11 : 12,
      textAlign: "right" as const,
    },
    boxMeta: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "flex-end" as const,
      gap: 4,
    },
    boxMetaText: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
      flexShrink: 1,
      textAlign: "right" as const,
    },
    boxTail: {
      color: theme.colors.foregroundMuted,
      fontSize: compact ? 10 : 11,
      textAlign: "right" as const,
    },
    boxTailLive: {
      color: theme.colors.foreground,
      fontSize: compact ? 10 : 11,
      textAlign: "right" as const,
    },
    sectionHeader: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 6,
      height: 22,
      paddingHorizontal: 2,
      // 盖住背后的时间网格线，让分区标题读起来干净一些。
      backgroundColor: theme.colors.surface0,
    },
    sectionTitle: { fontSize: 12, fontWeight: "600" as const },
    sectionCount: { color: theme.colors.foregroundMuted, fontSize: 11 },
    sectionRule: { flex: 1, height: 1, backgroundColor: theme.colors.border },
    statusDot: { width: 6, height: 6, borderRadius: 3 },
    centered: {
      flex: 1,
      justifyContent: "center" as const,
      alignItems: "center" as const,
      gap: 6,
    },
    footer: { borderTopWidth: 1, borderColor: theme.colors.border, paddingTop: 10, gap: 5 },
    footerTitle: { flex: 1, color: theme.colors.foreground, fontSize: 14, fontWeight: "600" as const },
    footerText: { color: theme.colors.foregroundMuted, fontSize: 12 },
    hint: { color: theme.colors.foregroundMuted, fontSize: 12, textAlign: "center" as const },
    open: {
      marginLeft: "auto" as const,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 8,
      backgroundColor: theme.colors.accent,
    },
    openLabel: { color: theme.colors.accentForeground, fontSize: 13 },
  };
}

type LaneStyles = ReturnType<typeof laneStyles>;

export function WorkspaceTimelineScreen({ theme, layout, navigation, host }: PluginScreenProps) {
  const compact = layout.compact;
  const boxMinWidth = compact ? 160 : 190;
  const boxHeight = compact ? 88 : 96;
  const rowHeight = boxHeight + 6;

  const [span, setSpan] = useState(DEFAULT_SPAN);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [canvasWidth, setCanvasWidth] = useState(0);
  // null = 窗口居中在今天；拖动 / 缩放后固定为绝对中心时间。
  const [center, setCenter] = useState<number | null>(null);

  const styles = useMemo(
    () => laneStyles(theme, compact, rowHeight, boxMinWidth, boxHeight),
    [theme, compact, rowHeight, boxMinWidth, boxHeight],
  );

  const {
    entries: workspaces,
    truncated,
    isInitialLoading,
    isRefreshing,
    error,
    syncedAt,
    refresh,
  } = useWorkspaceTimeline(host.id);
  const agents = useAgentList();

  const workspaceNames = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspaceLabel(workspace)])),
    [workspaces],
  );

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), NOW_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const viewSpan = clampZoomSpan(span);
  const effectiveCenter = center ?? dayCenter(now);
  const domain = useMemo(
    () => windowDomain(effectiveCenter, viewSpan),
    [effectiveCenter, viewSpan],
  );

  const lanes = useMemo(() => {
    const nodes = agents
      .map((agent) => toAgentEntry(agent, workspaceNames, now))
      .filter((entry): entry is AgentEntry => entry !== null);
    // 固定窗口：默认整天居中在今天，左右拖动只移动窗口中心，滚轮改变窗口宽度（缩放）。
    const visible = nodes
      .filter((entry) => entry.updatedAt >= domain.start && entry.updatedAt <= domain.end)
      .sort((left, right) => right.updatedAt - left.updatedAt);
    // 同一个 workspace 的 agent 用同一种颜色，扫一眼就能看出归属。
    const workspaceIds = [...new Set(visible.map((entry) => entry.workspaceId))];
    const active = visible.filter((entry) => !entry.archived);
    const archived = visible.filter((entry) => entry.archived);
    return {
      domain,
      rows: visible,
      // 按状态上下分区：运行中始终在最上面，其余按待处理 / 出错 / 空闲 / 已完成排序；归档垫底。
      sections: [
        ...groupByStatus(active),
        ...(archived.length > 0
          ? [{ status: "archived", label: "已归档", rows: archived }]
          : []),
      ],
      ticks: axisTicks(domain, compact ? 4 : TICK_COUNT),
      colors: colorsFor(workspaceIds),
    };
  }, [agents, workspaceNames, now, domain, compact]);

  const liveAgentIds = useMemo(
    () =>
      lanes.rows
        .filter((entry) => entry.status === "running" && !entry.archived)
        .map((entry) => entry.id),
    [lanes.rows],
  );
  const liveLines = useLiveOutput(liveAgentIds);

  const dragAreaRef = useRef<View>(null);
  const scrollRef = useRef<ScrollView>(null);
  const scrollY = useRef(0);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    startCenter: number;
    panned: boolean;
  } | null>(null);
  // 拖动结束后短时间内忽略点选，避免「拖一下」被当成点击方框。
  const lastPanAt = useRef(0);
  // pointermove / wheel 里读最新值，避免 span / 宽度变化时反复重挂监听。
  const panInfoRef = useRef({ center: effectiveCenter, span: viewSpan, width: canvasWidth });
  panInfoRef.current = { center: effectiveCenter, span: viewSpan, width: canvasWidth };

  const shiftWindow = useCallback((direction: number) => {
    setCenter(
      (current) => (current ?? dayCenter(Date.now())) + direction * panInfoRef.current.span * 0.4,
    );
  }, []);

  const resetToToday = useCallback(() => {
    setNow(Date.now());
    setCenter(null);
  }, []);

  // 拖动 / 滚轮时最多每 16ms 触发一次重渲染。
  const panTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCenter = useRef<number | null>(null);
  const queueCenter = useCallback((value: number) => {
    pendingCenter.current = value;
    if (panTimer.current != null) return;
    panTimer.current = setTimeout(() => {
      panTimer.current = null;
      const next = pendingCenter.current;
      if (next != null) setCenter(next);
    }, 16);
  }, []);

  useEffect(() => {
    const target = globalThis as unknown as DomEventTarget | null;
    if (!target || typeof target.addEventListener !== "function") return;
    const node = dragAreaRef.current as unknown as DomEventTarget | null;

    const onDown = (event: PointerLike) => {
      if (event.button != null && event.button !== 0) return;
      dragRef.current = {
        startX: event.clientX ?? 0,
        startY: event.clientY ?? 0,
        startCenter: panInfoRef.current.center,
        panned: false,
      };
    };
    const onMove = (event: PointerLike) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = (event.clientX ?? 0) - drag.startX;
      const dy = (event.clientY ?? 0) - drag.startY;
      if (!drag.panned) {
        if (Math.abs(dx) < 4) return;
        // 竖向手势留给列表滚动，不抢。
        if (Math.abs(dy) > Math.abs(dx)) {
          dragRef.current = null;
          return;
        }
        drag.panned = true;
      }
      const info = panInfoRef.current;
      if (info.width <= 0) return;
      lastPanAt.current = Date.now();
      queueCenter(drag.startCenter - (dx * info.span) / info.width);
    };
    const onUp = () => {
      dragRef.current = null;
    };
    // 滚轮缩放：以指针所在时间为锚点，改窗口宽度而不是改比例尺上限。
    const onWheel = (event: PointerLike) => {
      const delta = event.deltaY ?? 0;
      if (delta === 0) return;
      event.preventDefault?.();
      // Shift+滚轮保留纵向滚动，否则轨道多时没法上下翻。
      if (event.shiftKey) {
        const step = (event.deltaMode ?? 0) === 1 ? 16 : 1;
        scrollRef.current?.scrollTo({
          y: Math.max(0, scrollY.current + delta * step),
          animated: false,
        });
        return;
      }
      const info = panInfoRef.current;
      if (info.width <= 0) return;
      const rect = node?.getBoundingClientRect?.();
      const fraction =
        rect && rect.width > 0
          ? Math.min(1, Math.max(0, ((event.clientX ?? rect.left) - rect.left) / rect.width))
          : 0.5;
      const anchor = info.center - info.span / 2 + fraction * info.span;
      // deltaMode 1 是「按行」滚动（Firefox），换算成像素量级。
      const scale = (event.deltaMode ?? 0) === 1 ? 16 : 1;
      const nextSpan = clampZoomSpan(info.span * Math.exp(delta * scale * 0.0015));
      const nextCenter = anchor + (0.5 - fraction) * nextSpan;
      setSpan(nextSpan);
      setCenter(nextCenter);
    };

    if (node && typeof node.addEventListener === "function") {
      // 捕获阶段：轨道整行都是 Pressable，冒泡阶段可能被它拦掉。
      node.addEventListener("pointerdown", onDown, true);
      node.addEventListener("wheel", onWheel, { passive: false });
    }
    target.addEventListener("pointermove", onMove, true);
    target.addEventListener("pointerup", onUp, true);
    target.addEventListener("pointercancel", onUp, true);

    return () => {
      if (node && typeof node.removeEventListener === "function") {
        node.removeEventListener("pointerdown", onDown, true);
        node.removeEventListener("wheel", onWheel, { passive: false });
      }
      target.removeEventListener("pointermove", onMove, true);
      target.removeEventListener("pointerup", onUp, true);
      target.removeEventListener("pointercancel", onUp, true);
      if (panTimer.current != null) {
        clearTimeout(panTimer.current);
        panTimer.current = null;
      }
    };
  }, [queueCenter]);

  const selected = lanes.rows.find((entry) => entry.id === selectedId) ?? null;
  const latest = lanes.rows[0]?.updatedAt ?? null;
  const runningCount =
    lanes.sections.find((section) => section.status === "running")?.rows.length ?? 0;
  const archivedCount =
    lanes.sections.find((section) => section.status === "archived")?.rows.length ?? 0;

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Workspace 时间线</Text>
          <Text style={styles.meta}>
            {lanes.rows.length} 个 agent · 窗口 {formatSpan(viewSpan)}
            {runningCount > 0 ? ` · ${runningCount} 个运行中` : ""}
            {archivedCount > 0 ? ` · ${archivedCount} 个已归档` : ""}
            {latest ? ` · 最近更新 ${formatRelative(latest, now)}` : ""}
            {isRefreshing ? " · 更新中…" : syncedAt ? ` · 缓存 ${formatClock(syncedAt)}` : ""}
            {truncated ? " · 仅显示前 200 个" : ""}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="刷新列表"
          onPress={refresh}
          style={styles.iconButton}
        >
          <Icon name="RefreshCw" size={15} color={theme.colors.foreground} />
        </Pressable>
      </View>

      <View style={styles.controls}>
        {RANGE_OPTIONS.map((option) => {
          const active = Math.abs(span - option.ms) < option.ms * 0.02;
          return (
            <Pressable
              key={option.id}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`窗口跨度 ${option.label}`}
              onPress={() => setSpan(option.ms)}
              style={[styles.pill, active ? styles.pillActive : null]}
            >
              <Text style={active ? styles.pillLabelActive : styles.pillLabel}>{option.label}</Text>
            </Pressable>
          );
        })}
        <View style={styles.panGroup}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="向前平移时间窗口"
            onPress={() => shiftWindow(-1)}
            style={styles.iconButton}
          >
            <Text style={styles.panIcon}>‹</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="回到今天"
            onPress={resetToToday}
            style={styles.pill}
          >
            <Text style={styles.pillLabel}>今天</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="向后平移时间窗口"
            onPress={() => shiftWindow(1)}
            style={styles.iconButton}
          >
            <Text style={styles.panIcon}>›</Text>
          </Pressable>
        </View>
      </View>

      <View ref={dragAreaRef} style={styles.timelineArea}>
        <View
          style={styles.axis}
          onLayout={(event) => setCanvasWidth(event.nativeEvent.layout.width)}
        >
          <Text style={[styles.axisLabel, { left: 0, color: theme.colors.foregroundMuted }]}>
            {edgeLabel(lanes.domain.start, lanes.domain.span)}
          </Text>
          {lanes.ticks.map((tick) => (
            <Text
              key={tick.time}
              style={[
                styles.axisLabel,
                {
                  left: `${timePercent(tick.time, lanes.domain)}%`,
                  width: 48,
                  marginLeft: -24,
                  textAlign: "center",
                  color: theme.colors.foregroundMuted,
                },
              ]}
            >
              {tickLabel(tick.time, lanes.domain.span)}
            </Text>
          ))}
          {now >= lanes.domain.start && now <= lanes.domain.end ? (
            <Text
              style={[
                styles.axisLabel,
                {
                  left: `${timePercent(now, lanes.domain)}%`,
                  width: 32,
                  marginLeft: -16,
                  textAlign: "center",
                  color: theme.colors.accent,
                },
              ]}
            >
              现在
            </Text>
          ) : null}
          <Text style={[styles.axisLabel, { right: 0, color: theme.colors.foregroundMuted }]}>
            {edgeLabel(lanes.domain.end, lanes.domain.span)}
          </Text>
        </View>

        {error ? (
          <View style={styles.centered}>
            <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>加载失败：{error}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="重试加载"
              onPress={refresh}
              style={[styles.iconButton, { width: 88 }]}
            >
              <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>重试</Text>
            </Pressable>
          </View>
        ) : isInitialLoading && lanes.rows.length === 0 ? (
          <View style={{ flex: 1, justifyContent: "center" }}>
            <Loading />
          </View>
        ) : lanes.rows.length === 0 ? (
          <View style={styles.centered}>
            <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>
              这个时间范围内没有 agent
            </Text>
            <Text style={styles.footerText}>左右拖动可以看其他时间，或点「今天」回到当天</Text>
          </View>
        ) : (
          <ScrollView
            ref={scrollRef}
            style={styles.scroll}
            contentContainerStyle={{ paddingBottom: 8 }}
            scrollEventThrottle={16}
            onScroll={(event) => {
              scrollY.current = event.nativeEvent.contentOffset.y;
            }}
          >
            <View style={styles.canvas}>
              <View style={styles.grid} pointerEvents="none">
                {lanes.ticks.map((tick) => (
                  <View
                    key={tick.time}
                    style={[styles.gridLine, { left: `${timePercent(tick.time, lanes.domain)}%` }]}
                  />
                ))}
                {now >= lanes.domain.start && now <= lanes.domain.end ? (
                  <View style={[styles.nowLine, { left: `${timePercent(now, lanes.domain)}%` }]} />
                ) : null}
              </View>
              {lanes.sections.map((section) => (
                <View key={section.status}>
                  <View style={styles.sectionHeader}>
                    <View
                      style={[
                        styles.statusDot,
                        { backgroundColor: statusColor(section.status, theme) },
                      ]}
                    />
                    <Text style={[styles.sectionTitle, { color: statusColor(section.status, theme) }]}>
                      {section.label}
                    </Text>
                    <Text style={styles.sectionCount}>{section.rows.length}</Text>
                    <View style={styles.sectionRule} />
                  </View>
                  {section.rows.map((entry) => (
                    <Lane
                      key={entry.id}
                      entry={entry}
                      domain={lanes.domain}
                      canvasWidth={canvasWidth}
                      color={lanes.colors[entry.workspaceId] ?? theme.colors.accent}
                      selected={entry.id === selectedId}
                      liveLine={liveLines[entry.id] ?? null}
                      now={now}
                      theme={theme}
                      styles={styles}
                      onPress={() => {
                        if (Date.now() - lastPanAt.current < 200) return;
                        setSelectedId(entry.id === selectedId ? null : entry.id);
                      }}
                    />
                  ))}
                </View>
              ))}
            </View>
          </ScrollView>
        )}
      </View>

      {selected ? (
        <DetailFooter
          entry={selected}
          liveLine={liveLines[selected.id] ?? null}
          now={now}
          theme={theme}
          styles={styles}
          onClose={() => setSelectedId(null)}
          onOpen={
            navigation?.openAgent
              ? () => navigation.openAgent({ agentId: selected.id })
              : undefined
          }
        />
      ) : (
        <Text style={styles.hint}>
          滚轮缩放 · Shift+滚轮上下滚动 · 左右拖动平移 · 点方框看详情
        </Text>
      )}
    </View>
  );
}

function Lane({
  entry,
  domain,
  canvasWidth,
  color,
  selected,
  liveLine,
  now,
  theme,
  styles,
  onPress,
}: {
  entry: AgentEntry;
  domain: Domain;
  canvasWidth: number;
  color: string;
  selected: boolean;
  liveLine: string | null;
  now: number;
  theme: PluginTheme;
  styles: LaneStyles;
  onPress: () => void;
}) {
  // 右端 = 更新时间；左端 = 开始时间。跨度过短时保留最小宽度（向左延展，右端不动）。
  const startX = Math.max(0, (timePercent(entry.start, domain) / 100) * canvasWidth);
  const endX = (timePercent(entry.updatedAt, domain) / 100) * canvasWidth;
  const left = Math.max(0, Math.min(startX, endX - styles.boxMinWidth));
  const width = Math.max(2, endX - left);
  const running = entry.status === "running" && !entry.archived;
  const tail = entry.archived
    ? `归档于 ${formatRelative(entry.updatedAt, now)}`
    : running
      ? (liveLine ?? "运行中，等待输出…")
      : `上次更新 ${formatRelative(entry.updatedAt, now)}`;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${entry.workspaceName}，${entry.name}，${agentLabel(entry)}，${formatRelative(entry.updatedAt, now)}`}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={styles.row}
    >
      <View style={styles.rowCanvas}>
        {canvasWidth > 0 ? (
          <View
            style={[
              styles.box,
              {
                left,
                width,
                borderColor: color,
                backgroundColor: selected ? theme.colors.surface2 : theme.colors.surface1,
                borderWidth: selected ? 3 : 2,
              },
            ]}
          >
            <Text numberOfLines={1} style={styles.boxName}>
              {entry.workspaceName}
            </Text>
            <Text numberOfLines={1} style={styles.boxAgent}>
              {entry.name}
            </Text>
            <View style={styles.boxMeta}>
              <View style={[styles.statusDot, { backgroundColor: agentColor(entry, theme) }]} />
              <Text numberOfLines={1} style={styles.boxMetaText}>
                <Text style={{ color: agentColor(entry, theme), fontWeight: "600" }}>
                  {agentLabel(entry)}
                </Text>
                {" · "}
                {formatClock(entry.updatedAt)}
              </Text>
            </View>
            <Text numberOfLines={1} style={running && liveLine ? styles.boxTailLive : styles.boxTail}>
              {tail}
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

function DetailFooter({
  entry,
  liveLine,
  now,
  theme,
  styles,
  onClose,
  onOpen,
}: {
  entry: AgentEntry;
  liveLine: string | null;
  now: number;
  theme: PluginTheme;
  styles: LaneStyles;
  onClose: () => void;
  onOpen?: () => void;
}) {
  return (
    <View style={styles.footer}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View style={[styles.statusDot, { backgroundColor: agentColor(entry, theme) }]} />
        <Text numberOfLines={1} style={styles.footerTitle}>
          {entry.workspaceName}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="关闭详情"
          onPress={onClose}
          hitSlop={8}
        >
          <Icon name="X" size={14} color={theme.colors.foregroundMuted} />
        </Pressable>
      </View>
      <Text numberOfLines={1} style={styles.footerText}>
        {entry.name}
      </Text>
      <Text style={styles.footerText}>
        {agentLabel(entry)} · {formatFull(entry.updatedAt)}（
        {formatRelative(entry.updatedAt, now)}）
      </Text>
      {liveLine ? (
        <Text numberOfLines={2} style={styles.footerText}>
          输出：{liveLine}
        </Text>
      ) : null}
      <Text style={styles.footerText}>
        创建 {formatFull(entry.start)} · 跨度 {formatDuration(Math.max(0, entry.updatedAt - entry.start))}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        {onOpen ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`打开 agent ${entry.name}`}
            onPress={onOpen}
            style={styles.open}
          >
            <Text style={styles.openLabel}>打开 agent</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function agentLabel(entry: AgentEntry): string {
  return entry.archived ? "已归档" : statusLabel(entry.status);
}

function agentColor(entry: AgentEntry, theme: PluginTheme): string {
  return entry.archived
    ? theme.colors.foregroundMuted
    : statusColor(entry.status, theme);
}

function statusColor(status: string, theme: PluginTheme): string {
  if (status === "archived") return theme.colors.foregroundMuted;
  if (status === "running") return theme.colors.accent;
  if (status === "initializing") return theme.colors.statusWarning;
  if (status === "attention" || status === "needs_input") return theme.colors.statusWarning;
  if (status === "error" || status === "failed") return theme.colors.statusDanger;
  if (status === "done") return theme.colors.statusSuccess;
  return theme.colors.foregroundMuted;
}
