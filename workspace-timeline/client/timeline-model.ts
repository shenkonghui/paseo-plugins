/**
 * Pure timeline model: normalization, ordering, range filtering, colours and labels.
 * No React Native or host imports so it can be reasoned about (and unit tested) in isolation.
 */

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Fixed viewport widths. The window is centered on "today" and can be panned left / right. */
export type RangeId = "1d" | "3d" | "7d" | "30d";

export interface RangeOption {
  readonly id: RangeId;
  readonly label: string;
  readonly ms: number;
}

export const RANGE_OPTIONS: readonly RangeOption[] = [
  { id: "1d", label: "1 天", ms: DAY },
  { id: "3d", label: "3 天", ms: 3 * DAY },
  { id: "7d", label: "7 天", ms: 7 * DAY },
  { id: "30d", label: "30 天", ms: 30 * DAY },
];

/** Midpoint of the local day containing `now`: a 1-day window then shows exactly today. */
export function dayCenter(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime() + DAY / 2;
}

/** Fixed-width viewport centered on `center`. Panning moves the center instead of rescaling. */
export function windowDomain(center: number, span: number): Domain {
  const safe = Math.max(span, MINUTE);
  return { start: center - safe / 2, end: center + safe / 2, span: safe };
}

/** Structural subset of the host workspace descriptor this plugin reads. */
export interface WorkspaceLike {
  readonly id: string;
  readonly name?: string | null;
  readonly title?: string | null;
  readonly projectDisplayName?: string | null;
  readonly projectCustomName?: string | null;
  readonly workspaceDirectory?: string | null;
  readonly projectRootPath?: string | null;
  readonly status?: string | null;
  readonly workspaceKind?: string | null;
  readonly createdAt?: string | null;
  /** Always null on current daemons; kept so a future daemon starts working without a change. */
  readonly activityAt?: string | null;
  readonly statusEnteredAt?: string | null;
  readonly lastUserMessageAt?: string | null;
  readonly diffStat?: { readonly additions: number; readonly deletions: number } | null;
}

export type WorkspaceUpdateLike =
  | { readonly kind: "upsert"; readonly workspace: WorkspaceLike }
  | { readonly kind: "remove"; readonly id: string }
  | { readonly kind: string };

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/** Structural subset of an agent snapshot; agents are the timeline nodes now. */
export interface AgentLike {
  readonly id: string;
  readonly workspaceId?: string | null;
  readonly title?: string | null;
  readonly status?: string | null;
  readonly createdAt?: string | null;
  readonly updatedAt?: string | null;
  readonly lastUserMessageAt?: string | null;
  readonly archivedAt?: string | null;
  readonly internal?: boolean;
}

export interface AgentEntry {
  readonly id: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  /** Agent title, shown as the secondary title under the workspace name. */
  readonly name: string;
  readonly status: string;
  readonly start: number;
  readonly updatedAt: number;
  /** Archived agents still show on the timeline, grouped under「已归档」. */
  readonly archived: boolean;
}

export function workspaceLabel(workspace: WorkspaceLike): string {
  return workspace.title?.trim() || workspace.name?.trim() || "未命名 workspace";
}

/** One box per agent: workspace name is the primary title, agent title the secondary one. */
export function toAgentEntry(
  agent: AgentLike,
  workspaceNames: ReadonlyMap<string, string>,
  now: number,
): AgentEntry | null {
  if (agent.internal === true) return null;
  const workspaceId = agent.workspaceId?.trim();
  if (!workspaceId) return null;
  const created =
    parseTime(agent.createdAt) ?? parseTime(agent.lastUserMessageAt) ?? parseTime(agent.updatedAt) ?? now;
  // 归档 agent 的右端应为归档时间：归档本身也是最后一次状态变化。
  const updated = Math.max(
    created,
    parseTime(agent.updatedAt) ?? created,
    parseTime(agent.lastUserMessageAt) ?? created,
    parseTime(agent.archivedAt) ?? created,
  );
  return {
    id: agent.id,
    workspaceId,
    workspaceName: workspaceNames.get(workspaceId) ?? "未知 workspace",
    name: agent.title?.trim() || "未命名 agent",
    status: agent.status ?? "unknown",
    start: Math.min(created, updated),
    updatedAt: updated,
    archived: agent.archivedAt != null,
  };
}

export interface Domain {
  readonly start: number;
  readonly end: number;
  readonly span: number;
}

export interface AxisTick {
  readonly time: number;
}

/** 0 means the left edge of the axis, 100 means the right edge. */
export function timePercent(time: number, domain: Domain): number {
  return clamp(((time - domain.start) / domain.span) * 100, 0, 100);
}

