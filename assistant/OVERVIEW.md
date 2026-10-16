# 助理（assistant）

在左侧栏顶部（Workspaces 分组上方）增加固定「助理」入口；再提供一个 `/send` 命令，把消息派发到
现有 workspace 里自动选中的 agent，并在右侧 Explorer 面板实时显示那个 agent 的输出。

## 1. 助理入口

- 点击侧栏顶部「助理」→ 打开 `$PASEO_HOME/default`（默认 `~/.paseo/default`）下**唯一一个**会话。
- `assistant.ensure` 复用已存在的会话，只有不存在时才创建（标题固定「助理」）。
- 与任何仓库无关；上下文压缩交给该 agent 自己的配置。

## 2. `/send <消息>`（自动挑 workspace/agent 直接发）

在任意 agent 的输入框输入：

```
/send 检查一下最近的构建日志
```

- 自动挑 workspace：在所有「带 agent 的 workspace」里挑**最近有活动**的，并尽量避开你当前所在的 workspace。
- 自动挑 agent：该 workspace 内未归档 agent 中**最近有活动**（`lastUserMessageAt` → `updatedAt`）的优先，
  并列取第一个，并尽量避开当前 agent。
- 发送后右侧 Explorer 自动打开「助理输出」面板显示目标 agent 的实时输出。

## 3. 右侧输出面板「助理输出」

实时显示目标 agent 的 timeline（`refetch` 取历史 + `subscribe` 吃实时事件）：用户消息、assistant 文本、
思考、工具调用（shell/read/edit/write/search/fetch）、任务清单、错误、压缩事件。顶部「打开」跳到原生会话。

右侧是插件自绘的输出流，不是 Paseo 原生聊天界面——插件 API 无法把原生 agent 视图放进 side pane。

## RPC

| RPC | 说明 |
| --- | --- |
| `assistant.ensure` | 复用或创建 `~/.paseo/default` 下的唯一会话 |
| `assistant.reset` | 归档当前会话并新建一个 |
| `assistant.dispatch` | 自动挑 workspace/agent、发送消息，返回目标信息 |

## 已知限制

- Paseo 0.11.1 客户端没有「隐藏项目」能力，插件 API 也没有；`~/.paseo/default` 会以 `default` 项目出现在工作区列表里。
- 插件无法往 composer 写文本，也没有自定义触发符（`#`）；斜杠命令参数没有补全回调。所以「输入 `/send` 弹出 workspace 列表」这类交互做不了，只保留 `/send <消息>` 自动挑。
