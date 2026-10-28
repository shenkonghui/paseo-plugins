# 多任务（multi-task）

在左侧栏顶部（Workspaces 分组上方）增加固定「多任务」入口；点开进入多任务窗口，可**添加任意 workspace**，每个 workspace 一个面板并排实时查看、直接发消息。

## 1. 入口

- 侧栏顶部「多任务」行 → 打开 `multi-task` 屏幕。
- 命令中心（⌘K）也有「打开多任务窗口（⌘⇧M）」。
- **全局快捷键 `⌘⇧M` / `Ctrl+Shift+M`** 直接切到多任务窗口。SDK 没有快捷键注册 API，所以是在宿主 `window` 上自行监听；焦点在**内嵌面板**里时按键不会冒泡到宿主，由同源监听 iframe 转发（同一份逻辑）。想换键改 `client/shortcut.ts` 的 `SHORTCUT_KEY` / `REQUIRES_SHIFT`。

## 2. 添加 / 移除 workspace

- 右上角「+ 添加 workspace」→ 弹窗列出所有 workspace（可搜索 workspace 名或其中的 agent 名），每行显示 agent 数量。
  - **排序**：运行中的排最前 → 其余按最近更新时间倒序（`lastUserMessageAt → updatedAt`）→ 再按名字。
  - **运行中标记**：有 agent 在跑时，该行用 **accent 描边 + accent 状态点**，副标题显示「运行中 · N 个 agent」；其余为普通描边 + 灰点。
- 点选一个 workspace 即加入窗口；已在窗口中的显示「已添加」。
- 每个面板头部有「移除」，从窗口移除该 workspace（不影响原生会话）；会先弹窗确认，取消则保持原样。

面板内容取该 workspace **当前活跃的 agent**（未归档里 `lastUserMessageAt → updatedAt` 最新的那个），所以 workspace 里换了活跃会话，面板会跟着变。

## 3. 布局：自动平铺 + 自由拖拽调整

窗口会根据当前 workspace 数量**自动平铺**，无需手动排布；平铺后还可以**拖拽分隔条自由调整大小**（每行内相邻面板的宽度、相邻行的高度）。

### 自动平铺

- 测量可用区域后自动决定列数：**优先「一行铺满」**——只要每格不窄于最小宽度、也不会被拉成瘦高条，N 个 workspace 就并排成 N 列；确实施不开时，才在「单元格不窄于最小宽度」的候选列数里选最接近正方形、且尽量铺满整行的方案（放不满一行的方案带空位惩罚）。
- 1 个 → 占满；2 个 → 左右并排；**3 个 → 3 竖列**；4 个 → 2×2（单行会把每格压成细条时）；5 个 → 3+2；6 个 → 3×2；7 个 → 3+3+1……随数量与可用宽度自动变化。
- **尾行不再被拉成通栏**：最后一行只剩 1 个面板时，它沿用满行的单元格宽度（与上一行左对齐），不会再变成一整条「下面占一个大」的面板；剩 2 个以上则仍平分整行，避免留一大块空白。
- 面板过多导致高度不足时，保持最小高度并整体**纵向滚动**；窗口尺寸变化（缩放、旋转）会实时重算。
- **隐藏 / 恢复 / 移除面板**：面板头部「隐藏」按钮把该面板**移出平铺网格**——隐藏项不再占格子，展开的面板自动重算、**变大铺满**。隐藏的面板收进工具栏右上角「**已隐藏 N ▾**」（紧挨在「+ 添加 workspace」右侧），点开是个下拉浮层：每项显示状态点 + workspace 名 + agent 名，右侧「**恢复**」把它放回平铺网格（并设为当前焦点），「**移除**」直接从窗口删掉（同样先弹窗确认）；点浮层外面任何位置关掉。隐藏状态持久化，隐藏期间不建立订阅（省资源）。全部隐藏时主区域提示去右上角「已隐藏」恢复。
- **拖动排序**：按住面板**标题区任意位置**（整块头部都行：`⠿` 把手 + 标题 / 副标题，右侧「打开 / 隐藏 / 移除」按钮除外）拖动，整个面板跟手浮起，**落点格子会打上虚线高亮**，松手即换位；顺序持久化。
  - 落点按**格子中线**算：面板中心拖过相邻面板的中线就换到那一格（按每行实际宽度 / 行高逐格比较），所以拖一格只需拖一个面板的宽度，多行之间可上下换行。
  - 用 **DOM 层 pointer 事件**（`pointerdown` + 全局 `pointermove`/`pointerup`）实现——RN 的 responder 在宿主里会被外层抢走，导致拖不动；超过 6px 才算拖动，单纯点一下不触发。高亮只在跨格时更新 state，不随每帧 pointermove 重渲染。
