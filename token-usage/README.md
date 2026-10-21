# token-usage

Token 监控面板:读取本机各 agent CLI 自己的本地数据,汇总展示 token 用量。

## 功能

- 侧边栏「Token 监控」入口 + 命令中心「打开 Token 监控」
- 支持 1 天 / 7 天 / 30 天窗口切换
- 总量卡片:总 tokens、请求数、会话数、成本(USD)、积分(如有上报)
- 柱状图:默认按天展示 total tokens,点击单根柱子查看当日明细;**窗口为「今天」时改为按小时**(0 点 → 当前小时),按本机时区切桶
- 按 agent 分卡片:每个 agent 的总量、请求、会话、输入/输出/缓存读/缓存写/思考 tokens、成本、积分(仅展示该 agent 上报的维度)
- **每个 agent 卡片右侧有采集开关**(默认开启):关闭后服务端直接跳过该 agent 的采集(不读它的数据源),卡片变灰并标「已暂停采集」;开关存在宿主侧设置里,跨客户端共享、重启不丢。开关左侧以弱化小字显示**实际读取的数据源路径**(`~` 表示宿主 home,多个路径用 ` · ` 连接,过长单行省略)
- **失败事件提示**:agent 卡片上直接列出本机当天 0 点以来的限流 / 额度 / 鉴权等失败(归类 + 状态码 + 次数 + 重置时间 + 原文),总量卡片再给一行汇总;没有失败的 agent 不展示这一块
- **本地磁盘占用（弹窗）**:面板底部只有一行「本地磁盘占用」入口,默认不采集也不展示占用;**点开弹窗才统计**,弹窗里按 agent 展示数据目录的递归总占用、会话数与会话数据占用
- **手动清理（弹窗内确认）**:在占用弹窗里按 agent 或一键删除 30 天前(且之后没有新活动)的会话,确认步骤写明将删除的会话数与预计释放空间,清理后立即用实际释放量刷新

## 采集来源(均在 daemon 主机本地读取)

| agent | 数据源 | 方式 |
| --- | --- | --- |
| CodeBuddy | `~/.codebuddy/projects/**/*.jsonl`(国内版) + `~/.paseo/homes/*/.codebuddy/projects/**/*.jsonl`(国际版，跑在 Paseo 独立 HOME 下) | JSONL 行扫描(`providerData.rawUsage`)，多个 home 合并为一张卡片 |
| Pi | `~/.pi/agent/sessions/**/*.jsonl` | JSONL 行扫描(`message.usage`) |
| OpenCode | XDG data 下 opencode 的 SQLite | `node:sqlite` 只读 keyset 分页 |
| Devin | XDG data 下 `devin/cli/sessions.db` | `node:sqlite` 只读物化 CTE 聚合(2GB 级库,一次扫描) |
| Qoder | `~/.qoder-cn/projects/**/*.jsonl`(国内版) + `~/.qoder/projects/**/*.jsonl`(国际版) | JSONL 行扫描(`message.usage`,含 `<uuid>/subagents/*.jsonl`,按 `request_id` 去重) |

### 失败事件(限流 / 额度 / 鉴权 等)

Paseo 只会把这类请求当成「没有返回」,而 agent CLI 的本地数据里其实写着结构化原因,所以面板把它们归一化成固定字段展示。窗口是**本机当天 0 点以来**,跨零点重新计算;切到「近 7 天 / 近 30 天」也不会回溯更早的失败——历史失败不代表当前是否被卡住,混进来只会让卡片越看越长。

| agent | 原始字段 | 能否采集 |
| --- | --- | --- |
| CodeBuddy | `providerData.error`(`code` / `status` / `message` / `isRetryable` / `isNetworkError` / `isStreamTimeout`) | 是 |
| OpenCode | `session_message.data.error`(`type` / `message` / `status` / `response.body`) | 是 |
| Pi / Qoder / Devin | 没有结构化错误字段 | 否(issues 恒为空) |

每条聚合记录固定为这些字段(拿不到的维度是 `null`,不虚构):

