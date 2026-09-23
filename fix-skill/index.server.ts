import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listSkills } from "./server/skills";
import { listSkillsRpc } from "./shared/skills";

export default function contribute(server: PluginServerContext) {
  server.handle(listSkillsRpc, listSkills);
  return () => {};
}
