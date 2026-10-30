/**
 * Paseo 内置工具清单（daemon 0.14）。只用于设置页展示；
 * 实际生效的是 `agents.providers.<providerId>.paseoTools`，由 daemon 在会话打开时解析。
 */
export type BuiltinToolGroup =
  | "system"
  | "workspace"
  | "agent"
  | "terminal"
  | "script"
  | "schedule"
  | "provider"
  | "browser";

export interface BuiltinTool {
  name: string;
  title: string;
  group: BuiltinToolGroup;
}

/** 展示顺序与中文类别名。 */
export const BUILTIN_TOOL_GROUPS: readonly { id: BuiltinToolGroup; label: string }[] = [
  { id: "system", label: "系统 / 语音" },
  { id: "workspace", label: "工作区" },
  { id: "agent", label: "Agent" },
  { id: "terminal", label: "终端" },
  { id: "script", label: "工作区脚本" },
  { id: "schedule", label: "日程 / 心跳" },
  { id: "provider", label: "Provider / 模型" },
  { id: "browser", label: "浏览器" },
];

export const BUILTIN_TOOLS: readonly BuiltinTool[] = [
  { name: "speak", title: "Speak", group: "system" },
  { name: "list_hosts", title: "List hosts", group: "system" },
  { name: "create_workspace", title: "Create workspace", group: "workspace" },
  { name: "list_workspaces", title: "List workspaces", group: "workspace" },
  { name: "archive_workspace", title: "Archive workspace", group: "workspace" },
  { name: "rename_workspace", title: "Rename workspace", group: "workspace" },
  { name: "create_agent", title: "Create agent", group: "agent" },
  { name: "send_agent_prompt", title: "Send agent prompt", group: "agent" },
  { name: "get_agent_status", title: "Get agent status", group: "agent" },
  { name: "get_agent_activity", title: "Get agent activity", group: "agent" },
  { name: "list_agents", title: "List agents", group: "agent" },
  { name: "cancel_agent", title: "Cancel agent run", group: "agent" },
  { name: "archive_agent", title: "Archive agent", group: "agent" },
  { name: "kill_agent", title: "Kill agent", group: "agent" },
  { name: "update_agent", title: "Update agent", group: "agent" },
  { name: "set_agent_mode", title: "Set agent session mode", group: "agent" },
  { name: "list_pending_permissions", title: "List pending permissions", group: "agent" },
  { name: "respond_to_permission", title: "Respond to permission", group: "agent" },
  { name: "list_terminals", title: "List terminals", group: "terminal" },
  { name: "create_terminal", title: "Create terminal", group: "terminal" },
  { name: "kill_terminal", title: "Kill terminal", group: "terminal" },
  { name: "capture_terminal", title: "Capture terminal", group: "terminal" },
  { name: "send_terminal_keys", title: "Send terminal keys", group: "terminal" },
  { name: "list_workspace_scripts", title: "List workspace scripts", group: "script" },
  { name: "start_workspace_script", title: "Start workspace script", group: "script" },
  { name: "stop_workspace_script", title: "Stop workspace script", group: "script" },
  { name: "create_schedule", title: "Create schedule", group: "schedule" },
  { name: "create_heartbeat", title: "Create heartbeat", group: "schedule" },
  { name: "delete_heartbeat", title: "Delete heartbeat", group: "schedule" },
  { name: "list_schedules", title: "List schedules", group: "schedule" },
  { name: "inspect_schedule", title: "Inspect schedule", group: "schedule" },
  { name: "pause_schedule", title: "Pause schedule", group: "schedule" },
  { name: "resume_schedule", title: "Resume schedule", group: "schedule" },
  { name: "delete_schedule", title: "Delete schedule", group: "schedule" },
  { name: "update_schedule", title: "Update schedule", group: "schedule" },
  { name: "schedule_logs", title: "Schedule logs", group: "schedule" },
  { name: "run_schedule_once", title: "Run schedule once", group: "schedule" },
  { name: "list_providers", title: "List providers", group: "provider" },
  { name: "list_models", title: "List models", group: "provider" },
  { name: "list_profiles", title: "List agent profiles", group: "provider" },
  { name: "inspect_provider", title: "Inspect provider", group: "provider" },
  { name: "browser_list_tabs", title: "List browser tabs", group: "browser" },
  { name: "browser_new_tab", title: "Create browser tab", group: "browser" },
  { name: "browser_snapshot", title: "Snapshot browser page", group: "browser" },
  { name: "browser_click", title: "Click browser element", group: "browser" },
  { name: "browser_fill", title: "Fill browser element", group: "browser" },
  { name: "browser_wait", title: "Wait for browser condition", group: "browser" },
  { name: "browser_type", title: "Type into browser", group: "browser" },
  { name: "browser_keypress", title: "Press browser key", group: "browser" },
  { name: "browser_navigate", title: "Navigate browser", group: "browser" },
  { name: "browser_screenshot", title: "Capture browser screenshot", group: "browser" },
  { name: "browser_upload", title: "Upload files in browser", group: "browser" },
  { name: "browser_select", title: "Select browser option", group: "browser" },
  { name: "browser_drag", title: "Drag browser element", group: "browser" },
  { name: "browser_logs", title: "Read browser logs", group: "browser" },
  { name: "browser_evaluate", title: "Evaluate browser JavaScript", group: "browser" },
  { name: "browser_scroll", title: "Scroll browser", group: "browser" },
  { name: "browser_resize", title: "Resize browser viewport", group: "browser" },
  { name: "browser_close_tab", title: "Close browser tab", group: "browser" },
];

/**
 * daemon 硬编码：speak 不受单个工具禁用影响，disabledTools 对它无效。
 * 注意 `enabled: false` 是整体关闭 paseo MCP server，此时 speak 也会一起下线。
 */
export const ALWAYS_ENABLED_TOOLS: ReadonlySet<string> = new Set(["speak"]);

export const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set(
  BUILTIN_TOOLS.map((tool) => tool.name),
);

export interface PaseoToolsPolicy {
  enabled?: boolean;
  disabledTools?: string[];
}

/** 与 daemon 的 `isPaseoToolPolicyEnabled` 一致：未配置视为开启。 */
export function isPolicyEnabled(policy: PaseoToolsPolicy | undefined): boolean {
  return policy?.enabled !== false;
}

/** 与 daemon 的 `isPaseoToolEnabled` 一致：speak 恒开，其余看开关与黑名单。 */
export function isToolEnabled(policy: PaseoToolsPolicy | undefined, name: string): boolean {
  if (ALWAYS_ENABLED_TOOLS.has(name)) return true;
  if (!isPolicyEnabled(policy)) return false;
  return !(policy?.disabledTools ?? []).includes(name);
}

/** 黑名单里保留清单外的名字（历史配置 / 未来新增工具），避免保存时丢配置。 */
export function unknownDisabledTools(policy: PaseoToolsPolicy | undefined): string[] {
  return (policy?.disabledTools ?? []).filter((name) => !BUILTIN_TOOL_NAMES.has(name));
}
