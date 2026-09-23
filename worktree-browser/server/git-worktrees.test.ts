import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizePathSegment } from "../shared/worktrees";
import { parseNameStatus, parsePorcelainChanges, parseSubmodulePaths } from "./git-submodules";
import { createWorktree, expandHome, parseWorktreePorcelain } from "./git-worktrees";

describe("parseWorktreePorcelain", () => {
  it("parses main and linked worktrees with branches", () => {
    const text = [
      "worktree /repo/main",
      "HEAD aaaa1111",
      "branch refs/heads/main",
      "",
      "worktree /repo/linked",
      "HEAD bbbb2222",
      "branch refs/heads/feature-x",
      "",
    ].join("\n");
    expect(parseWorktreePorcelain(text)).toEqual([
      {
        path: "/repo/main",
        branch: "main",
        head: "aaaa1111",
        bare: false,
        main: true,
        mtimeMs: null,
      },
      {
        path: "/repo/linked",
        branch: "feature-x",
        head: "bbbb2222",
        bare: false,
        main: false,
        mtimeMs: null,
      },
    ]);
  });

  it("handles detached HEAD and bare entries", () => {
    const text = [
      "worktree /repo/main",
      "HEAD aaaa1111",
      "branch refs/heads/main",
      "",
      "worktree /repo/det",
      "HEAD cccc3333",
      "detached",
      "",
      "worktree /repo/bare.git",
      "bare",
      "",
    ].join("\n");
    const result = parseWorktreePorcelain(text);
    expect(result[1]).toMatchObject({ path: "/repo/det", branch: null, head: "cccc3333" });
    expect(result[2]).toMatchObject({ path: "/repo/bare.git", bare: true });
  });

  it("keeps non-heads refs intact", () => {
    const text = "worktree /repo/wt\nHEAD dddd4444\nbranch refs/tags/v1\n";
    expect(parseWorktreePorcelain(text)[0]?.branch).toBe("refs/tags/v1");
  });

  it("returns empty list for empty output", () => {
    expect(parseWorktreePorcelain("")).toEqual([]);
  });
});

describe("sanitizePathSegment", () => {
  it("replaces slashes and other special characters with underscores", () => {
    expect(sanitizePathSegment("feature/foo")).toBe("feature_foo");
    expect(sanitizePathSegment("fix\\bar:baz qux")).toBe("fix_bar_baz_qux");
  });

  it("keeps dots, dashes and unicode letters", () => {
    expect(sanitizePathSegment("release-1.2_预发")).toBe("release-1.2_预发");
  });
});

describe("expandHome", () => {
  it("expands a leading tilde", () => {
    expect(expandHome("~/.worktrees/p/b")).toBe(join(homedir(), ".worktrees/p/b"));
    expect(expandHome("~")).toBe(homedir());
  });

  it("leaves absolute and relative paths untouched", () => {
    expect(expandHome("/tmp/x")).toBe("/tmp/x");
    expect(expandHome("rel/dir")).toBe("rel/dir");
  });
});

describe("createWorktree", () => {
  function initRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "wt-test-"));
    const git = (args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    git(["init"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "test"]);
    git(["commit", "--allow-empty", "-m", "init"]);
    return dir;
  }

  it("creates a worktree on a new branch from the source branch", async () => {
    const repo = initRepo();
    const dir = `${repo}-linked`;
    const result = await createWorktree({
      repoRoot: repo,
      sourceBranch: "HEAD",
      targetBranch: "feature/new",
      directory: dir,
    });
    expect(result).toEqual({ path: dir, branch: "feature/new" });
    expect(existsSync(join(dir, ".git"))).toBe(true);
    const sha = execFileSync(
      "git",
      ["-C", repo, "rev-parse", "--verify", "refs/heads/feature/new"],
      {
        encoding: "utf8",
      },
    );
    expect(sha.trim()).toHaveLength(40);
  });

  it("creates missing parent directories", async () => {
    const repo = initRepo();
    const dir = join(tmpdir(), `wt-nested-${Date.now()}`, "a/b");
    await createWorktree({
      repoRoot: repo,
      sourceBranch: "HEAD",
      targetBranch: "nested",
      directory: dir,
    });
    expect(existsSync(join(dir, ".git"))).toBe(true);
  });

  it("rejects empty fields", async () => {
    const repo = initRepo();
    await expect(
      createWorktree({ repoRoot: repo, sourceBranch: "", targetBranch: "x", directory: "/tmp/y" }),
    ).rejects.toThrow("不能为空");
  });
});

describe("parseSubmodulePaths", () => {
  it("returns submodule paths and strips the describe suffix", () => {
    const text = [
      " aaaa1111 libs/foo (v1.0)",
      "+bbbb2222 libs/bar (heads/main)",
      "-cccc3333 libs/baz",
      "Udddd4444 libs/qux",
      "",
    ].join("\n");
    expect(parseSubmodulePaths(text)).toEqual(["libs/foo", "libs/bar", "libs/baz", "libs/qux"]);
  });

  it("returns empty list for empty output", () => {
    expect(parseSubmodulePaths("")).toEqual([]);
  });
});

describe("parsePorcelainChanges", () => {
  it("parses XY codes and paths", () => {
    const text = " M src/a.ts\n?? src/b.ts\nM  staged.ts\n";
    expect(parsePorcelainChanges(text)).toEqual([
      { code: " M", path: "src/a.ts" },
      { code: "??", path: "src/b.ts" },
      { code: "M ", path: "staged.ts" },
    ]);
  });
});

describe("parseNameStatus", () => {
  it("parses status letters and takes the destination path for renames", () => {
    const text = "M\tsrc/a.ts\nA\tsrc/b.ts\nR100\told.ts\tnew.ts\n";
    expect(parseNameStatus(text)).toEqual([
      { code: "M", path: "src/a.ts" },
      { code: "A", path: "src/b.ts" },
      { code: "R100", path: "new.ts" },
    ]);
  });
});
