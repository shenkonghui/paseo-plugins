# Worktree browser plugin example

A surface listing the git worktrees of a selected project, and a one-tap action to back a
worktree with a Paseo workspace.

`PaseoApi` does not expose the daemon's `paseo_worktree_list` RPC, so the plugin runs
`git worktree list --porcelain` on the daemon host through a plugin RPC (`worktrees.list`,
see `shared/worktrees.ts` and `server/git-worktrees.ts`). The client calls it with
`useRpc` from the surface.

For each worktree the card shows branch (or `(detached)`), path, HEAD short-sha, mtime, and
whether it is the repo's main worktree. Rows are correlated with `paseo.workspaces.list()`
by `workspaceDirectory`; linked rows open the workspace through `navigation.openWorkspace`,
unlinked rows offer "创建 workspace" which calls `paseo.workspaces.create` with a
`{ kind: "directory", path, projectId }` source so the new workspace lands under the same
project, then navigates into it.

Non-main worktrees also offer "删除", which calls the `worktrees.remove` plugin RPC
(`git worktree remove` on the daemon host, with an optional `--force` toggle and an
optional "同时删除分支" toggle that runs `git branch -D` afterwards). Removing a worktree
does not delete a Paseo workspace linked to it — delete that separately if it exists.

## 新建工作区（自定义分支与路径）

工具栏的 "+ 工作区" 按钮打开一个弹窗，让用户在创建工作区时直接指定分支名与存放路径：

- **放置方式**
  - `Paseo 管理路径`：调用 `paseo.workspaces.create`，source 为
    `{ kind: "worktree", action: "branch-off", branchName, worktreeSlug }`，由 daemon 在
    `worktrees.root` 下建 worktree，目录名取自 `worktreeSlug`（与 daemon 的 slug 规则一致）。
  - `自定义绝对路径`：先用 `backend.createWorktree`（本地走插件 RPC `worktrees.create`，即
    `git worktree add -b`；远程主机走该主机上的临时终端）在指定目录建 worktree，再用
    `{ kind: "directory", path }` source 建工作区；若建工作区失败会自动回滚刚建的 worktree。
- **新分支名**：原样作为 git 分支名，不做 slug 化；目录名（slug）会随输入自动生成，可手动改。
- **工作区标题**：留空时回退为分支名。
- **初始提示词（可选）**：填写后需要选择一个 `provider/model`（来自
  `paseo.providers.listAvailable()` 与 `listModels`），工作区建好后再调
  `workspace.agents.create` 启动 agent。

工作区与 agent 分两步创建：daemon 在「带首个 agent 建工作区」时会把分支重命名为 LLM 生成的
名字，分步创建可保证用户填写的分支名不被改写。

## 多主机

工具栏顶部有「主机」一行，数据来自 `@getpaseo/plugin/client` 的 `useHosts()`；只有配置了多台
主机时才显示。

- **当前主机**（插件安装所在的主机）：走插件 RPC，`git` 直接在该 daemon 上执行。
- **其它主机**：通过 `getPaseoClient(serverId)` 借用该主机的 `PaseoApi`，项目 / workspace /
  创建 worktree 工作区 / provider 查询都发到该主机；`worktrees.list` 这类插件自身 RPC 没有跨主机
  能力，因此改由该主机上的一个短命终端执行 `git`（`client/backends.ts` 的 `createRemoteBackend`）：
  在项目的某个 workspace 目录下 `sh -c` 运行 `git -C <repoRoot> …`，读到退出码哨兵后立刻 kill。
  这要求该项目在目标主机上至少有一个 workspace（daemon 只允许在 workspace 根目录下建终端），
  否则会提示先在该主机打开一次项目。
- 打开 workspace 时会把 `serverId` 一并交给 `navigation.openWorkspace`，所以在任意主机选中的行
  都能跳到对应主机的 workspace。

插件只需安装在当前使用的主机上；其它主机不需要安装本插件（远程路径只依赖 `PaseoApi`）。
