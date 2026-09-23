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
