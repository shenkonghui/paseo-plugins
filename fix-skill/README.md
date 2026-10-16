# fix-skill

把磁盘上的 `.agents/skills` 注册成 Paseo 的斜杠命令，补上部分 provider（pi 等）不把项目 skill 上报给
Paseo 的缺口。

## 行为

- **扫描范围**：`~/.agents/skills` + 所有已知 agent 的工作目录 + 所有 workspace 目录/项目根。
  每个根目录除了 `<root>/.agents/skills`，还会浅扫一层子目录的 `.agents/skills`
  （例如 `/root/workspaces` 能带上 `/root/workspaces/<repo>` 的项目 skill）。
- **动态更新**：订阅 agent 列表，新建 agent 带来新目录时会增量重扫；skill 被删除时对应命令会移除。
- **提交语法**：pi provider 发送 `/skill:<name> [args]`（pi 的原生语法），其他 provider 发送
  `/<name> [args]`。项目 skill 与全局 skill 同名时，项目优先。
- **跨目录兜底**：如果 skill 所在项目不是 agent 工作目录的祖先（例如在 `/root/workspaces` 的
  agent 里使用 `/root/workspaces/paseo` 的 skill），pi 不会展开 `/skill:`，此时插件改为读取
  `SKILL.md` 并把指令注入消息，避免“点了没反应”。
- **缓存**：服务端对每个根目录做 3 秒 TTL 缓存并合并并发扫描请求。

## 已注册命令只在「已有 agent」的输入框出现

Paseo 插件 API 注册的斜杠命令只在 agent 已创建后参与 `/` 菜单过滤，**新建 agent 的草稿态看不到**。
草稿态的候选来自 Paseo 自己向 provider 拉取的命令列表，所以：

- 如果希望 pi 在草稿态就能看到项目 skill，需要让 pi 加载项目资源（项目信任）：
  `~/.pi/agent/trust.json` 里把项目目录设为 `true`，或在 pi 设置里配置 `defaultProjectTrust`。
- 否则本插件至少能保证 agent 创建后在 `/` 菜单里点到这些 skill。

## 限制

- 命令是全局注册的，Paseo 插件 API 不支持按 provider 或目录过滤，所以在不支持对应语法的
  provider 会话里也会显示；提交时可能收到 provider 的“未知命令”提示。
- skill 名必须符合 `^[a-z][a-z0-9-]*$`（与 Paseo 命令名校验一致），不合法的会被跳过。
