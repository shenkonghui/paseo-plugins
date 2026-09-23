import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { listDirectories, listFiles, readFile } from "./wiki";

const root = mkdtempSync(path.join(tmpdir(), "paseo-wiki-test-"));
mkdirSync(path.join(root, "docs/guides"), { recursive: true });
mkdirSync(path.join(root, "src"), { recursive: true });
mkdirSync(path.join(root, "node_modules/pkg"), { recursive: true });
writeFileSync(path.join(root, "README.md"), "# readme\n");
writeFileSync(path.join(root, "docs/a.md"), "# a\n");
writeFileSync(path.join(root, "docs/guides/b.mdx"), "# b\n");
writeFileSync(path.join(root, "src/code.ts"), "export {}\n");
writeFileSync(path.join(root, "node_modules/pkg/ignored.md"), "# ignored\n");

afterAll(() => rmSync(root, { recursive: true, force: true }));

test("listDirectories finds directories containing markdown, skips ignored dirs", async () => {
  const { directories } = await listDirectories({ rootPath: root });
  expect(directories).toEqual(["docs", "docs/guides"]);
});

test("listFiles lists markdown under selected directories only", async () => {
  const { files } = await listFiles({ rootPath: root, directories: ["docs"] });
  expect(files.map((f) => f.path)).toEqual(["docs/a.md", "docs/guides/b.mdx"]);
});

test("readFile reads content and rejects paths outside the root", async () => {
  expect(await readFile({ rootPath: root, path: "docs/a.md" })).toEqual({
    content: "# a\n",
    truncated: false,
  });
  await expect(readFile({ rootPath: root, path: "../escape.md" })).rejects.toThrow(
    /project root|escapes/,
  );
});