- **当前焦点面板高亮**：点击面板任意处、聚焦其输入框或点入内嵌视图，该面板会用 accent 描边 + 辉光标出；新增面板自动成为焦点。内嵌视图里的事件不冒泡到宿主，所以由同源监听 iframe 内部的 `mousedown` / `focusin` 来切换。

### 自由调整大小

- 面板之间的**间隙就是分隔条**：默认显示一条细线，鼠标移上去变成 accent 色并显示 `col-resize` / `row-resize` 光标。
- 拖拽**行内分隔条**改变相邻两个面板的宽度（两者总宽不变）；拖拽**行间分隔条**改变相邻两行的高度（两者总高不变）。
- 拖动时只显示一条 accent 预览线，**松手后才一次性应用尺寸**——内嵌面板是完整的 Paseo 实例，逐帧改 iframe 尺寸既卡又容易把内嵌页拖白。
- 拖动过程直接改预览线的 DOM 样式，不触发 React 重渲染。
- 有最小尺寸限制（紧凑模式宽 150px / 高 200px，舒适模式宽 190px / 高 220px）；窗口整体不够高时保持最小高度并纵向滚动。
- 调整结果**持久化**在面板设置里（`widthWeight` / `heightWeight`），刷新 / 重启后保留；窗口尺寸变化时按权重等比缩放。
- **拖动窗口缩放不卡**：外框（面板尺寸）实时跟随窗口变，但内嵌 iframe 的尺寸**冻结到尺寸稳定 180ms 后才更新一次**——每个面板都是一整套 Paseo 实例，逐帧改 iframe 尺寸会让它们反复重排（卡死 / 扁白）；冻结期间内容超出部分被面板裁切，松手后立即重排到位。
- 手动调整过布局后，工具栏会出现「重置布局」按钮，一键恢复等分平铺。
- 拖拽期间会盖一层透明遮罩：内嵌 iframe 是独立文档，不这么做指针移到 iframe 上就收不到 `pointermove` 了。
- 侧栏隐藏脚本只在能确认「主区域」时生效：面宽比侧栏阈值（460px）还窄时不隐藏，避免误藏到 `body` / `html` 把整个内嵌页变空白。
- 隐藏 / 展开、增删面板后，剩余面板仍按各自权重渲染，不需要重新调整。

## 4. 面板内容

每个面板针对一个 workspace（内容是其当前活跃 agent 的会话）。有 DOM（浏览器 / Electron）时面板内容就是**内嵌原生会话**（见第 5 节）；本节描述的自绘对话流只作为**没有 DOM** 的原生客户端自动退化路径。

- 头部：**workspace 名**（主标题）+ 状态胶囊徽标（执行中 / 空闲 / 出错…），副标题为 **agent 名**（没有 agent 时显示「无 agent」）；**「打开」在 app 主界面打开该 workspace**（`navigation.openWorkspace({ workspaceId })`，内嵌 / 退化视图都显示，且没有 agent 的 workspace 也能打开）与「移除」（**移除会先弹窗确认**，确认后才从窗口移除，取消则保持原样）。
- 中部：实时对话流，自动滚到底部。数据与原生会话同一份 `projected` 投影，渲染为**结构化条目**：
  - 用户 / assistant / 思考（斜体弱化）文本支持**轻量 markdown 渲染**：标题、代码块（带语言标签 + 「复制」按钮）、有序 / 无序列表（支持缩进嵌套）、引用、`---` 分隔线、`**粗体**`、`*斜体*`、`~~删除线~~`、行内 `code`、可点击链接（不引入额外依赖；`_`/`__` 变体故意不支持，避免误伤 `some_var_name` 之类的标识符）；
  - **思考（thinking）**单独成卡片（描边 + 浅底 + 斜体灰字）：**限高 120px + 内部滚动**、可点击折叠，不会把整条流一直往下推；**连续的思考会合并到同一张卡片**（对齐 daemon 的 `reasoning_merge` 语义）；
  - 错误（红）/ 压缩事件；
  - 通知按 `level` 分级配色（info 灰 / warning 黄 / error 红）；
  - 任务清单渲染成 ☑ / ☐ 勾选列表（完成的加删除线）；
  - **工具卡片**：一行摘要（`$ 命令`、`编辑 路径`、`搜索 关键词 · N 处`…）+ 状态徽标（执行中 / 完成 / 失败 / 取消），点标题展开正文：
    - shell → 输出 + 退出码；edit → **`+`/`-` 高亮着色**的 diff；read → 行号范围；
    - search → 匹配数 / 文件列表 / 网页结果；fetch → HTTP 状态 / 字节数；plan / 子任务 → 文本。
  - 长正文默认折叠、失败自动展开；过长截断并提示剩余行数。
