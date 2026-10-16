import type { PluginCleanup } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { GLOBAL_SKILL_SOURCE, listSkillsRpc, readSkillRpc } from "./shared/skills";

const MAX_ROOTS = 128;
const SYNC_DEBOUNCE_MS = 150;

function isPiProvider(provider: string): boolean {
  return provider.toLowerCase().startsWith("pi");
}

/** pi 只从工作目录向上查找 `.agents/skills`；跨目录时 `/skill:` 不会被展开。 */
function isSkillVisibleToPi(source: string, cwd: string): boolean {
  if (source === GLOBAL_SKILL_SOURCE) return true;
  const skillsDir = source.replace(/\/+$/, "");
  const suffix = "/.agents/skills";
  if (!skillsDir.endsWith(suffix)) return false;
  const projectRoot = skillsDir.slice(0, -suffix.length);
  const dir = cwd.replace(/\/+$/, "");
  return dir === projectRoot || dir.startsWith(`${projectRoot}/`);
}

/**
 * 把 `.agents/skills` 下的 skill 注册成 Paseo 的斜杠命令。
 *
 * 插件 API 只能注册静态命令，所以这里在插件加载后持续观察 agent 列表，
 * 动态发现新的工作目录并增量扫描；命令提交时发送 provider 认识的原生
 * 语法（pi 是 `/skill:<name>`）。
 *
 * 注意：插件命令只在 agent 已存在的输入框里出现；新建 agent 的草稿态由
 * Paseo 自身的 provider 命令列表负责。
 */
export default function contribute(client: PluginClientContext) {
  const lifetime = new AbortController();
  const registered = new Map<string, { description: string; cleanup: PluginCleanup }>();
  const roots = new Set<string>();
  let closed = false;
  let syncTimer: ReturnType<typeof setTimeout> | null = null;
  let syncPromise: Promise<void> | null = null;
  let syncQueued = false;

  const addRoot = (value: string | null | undefined): boolean => {
    const root = value?.trim();
    if (!root || roots.has(root)) return false;
    roots.add(root);
    return true;
  };

  const performSync = async (): Promise<void> => {
    const cwds = [...roots].slice(0, MAX_ROOTS);
    let skills;
    try {
      ({ skills } = await client.rpc(listSkillsRpc, {
        cwds,
        includeGlobal: true,
        nested: true,
      }));
    } catch (error) {
      if (!closed) console.warn("[fix-skill] skill scan failed", error);
      return;
    }
    if (closed || lifetime.signal.aborted) return;

    const seen = new Set<string>();
    for (const skill of skills) {
      seen.add(skill.name);
      const existing = registered.get(skill.name);
      if (existing?.description === skill.description) continue;
      if (existing) {
        existing.cleanup();
        registered.delete(skill.name);
      }
      try {
        const cleanup = client.addSlashCommand({
          name: skill.name,
          description: skill.description,
          argumentHint: "[args]",
          context: "agent",
          async onSubmit({ args, agent }) {
            const target = client.paseo.agents.ref(agent.id);
            if (!isPiProvider(agent.provider)) {
              return target.send(`/${skill.name}${args ? ` ${args}` : ""}`);
            }
            if (isSkillVisibleToPi(skill.source, agent.cwd)) {
              return target.send(`/skill:${skill.name}${args ? ` ${args}` : ""}`);
            }
            // 跨目录时 pi 不会展开 `/skill:`，把 SKILL.md 指令直接注入消息作为兜底。
            let content = "";
            try {
              ({ content } = await client.rpc(readSkillRpc, {
                source: skill.source,
                name: skill.name,
              }));
            } catch (error) {
              console.warn(`[fix-skill] cannot read skill ${skill.name}`, error);
            }
            const lines = [`请使用技能「${skill.name}」（技能目录：${skill.source}）。`];
            if (content.trim()) lines.push("", "以下是技能说明：", "", content.trim());
            if (args) lines.push("", `用户请求：${args}`);
            return target.send(lines.join("\n"));
          },
        });
        registered.set(skill.name, { description: skill.description, cleanup });
      } catch (error) {
        console.warn(`[fix-skill] cannot register /${skill.name}`, error);
      }
    }
    for (const [name, entry] of [...registered]) {
      if (!seen.has(name)) {
        entry.cleanup();
        registered.delete(name);
      }
    }
  };

  const runSync = async (): Promise<void> => {
    if (closed) return;
    if (syncPromise) {
      syncQueued = true;
      return;
    }
    if (!syncQueued) return;
    syncQueued = false;
    syncPromise = performSync();
    try {
      await syncPromise;
    } finally {
      syncPromise = null;
      if (syncQueued && !closed) scheduleSync(0);
    }
  };

  const scheduleSync = (delay = SYNC_DEBOUNCE_MS): void => {
    if (closed) return;
    syncQueued = true;
    if (syncTimer) return;
    syncTimer = setTimeout(() => {
      syncTimer = null;
      void runSync();
    }, delay);
  };

  /** 工作区目录也是正常的 skill 来源（例如 agent 跑在父目录、项目在子目录）。 */
  void client.paseo.workspaces
    .list({ page: { limit: 200 } })
    .then(({ entries }) => {
      let changed = false;
      for (const workspace of entries) {
        changed = addRoot(workspace.workspaceDirectory) || changed;
        changed = addRoot(workspace.projectRootPath) || changed;
      }
      if (changed) scheduleSync();
    })
    .catch((error) => {
      if (!closed) console.warn("[fix-skill] workspace scan skipped", error);
    });

  // 先只扫全局 skills，让菜单尽快有内容；agent 列表返回后再补充项目 skills。
  scheduleSync(0);

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal, page: { limit: 200 } })
    .then(({ entries, subscription }) => {
      let changed = false;
      for (const entry of entries) changed = addRoot(entry.agent.cwd) || changed;
      if (changed) scheduleSync();

      subscription.subscribe({
        snapshot: ({ entries: next }) => {
          let snapshotChanged = false;
          for (const entry of next) snapshotChanged = addRoot(entry.agent.cwd) || snapshotChanged;
          if (snapshotChanged) scheduleSync();
        },
        update: (message) => {
          if (message.type !== "agent_update" || message.payload.kind === "remove") return;
          if (addRoot(message.payload.agent.cwd)) scheduleSync();
        },
      });
    })
    .catch((error) => {
      if (!closed) console.warn("[fix-skill] agent observation failed", error);
    });

  return () => {
    closed = true;
    lifetime.abort();
    if (syncTimer) {
      clearTimeout(syncTimer);
      syncTimer = null;
    }
    for (const entry of registered.values()) entry.cleanup();
    registered.clear();
    roots.clear();
  };
}
