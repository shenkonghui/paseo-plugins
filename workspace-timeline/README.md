# workspace-timeline

Paseo 插件：当前 daemon 的每个 **agent** 一个方框，所有方框共用一条时间轴。方框主标题是所属 workspace，次标题是 agent 标题；默认窗口是「今天」并居中，可左右拖动平移、滚轮缩放。

## 使用

- 侧边栏「时间线」入口，或命令面板搜索「Workspace 时间线」。
- **一个方框 = 一个 agent**（归档的也显示）：主标题 workspace 名、次标题 agent 标题；同一 workspace 的 agent 用同一种颜色。归档 agent 单独归到最下面的「已归档」分区，时间条右端为归档时间。
- 方框是一条**时间条**：右端 = 更新时间，左端 = 开始时间，文字全部右对齐（贴着更新时间一端）。时间条有**最小宽度**（紧凑 160px / 舒适 190px）：跨度足够时左端就是开始时间；跨度过短时向左延展到最小宽度，右端始终对准更新时间。
- 窗口：默认 1 天（正好覆盖今天）并居中在今天。**左右拖动平移**，`‹` / `›` 每次平移 40% 窗口，「今天」回到当天；**滚轮以指针位置为锚点缩放**（约 5 分钟 ~ 1 年），`Shift+滚轮` 纵向滚动轨道列表，顶部 1 / 3 / 7 / 30 天按钮是快捷跨度。
- 方框内标注状态文字（运行中 / 初始化 / 等待输入 / 待处理 / 出错 / 空闲 / 已完成 / 已关闭）与更新时间；运行中的 agent 最后一行显示实时输出。
- 按状态**上下分区**，运行中固定在最上面；分区标题带状态文字与数量。
- 点方框查看详情（workspace、agent、状态、时间、跨度、实时输出），点「打开 agent」直接跳转。
- 「现在」在窗口内时，时间轴与轨道区会画一条 accent 色的现在线。

## 数据与缓存

- workspace 列表来自 `paseo.workspaces.list()`，结果写进 TanStack Query 缓存（`staleTime` 60 秒，`gcTime` 24 小时），插件内还保留一份模块级快照，重新打开屏幕会立即渲染上一帧，同时后台刷新。
- 打开屏幕时建立一次 `workspaces.list({ subscribe: {} })` 长订阅，后续 `workspace_update` 增量写入缓存；屏幕卸载时释放。
- agent 列表来自 `paseo.agents.list({ subscribe: {}, filter: { includeArchived: true }, page: { limit: 200 } })` 长订阅：快照 + `agent_update` 增量维护；归档 agent 显示在「已归档」分区，`internal` agent 不显示。
- workspace 名从 workspace 列表解析（不在前 200 个里的显示「未知 workspace」）。方框时间取 agent 的 `createdAt`、`updatedAt`、`lastUserMessageAt` 中最晚的时间。超过 200 个 agent 时只显示前 200 个，并在标题栏提示。
- 运行中 agent 的实时输出按 agent 单独订阅，只对窗口内运行中的 agent 建立订阅。

## 开发

```bash
npm install
npm run typecheck
paseo plugin reload workspace-timeline
```

代码分层：`client/timeline-model.ts` 是纯函数（时间窗口、时间轴刻度、位置百分比、配色、状态分区、格式化），`client/workspace-data.ts` 与 `client/agent-data.ts` 负责取数与缓存，`client/live-output.ts` 负责运行中 agent 的输出订阅，`client/timeline-screen.tsx` 只做渲染（拖动平移、滚轮缩放、布局）。
