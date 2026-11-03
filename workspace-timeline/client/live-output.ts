import { usePaseo } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { summarize, type TimelineItemLike } from "./timeline-model";

/**
 * Last line of live output per agent, keyed by agent id. Each target opens one timeline
 * subscription; the set is re-evaluated only when the agent ids change.
 */
export function useLiveOutput(agentIds: readonly string[]): Record<string, string> {
  const paseo = usePaseo();
  const [lines, setLines] = useState<Record<string, string>>({});
  const signature = [...agentIds].sort().join("|");

  useEffect(() => {
    const ids = signature ? signature.split("|").filter((id) => id.length > 0) : [];
    if (ids.length === 0) return;

    let cancelled = false;
    const releases: Array<() => Promise<void>> = [];

    const setLine = (agentId: string, line: string): void => {
      setLines((current) =>
        current[agentId] === line ? current : { ...current, [agentId]: line },
      );
    };

    for (const agentId of ids) {
      const timeline = paseo.agents.ref(agentId).timeline;

      // Subscriptions deliver live events only, so seed the tail from recent history once.
      void timeline
        .refetch({ limit: 20 })
        .then((payload) => {
          if (cancelled) return;
          const entries = payload.entries ?? [];
          for (let index = entries.length - 1; index >= 0; index -= 1) {
            const line = summarize(entries[index].item as TimelineItemLike);
            if (!line) continue;
            setLine(agentId, line);
            return;
          }
        })
        .catch(() => {});

      const subscription = timeline.subscribe((event) => {
        if (cancelled) return;
        if (event.event.type !== "timeline") return;
        const line = summarize(event.event.item as TimelineItemLike);
        if (line) setLine(agentId, line);
      });
      void Promise.resolve(subscription.ready).catch(() => {});
      releases.push(() => subscription.release());
    }

    return () => {
      cancelled = true;
      for (const release of releases) void release();
    };
  }, [paseo, signature]);

  return lines;
}
