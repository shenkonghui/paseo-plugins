import type { Worktree } from "./worktrees";

const BRANCH_PREFIX = "refs/heads/";

/**
 * Parses `git worktree list --porcelain` output. The first block is the main worktree.
 * Shared by the daemon-side runner and the client-side remote runner.
 */
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
