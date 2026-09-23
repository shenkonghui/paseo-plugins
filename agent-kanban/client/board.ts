export type KanbanColumnId = "todo" | "running" | "done" | "closed";

export interface KanbanColumn {
  id: KanbanColumnId;
  title: string;
}

export const KANBAN_COLUMNS: readonly KanbanColumn[] = [
  { id: "todo", title: "未开始" },
  { id: "running", title: "进行中" },
  { id: "done", title: "已完成" },
  { id: "closed", title: "已关闭" },
];

/** Label key carrying the deferred prompt on kanban-created agents. */
export const PENDING_PROMPT_LABEL = "agent-kanban.prompt";

/** Structural subset of the daemon's agent snapshot so grouping stays testable. */
export interface KanbanAgent {
  id: string;
  title: string | null;
  provider: string;
  model?: string | null;
  cwd: string;
  workspaceId?: string | null;
  status: "initializing" | "idle" | "running" | "error" | "closed";
  lastUserMessageAt: string | null;
  labels?: Record<string, string>;
  requiresAttention?: boolean;
  attentionReason?: "finished" | "error" | "permission" | null;
  pendingPermissions?: readonly unknown[];
  archivedAt?: string | null;
  updatedAt: string;
}

export interface KanbanCard {
  id: string;
  title: string;
  providerLabel: string;
  workspaceName: string | null;
  badgeLabel: string | null;
  badgeTone: "warning" | "danger" | null;
  pendingPrompt: string | null;
  updatedAt: string;
}

function awaitsPermission(agent: KanbanAgent): boolean {
  return (agent.pendingPermissions?.length ?? 0) > 0 || agent.attentionReason === "permission";
}

export function columnFor(agent: KanbanAgent): KanbanColumnId {
  if (agent.archivedAt != null) return "closed";
  if (awaitsPermission(agent)) return "running";
  if (agent.status === "initializing" || agent.lastUserMessageAt == null) return "todo";
  if (agent.status === "running") return "running";
  return "done";
}

function basename(cwd: string): string {
  return cwd.split(/[\\/]/).findLast((part) => part.length > 0) ?? cwd;
}

function badge(agent: KanbanAgent): Pick<KanbanCard, "badgeLabel" | "badgeTone"> {
  if (awaitsPermission(agent)) return { badgeLabel: "需要授权", badgeTone: "warning" };
  if (agent.status === "error" || agent.attentionReason === "error")
    return { badgeLabel: "出错", badgeTone: "danger" };
  return { badgeLabel: null, badgeTone: null };
}

export function groupAgents(
  agents: Iterable<KanbanAgent>,
  workspaceNames: ReadonlyMap<string, string>,
): ReadonlyMap<KanbanColumnId, KanbanCard[]> {
  const board = new Map<KanbanColumnId, KanbanCard[]>();
  for (const column of KANBAN_COLUMNS) board.set(column.id, []);
  for (const agent of agents) {
    const column = columnFor(agent);
    const workspaceName = agent.workspaceId
      ? (workspaceNames.get(agent.workspaceId) ?? null)
      : null;
    board.get(column)!.push({
      id: agent.id,
      title: agent.title ?? workspaceName ?? basename(agent.cwd),
      providerLabel: agent.model ? `${agent.provider} · ${agent.model}` : agent.provider,
      workspaceName,
      ...badge(agent),
      // The pending prompt only matters while the agent has never been prompted;
      // once sent, lastUserMessageAt is set and the start affordance hides.
      pendingPrompt:
        agent.lastUserMessageAt == null ? (agent.labels?.[PENDING_PROMPT_LABEL] ?? null) : null,
      updatedAt: agent.updatedAt,
    });
  }
  for (const cards of board.values()) {
    cards.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  return board;
}

export function formatRelativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return "刚刚";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}