| 字段 | 含义 |
| --- | --- |
| `kind` | `rate_limit` / `quota` / `auth` / `network` / `timeout` / `upstream` / `aborted` / `unknown` |
| `code` / `httpStatus` | provider 错误码(如 CodeBuddy `6004`)与 HTTP 状态码(如 `429`) |
| `retryable` | provider 是否标记为可重试 |
| `message` | **原文**,不翻译;聚合时保留最近一次的 |
| `model` / `sessionId` | 最近一次发生时的模型与会话(相对数据根的路径) |
| `firstAt` / `lastAt` / `count` | 首次、最近一次时间与发生次数 |
| `resetAt` | 从文案里解析出的额度重置时间;解析不出为 `null` |

聚合键是 `kind + code + httpStatus + resetAt`(不含 `message`——原文里带 requestID / 会话 id,按它聚合会一条都合不起来)。比如 CodeBuddy 的 `429 …将在 2026-10-20 09:09:22 UTC+8 重置…` 会被识别成 `kind=quota`、`httpStatus=429`、`code=6004`,并把重置时间解析成 ISO 时刻;`Interrupted by user` 归 `aborted`,不计入失败。

> `resetAt` 只认带时区的写法(`UTC+8` 或 ISO 偏移),认不出就留 `null`,不按主机时区猜。

> **Qoder 的 token 需要显式开启上报**:Qoder CLI 默认把 token 清零,只写 Credits。要让面板拿到真实 token,需给 CLI 进程加上环境变量——国内版 `QODERCN_EXPOSE_TOKEN_USAGE=1`,国际版 `QODER_EXPOSE_TOKEN_USAGE=1`(前缀不可互换),例如写进 `~/.paseo/config.json` 的 `agents.providers["qoder-cn"].env`。未开启时该 agent 仍会显示请求数、会话数和积分,但 token 维度为 0。
> Qoder 的 Credits(积分)按**账单口径**统计:只累计 `billable !== false` 的请求,免费模型的请求(token 与请求数照计)不计入积分。

采集在插件 server 进程内串行执行,yield gate 限制每个同步步的事件循环占用。按「所选窗口(今天 / 近 7 天 / 近 30 天) + 关闭采集的 agent 集合」分别采集并各自缓存 1 小时;快照落盘(`~/.paseo/plugin-cache/token-usage/usage-cache.json`,重启后秒开):打开页面只读缓存,过期时显示「缓存已过期」;只有点击 Surface 的「刷新」按钮才强制重新采集,不做任何后台主动采集。默认窗口是「今天」。

## 磁盘占用与清理(均在 daemon 主机本地执行)

占用为该 agent 数据目录的**递归总占用**(会包含日志、快照等非会话数据);「会话数据」只统计会话本身。

面板底部只放一行入口:**打开占用的弹窗时才做统计**(弹窗打开期间的重复查看走宿主 60 秒缓存,可通过「重新统计」强制刷新),因此打开面板本身不会去遍历这些数据目录。清理确认是弹窗内的下一步:写明将删除的会话数与预计释放空间,失败时留在确认步骤并显示原因。

| agent | 占用统计范围 | 清理动作 |
| --- | --- | --- |
| CodeBuddy | `~/.codebuddy` | 删除 30 天前的 `projects/**/*.jsonl` 及其同名附属目录(`<uuid>/`) |
| Pi | `~/.pi` | 删除 30 天前的 `agent/sessions/**/*.jsonl` |
| OpenCode | `$XDG_DATA_HOME/opencode` | 删除 `session_v2` 中 30 天前的会话(外键级联删消息等),再 `VACUUM` 回收空间 |
| Devin | `$XDG_DATA_HOME/devin` | 删除 `sessions` 中 30 天前的会话及其子表行,再 `VACUUM` 回收空间 |
| Qoder | `~/.qoder-cn` + `~/.qoder`(两个数据根合并统计) | 删除 30 天前的 `projects/**/*.jsonl` 及其同名附属目录(`<uuid>/`,含 `subagents/`) |

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