/**
 * Ticks land on local midnights (day scale) or clock hours (hour scale) so labels read as dates
 * rather than as arbitrary offsets. Ticks too close to either edge are dropped: those edges carry
 * their own labels.
 */
export function axisTicks(domain: Domain, maxTicks = 6): AxisTick[] {
  const ticks =
    domain.span > 400 * DAY
      ? monthTicks(domain, maxTicks)
      : domain.span > 2 * DAY
        ? dayTicks(domain, maxTicks)
        : hourTicks(domain, maxTicks);
  return ticks.filter((tick) => {
    const fraction = (tick.time - domain.start) / domain.span;
    return fraction > 0.06 && fraction < 0.94;
  });
}

function pushTick(ticks: AxisTick[], time: number, domain: Domain): void {
  if (time < domain.start || time > domain.end) return;
  ticks.push({ time });
}

function dayTicks(domain: Domain, maxTicks: number): AxisTick[] {
  const stepDays = Math.max(1, Math.ceil(domain.span / DAY / maxTicks));
  const cursor = new Date(domain.start);
  cursor.setHours(0, 0, 0, 0);
  cursor.setDate(cursor.getDate() + stepDays);
  const ticks: AxisTick[] = [];
  while (cursor.getTime() <= domain.end) {
    pushTick(ticks, cursor.getTime(), domain);
    cursor.setDate(cursor.getDate() + stepDays);
  }
  return ticks;
}

function hourTicks(domain: Domain, maxTicks: number): AxisTick[] {
  const step = Math.max(1, Math.ceil(domain.span / HOUR / maxTicks)) * HOUR;
  const cursor = new Date(domain.start);
  cursor.setHours(0, 0, 0, 0);
  let time = cursor.getTime();
  while (time < domain.start) time += step;
  const ticks: AxisTick[] = [];
  for (; time <= domain.end; time += step) pushTick(ticks, time, domain);
  return ticks;
}

function monthTicks(domain: Domain, maxTicks: number): AxisTick[] {
  const months = domain.span / (30 * DAY);
  const stepMonths = Math.max(1, Math.ceil(months / maxTicks));
  const cursor = new Date(domain.start);
  cursor.setDate(1);
  cursor.setHours(0, 0, 0, 0);
  cursor.setMonth(cursor.getMonth() + 1);
  const ticks: AxisTick[] = [];
  while (cursor.getTime() <= domain.end) {
    pushTick(ticks, cursor.getTime(), domain);
    cursor.setMonth(cursor.getMonth() + stepMonths);
  }
  return ticks;
}

export function tickLabel(time: number, span: number): string {
  if (span <= 2 * DAY) return formatClock(time);
  if (span <= 400 * DAY) return formatDay(time);
  const date = new Date(time);
  return `${date.getFullYear()}/${date.getMonth() + 1}`;
}

/** The left edge of a short range needs the date too, or "19:30" reads as today. */
export function edgeLabel(time: number, span: number): string {
  if (span <= 2 * DAY) return `${formatDay(time)} ${formatClock(time)}`;
  return tickLabel(time, span);
}

const PALETTE = [
  "#4C8DFF",
  "#22C55E",
  "#F59E0B",
  "#EF4444",
  "#A855F7",
  "#14B8A6",
  "#EC4899",
  "#0EA5E9",
  "#84CC16",
  "#F97316",
  "#6366F1",
  "#06B6D4",
  "#D946EF",
  "#EAB308",
] as const;

function hash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Stable colour per workspace. When two workspaces hash to the same slot the later id takes the
 * next free slot, so neighbouring nodes stay distinguishable without shifting between renders.
 */
export function colorsFor(ids: readonly string[]): Record<string, string> {
  const used = new Set<number>();
  const colors: Record<string, string> = {};
  for (const id of [...ids].sort()) {
    let slot = hash(id) % PALETTE.length;
    for (let tries = 0; tries < PALETTE.length && used.has(slot); tries += 1) {
      slot = (slot + 1) % PALETTE.length;
    }
    used.add(slot);
    colors[id] = PALETTE[slot];
  }
  return colors;
}

export function applyWorkspaceUpdate(
  current: readonly WorkspaceLike[] | undefined,
  update: WorkspaceUpdateLike,
): readonly WorkspaceLike[] | undefined {
  if (!current) return current;
  if (update.kind === "remove") {
    const removed = (update as { readonly id: string }).id;
    return current.filter((workspace) => workspace.id !== removed);
  }
  if (update.kind !== "upsert") return current;
  const workspace = (update as { readonly workspace: WorkspaceLike }).workspace;
  const rest = current.filter((entry) => entry.id !== workspace.id);
  return [...rest, workspace];
}

