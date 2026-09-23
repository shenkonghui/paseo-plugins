import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const WorktreeSchema = z.object({
  path: z.string(),
  branch: z.string().nullable(),
  head: z.string().nullable(),
  bare: z.boolean(),
  main: z.boolean(),
  mtimeMs: z.number().nullable(),
});

export type Worktree = z.infer<typeof WorktreeSchema>;

export const listWorktreesRpc = defineRpc({
  name: "worktrees.list",
  input: z.object({ repoRoot: z.string() }),
  output: z.object({ worktrees: z.array(WorktreeSchema) }),
});

/** Makes a branch or project name safe as a single path segment. */
export function sanitizePathSegment(name: string): string {
  return name.trim().replace(/[\\/:*?"<>|\s]+/g, "_");
}

export const worktreeBranchesRpc = defineRpc({
  name: "worktrees.branches",
  input: z.object({ repoRoot: z.string() }),
  output: z.object({
    currentBranch: z.string().nullable(),
    branches: z.array(z.string()),
  }),
});

export const createWorktreeRpc = defineRpc({
  name: "worktrees.create",
  input: z.object({
    repoRoot: z.string(),
    sourceBranch: z.string(),
    targetBranch: z.string(),
    directory: z.string(),
  }),
  output: z.object({ path: z.string(), branch: z.string() }),
});

export const SubmoduleChangeSchema = z.object({
  code: z.string(),
  path: z.string(),
});

export type SubmoduleChange = z.infer<typeof SubmoduleChangeSchema>;

export const CommitSchema = z.object({
  sha: z.string(),
  subject: z.string(),
  author: z.string(),
  relativeDate: z.string(),
});

export type RepoCommit = z.infer<typeof CommitSchema>;

export const repoOverviewRpc = defineRpc({
  name: "worktrees.repo-overview",
  input: z.object({ repoRoot: z.string() }),
  output: z.object({
    branch: z.string().nullable(),
    changes: z.array(SubmoduleChangeSchema),
    commits: z.array(CommitSchema),
    submodulePaths: z.array(z.string()),
  }),
});

export const repoCommitFilesRpc = defineRpc({
  name: "worktrees.repo-commit-files",
  input: z.object({ repoRoot: z.string(), sha: z.string() }),
  output: z.object({ files: z.array(SubmoduleChangeSchema) }),
});

export const repoFileDiffRpc = defineRpc({
  name: "worktrees.repo-file-diff",
  input: z.object({
    repoRoot: z.string(),
    file: z.string(),
    mode: z.enum(["worktree", "commit"]),
    sha: z.string().optional(),
  }),
  output: z.object({ diff: z.string() }),
});

export const submoduleFilesRpc = defineRpc({
  name: "worktrees.submodule-files",
  input: z.object({
    repoRoot: z.string(),
    path: z.string(),
    mode: z.enum(["worktree", "commit"]),
    sha: z.string().optional(),
  }),
  output: z.object({ files: z.array(SubmoduleChangeSchema) }),
});

export const submoduleFileDiffRpc = defineRpc({
  name: "worktrees.submodule-file-diff",
  input: z.object({
    repoRoot: z.string(),
    path: z.string(),
    file: z.string(),
    mode: z.enum(["worktree", "commit"]),
    sha: z.string().optional(),
  }),
  output: z.object({ diff: z.string() }),
});
