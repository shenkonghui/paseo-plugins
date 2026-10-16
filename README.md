# paseo-plugins

Paseo 本地插件合集。插件是无沙箱的信任代码:server 端在 daemon 机器上运行,安装前请确认你信任本仓库。

## 安装

要求 daemon ≥ 0.8.0,且 `config.json` 中 `pluginsEnabled: true`(改完执行 `paseo reload`)。

```bash
paseo plugin add shenkonghui/paseo-plugins:<插件目录>
paseo plugin ls
# 更新:
paseo plugin update <插件id>
```

## 插件列表

| 目录 | id | 说明 |
| --- | --- | --- |
| `assistant` | `assistant` | 左侧栏顶部「助理」入口 + `/send <消息>` 自动派发到现有 workspace 的 agent，右侧查看实时输出 |
| `multi-task` | `multi-task` | 左侧栏顶部「多任务」入口：自定义添加任意 workspace 的 agent 对话面板，并排实时查看与发送消息 |
| `worktree-browser` | `worktree-browser` | 列出项目的 git worktree / submodule,一键把 worktree 挂成 Paseo workspace |
| `agent-injector` | `agent-injector` | 为每个新建 agent 注入全局规则(systemPrompt)与额外 MCP server |
| `wiki` | `wiki` | 工作区 wiki 面板:文件树、markdown 渲染、mermaid flowchart 子集 |
| `agent-kanban` | `agent-kanban` | agent 看板面板 |
| `fix-skill` | `fix-skill` | 把 `~/.agents/skills` 与各项目 `.agents/skills` 注册成斜杠命令（pi 提交 `/skill:<name>`），动态跟随 agent 目录变化 |
| `port-forward` | `port-forward` | daemon 主机 TCP 端口转发与监听端口扫描:把服务器上(含仅 `127.0.0.1`)的服务暴露成本地可访问的 URL |
| `token-usage` | `token-usage` | Token 监控面板:读取 codebuddy / pi / opencode / devin 的本地数据,按 1/7/30 天展示 token 各维度用量、会话数、成本与柱状图 |

详细说明见各目录下的 `README.md`(`fix-skill` 暂无,直接看 `index.server.ts` / `index.client.tsx`)。
