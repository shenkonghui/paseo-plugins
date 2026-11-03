import { usePaseo } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import type { AgentLike } from "./timeline-model";

/** The daemon caps `page.limit` at 200, same as the workspace list. */
const PAGE_LIMIT = 200;

/**
 * All agents of the selected daemon (archived included), kept in sync through one long-lived
 * `agents.list({ subscribe })`. Internal agents are filtered in `toAgentEntry`.
 */
export function useAgentList(): readonly AgentLike[] {
  const paseo = usePaseo();
  const [agents, setAgents] = useState<readonly AgentLike[]>([]);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    let subscription: { release(): Promise<void> } | null = null;

    void paseo.agents
      // 归档 agent 也显示（单独归到「已归档」分区），internal 的仍在模型里过滤掉。
      .list({ subscribe: {}, filter: { includeArchived: true }, page: { limit: PAGE_LIMIT } })
      .then((result) => {
        const initial = result.entries.map((entry) => entry.agent as AgentLike);
        if (!cancelled) setAgents(initial);

        const owned = result.subscription;
        if (!owned) return;
        if (cancelled) {
          void owned.release();
          return;
        }
        subscription = owned;
        unsubscribe = owned.subscribe({
          snapshot: ({ entries }) => {
            if (cancelled) return;
            setAgents(entries.map((entry) => entry.agent as AgentLike));
          },
          update: (message) => {
            if (cancelled || message.type !== "agent_update") return;
            const payload = message.payload as {
              kind?: string;
              agent?: AgentLike;
              agentId?: string;
            };
            setAgents((current) => {
              if (payload.kind === "upsert" && payload.agent) {
                const next = payload.agent;
                return [...current.filter((agent) => agent.id !== next.id), next];
              }
              if (payload.kind === "remove" && payload.agentId) {
                return current.filter((agent) => agent.id !== payload.agentId);
              }
              return current;
            });
          },
        });
      })
      .catch(() => {
        // The timeline still renders the workspace data if the agent subscription fails.
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
      void subscription?.release();
    };
  }, [paseo]);

  return agents;
}
