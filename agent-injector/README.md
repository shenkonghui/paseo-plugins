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
| `subagentConfigMode` | `inherit` 继承父 agent；`custom` 按模型队列；`profile` 调用方在 `create_subagent` 传 `profileId` 或 `provider`/`model` 自选，仅允许命中 daemon 配置的 `agentProfiles` |
| `subagentModelQueue` | 队列 JSON 数组，按顺序取第一个可用项；元素可为 `{provider, model?, modeId?, thinkingOptionId?}` 或 `{"inherit": true}` |
| `subagentFailureCooldownHours` | 队列项失败后的冷却时长（小时），默认 4，0 表示不跳过 |
| `autoTitleEnabled` | 根据对话自动更新 agent 标题，默认关闭 |
| `autoTitleTurns` | 每完成多少轮检查一次，默认 5；首轮完成后总会先跑一次 |
| `autoTitleIntervalMinutes` | 两次自动标题的最小间隔（分钟），默认 10，0 表示不限制 |
| `autoTitleWorkspace` | 自动标题时同步改写所在 workspace 标题，默认关闭 |
| `autoTitleWorkspaceFirstTurn` | 首轮完成后，若标题助手改了 agent 标题则同步写一次 workspace 标题，默认关闭；独立于 `autoTitleWorkspace` |

设置页还有一个 **内置工具** 区块，按 provider 控制 Paseo 自带工具（含浏览器工具）：可以整体开关，或在 41 个 paseo 工具 + 18 个浏览器工具的多选清单里勾选。清单按「系统 / 语音、工作区、Agent、终端、工作区脚本、日程 / 心跳、Provider / 模型、浏览器」分类，每个类别都有自己的全选 / 全不选，顶部另有全局全选 / 全不选。它写入 daemon 配置 `agents.providers.<providerId>.paseoTools = { enabled, disabledTools }`，不占用插件设置文件；单个禁用对 `speak` 无效，整体关闭时 `speak` 也会下线。改动在新建或重开会话后生效。

**子代理队列**：会话打开时向模型注入 `create_subagent`。模型配置有三种来源（`subagentConfigMode`，也可由调用方在工具入参 `configMode` 里逐次覆盖）：`inherit` 继承父 agent；`custom` 按队列取第一个可用项（provider 可用、模型存在），队列支持 `{"inherit": true}` 兜底项；`profile` 放开给调用方自选——在工具入参里传 `profileId` 或 `provider`/`model`，服务端从 daemon `config.agentProfiles` 里匹配，命中才允许创建，mode/thinking/featureValues 取自该 profile，未匹配时报错并回可选清单（调用方可先用 `list_profiles` 查看有哪些 profile）。设置页里可添加、删除、拖动排序队列项，也可点 ✎ 就地修改已有项的 provider、模型、会话模式与思考档位。某项创建失败，或由它创建的子 agent 首轮运行失败，会按 `subagentFailureCooldownHours` 进入冷却并被跳过，到期自动恢复；成功的子 agent 会清除该项的失败记录。设置页里当前会选中项标绿并注「当前」，冷却 / 不可用项显示原因与剩余时间；「失败记录」弹窗列出冷却中的项、失败时间与恢复倒计时，支持单项或全部手动重置。运行状态存放在 `~/.paseo/plugin-data/agent-injector/subagent-queue.json`，不影响设置文件。

**自动标题**：插件无法直接修改 agent 标题（`update_agent` 只能由模型调用），因此每一轮结束后按「轮数 + 最小间隔」判断是否创建一个一次性的「自动标题」助手 agent：助手读取目标 agent 最近 5 轮**对话**（用户消息 + 助手回复，自动去掉围栏代码块；工具调用、命令输出不计），调用内置 `update_agent` 改写标题，完成后自动归档。标题要求不放在插件设置里，而是读所在仓库根目录 `paseo.json` 的 `metadataGeneration.title.instructions`（与 Paseo 自己生成 workspace 标题用的是同一份配置，整体替换内置要求行）；worktree / 子模块自己的 `paseo.json` 里读不到该字段时，顺着 `.git` 文件（`gitdir:` → `commondir`）回落到主检出的 `paseo.json` 再试一次；都读不到时用内置默认（中文、不超过 30 字）。助手继承父 agent 的 provider/model，会产生额外调用，默认关闭。若 provider 把 `update_agent` 交给人工审批，插件会自动放行该请求，其它权限请求一律拒绝，避免助手停在 permission 状态卡住后续自动标题。开启 `autoTitleWorkspace` 后，插件会用新标题直接改写所在 workspace（`workspaces.ref().setTitle`），无需 `rename_workspace`（该工具在多数 provider 下被禁用）。`autoTitleWorkspaceFirstTurn`（默认关闭）是单发版本：首轮助手改了 agent 标题时同步写一次 workspace，与 `autoTitleWorkspace` 的持续同步相互独立。用户手动改过 agent 标题后，该 agent 永久跳过自动改名。workspace 侧的状态按 workspace 记录（多个 agent 共用同一 workspace 时，彼此写入的标题都算「插件写的」，不会误判为手动改名），只有出现插件从未写过的标题才判定为手动并永久停写。状态存放在 `~/.paseo/plugin-data/agent-injector/auto-title.json`，插件按文件 mtime 失效内存缓存，手工修改该文件不会被打回。子代理与助手自身不参与自动标题。

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

