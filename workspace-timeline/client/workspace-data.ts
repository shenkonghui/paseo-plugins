import { usePaseo } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";
import { applyWorkspaceUpdate, type WorkspaceLike } from "./timeline-model";

/** The daemon rejects `page.limit` above 200 (`z.number().max(200)`). */
const PAGE_LIMIT = 200;

interface TimelineSnapshot {
  readonly entries: readonly WorkspaceLike[];
  readonly hasMore: boolean;
}

/**
 * Last list seen on this host. Kept at module scope so reopening the screen paints the previous
 * timeline immediately instead of flashing a spinner, even if the query cache was collected.
 */
let memorySnapshot: { hostId: string; entries: readonly WorkspaceLike[]; at: number } | null = null;

export interface WorkspaceTimelineData {
  readonly entries: readonly WorkspaceLike[];
  readonly truncated: boolean;
  readonly isInitialLoading: boolean;
  readonly isRefreshing: boolean;
  readonly error: string | null;
  readonly syncedAt: number | null;
  readonly refresh: () => void;
}

export function useWorkspaceTimeline(hostId: string): WorkspaceTimelineData {
  const paseo = usePaseo();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ["workspace-timeline", "list", hostId] as const, [hostId]);

  const query = useQuery({
    queryKey,
    queryFn: async (): Promise<TimelineSnapshot> => {
      const result = await paseo.workspaces.list({ page: { limit: PAGE_LIMIT } });
      const entries = result.entries as readonly WorkspaceLike[];
      memorySnapshot = { hostId, entries, at: Date.now() };
      return { entries, hasMore: result.pageInfo.hasMore };
    },
    staleTime: 60_000,
    gcTime: 24 * 60 * 60_000,
    placeholderData: () =>
      memorySnapshot?.hostId === hostId
        ? { entries: memorySnapshot.entries, hasMore: false }
        : undefined,
    retry: 1,
  });

  // One daemon subscription per mounted screen: it seeds the cache and then patches it in place,
  // so live activity moves bars without paying for a full refetch.
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    let subscription: { release(): Promise<void> } | null = null;

    void paseo.workspaces
      .list({ subscribe: {}, page: { limit: PAGE_LIMIT } })
      .then((result) => {
        const owned = result.subscription;
        if (!owned) return;
        if (cancelled) {
          void owned.release();
          return;
        }
        subscription = owned;
        unsubscribe = owned.subscribe({
          snapshot: ({ entries, pageInfo }) => {
            const list = entries as readonly WorkspaceLike[];
            memorySnapshot = { hostId, entries: list, at: Date.now() };
            queryClient.setQueryData<TimelineSnapshot>(queryKey, {
              entries: list,
              hasMore: pageInfo.hasMore,
            });
          },
          update: (message) => {
            if (message.type !== "workspace_update") return;
            queryClient.setQueryData<TimelineSnapshot>(queryKey, (current) =>
              current
                ? { ...current, entries: applyWorkspaceUpdate(current.entries, message.payload) ?? [] }
                : current,
            );
          },
        });
      })
      .catch(() => {
        // The subscription is an accelerant; the query above already surfaces real errors.
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
      void subscription?.release();
    };
  }, [paseo, queryClient, queryKey, hostId]);

  const refresh = useCallback(() => {
    void query.refetch();
  }, [query]);

  return {
    entries: query.data?.entries ?? [],
    truncated: query.data?.hasMore ?? false,
    isInitialLoading: query.isPending,
    isRefreshing: query.isFetching,
    error: query.error ? describeError(query.error) : null,
    syncedAt: memorySnapshot?.hostId === hostId ? memorySnapshot.at : null,
    refresh,
  };
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Schema failures arrive as a JSON array of issues; one line reads better than the raw blob.
  try {
    const issues: unknown = JSON.parse(message);
    if (Array.isArray(issues) && issues.length > 0) {
      const first = issues[0] as { path?: unknown[]; message?: string };
      const path = Array.isArray(first.path) ? first.path.join(".") : "";
      return [path, first.message].filter(Boolean).join(": ") || message;
    }
  } catch {
    // Not JSON, fall through to the raw message.
  }
  return message;
}
