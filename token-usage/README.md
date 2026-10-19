# token-usage

Token 监控面板:读取本机各 agent CLI 自己的本地数据,汇总展示 token 用量。

## 功能

- 侧边栏「Token 监控」入口 + 命令中心「打开 Token 监控」
- 支持 1 天 / 7 天 / 30 天窗口切换
- 总量卡片:总 tokens、请求数、会话数、成本(USD)、积分(如有上报)
- 柱状图:默认按天展示 total tokens,点击单根柱子查看当日明细;**窗口为「今天」时改为按小时**(0 点 → 当前小时),按本机时区切桶
- 按 agent 分卡片:每个 agent 的总量、请求、会话、输入/输出/缓存读/缓存写/思考 tokens、成本、积分(仅展示该 agent 上报的维度)
- **每个 agent 卡片右侧有采集开关**(默认开启):关闭后服务端直接跳过该 agent 的采集(不读它的数据源),卡片变灰并标「已暂停采集」;开关存在宿主侧设置里,跨客户端共享、重启不丢
- **本地磁盘占用**:面板底部按 agent 展示数据目录的递归总占用、会话数与会话数据占用
- **手动清理**:按 agent 或一键删除 30 天前(且之后没有新活动)的会话,清理前二次确认,清理后立即用实际释放量刷新占用

## 采集来源(均在 daemon 主机本地读取)

| agent | 数据源 | 方式 |
| --- | --- | --- |
| CodeBuddy | `~/.codebuddy/projects/*.jsonl` | JSONL 行扫描(`providerData.rawUsage`) |
| Pi | `~/.pi/agent/sessions/**/*.jsonl` | JSONL 行扫描(`message.usage`) |
| OpenCode | XDG data 下 opencode 的 SQLite | `node:sqlite` 只读 keyset 分页 |
| Devin | XDG data 下 `devin/cli/sessions.db` | `node:sqlite` 只读物化 CTE 聚合(2GB 级库,一次扫描) |

采集在插件 server 进程内串行执行,yield gate 限制每个同步步的事件循环占用。按「所选窗口(今天 / 近 7 天 / 近 30 天) + 关闭采集的 agent 集合」分别采集并各自缓存 1 小时;快照落盘(`~/.paseo/plugin-cache/token-usage/usage-cache.json`,重启后秒开):打开页面只读缓存,过期时显示「缓存已过期」;只有点击 Surface 的「刷新」按钮才强制重新采集,不做任何后台主动采集。默认窗口是「今天」。

## 磁盘占用与清理(均在 daemon 主机本地执行)

占用为该 agent 数据目录的**递归总占用**(会包含日志、快照等非会话数据);「会话数据」只统计会话本身。

| agent | 占用统计范围 | 清理动作 |
| --- | --- | --- |
| CodeBuddy | `~/.codebuddy` | 删除 30 天前的 `projects/**/*.jsonl` 及其同名附属目录(`<uuid>/`) |
| Pi | `~/.pi` | 删除 30 天前的 `agent/sessions/**/*.jsonl` |
| OpenCode | `$XDG_DATA_HOME/opencode` | 删除 `session_v2` 中 30 天前的会话(外键级联删消息等),再 `VACUUM` 回收空间 |
| Devin | `$XDG_DATA_HOME/devin` | 删除 `sessions` 中 30 天前的会话及其子表行,再 `VACUUM` 回收空间 |

「过期」以会话最后一次活动时间为准(文件型取文件 mtime,数据库型取 `time_updated` / `last_activity_at`),因此 30 天内活跃过的会话不会被删。已在运行中的 agent 会话(包括当前会话)通常属于最近活动,不会被清理。数据库型 agent 的「预计可释放」按会话数比例估算,清理后给出 VACUUM 前后的实际差值;Devin 的库接近 GB 级,VACUUM 可能耗时较久。

## 安装

```bash
paseo plugin add /path/to/paseo-plugins/token-usage
```

## 开发

```bash
npm install
npm run typecheck
npm test
```
