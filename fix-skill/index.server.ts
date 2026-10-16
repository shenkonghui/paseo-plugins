import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listSkills, readSkill } from "./server/skills";
import { listSkillsRpc, readSkillRpc } from "./shared/skills";

export default function contribute(server: PluginServerContext) {
  server.handle(listSkillsRpc, listSkills);
  server.handle(readSkillRpc, readSkill);
  return () => {};
}
