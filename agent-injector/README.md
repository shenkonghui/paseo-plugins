# agent-injector

在 **agent 创建时** 通过 `server.before("agent.create")` hook，为每个新 agent 注入：

1. **全局规则** → 写入 agent 的 `systemPrompt`（内联 markdown 和/或规则文件）
2. **额外 MCP server** → 合并进 `mcpServers`

配置在 Paseo 应用里，三种入口任选：

- **左侧菜单栏「Agent 注入」**（位于 Workspaces 上方）→ 打开全屏配置页
- **Settings → Plugins → agent-injector**
- **Command Center**「配置全局 agent 注入」

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
- 如果只是想给**所有** session（含 resume/refresh）追加一段系统提示，除了本插件，也可以直接用 daemon 原生配置 `daemon.appendSystemPrompt`。

## 安装

```bash
cd /root/workspaces/paseo-plugins
paseo plugin install /root/workspaces/paseo-plugins/agent-injector
paseo plugin ls
```

前提：`config.json` 中 `pluginsEnabled: true`，改动后 `paseo reload`。
