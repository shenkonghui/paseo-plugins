import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  createWorktreeRpc,
  listDirsRpc,
  listSubmodulesRpc,
  listWorktreesRpc,
  removeWorktreeRpc,
  worktreeBranchesRpc,
} from "./shared/worktrees";
import { listSubmoduleDirs, listTopDirs } from "./server/git-submodules";
import {
  createWorktree,
  listBranches,
  listWorktrees,
  removeWorktree,
} from "./server/git-worktrees";

export default function contribute(server: PluginServerContext) {
  server.handle(listWorktreesRpc, ({ repoRoot }) => listWorktrees(repoRoot));
  server.handle(worktreeBranchesRpc, ({ repoRoot }) => listBranches(repoRoot));
  server.handle(createWorktreeRpc, (input) => createWorktree(input));
  server.handle(removeWorktreeRpc, (input) => removeWorktree(input));
  server.handle(listSubmodulesRpc, ({ repoRoot }) => listSubmoduleDirs(repoRoot));
  server.handle(listDirsRpc, ({ repoRoot }) => listTopDirs(repoRoot));
  return () => {};
}
