import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import { GLOBAL_SKILL_SOURCE, type listSkillsRpc, type readSkillRpc } from "../shared/skills";

interface SkillEntry {
  name: string;
  description: string;
  source: string;
}

/** 与客户端 `addSlashCommand` 的校验保持一致，避免注册一个名字就中断整轮扫描。 */
const SKILL_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const CACHE_TTL_MS = 3_000;
const MAX_CWDS = 128;
const MAX_SKILLS = 200;
const MAX_SKILL_BYTES = 64 * 1024;
const FOLDED_SCALAR_MARKERS = new Set([">", ">-", ">+", "|", "|-", "|+"]);

const cache = new Map<string, { at: number; skills: SkillEntry[] }>();
const inflight = new Map<string, Promise<SkillEntry[]>>();

/**
 * 解析 SKILL.md 的 frontmatter。只读取 name/description，并支持 YAML
 * 折叠/字面量标量（`description: >`）这种常见写法。
 */
function parseFrontmatter(content: string): { name?: string; description?: string } {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1];
  if (!block) return {};
  const fields: Record<string, string> = {};
  const lines = block.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([A-Za-z0-9_-]+):\s?(.*)$/.exec(lines[index] ?? "");
    if (!match) continue;
    const key = match[1] ?? "";
    let value = (match[2] ?? "").trim();
    if (FOLDED_SCALAR_MARKERS.has(value)) {
      const parts: string[] = [];
      while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1] ?? "")) {
        index += 1;
        parts.push((lines[index] ?? "").trim());
      }
      value = parts.join(" ");
    }
    if (value) fields[key] = value.replace(/^["']/, "").replace(/["']$/, "");
  }
  return { name: fields.name, description: fields.description };
}

/** 读取单个 `<dir>/<entryName>/SKILL.md`；无效或缺 description 时返回 null。 */
async function readSkillEntry(dir: string, entryName: string, source: string): Promise<SkillEntry | null> {
  let content: string;
  try {
    content = await readFile(join(dir, entryName, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
  const { name, description } = parseFrontmatter(content);
  const resolvedName = (name?.trim() || entryName).trim();
  const resolvedDescription = description?.trim() ?? "";
  if (!resolvedDescription || !SKILL_NAME_PATTERN.test(resolvedName)) return null;
  return { name: resolvedName, description: resolvedDescription, source };
}

/** 扫描一个 `<something>/.agents/skills` 目录。 */
async function scanSkillsDir(dir: string, source: string): Promise<SkillEntry[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => readSkillEntry(dir, entry.name, source)),
  );
  return skills.filter((skill): skill is SkillEntry => skill !== null);
}

/** 扫描项目根的 `.agents/skills`；nested 时再浅扫一层子目录。source 始终是该 skills 目录本身。 */
async function scanRoot(root: string, nested: boolean): Promise<SkillEntry[]> {
  const skillsDir = join(root, ".agents", "skills");
  const skills = await scanSkillsDir(skillsDir, skillsDir);
  if (!nested) return skills;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return skills;
  }
  const children = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));
  const nestedSkills = await Promise.all(
    children.map((entry) => {
      const childSkillsDir = join(root, entry.name, ".agents", "skills");
      return scanSkillsDir(childSkillsDir, childSkillsDir);
    }),
  );
  return skills.concat(...nestedSkills);
}

/** 同一目录的扫描结果做短 TTL 缓存，并合并并发请求。 */
function scanCached(key: string, run: () => Promise<SkillEntry[]>): Promise<SkillEntry[]> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.skills);
  const pending = inflight.get(key);
  if (pending) return pending;
  const promise = run()
    .then((skills) => {
      cache.set(key, { at: Date.now(), skills });
      return skills;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, promise);
  return promise;
}

export async function listSkills(input: RpcInput<typeof listSkillsRpc>) {
  const seen = new Map<string, SkillEntry>();
  const nested = input.nested !== false;
  const cwds = [...new Set((input.cwds ?? []).map((cwd) => cwd.trim()).filter(Boolean))].slice(
    0,
    MAX_CWDS,
  );

  for (const cwd of cwds) {
    const skills = await scanCached(`root:${cwd}:${nested}`, () => scanRoot(cwd, nested));
    for (const skill of skills) {
      if (!seen.has(skill.name)) seen.set(skill.name, skill);
    }
    if (seen.size >= MAX_SKILLS) break;
  }

  if (input.includeGlobal !== false && seen.size < MAX_SKILLS) {
    const globalDir = join(homedir(), ".agents", "skills");
    const skills = await scanCached("global", () => scanSkillsDir(globalDir, GLOBAL_SKILL_SOURCE));
    for (const skill of skills) {
      if (!seen.has(skill.name)) seen.set(skill.name, skill);
    }
  }

  return { skills: [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

/** 读取某个 skill 的 SKILL.md，供 agent 目录不可见时把指令注入消息。 */
export async function readSkill(input: RpcInput<typeof readSkillRpc>) {
  const name = input.name.trim();
  const source = input.source.trim();
  if (!SKILL_NAME_PATTERN.test(name)) throw new Error(`Invalid skill name: ${input.name}`);
  if (source !== GLOBAL_SKILL_SOURCE && !isAbsolute(source)) {
    throw new Error(`Invalid skill source: ${input.source}`);
  }
  const root = source === GLOBAL_SKILL_SOURCE ? join(homedir(), ".agents", "skills") : source;
  const content = await readFile(join(root, name, "SKILL.md"), "utf8");
  return { content: content.slice(0, MAX_SKILL_BYTES) };
}
