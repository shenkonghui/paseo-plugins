# agent-injector

在 **agent 创建时** 通过 `server.before("agent.create")` hook，为每个新 agent 注入：

1. **全局规则** → 写入 agent 的 `systemPrompt`（内联 markdown 和/或规则文件）
2. **额外 MCP server** → 合并进 `mcpServers`

配置在 Paseo 应用里，三种入口任选：

- **左侧菜单栏「Agent 扩展」**（位于 Workspaces 上方）→ 打开全屏配置页
- **Settings → Plugins → agent-injector**
- **Command Center**「配置 Agent 扩展」

---

## 配置项

| 字段 | 说明 |
| --- | --- |
| `enabled` | 总开关 |
| `providers` | provider 白名单，逗号/换行分隔；留空表示所有 provider。`codex` 可同时命中 `codex/gpt-5` |
| `rules` | 内联全局规则（markdown） |
| `ruleFiles` | 规则文件路径，每行一个，支持 `~`，按顺序拼接 |
| `prependRules` | `true` 时规则块放在 `systemPrompt` 最前面，否则追加到末尾 |
| `mcpServersJson` | MCP server 映射 JSON |
| `subagentEnabled` / `subagentCreateTool` | 子代理工具总开关 / 是否暴露 `create_subagent` |
| `subagentConfigMode` | `inherit` 继承父 agent，`custom` 按模型队列 |
| `subagentModelQueue` | 队列 JSON 数组，按顺序取第一个可用项；元素可为 `{provider, model?, modeId?, thinkingOptionId?}` 或 `{"inherit": true}` |
| `subagentFailureCooldownHours` | 队列项失败后的冷却时长（小时），默认 4，0 表示不跳过 |
| `autoTitleEnabled` | 根据对话自动更新 agent 标题，默认关闭 |
| `autoTitleTurns` | 每完成多少轮检查一次，默认 5；首轮完成后总会先跑一次 |
| `autoTitleIntervalMinutes` | 两次自动标题的最小间隔（分钟），默认 10，0 表示不限制 |
| `autoTitleWorkspace` | 自动标题时同步改写所在 workspace 标题，默认关闭 |

设置页还有一个 **内置工具** 区块，按 provider 控制 Paseo 自带工具（含浏览器工具）：可以整体开关，或在 41 个 paseo 工具 + 18 个浏览器工具的多选清单里勾选。清单按「系统 / 语音、工作区、Agent、终端、工作区脚本、日程 / 心跳、Provider / 模型、浏览器」分类，每个类别都有自己的全选 / 全不选，顶部另有全局全选 / 全不选。它写入 daemon 配置 `agents.providers.<providerId>.paseoTools = { enabled, disabledTools }`，不占用插件设置文件；单个禁用对 `speak` 无效，整体关闭时 `speak` 也会下线。改动在新建或重开会话后生效。

**子代理队列**：会话打开时向模型注入 `create_subagent`，模型配置优先按队列取第一个可用项（provider 可用、模型存在），队列支持 `{"inherit": true}` 兜底项。设置页里可添加、删除、拖动排序队列项，也可点 ✎ 就地修改已有项的 provider、模型、会话模式与思考档位。某项创建失败，或由它创建的子 agent 首轮运行失败，会按 `subagentFailureCooldownHours` 进入冷却并被跳过，到期自动恢复；成功的子 agent 会清除该项的失败记录。设置页里当前会选中项标绿并注「当前」，冷却 / 不可用项显示原因与剩余时间；「失败记录」弹窗列出冷却中的项、失败时间与恢复倒计时，支持单项或全部手动重置。运行状态存放在 `~/.paseo/plugin-data/agent-injector/subagent-queue.json`，不影响设置文件。