export function formatClock(time: number): string {
  const date = new Date(time);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatDay(time: number): string {
  const date = new Date(time);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export function formatFull(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export function formatRelative(time: number, now: number): string {
  const delta = Math.max(0, now - time);
  if (delta < MINUTE) return "刚刚";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)} 分钟前`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)} 小时前`;
  if (delta < 30 * DAY) return `${Math.floor(delta / DAY)} 天前`;
  return formatDay(time);
}

export function formatDuration(ms: number): string {
  if (ms < MINUTE) return "不到 1 分钟";
  if (ms < HOUR) return `${Math.round(ms / MINUTE)} 分钟`;
  if (ms < DAY) return `${(ms / HOUR).toFixed(ms < 10 * HOUR ? 1 : 0)} 小时`;
  return `${(ms / DAY).toFixed(ms < 10 * DAY ? 1 : 0)} 天`;
}

/** Wheel zoom limits: from a few minutes to a whole year. */
export const MIN_ZOOM_SPAN = 5 * MINUTE;
export const MAX_ZOOM_SPAN = 365 * DAY;

export function clampZoomSpan(span: number): number {
  if (!Number.isFinite(span) || span <= 0) return DAY;
  return Math.min(MAX_ZOOM_SPAN, Math.max(MIN_ZOOM_SPAN, span));
}

export function formatSpan(ms: number): string {
  if (ms >= DAY) {
    const days = ms / DAY;
    return `${days >= 10 ? Math.round(days) : Math.round(days * 10) / 10} 天`;
  }
  if (ms >= HOUR) {
    const hours = ms / HOUR;
    return `${hours >= 10 ? Math.round(hours) : Math.round(hours * 10) / 10} 小时`;
  }
  return `${Math.max(1, Math.round(ms / MINUTE))} 分钟`;
}

export const STATUS_LABELS: Record<string, string> = {
  running: "运行中",
  initializing: "初始化",
  needs_input: "等待输入",
  attention: "待处理",
  error: "出错",
  failed: "失败",
  idle: "空闲",
  done: "已完成",
  closed: "已关闭",
  unknown: "未知",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

/** Section order: running first, then anything that needs attention / failed, idle and closed last. */
const STATUS_RANK: Record<string, number> = {
  running: 0,
  initializing: 1,
  needs_input: 2,
  attention: 3,
  error: 4,
  failed: 4,
  idle: 5,
  done: 6,
  closed: 7,
};

export function statusRank(status: string): number {
  return STATUS_RANK[status] ?? 8;
}

export interface TimelineSection<T> {
  readonly status: string;
  readonly label: string;
  readonly rows: readonly T[];
}

/**
 * Group lanes by status so the list reads top-down as running -> initializing / needs input ->
 * attention -> error -> idle -> done -> closed. Entries keep the incoming order inside a section.
 */
export function groupByStatus<T extends { readonly status: string }>(
  entries: readonly T[],
): TimelineSection<T>[] {
  const buckets = new Map<string, T[]>();
  for (const entry of entries) {
    const bucket = buckets.get(entry.status);
    if (bucket) bucket.push(entry);
    else buckets.set(entry.status, [entry]);
  }
  return [...buckets.entries()]
    .map(([status, rows]) => ({ status, label: statusLabel(status), rows }))
    .sort((left, right) => statusRank(left.status) - statusRank(right.status));
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Structural view of an agent timeline item; the plugin may not import the protocol package. */
export interface TimelineItemLike {
  readonly type?: string;
  readonly text?: string;
  readonly message?: string;
  readonly name?: string;
  readonly status?: string;
  readonly detail?: Record<string, unknown>;
}

/** One readable line from a timeline item, or null when the item says nothing useful. */
export function summarize(item: TimelineItemLike | null | undefined): string | null {
  if (!item) return null;
  switch (item.type) {
    case "assistant_message":
    case "reasoning":
      return lastLine(item.text);
    case "error":
    case "notification":
      return lastLine(item.message);
    case "tool_call":
      return toolLine(item);
    default:
      return null;
  }
}

function toolLine(item: TimelineItemLike): string | null {
  if (!item.name) return null;
  const detail = item.detail ?? {};
  const hint = ["command", "title", "label", "query", "filePath", "path"]
    .map((key) => detail[key])
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  const prefix = item.status === "running" ? "▸ " : "";
  const suffix = hint ? ` · ${truncate(hint.trim())}` : "";
  return `${prefix}${item.name}${suffix}`;
}

function truncate(text: string, limit = 140): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > limit ? `${cleaned.slice(0, limit - 1)}…` : cleaned;
}

function lastLine(text: string | undefined): string | null {
  if (!text) return null;
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("```"));
  const last = lines[lines.length - 1];
  if (!last) return null;
  const cleaned = last.replace(/^[#>\-*\s]+/, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.length > 140 ? `${cleaned.slice(0, 139)}…` : cleaned;
}
