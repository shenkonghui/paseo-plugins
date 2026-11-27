# 单窗口视图（single-workspace）

把单个 workspace 变成可嵌入的裸视图：在 workspace URL 后加 `?bare=1`，左侧栏被隐藏，右侧 Explorer、tab 行、composer 全部保留。

```text
http://<daemon-host>:6767/h/<serverId>/workspace/<workspaceId>?bare=1
```

门户 / 其他系统只需一层 iframe：

```html
<iframe src="http://127.0.0.1:6767/h/local/workspace/wks_xxx?bare=1" style="width:100%;height:100%;border:0"></iframe>
```

## 为什么需要插件

`AppContainer` 只在 focus mode 下卸载左侧栏，而 focus mode 是本地持久化状态（`panelStore.desktop.focusModeEnabled`），不受 URL 控制；app 也没有隐藏侧栏的查询参数。所以插件 client bundle 在每个 app 实例里加载后，在**自己的文档**里注入样式并标记侧栏容器：

- 从 `[data-testid="left-sidebar-resize-handle"]` 往上找到侧栏容器，打 `data-paseo-bare-hidden`，由注入的 `display:none!important` 压过 React 内联样式；
- 固定隐藏 `#agent-list-gesture-host`（紧凑形态抽屉宿主）和 `[data-testid="menu-button"]`（打开任务列表的按钮）；
- 视口比侧栏阈值（460px）还窄时不隐藏，避免误藏到 `body` / `html` 把整页变空白。

这套选择器与 `multi-task` 插件内嵌面板用的是同一份。

## 行为细节

- **参数锁存**：`bare` 一旦出现就锁存到本页生命周期结束。workspace 内部导航（打开 agent / 文件）会重写 URL 并丢掉 query，侧栏不能在用户操作中途冒回来。
- **不贡献任何可见界面**：没有侧栏行、按钮或设置页。
- **无参数时零影响**：不带 `?bare=1` 的页面完全不受影响。
- **首帧**：rAF 节流的 `MutationObserver` 抢首帧，之后 400ms 轮询兜底侧栏重挂。

## 边界

- 依赖 app 内部 `data-testid`，app 改版可能失效；失效表现是侧栏可见，不会报错。
- 隐藏的是 `display:none`，不是卸载：侧栏快捷键仍可能切换状态（视觉上无变化）。
- 只处理 web / Electron（需要 DOM）；原生客户端不加载 client DOM 能力，参数无效果。
- 插件必须装在目标 daemon 上，否则该实例不会隐藏侧栏（页面仍可正常打开）。
