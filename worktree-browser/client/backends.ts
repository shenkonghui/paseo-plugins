import { parseWorktreePorcelain } from "../shared/porcelain";
import type { Worktree } from "../shared/worktrees";

export interface WorktreeBackend {
  /** How git runs under this backend, surfaced in the UI. */
  readonly kind: "local" | "remote";
  listWorktrees(repoRoot: string): Promise<Worktree[]>;
  listBranches(repoRoot: string): Promise<{ currentBranch: string | null; branches: string[] }>;
  createWorktree(input: {
    repoRoot: string;
    sourceBranch: string;
    targetBranch: string;
    directory: string;
  }): Promise<{ path: string; branch: string }>;
  removeWorktree(input: {
    repoRoot: string;
    path: string;
    branch: string | null;
    force?: boolean;
    deleteBranch?: boolean;
  }): Promise<{ removed: string; branchDeleted: string | null }>;
}

export interface LocalWorktreeRpc {
  listWorktrees(input: { repoRoot: string }): Promise<{ worktrees: Worktree[] }>;
  listBranches(input: { repoRoot: string }): Promise<{
    currentBranch: string | null;
    branches: string[];
  }>;
  createWorktree(input: {
    repoRoot: string;
    sourceBranch: string;
    targetBranch: string;
    directory: string;
  }): Promise<{ path: string; branch: string }>;
  removeWorktree(input: {
    repoRoot: string;
    path: string;
    force?: boolean;
    deleteBranch?: boolean;
  }): Promise<{ removed: string; branchDeleted: string | null }>;
}

