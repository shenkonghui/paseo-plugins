import type {
  AgentProcesses,
  ProcessOutput,
  ProcessOutputInput,
  ProcessesSnapshot,
} from "../shared/processes";

type SnapshotRpc = (input: { agentIds: string[] }) => Promise<ProcessesSnapshot>;
type OutputRpc = (input: ProcessOutputInput) => Promise<ProcessOutput>;

interface ProcessesRpc {
  snapshot: SnapshotRpc;
  output: OutputRpc;
}

export interface ProcessesState {
  status: "idle" | "loading" | "ready" | "error";
  snapshot: ProcessesSnapshot | null;
  error: string | null;
}

let rpc: ProcessesRpc | null = null;
let state: ProcessesState = { status: "idle", snapshot: null, error: null };
let inFlight = false;
let requestSeq = 0;

const listeners = new Set<() => void>();

export function configureProcessesRpc(next: ProcessesRpc | null): void {
  rpc = next;
  if (!next) {
    state = { status: "idle", snapshot: null, error: null };
    inFlight = false;
    requestSeq = 0;
  }
}

export function getProcessesState(): ProcessesState {
  return state;
}

export function getAgentProcesses(agentId: string): AgentProcesses | null {
  return state.snapshot?.agents[agentId] ?? null;
}

export function subscribeProcesses(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(next: ProcessesState): void {
  state = next;
  for (const listener of listeners) listener();
}

export async function refreshProcesses(agentIds: string[]): Promise<void> {
  if (!rpc || inFlight || agentIds.length === 0) return;
  const seq = ++requestSeq;
  inFlight = true;
  if (state.snapshot === null) emit({ status: "loading", snapshot: null, error: null });

  try {
    const snapshot = await rpc.snapshot({ agentIds });
    if (seq !== requestSeq) return;
    emit({ status: "ready", snapshot, error: snapshot.error });
  } catch (error) {
    if (seq !== requestSeq) return;
    emit({
      status: "error",
      snapshot: state.snapshot,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (seq === requestSeq) inFlight = false;
  }
}

export async function fetchProcessOutput(input: ProcessOutputInput): Promise<ProcessOutput> {
  if (!rpc) throw new Error("插件未就绪");
  return await rpc.output(input);
}
