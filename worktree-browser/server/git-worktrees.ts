import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Worktree } from "../shared/worktrees";

const BRANCH_PREFIX = "refs/heads/";

/** Parses `git worktree list --porcelain` output. The first block is the main worktree. */
export function parseWorktreePorcelain(text: string): Worktree[] {
  const worktrees: Worktree[] = [];
  let current: Worktree | null = null;
  const flush = () => {
    if (current) worktrees.push(current);
    current = null;
  };
  for (const line of text.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      current = {
        path: line.slice("worktree ".length),
        branch: null,
        head: null,
        bare: false,
        main: worktrees.length === 0,
        mtimeMs: null,
      };
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (current && line.startsWith("branch ")) {
      const ref = line.slice("branch ".length);
      current.branch = ref.startsWith(BRANCH_PREFIX) ? ref.slice(BRANCH_PREFIX.length) : ref;
    } else if (current && line === "bare") {
      current.bare = true;
    } else if (current && line === "detached") {
      current.branch = null;
    }
  }
  flush();
  return worktrees;
}

function runGit(repoRoot: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", repoRoot, ...args], { timeout: 15000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

async function mtime(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

export async function listWorktrees(repoRoot: string): Promise<{ worktrees: Worktree[] }> {
  const worktrees = parseWorktreePorcelain(
    await runGit(repoRoot, ["worktree", "list", "--porcelain"]),
  );
  await Promise.all(
    worktrees.map(async (worktree) => {
      worktree.mtimeMs = await mtime(worktree.path);
    }),
  );
  return { worktrees };
}

export async function listBranches(
  repoRoot: string,
): Promise<{ currentBranch: string | null; branches: string[] }> {
  const [current, raw] = await Promise.all([
    runGit(repoRoot, ["branch", "--show-current"]).catch(() => ""),
    runGit(repoRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]),
  ]);
  return {
    currentBranch: current.trim() || null,
    branches: raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  };
}

/** Expands a leading `~` against the daemon host's home directory. */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

export interface CreateWorktreeInput {
  repoRoot: string;
  sourceBranch: string;
  targetBranch: string;
  directory: string;
}

export async function createWorktree(
  input: CreateWorktreeInput,
): Promise<{ path: string; branch: string }> {
  const source = input.sourceBranch.trim();
  const target = input.targetBranch.trim();
  const directory = expandHome(input.directory.trim());
  if (!source || !target || !directory) {
    throw new Error("源分支、目标分支和目录均不能为空");
  }
  await mkdir(dirname(directory), { recursive: true });
  await runGit(input.repoRoot, ["worktree", "add", "-b", target, directory, source]);
  return { path: directory, branch: target };
}