/** Thin adapter over the local daemon RPCs (`index.server.ts`). */
export function createLocalBackend(rpc: LocalWorktreeRpc): WorktreeBackend {
  return {
    kind: "local",
    async listWorktrees(repoRoot) {
      const { worktrees } = await rpc.listWorktrees({ repoRoot });
      return worktrees;
    },
    listBranches: (repoRoot) => rpc.listBranches({ repoRoot }),
    createWorktree: (input) => rpc.createWorktree(input),
    async removeWorktree({ repoRoot, path, branch, force, deleteBranch }) {
      const result = await rpc.removeWorktree({ repoRoot, path, force, deleteBranch });
      // `branch` is only needed by the remote backend, which cannot look it up locally.
      void branch;
      return result;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Remote backend: runs git on another Paseo host through a short-lived
 * terminal process owned by that host's daemon.
 * ------------------------------------------------------------------ */

interface RemoteWorkspaceEntry {
  id: string;
  projectId: string;
  projectRootPath: string;
  workspaceDirectory?: string;
  workspaceKind?: string;
  name: string;
}

interface RemoteTerminalHandle {
  capture(options?: { stripAnsi?: boolean }): Promise<{ lines: string[] }>;
  kill(): Promise<void>;
}

/** The slice of `PaseoApi` this backend needs, kept structural so the plugin needs no extra package. */
export interface RemotePaseoApi {
  workspaces: {
    list(): Promise<{ entries: readonly RemoteWorkspaceEntry[] }>;
  };
  terminals: {
    create(options: {
      workspaceId: string;
      cwd?: string;
      name?: string;
      command?: string;
      args?: string[];
      size?: { rows: number; cols: number };
    }): Promise<RemoteTerminalHandle>;
  };
}

const EXIT_SENTINEL = /__PASEO_WB_EXIT_(-?\d+)__/g;
const MTIME_MARKER = "__PASEO_WB_MTIME__";
const BRANCH_MARKER = "__PASEO_WB_BRANCHES__";
const PATH_PREFIX = "__PASEO_WB_PATH__";
const POLL_INTERVAL_MS = 150;
const COMMAND_TIMEOUT_MS = 60_000;

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizePath(value: string): string {
  return value.replace(/[\\/]+$/, "");
}

function expandHomeShell(variable: string): string {
  return [
    `case "$${variable}" in`,
    `  "~") ${variable}="$HOME" ;;`,
    `  "~/"*) ${variable}="$HOME/\${${variable}#\\~/}" ;;`,
    `esac`,
  ].join("\n");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Picks a workspace on the remote host to host the git process. The daemon only
 * allows terminals inside a workspace root, so a project with no workspace there
 * cannot be inspected remotely.
 */
async function resolveExecWorkspace(
  api: RemotePaseoApi,
  repoRoot: string,
): Promise<{ workspaceId: string; cwd: string }> {
  const { entries } = await api.workspaces.list();
  const root = normalizePath(repoRoot);
  const candidates = entries.filter(
    (entry) =>
      entry.workspaceDirectory &&
      normalizePath(entry.projectRootPath ?? "") === root,
  );
  const direct = candidates.find(
    (entry) => normalizePath(entry.workspaceDirectory ?? "") === root,
  );
  const chosen = direct ?? candidates[0];
  if (!chosen?.workspaceDirectory) {
    throw new Error(
      `该主机上还没有 ${repoRoot} 的 workspace，无法远程执行 git。请先在该主机为这个项目打开一次 workspace。`,
    );
  }
  return { workspaceId: chosen.id, cwd: chosen.workspaceDirectory };
}

/**
 * Runs `script` through `/bin/sh` in a remote terminal and returns its output.
 * The shell is kept alive by a trailing sleep so the daemon cannot drop the
 * buffer before the exit sentinel is read; the terminal is killed afterwards.
 */
async function runRemoteScript(
  api: RemotePaseoApi,
  exec: { workspaceId: string; cwd: string },
  script: string,
): Promise<string> {
  const wrapped = [
    "(",
    script,
    ")",
    '__paseo_wb_exit=$?',
    `printf '\\n__PASEO_WB_EXIT_%s__\\n' "$__paseo_wb_exit"`,
    "sleep 30",
  ].join("\n");
  const terminal = await api.terminals.create({
    workspaceId: exec.workspaceId,
    cwd: exec.cwd,
    name: "worktree-browser",
    command: "/bin/sh",
    args: ["-c", wrapped],
    size: { rows: 50, cols: 400 },
  });
  try {
    const deadline = Date.now() + COMMAND_TIMEOUT_MS;
    let text = "";
    while (Date.now() < deadline) {
      const capture = await terminal.capture({ stripAnsi: true });
      text = capture.lines.join("\n").replace(/\r/g, "");
      // A redrawn pty can repeat the sentinel; the last one carries the final status.
      const matches = [...text.matchAll(EXIT_SENTINEL)];
      const match = matches.at(-1);
      if (match && match.index !== undefined) {
        const code = Number(match[1]);
        const body = text.slice(0, match.index);
        if (code !== 0) {
          throw new Error(body.trim() || `远程 git 命令失败（退出码 ${code}）`);
        }
        return body;
      }
      await delay(POLL_INTERVAL_MS);
    }
    throw new Error("远程 git 命令超时");
  } finally {
    await terminal.kill().catch(() => undefined);
  }
}

function parseMtimes(text: string): Map<string, number> {
  const mtimes = new Map<string, number>();
  for (const line of text.split("\n")) {
    const separator = line.lastIndexOf("\t");
    if (separator <= 0) continue;
    const path = line.slice(0, separator);
    const seconds = Number(line.slice(separator + 1));
    if (Number.isFinite(seconds) && seconds >= 0) mtimes.set(path, seconds * 1000);
  }
  return mtimes;
}

export function createRemoteBackend(getApi: () => RemotePaseoApi): WorktreeBackend {
  const execCache = new Map<string, { at: number; value: { workspaceId: string; cwd: string } }>();

  async function exec(repoRoot: string): Promise<{ workspaceId: string; cwd: string }> {
    const cached = execCache.get(repoRoot);
    if (cached && Date.now() - cached.at < 30_000) return cached.value;
    const value = await resolveExecWorkspace(getApi(), repoRoot);
    execCache.set(repoRoot, { at: Date.now(), value });
    return value;
  }

  async function run(repoRoot: string, script: string): Promise<string> {
    try {
      return await runRemoteScript(getApi(), await exec(repoRoot), script);
    } catch (error) {
      // A stale workspace (archived/renamed) should be re-resolved once.
      if (error instanceof Error && /workspace/i.test(error.message)) execCache.delete(repoRoot);
      throw error;
    }
  }

  return {
    kind: "remote",
    async listWorktrees(repoRoot) {
      const output = await run(
        repoRoot,
        [
          `git -C ${quote(repoRoot)} worktree list --porcelain`,
          `__paseo_wb_code=$?`,
          `printf '\\n${MTIME_MARKER}\\n'`,
          `git -C ${quote(repoRoot)} worktree list --porcelain | sed -n 's/^worktree //p' | while IFS= read -r __paseo_wb_path; do __paseo_wb_mtime=$(stat -c %Y "$__paseo_wb_path" 2>/dev/null || stat -f %m "$__paseo_wb_path" 2>/dev/null || echo -1); printf '%s\\t%s\\n' "$__paseo_wb_path" "$__paseo_wb_mtime"; done`,
          `( exit $__paseo_wb_code )`,
        ].join("\n"),
      );
      const marker = output.indexOf(MTIME_MARKER);
      const porcelain = marker === -1 ? output : output.slice(0, marker);
      const mtimeText = marker === -1 ? "" : output.slice(marker + MTIME_MARKER.length);
      const worktrees = parseWorktreePorcelain(porcelain);
      const mtimes = parseMtimes(mtimeText);
      for (const worktree of worktrees) worktree.mtimeMs = mtimes.get(worktree.path) ?? null;
      return worktrees;
    },
    async listBranches(repoRoot) {
      const output = await run(
        repoRoot,
        [
          `git -C ${quote(repoRoot)} branch --show-current`,
          `printf '\\n${BRANCH_MARKER}\\n'`,
          `git -C ${quote(repoRoot)} for-each-ref --format='%(refname:short)' refs/heads`,
          `__paseo_wb_code=$?`,
          `( exit $__paseo_wb_code )`,
        ].join("\n"),
      );
      const marker = output.indexOf(BRANCH_MARKER);
      const current = (marker === -1 ? output : output.slice(0, marker)).trim();
      const raw = marker === -1 ? "" : output.slice(marker + BRANCH_MARKER.length);
      return {
        currentBranch: current || null,
        branches: raw
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
      };
    },
    async createWorktree({ repoRoot, sourceBranch, targetBranch, directory }) {
      const target = targetBranch.trim();
      const source = sourceBranch.trim();
      const output = await run(
        repoRoot,
        [
          `__paseo_wb_dir=${quote(directory.trim())}`,
          expandHomeShell("__paseo_wb_dir"),
          `mkdir -p "$(dirname -- "$__paseo_wb_dir")"`,
          `git -C ${quote(repoRoot)} worktree add -b ${quote(target)} "$__paseo_wb_dir" ${quote(source)}`,
          `__paseo_wb_code=$?`,
          `if [ "$__paseo_wb_code" -eq 0 ]; then printf '\\n${PATH_PREFIX}%s\\n' "$__paseo_wb_dir"; fi`,
          `( exit $__paseo_wb_code )`,
        ].join("\n"),
      );
      const marker = output.indexOf(PATH_PREFIX);
      const path =
        marker === -1
          ? directory.trim()
          : output.slice(marker + PATH_PREFIX.length).split("\n")[0].trim();
      return { path, branch: target };
    },
    async removeWorktree({ repoRoot, path, branch, force, deleteBranch }) {
      const output = await run(
        repoRoot,
        [
          `__paseo_wb_path=${quote(path.trim())}`,
          expandHomeShell("__paseo_wb_path"),
          `git -C ${quote(repoRoot)} worktree remove ${force ? "--force " : ""}"$__paseo_wb_path"`,
          `__paseo_wb_code=$?`,
          deleteBranch && branch
            ? `if [ "$__paseo_wb_code" -eq 0 ]; then git -C ${quote(repoRoot)} branch -D ${quote(branch)}; __paseo_wb_code=$?; fi`
            : "",
          `( exit $__paseo_wb_code )`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
      void output;
      return { removed: path, branchDeleted: deleteBranch && branch ? branch : null };
    },
  };
}
