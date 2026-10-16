import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** 全局 skills 目录的稳定标识（客户端不依赖 home 路径）。 */
export const GLOBAL_SKILL_SOURCE = "~/.agents/skills";

export const skillEntrySchema = z.object({
  name: z.string(),
  description: z.string(),
  /** 发现该 skill 的根目录（项目绝对路径或 GLOBAL_SKILL_SOURCE）。 */
  source: z.string(),
});

export const listSkillsRpc = defineRpc({
  name: "list-skills",
  input: z.object({
    /** 需要扫描 `.agents/skills` 的项目根目录列表。 */
    cwds: z.array(z.string()).optional(),
    /** 每个根目录下再浅扫一层子目录（覆盖 `/root/workspaces/<repo>` 这类聚合目录）。 */
    nested: z.boolean().optional(),
    /** 是否包含 `~/.agents/skills`，默认包含。 */
    includeGlobal: z.boolean().optional(),
  }),
  output: z.object({ skills: z.array(skillEntrySchema) }),
});

export const readSkillRpc = defineRpc({
  name: "read-skill",
  input: z.object({
    source: z.string(),
    name: z.string(),
  }),
  output: z.object({ content: z.string() }),
});
