# token-usage

Token 监控面板:读取本机各 agent CLI 自己的本地数据,汇总展示 token 用量。

## 功能

- 侧边栏「Token 监控」入口 + 命令中心「打开 Token 监控」
- 支持 1 天 / 7 天 / 30 天窗口切换
- 总量卡片:总 tokens、请求数、会话数、成本(USD)、积分(如有上报)
- 柱状图:按天展示 total tokens,点击单根柱子查看当日明细
- 按 agent 分卡片:每个 agent 的总量、请求、会话、输入/输出/缓存读/缓存写/思考 tokens、成本、积分(仅展示该 agent 上报的维度)

## 采集来源(均在 daemon 主机本地读取)

| agent | 数据源 | 方式 |
| --- | --- | --- |
| CodeBuddy | `~/.codebuddy/projects/*.jsonl` | JSONL 行扫描(`providerData.rawUsage`) |
| Pi | `~/.pi/agent/sessions/**/*.jsonl` | JSONL 行扫描(`message.usage`) |
| OpenCode | XDG data 下 opencode 的 SQLite | `node:sqlite` 只读 keyset 分页 |
| Devin | XDG data 下 `devin/cli/sessions.db` | `node:sqlite` 只读物化 CTE 聚合(2GB 级库,一次扫描) |
| Qoder（积分额度） | `~/.qoder-cn/logs/runs/*/qodercli.log` | 解析 CLI 自己打印的 `/api/v2/quota/usage` 响应(仅套餐 credits,无 token 明细——Qoder 网关不吐 token 数) |

采集在插件 server 进程内串行执行,yield gate 限制每个同步步的事件循环占用。结果缓存 1 小时并落盘(`~/.paseo/plugin-cache/token-usage/usage-cache.json`,重启后秒开):打开页面只读缓存,过期时显示「缓存已过期」;只有点击 Surface 的「刷新」按钮才强制重新采集,不做任何后台主动采集。

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