- 底部（仅自绘退化视图）：输入框 + 「发送」→ 直接给该 workspace 当前的 agent 发消息（`paseo.agents.ref(id).send`）；**Enter 发送，Shift+Enter 换行**。
  - **发送队列**：发送中会显示「发送中…」；此时再发送会**排队**（显示「排队中 · N」），逐个发出。agent 正在跑当前回合时同样计入忙碌——排队消息等它空闲再发（想要「忙时也立刻投递 / steering」，把 `agent-pane.tsx` 里 `busy` 中的 `agentRunning` 去掉即可）。

流式文本增长与工具 running→完成会按条目 identity **就地更新**，不会重复堆叠；连续思考按合并语义累加进同一张卡片（兼容累积式与增量式两种下发）。

另外，外层对话流只在**贴近底部**时自动跟随新内容，往上翻历史时不会被强行拉回底部。

## 5. 内嵌原生会话（唯一面板视图）

面板**只保留内嵌这一种视图**，不再提供「流 / 内嵌」切换；头部始终有「打开」，用于在 app 主界面打开该 workspace：

- 用 `<iframe>` 加载 `/h/<serverId>/agent/<agentId>`（`buildAgentDeepLinkRoute`，agentId = 该 workspace 当前活跃 agent），即**真正的原生会话**，自带的输入框/权限弹窗/文件 diff 全都在。
- 自绘对话流不再是可选项：只作为**没有 DOM** 的原生客户端（iOS / Android）自动退化路径，见第 4 节。

**workspace 里没有 agent 时**：会打开该 workspace 的「新建 agent」页（`/h/<serverId>/workspace/<workspaceId>?open=draft:new`，app 会把它换成一张新草稿标签），可以直接在里面创建 agent；创建后刷新（或下次重进）即切到该 agent 的会话。原生平台没有 DOM，仍显示「该 workspace 暂无 agent。」。

**侧栏处理**：内嵌的是完整 app 实例，自带左侧 workspace 栏与右侧 Explorer。插件**只藏左侧栏、保留右侧 Explorer**——app 没有提供隐藏它们的 URL 参数，所以在同源 iframe 里注入一段 CSS：`:has(> [data-testid="left-sidebar-resize-handle"]){display:none!important}`。
这段注入是**尽力而为**的：依赖 app 的 DOM 结构与 `:has()`（Chromium 105+ / Electron 满足），app 改版可能失效；跨源时拿不到 `contentDocument`，不会注入。想连右侧也藏起来，在 `client/embedded-agent.tsx` 的 `HIDE_LEFT_SIDEBAR_CSS` 里补一条 `[data-testid="workspace-explorer-sidebar"]{display:none!important}` 即可。

**窄面板保护**：找左侧栏容器时会向上走到「主区域」（宽度 ≥ 460px）为止；如果面板本身比 460px 还窄、根本找不到主区域，就不隐藏侧栏（交给 app 的紧凑形态），绝不把 `body` / `html` 标成隐藏。旧版本误标到根节点上的标记会自动清掉，避免整个内嵌页空白。

**屏蔽内嵌视图的快捷键**：内嵌视图里 `⌘E` / `⌘L` 会在 iframe 的 window 上被捕获并吃掉（`preventDefault` + `stopImmediatePropagation`），避免它们触发 app 自身的动作。要增删按键，改 `client/embedded-agent.tsx` 里的 `BLOCKED_META_KEYS`。注意：Electron 主进程级菜单加速键无法从渲染进程拦截。

