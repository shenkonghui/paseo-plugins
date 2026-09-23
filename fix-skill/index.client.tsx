import type { PluginClientContext } from "@getpaseo/plugin/client";
import { listSkillsRpc } from "./shared/skills";

export default function contribute(client: PluginClientContext) {
  const cleanups: Array<() => void> = [];
  const registered = new Set<string>();

  const register = (name: string, description: string) => {
    if (registered.has(name)) return;
    registered.add(name);
    cleanups.push(
      client.addSlashCommand({
        name,
        description: description || `Skill: ${name}`,
        argumentHint: "[args]",
        context: "agent",
        onSubmit({ args, agent }) {
          return client.paseo.agents.ref(agent.id).send(`/${name}${args ? ` ${args}` : ""}`);
        },
      }),
    );
  };

  // Scan ~/.agents/skills plus every known agent's ./.agents/skills, then
  // register each discovered skill as a top-level slash command so it shows
  // up in composer autocomplete.
  void (async () => {
    const cwds = new Set<string>([""]);
    try {
      const { entries } = await client.paseo.agents.list();
      for (const entry of entries) {
        if (entry.agent.cwd) cwds.add(entry.agent.cwd);
      }
    } catch {
      // Fall back to global skills only.
    }
    for (const cwd of cwds) {
      try {
        const { skills } = await client.rpc(listSkillsRpc, cwd ? { cwd } : {});
        for (const skill of skills) register(skill.name, skill.description);
      } catch {
        // Skip unreachable scan roots.
      }
    }
  })();

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
