import type { SubagentRow, SubagentsInput, SubagentsOutput } from "../shared/subagents";

export interface AgentSubagentsState {
  /** running 在前，其余按开始时间倒序 */
  rows: readonly SubagentRow[];
  supported: boolean;
  provider: string;
  sessionId: string | null;
  error: string | null;
  loading: boolean;
  fetchedAt: number | null;
}

type RpcFn = (input: SubagentsInput) => Promise<SubagentsOutput>;

export const EMPTY_STATE: AgentSubagentsState = {
  rows: [],
  supported: false,
  provider: "",
  sessionId: null,
  error: null,
  loading: false,
  fetchedAt: null,
};

let rpcFn: RpcFn | null = null;

export function configureSubagentsRpc(fn: RpcFn | null): void {
  rpcFn = fn;
}

const states = new Map<string, AgentSubagentsState>();
const listeners = new Map<string, Set<() => void>>();
const inflight = new Map<string, Promise<void>>();

function commit(agentId: string, next: AgentSubagentsState): void {
  states.set(agentId, next);
  const set = listeners.get(agentId);
  if (!set) return;
  for (const listener of set) {
    try {
      listener();
    } catch (error) {
      console.error("[acp-adapt] listener failed", error);
    }
  }
}

export function getSubagentsState(agentId: string): AgentSubagentsState {
  return states.get(agentId) ?? EMPTY_STATE;
}

export function subscribeSubagents(agentId: string, listener: () => void): () => void {
  const set = listeners.get(agentId) ?? new Set<() => void>();
  listeners.set(agentId, set);
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(agentId);
  };
}

export function runningCount(state: AgentSubagentsState): number {
  return state.rows.filter((row) => row.status === "running").length;
}

export function releaseAgent(agentId: string): void {
  states.delete(agentId);
  listeners.delete(agentId);
  inflight.delete(agentId);
}

export async function refreshSubagents(agentId: string): Promise<void> {
  if (!rpcFn) return;
  const pending = inflight.get(agentId);
  if (pending) return pending;

  const previous = getSubagentsState(agentId);
  if (previous.fetchedAt === null && !previous.loading) {
    commit(agentId, { ...previous, loading: true });
  }

  const run = rpcFn({ agentId })
    .then((output) => {
      commit(agentId, {
        rows: output.rows,
        supported: output.supported,
        provider: output.provider,
        sessionId: output.sessionId,
        error: output.error,
        loading: false,
        fetchedAt: Date.now(),
      });
    })
    .catch((error: unknown) => {
      commit(agentId, {
        ...getSubagentsState(agentId),
        loading: false,
        fetchedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      inflight.delete(agentId);
    });

  inflight.set(agentId, run);
  return run;
}
