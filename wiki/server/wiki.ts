import { promises as fs } from "node:fs";
import path from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import type { listDirectoriesRpc, listFilesRpc, readFileRpc } from "../shared/wiki";

const MAX_DEPTH = 4;
const MAX_FILE_BYTES = 256 * 1024;
const SKIPPED_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "coverage"]);

function resolveInside(rootPath: string, relative: string): string {
  const root = path.resolve(rootPath);
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path escapes the project root: ${relative}`);
  }
  return resolved;
}

async function* walk(
  root: string,
  dir: string,
  depth: number,
): AsyncGenerator<{ absolute: string; relative: string; isMarkdown: boolean }> {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name)) continue;
      yield* walk(root, absolute, depth + 1);
    } else if (/\.mdx?$/i.test(entry.name)) {
      yield { absolute, relative, isMarkdown: true };
    }
  }
}

// ponytail: directories are those that directly contain .md files; deeper
// nesting and nested-wiki grouping are left to the file list view.
export async function listDirectories(input: RpcInput<typeof listDirectoriesRpc>) {
  const root = path.resolve(input.rootPath);
  const directories = new Set<string>();
  for await (const file of walk(root, root, 0)) {
    directories.add(path.posix.dirname(file.relative));
  }
  directories.delete(".");
  return { directories: [...directories].sort() };
}

export async function listFiles(input: RpcInput<typeof listFilesRpc>) {
  const root = path.resolve(input.rootPath);
  const files: { directory: string; path: string; name: string }[] = [];
  for (const directory of input.directories) {
    const dir = resolveInside(root, directory);
    for await (const file of walk(root, dir, 0)) {
      files.push({ directory, path: file.relative, name: path.posix.basename(file.relative) });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files };
}

export async function readFile(input: RpcInput<typeof readFileRpc>) {
  const absolute = resolveInside(input.rootPath, input.path);
  const buffer = await fs.readFile(absolute);
  const truncated = buffer.byteLength > MAX_FILE_BYTES;
  return { content: buffer.subarray(0, MAX_FILE_BYTES).toString("utf8"), truncated };
}
