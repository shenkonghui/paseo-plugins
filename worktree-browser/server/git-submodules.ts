import { execFile } from "node:child_process";
import type { RepoCommit, SubmoduleChange } from "../shared/worktrees";

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], { timeout: 15000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

/** `git rev-parse`, resolving to null instead of rejecting. */
async function gitRevParse(cwd: string, ref: string): Promise<string | null> {
  try {
    const out = await git(cwd, ["rev-parse", "--verify", "--quiet", ref]);
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** Parses `git submodule status` lines and returns just the submodule paths. */
export function parseSubmodulePaths(text: string): string[] {
  const paths: string[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const rest = line.slice(1).trimStart();
    const sha = rest.split(/\s/, 1)[0];
    const path = rest
      .slice(sha.length)
      .trim()
      .replace(/\s+\(.*\)$/, "");
    if (sha && path) paths.push(path);
  }
  return paths;
}

/** Parses `git status --porcelain` lines into change entries. */
export function parsePorcelainChanges(text: string): SubmoduleChange[] {
  const changes: SubmoduleChange[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    changes.push({ code: line.slice(0, 2), path: line.slice(3) });
  }
  return changes;
}

/** Parses `git diff --name-status` / `git show --name-status` output. */
export function parseNameStatus(text: string): SubmoduleChange[] {
  const changes: SubmoduleChange[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const [code, ...rest] = line.split("\t");
    const path = rest[rest.length - 1];
    if (code && path) changes.push({ code, path });
  }
  return changes;
}

const LOG_FIELD = "\x1f";

function parseLog(text: string): RepoCommit[] {
  const commits: RepoCommit[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const [sha, subject, author, relativeDate] = line.split(LOG_FIELD);
    if (sha) {
      commits.push({
        sha,
        subject: subject ?? "",
        author: author ?? "",
        relativeDate: relativeDate ?? "",
      });
    }
  }
  return commits;
}

export interface RepoOverview {
  branch: string | null;
  changes: SubmoduleChange[];
  commits: RepoCommit[];
  submodulePaths: string[];
}

export async function getRepoOverview(repoRoot: string): Promise<RepoOverview> {
  const [branchText, statusText, logText, submodulesText] = await Promise.all([
    git(repoRoot, ["branch", "--show-current"]).catch(() => ""),
    git(repoRoot, ["status", "--porcelain"]).catch(() => ""),
    git(repoRoot, ["log", `--format=%H${LOG_FIELD}%s${LOG_FIELD}%an${LOG_FIELD}%cr`, "-50"]).catch(
      () => "",
    ),
    git(repoRoot, ["submodule", "status"]).catch(() => ""),
  ]);
  return {
    branch: branchText.trim() || null,
    changes: parsePorcelainChanges(statusText),
    commits: parseLog(logText),
    submodulePaths: parseSubmodulePaths(submodulesText),
  };
}

export async function getCommitFiles(
  repoRoot: string,
  sha: string,
): Promise<{ files: SubmoduleChange[] }> {
  const text = await git(repoRoot, ["show", "--name-status", "--format=", sha]).catch(() => "");
  return { files: parseNameStatus(text) };
}

async function worktreeDiff(cwd: string, file: string): Promise<string> {
  // Working tree + index vs HEAD covers modified/staged files. Untracked
  // files have no HEAD blob, so read them wholesale as an "all added" diff.
  const diff = await git(cwd, ["diff", "HEAD", "--", file]).catch(() => "");
  if (diff) return diff;
  return git(cwd, ["diff", "--no-index", "--", "/dev/null", file]).catch(() => "");
}

export async function getRepoFileDiff(
  repoRoot: string,
  file: string,
  mode: "worktree" | "commit",
  sha?: string,
): Promise<{ diff: string }> {
  if (mode === "commit") {
    if (!sha) return { diff: "" };
    const diff = await git(repoRoot, ["show", "--format=", sha, "--", file]).catch(() => "");
    return { diff };
  }
  return { diff: await worktreeDiff(repoRoot, file) };
}

interface GitlinkRange {
  oldSha: string | null;
  newSha: string | null;
}

async function gitlinkRange(repoRoot: string, path: string, sha: string): Promise<GitlinkRange> {
  const [oldSha, newSha] = await Promise.all([
    gitRevParse(repoRoot, `${sha}^:${path}`),
    gitRevParse(repoRoot, `${sha}:${path}`),
  ]);
  return { oldSha, newSha };
}

export async function getSubmoduleFiles(
  repoRoot: string,
  path: string,
  mode: "worktree" | "commit",
  sha?: string,
): Promise<{ files: SubmoduleChange[] }> {
  const sub = `${repoRoot}/${path}`;
  if (mode === "worktree") {
    const text = await git(sub, ["status", "--porcelain"]).catch(() => "");
    return { files: parsePorcelainChanges(text) };
  }
  if (!sha) return { files: [] };
  const { oldSha, newSha } = await gitlinkRange(repoRoot, path, sha);
  if (!newSha) return { files: [] };
  if (!oldSha) {
    const text = await git(sub, ["show", "--name-status", "--format=", newSha]).catch(() => "");
    return { files: parseNameStatus(text) };
  }
  const text = await git(sub, ["diff", "--name-status", oldSha, newSha]).catch(() => "");
  return { files: parseNameStatus(text) };
}

export async function getSubmoduleFileDiff(
  repoRoot: string,
  path: string,
  file: string,
  mode: "worktree" | "commit",
  sha?: string,
): Promise<{ diff: string }> {
  const sub = `${repoRoot}/${path}`;
  if (mode === "worktree") {
    return { diff: await worktreeDiff(sub, file) };
  }
  if (!sha) return { diff: "" };
  const { oldSha, newSha } = await gitlinkRange(repoRoot, path, sha);
  if (!newSha) return { diff: "" };
  if (!oldSha) {
    const diff = await git(sub, ["show", "--format=", newSha, "--", file]).catch(() => "");
    return { diff };
  }
  const diff = await git(sub, ["diff", oldSha, newSha, "--", file]).catch(() => "");
  return { diff };
}
