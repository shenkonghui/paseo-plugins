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
| `worktree-browser` | `worktree-browser` | 列出项目的 git worktree / submodule,一键把 worktree 挂成 Paseo workspace |
| `wiki` | `wiki` | 工作区 wiki 面板:文件树、markdown 渲染、mermaid flowchart 子集 |
| `agent-kanban` | `agent-kanban` | agent 看板面板 |
| `fix-skill` | `fix-skill` | client + server + shared 三端结构示例 |

详细说明见各目录下的 `README.md`(`fix-skill` 暂无,直接看 `index.server.ts` / `index.client.tsx`)。