**自动标题**：插件无法直接修改 agent 标题（`update_agent` 只能由模型调用），因此每一轮结束后按「轮数 + 最小间隔」判断是否创建一个一次性的「自动标题」助手 agent：助手读取目标 agent 最近 12 条对话，调用内置 `update_agent` 改写标题，完成后自动归档。助手继承父 agent 的 provider/model，会产生额外调用，默认关闭。若 provider 把 `update_agent` 交给人工审批，插件会自动放行该请求，其它权限请求一律拒绝，避免助手停在 permission 状态卡住后续自动标题。开启 `autoTitleWorkspace` 后，插件会用新标题直接改写所在 workspace（`workspaces.ref().setTitle`），无需 `rename_workspace`（该工具在多数 provider 下被禁用）。用户手动改过 agent 标题后，该 agent 永久跳过自动改名。workspace 侧的状态按 workspace 记录（多个 agent 共用同一 workspace 时，彼此写入的标题都算「插件写的」，不会误判为手动改名），只有出现插件从未写过的标题才判定为手动并永久停写。状态存放在 `~/.paseo/plugin-data/agent-injector/auto-title.json`，插件按文件 mtime 失效内存缓存，手工修改该文件不会被打回。子代理与助手自身不参与自动标题。

配置文件（也可直接编辑，改完新开 agent 即生效）：
`~/.paseo/plugin-settings/agent-injector/injector.json`

## MCP server JSON 格式

支持两种写法，二选一：

**直接映射**

```json
{
  "company": {
    "type": "http",
    "url": "https://tools.example.com/mcp"
  },
  "local-fs": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"],
    "env": { "LOG_LEVEL": "warn" }
  }
}
```

**带 `mcpServers` 包裹**（Claude / Cursor 配置可直接粘贴）

```json
{
  "mcpServers": {
    "钉钉文档": {
      "type": "http",
      "url": "https://mcp-gw.dingtalk.com/oauth/server/doc"
    }
  }
}
```

`type: "http"` 即 MCP 的 Streamable HTTP；`sse` 为旧 SSE；`stdio` 为本地进程（`command` / `args` / `env`）。可选 `alwaysLoad: true`（仅 Claude provider 生效）。

> OAuth 类 HTTP MCP（如钉钉文档的 `/oauth/server/...`）由底层 CLI 自行完成授权；Pi provider 会被 Paseo 显式设为 `oauth: false`，不适用这类需要交互授权的服务。

## 全局规则文件示例

`~/.paseo/global-rules.md`：

```markdown
- 始终用中文回复。
- 改动代码后运行相关测试。
- 不要执行 `git push`，除非我明确要求。
```

然后在设置里把 `ruleFiles` 填成 `~/.paseo/global-rules.md`。

---

## 生效范围与限制

- 注入发生在 **agent 创建时**。已存在的 agent 不会自动获得新规则/MCP；需要重建 agent，或 `paseo agent reload <id>`（reload 使用已保存配置，规则仍不会变）——若要覆盖已有 agent，请重新创建。
- 跳过 daemon 内部工具 agent（`config.internal === true`，例如生成标题/commit message）。
- 名为 `paseo` 的 MCP server 会被 Paseo 内置 MCP 覆盖，避免使用该名字。
- provider 必须支持 `mcpServers`；不支持时该字段会被忽略或导致启动失败。ACP 类 provider 若无法接受 `mcpServers`，需在其 provider 定义里设 `params.supportsMcpServers: false`。
- Pi provider 需要 `pi-mcp-adapter` 扩展才能消费注入的 MCP。
- 自动标题依赖内置 MCP 工具 `update_agent`；在“内置工具”区块禁用它，标题助手就改不了名。
- 如果只是想给**所有** session（含 resume/refresh）追加一段系统提示，除了本插件，也可以直接用 daemon 原生配置 `daemon.appendSystemPrompt`。

## 安装

```bash
cd /root/workspaces/paseo-plugins
paseo plugin install /root/workspaces/paseo-plugins/agent-injector
paseo plugin ls
```

前提：`config.json` 中 `pluginsEnabled: true`，改动后 `paseo reload`。
