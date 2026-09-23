import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import type { listSkillsRpc } from "../shared/skills";

function parseSkillFile(path: string, fallbackName: string) {
  try {
    const content = readFileSync(path, "utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1] ?? "";
    const name = /^name:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim() || fallbackName;
    const description = /^description:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim() ?? "";
    return { name, description };
  } catch {
    return null;
  }
}

function scanDir(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => parseSkillFile(join(dir, entry.name, "SKILL.md"), entry.name))
      .filter((skill) => skill !== null);
  } catch {
    return [];
  }
}

export function listSkills(input: RpcInput<typeof listSkillsRpc>) {
  const dirs = [join(homedir(), ".agents", "skills")];
  if (input.cwd) {
    dirs.unshift(join(input.cwd, ".agents", "skills"));
  }
  const seen = new Set<string>();
  const skills = [];
  for (const dir of dirs) {
    for (const skill of scanDir(dir)) {
      if (!seen.has(skill.name)) {
        seen.add(skill.name);
        skills.push(skill);
      }
    }
  }
  return { skills };
}
