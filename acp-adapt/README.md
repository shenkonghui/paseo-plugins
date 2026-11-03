# acp-adapt — ACP 子任务可见性

给 **ACP 协议的 agent**（Qoder、CodeBuddy 这类走 `--acp` 的 CLI）补一个 Paseo 内置能力：**子任务列表**。

## 为什么需要

Paseo 的 Subagents track 只由三个原生 adapter 喂数据：

| provider | 来源 |
| --- | --- |
| opencode | 子会话的 `parentID` |
| claude | sidechain / `task_notification` |
| pi | 扩展的 child-session |

ACP 链路没有这个通道，所以 Qoder 用 `Agent` 工具开出来的后台子 agent，在 Paseo 里只会显示成一张 `Think / Agent` 的普通工具卡——看不到有几个在跑、看不到状态，父 agent 还显示 idle。

这些子任务的真实状态 CLI 会落在本地磁盘上，本插件直接读它。

## 它做什么

- 每个 ACP agent 的 composer 上方多一条 pill：`子任务 2/5`（运行中/总数），点击展开面板
- 面板按「运行中优先 + 开始时间倒序」列出：状态点、任务描述、状态、耗时、开始时间、agent 类型、短 id
- 面板打开时 2.5s 刷新；关闭时按「有子任务在跑 3s / agent 在跑 5s / 全空闲 20s」三档轮询

## 数据来源

以 Qoder 为例：

```
~/.qoder-cn/projects/<cwd-slug>/<sessionId>/subagents/task-*.json
```

字段直接用 CLI 自己的：`taskId`、`agentId`、`agentType`、`description`、`status`、`createdAt`、`updatedAt`、`completedAt`、`summary`、`outputPath`。

`sessionId` 取自 Paseo 的 agent 记录（`~/.paseo/agents/<cwd-slug>/<agentId>.json` 里的 `persistence.sessionId`），不需要用户配置。

环境变量：`PASEO_HOME`（默认 `~/.paseo`）、`QODER_HOME`（默认 `~/.qoder-cn`）。

## 增加一个新 CLI

在 `server/stores.ts` 里实现 `SubagentStoreAdapter` 并加进 `adapters`：

```ts
export const codebuddyAdapter: SubagentStoreAdapter = {
  label: "codebuddy",
  matches: (provider) => provider.startsWith("codebuddy"),
  async list(sessionId) { /* 读它自己的任务存储，返回 SubagentRow[] */ },
};
```

同时在 `index.client.tsx` 的 `TRACKED_PROVIDER_PREFIXES` 里加上前缀（只影响客户端是否挂 pill）。

## 已知限制

- **不能点进子任务的过程**：CLI 只给父会话一个启动回执和产物文件路径，中间过程不上报，插件无法凭空重建时间线。
- **不能停止子任务**：停止要走 CLI 自己的 `TaskStop`，插件没有调用通道；需要停止时在对话里让 agent 停。
- **完成态依赖 CLI 的本地任务文件**：CLI 不写 `completedAt` 时会退化成 `updatedAt`。
- **不支持 ACP 之外的 provider**：非适配 provider 的 agent 不会挂 pill，RPC 返回 `supported: false`。

## 与「改源码」的关系

这是不改 Paseo 源码的等价方案：UI 自带一条 pill/面板，不进内置 Subagents track。若要让 ACP 子任务进内置 track（可点开、可停止），必须改 `packages/server/src/server/agent/providers/acp-agent.ts`。