**回车发送**：内嵌的 app 在窄面板里会退化成**紧凑形态**——app 的规则是 `submitOnEnter = isWeb && !isCompact`，而面板宽度基本都低于它 `md` 断点（720px），所以内嵌视图里**回车只换行，只能点「发送」按钮**。插件在同源 iframe 里把回车补回来（`installEmbeddedEnterSubmit`）：

- 监听 **`keypress`**：app 只在 `keydown` 上处理回车，被它 `preventDefault` 过的回车浏览器不再派发 `keypress`——所以「收到 `keypress`」就等于「app 没处理这次回车」，不会重复发送、也不会打断斜杠命令 / `@` 补全的选词；
- 只在**焦点位于会话输入框**（`data-composer-input`，且可编辑）时接管，输入法组合中（中文选字）的回车不处理，`Shift/Cmd/Ctrl+Enter` 也放行；
- 命中后代替用户点一下 composer 的「发送」按钮（DOM 里是 composer 根节点 `[data-testid="message-input-root"]` 的最后一个按钮），因此走的是 app 自己的发送逻辑（排队 / steering / 附件都不受影响）；按钮禁用（如输入框为空）时不代点。

和侧栏注入一样是绕过 SDK 的 DOM 操作，app 改版可能失效；失效时退化成原来的「只能点按钮」，不会误发。

**代价（务必了解）**：内嵌会把整个 Paseo app **再加载一次**——每个面板一个完整实例，各自建立 websocket 与订阅，内存 / CPU / 连接数随面板数线性增长。所以：

- 只要运行环境**有 DOM**（浏览器 / Electron 桌面 App）就启用；iOS / Android 原生没有 DOM，自动回退自绘。
- iframe 用**相对路由** `/h/<serverId>/agent/<agentId>`（`buildAgentDeepLinkRoute`），基于当前文档解析，天然同源，共享鉴权与本地存储，无需硬编码 host / origin。
- **只有内嵌**：有 DOM 就内嵌，没有「流」可切；加载失败时面板里提供「重新加载」（重挂 iframe），不会切到自绘。

## 6. 工具栏尺寸 / 收起

顶部「多任务 / 刷新 / + 添加 workspace」工具栏支持两种尺寸（宿主侧设置，所有客户端共享）：

- **紧凑（默认）**：更小的上下留白、间距与字号，工具栏高度约 41px；
- **舒适**：保留较大的间距与字号（旧版样式）。

工具栏最右侧的「▴」把整行收起，只留左上角一个小图标「▾」，点它即可展开。收起是纯界面状态（不持久化，重开窗口默认展开）。

入口：命令中心（⌘K）搜「多任务设置」，或 设置 → 插件 → 多任务。对应 `shared/settings.ts` 的 `toolbarSize` 字段（`compact` / `comfortable`）。

## 7. 持久化

面板列表存放在**宿主侧 settings**（`defineSettings`，scope `host`），所有客户端共享、刷新或重启 daemon 不丢。
存 `{ views, toolbarSize }`；workspace 名、当前 agent、状态每次从实时列表解析。settings 版本从 1 迁到 2（v1 按 agent 存，迁移时按 `workspaceId` 去重），v3 新增 `toolbarSize`（旧数据自动补 `compact`），v4 去掉每个面板的 `mode`（只保留内嵌视图，旧数据里的 `mode` 解析时自动剥离），v5 新增可选的 `widthWeight` / `heightWeight`（手动拖拽调节面板大小后持久化，缺省等价于等分）。

## 已知限制

- 插件 SDK **没有**「嵌入原生会话组件」的 API（`addTimelineRenderer` 是往原生会话里加自定义条目，不是把会话搬进面板）。内嵌视图是绕过 SDK、用 DOM `<iframe>` 直接加载 app 深链实现的，只在 web / Electron 可用且开销较大。
- 没有 DOM 时退化为插件的实时对话流（`timeline.refetch` + `subscribe`），内容与原生同源（同一份 `projected` 投影），但不是原生聊天组件。
- workspace 与 agent 列表各取前 200 条（`workspaces.list` / `agents.list` 分页上限）；正常使用足够。

## 验证

```bash
cd multi-task && npm install && npm run typecheck
```
