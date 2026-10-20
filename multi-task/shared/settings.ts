import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * 一个「多任务」面板：绑定到某个 workspace。
 * id 用于去重与增删；面板内容取该 workspace 当前活跃的 agent（动态解析）。
 */
export const multiTaskViewSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  /** 面板视图：自绘对话流，或用 iframe 内嵌原生会话（仅 web/Electron 可用）。 */
  mode: z.enum(["stream", "embedded"]).default("stream"),
  /** 折叠到窗口底部的「最小化条」。 */
  collapsed: z.boolean().default(false),
});

export type MultiTaskView = z.output<typeof multiTaskViewSchema>;
export type MultiTaskViewMode = MultiTaskView["mode"];

export const multiTaskToolbarSizeSchema = z.enum(["compact", "comfortable"]).default("compact");
export type MultiTaskToolbarSize = z.output<typeof multiTaskToolbarSizeSchema>;

/** 面板列表持久化在宿主侧，所有客户端共享，刷新 / 重启不丢。 */
export const multiTaskSettings = defineSettings({
  id: "views",
  scope: "host",
  version: 3,
  schema: z.object({
    views: z.array(multiTaskViewSchema).default([]),
    /** 工具栏尺寸：compact 更矮（默认），comfortable 保留较大的间距。 */
    toolbarSize: multiTaskToolbarSizeSchema,
  }),
  // v1 是按 agent 存的（{id, agentId, workspaceId, mode}），v2 改为按 workspace；按 workspaceId 去重。
  // v2→v3 只新增 toolbarSize，校验时由 schema 默认值补齐。
  migrate(values, fromVersion) {
    if (fromVersion >= 2) return values;
    const raw = values as { views?: unknown } | null;
    const list = Array.isArray(raw?.views) ? raw.views : [];
    const seen = new Set<string>();
    const views: MultiTaskView[] = [];
    for (const entry of list) {
      const view = (entry ?? {}) as Record<string, unknown>;
      const workspaceId = typeof view.workspaceId === "string" ? view.workspaceId : "";
      if (workspaceId.length === 0 || seen.has(workspaceId)) continue;
      seen.add(workspaceId);
      views.push({
        id: typeof view.id === "string" && view.id.length > 0 ? view.id : makeViewId(),
        workspaceId,
        mode: view.mode === "embedded" ? "embedded" : "stream",
        collapsed: false,
      });
    }
    return { views };
  },
});

export function makeViewId(): string {
  return `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
