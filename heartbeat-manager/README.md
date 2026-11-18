# heartbeat-manager

Paseo 心跳管理插件。心跳就是**目标为某个具体 agent 的 schedule**（`target: { type: "agent", agentId }`），运行时会向该 agent 周期性发送 prompt。

界面入口：左侧栏「心跳」、Command Center「打开心跳管理」。

## 功能

- 列出当前 daemon 上所有 agent 心跳（过滤掉 new-agent 类型的普通定时任务）
- 新建：选择归属 agent、prompt、cron、时区、名称、最大运行次数、过期时间
- 编辑：cron / 时区 / 名称 / prompt / max-runs / 过期时间
- 暂停 / 恢复 / 立即运行 / 删除（二次确认）
- 查看最近 3 次运行记录（状态、时间、错误摘要）
- 15s 轮询刷新，变更后立即刷新
- 每个 agent 窗口的 composer 左下角有一个「心跳 N」pill（仅在该 agent 有运行中/已暂停心跳时出现），点击弹出浮层查看这些心跳、暂停/恢复/立即运行，并可跳到管理页

## 实现方式

Paseo 插件 SDK 的 `PaseoApi` 没有 schedule 分组，而 `paseo schedule` CLI 又把
`agent` 目标的心跳从 `ls` / `inspect` / `pause` / `update` 里过滤掉了。插件 server
进程与 daemon 同机同用户，因此用官方 `@getpaseo/client` 的 `createHostClient`，
读取 `~/.paseo/paseo.pid` 与 `local-credential` 直连本地 daemon，直接调用 daemon 的
schedule RPC（与官方 app 走同一条协议）：

| RPC | daemon 调用 |
| --- | --- |
| `heartbeat-manager.list` | `scheduleList` + 对每个 agent 目标 `scheduleInspect` |
| `heartbeat-manager.create` | `scheduleCreate`（`target: { type: "agent", agentId }`） |
| `heartbeat-manager.update` | `scheduleUpdate`（cron/时区/名称/prompt/maxRuns/expiresAt） |
| `heartbeat-manager.action` | `schedulePause` / `scheduleResume` / `scheduleRunOnce` / `scheduleDelete` |

连接地址取自 daemon 自己的 pid 文件，`PASEO_HOME` 与 `PASEO_PASSWORD` 环境变量会被沿用。

## 开发

```bash
npm install
npm run typecheck
paseo plugin install /root/.paseo/default/paseo-plugins/heartbeat-manager
paseo plugin reload heartbeat-manager   # 改代码后
paseo plugin logs heartbeat-manager
```