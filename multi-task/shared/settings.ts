import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * 一个「多任务」面板：绑定到某个 workspace。
 * id 用于去重与增删；面板内容取该 workspace 当前活跃的 agent（动态解析）。
 */
export const multiTaskViewSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  /** 折叠到窗口底部的「最小化条」。 */
  collapsed: z.boolean().default(false),
  /** 手动拖拽调整后的宽度权重（同一行内归一化）；缺省 = 均分。 */
  widthWeight: z.number().positive().optional(),
  /** 手动拖拽调整后的行高权重（同一行共用）；缺省 = 均分。 */
  heightWeight: z.number().positive().optional(),
});

export type MultiTaskView = z.output<typeof multiTaskViewSchema>;

export const multiTaskToolbarSizeSchema = z.enum(["compact", "comfortable"]).default("compact");
export type MultiTaskToolbarSize = z.output<typeof multiTaskToolbarSizeSchema>;

/** 面板列表持久化在宿主侧，所有客户端共享，刷新 / 重启不丢。 */
export const multiTaskSettings = defineSettings({
  id: "views",
  scope: "host",
  version: 5,
  schema: z.object({
    views: z.array(multiTaskViewSchema).default([]),
    /** 工具栏尺寸：compact 更矮（默认），comfortable 保留较大的间距。 */
    toolbarSize: multiTaskToolbarSizeSchema,
  }),
  // v1 是按 agent 存的（{id, agentId, workspaceId, mode}），v2 改为按 workspace；按 workspaceId 去重。
  // v2→v3 只新增 toolbarSize，校验时由 schema 默认值补齐。
  // v3→v4 去掉每个面板的 mode：面板只保留内嵌原生视图，旧数据里的 mode 由 schema 解析时自动剥离。
  // v4→v5 新增可选的 widthWeight / heightWeight：手动拖拽调节面板大小后持久化，缺省等价于均分。
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
        collapsed: false,
      });
    }
    return { views };
  },
});

export function makeViewId(): string {
  return `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
