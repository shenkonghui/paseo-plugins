import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  createWorktreeRpc,
  listWorktreesRpc,
  repoCommitFilesRpc,
  repoFileDiffRpc,
  repoOverviewRpc,
  submoduleFileDiffRpc,
  submoduleFilesRpc,
  worktreeBranchesRpc,
} from "./shared/worktrees";
import {
  getCommitFiles,
  getRepoFileDiff,
  getRepoOverview,
  getSubmoduleFileDiff,
  getSubmoduleFiles,
} from "./server/git-submodules";
import { createWorktree, listBranches, listWorktrees } from "./server/git-worktrees";

export default function contribute(server: PluginServerContext) {
  server.handle(listWorktreesRpc, ({ repoRoot }) => listWorktrees(repoRoot));
  server.handle(worktreeBranchesRpc, ({ repoRoot }) => listBranches(repoRoot));
  server.handle(createWorktreeRpc, (input) => createWorktree(input));
  server.handle(repoOverviewRpc, ({ repoRoot }) => getRepoOverview(repoRoot));
  server.handle(repoCommitFilesRpc, ({ repoRoot, sha }) => getCommitFiles(repoRoot, sha));
  server.handle(repoFileDiffRpc, ({ repoRoot, file, mode, sha }) =>
    getRepoFileDiff(repoRoot, file, mode, sha),
  );
  server.handle(submoduleFilesRpc, ({ repoRoot, path, mode, sha }) =>
    getSubmoduleFiles(repoRoot, path, mode, sha),
  );
  server.handle(submoduleFileDiffRpc, ({ repoRoot, path, file, mode, sha }) =>
    getSubmoduleFileDiff(repoRoot, path, file, mode, sha),
  );
  return () => {};
}
