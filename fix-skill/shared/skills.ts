import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const skillEntrySchema = z.object({
  name: z.string(),
  description: z.string(),
});

export const listSkillsRpc = defineRpc({
  name: "list-skills",
  input: z.object({ cwd: z.string().optional() }),
  output: z.object({ skills: z.array(skillEntrySchema) }),
});