---

## 后台进程 pill（进程树）

每个 agent 的 composer 上方会挂一个「**后台进程 N**」pill，点开是一个浮层，按进程树列出该 agent 当前实际在跑的进程：命令行、pid、运行时长、状态（运行 / 等待…）、cwd。有进程处于 `R` 时 pill 显示 `后台进程 运行中/总数`。

**怎么认领进程**：Paseo 不对外暴露 agent 进程 pid，但 daemon 启动 agent CLI 时会注入 `PASEO_AGENT_ID`（`agent-manager.ts`），而且子进程会继承。插件服务端因此扫描 `/proc/*/environ`，按 `PASEO_AGENT_ID=<agentId>` 精确认领，再取祖先链上没有任何同 agent 进程的那个 pid 作为根（ACP 进程、MCP server、Bash 命令都带同一个变量），最后按 `ppid` 收集全部后代。

- 一次 RPC 覆盖所有 agent，客户端只有一个轮询定时器：有子进程时 5s、全空闲 15s。
- **只显示第一级后台任务**：CLI 的直接子进程，以及父进程不属于本 agent 的顶层进程（CodeBuddy 的 Bash 命令由 daemon 直接 spawn）；更深的 `make` → `sh -c` → `ginkgo` → 测试二进制不再展开。一条 9 层的 e2e 链只占它最上层的 1 行。
- **过滤规则**：MCP server、CLI 内部 helper（`--internal-process-guard` 等）直接隐藏；**前台命令**也隐藏——它们的输出由 CLI 通过 pipe/socket 捕获，只保留输出重定向到文件、能持续查看的后台任务。代价是：没有重定向输出的后台任务也看不到（要支持这类任务，需要改成用 timeline 里 `running` 的 shell 工具调用来判定前台）。
- 归属按 `PASEO_AGENT_ID` 集合判定，而不是只沿 `ppid` 树：CodeBuddy 的 Bash 工具命令由 daemon 直接 spawn（ppid 是 daemon，不是 agent CLI），只沿树走会漏掉这些顶层进程；现在它们同样成组，CLI 本体按启动时间识别并排除。
- `/proc/<pid>/environ` 的解析结果按 `pid + starttime` 缓存，稳态下一次扫描约 30–80ms（几百个进程）。
- 只支持 Linux；其它平台 pill 不显示（浮层里会提示）。
- 目前不过滤 MCP server：它们也是 agent CLI 的子进程，所以只要会话开着，pill 至少显示 1 个。想只看真正的业务命令，需要再加命令白/黑名单。

**看 stdout / stderr**：浮层里每行右侧有「输出」，点一下在**右侧栏**（explorer）打开「后台进程输出」面板——面板里是完整界面：进程列表（可点切换）+ 选中进程的输出尾部（每 2s 刷新，默认读最后 32KB，显示大小与「仅显示尾部」标记，接近底部时自动跟随）。

- 面板注册为 agent 面板（`addAgentPanel`，`locations: ["workspace","explorer"]`），通过 `client.openPanel(..., { location: "explorer" })` 打开；同一个 agent 已开着就复用。
- 浮层只负责选进程：点击时先写选中状态再开面板，因此面板里能直接定位到刚点的那一行。
- 第一级进程常常是包装 shell（`bash -c python3 … > log`），它自己的 fd 可能是工具捕获用的 socket；服务端会往下探最多 6 层，取第一个把 stdout/stderr 重定向到文件的子进程作为 `outputPid`，面板按这个 pid 读输出（行上仍显示第一级命令）。
- 只有 **fd 重定向到普通文件** 时才读得到：Qoder 的后台任务就是这种（`/tmp/qoder-cli-*/…/tasks/<id>.output`），stdout 与 stderr 常指向同一个文件，这时只显示一个「stdout + stderr」块；不同文件则在面板顶部用 `stdout` / `stderr` 两个标签切换。
- 接在 `pipe:[…]` / `socket:[…]` 上的输出由 CLI 自己消费（CodeBuddy 的 Bash 工具就是 socket），插件无法旁路读取（打开 `pipe:` 只会拿到写端副本，拿不到已写入的数据；要抓只能 ptrace，代价和侵入性都不可接受）。面板里会直接标出 `stdout → socket:[…]（由 CLI 捕获，插件读不到）`。
- 读取前会校验该 pid 的环境变量里的 `PASEO_AGENT_ID` 与请求的 agent 一致，避免读到别的 agent 的进程输出。

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
