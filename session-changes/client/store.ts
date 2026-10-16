import type {
  PaseoAgentStream,
  PaseoAgentTimelineEvent,
  PaseoAgentTimelineHandle,
  PaseoApi,
} from "@getpaseo/client";
import type { ToolCallDetail, ToolCallTimelineItem } from "@getpaseo/protocol/agent-types";
import type {
  CheckpointRecord,
  CheckpointsInput,
  CheckpointsOutput,
  EditDetailRecord,
  EditDetailsInput,
  EditDetailsOutput,
  RestoreInput,
  RestoreOutput,
} from "../shared/edit-details";
import { buildDiff, countUnifiedLines, splitLines } from "./diff";

type TimelinePage = Awaited<ReturnType<PaseoAgentTimelineHandle["refetch"]>>;

export type ChangeStatus = "running" | "completed" | "failed" | "canceled";

export interface ChangeRecord {
  callId: string;
  kind: "edit" | "write";
  filePath: string;
  oldText?: string;
  newText?: string;
  unifiedDiff?: string;
  status: ChangeStatus;
  at: string;
  adds: number;
  dels: number;
}

export interface FileChangeState {
  filePath: string;
  records: ChangeRecord[];
  adds: number;
  dels: number;
}

export interface AgentChangesState {
  files: FileChangeState[];
  fileCount: number;
  adds: number;
  dels: number;
}

const EMPTY_CHANGES: AgentChangesState = { files: [], fileCount: 0, adds: 0, dels: 0 };
const TAIL_LIMIT = 300;

interface AgentStore {
  byCallId: Map<string, ChangeRecord>;
  listeners: Set<() => void>;
  cached: AgentChangesState | null;
  hydrationAttempts: Map<string, number>;
}

const stores = new Map<string, AgentStore>();
const trackers = new Map<string, () => void>();

function storeFor(agentId: string): AgentStore {
  let store = stores.get(agentId);
  if (!store) {
    store = {
      byCallId: new Map(),
      listeners: new Set(),
      cached: null,
      hydrationAttempts: new Map(),
    };
    stores.set(agentId, store);
  }
  return store;
}

function notify(store: AgentStore): void {
  store.cached = null;
  for (const listener of store.listeners) {
    try {
      listener();
    } catch (error) {
      console.error("[session-changes] listener failed", error);
    }
  }
}

function countsForEdit(detail: Extract<ToolCallDetail, { type: "edit" }>): {
  adds: number;
  dels: number;
} {
  if (detail.oldString !== undefined || detail.newString !== undefined) {
    const block = buildDiff(detail.oldString ?? "", detail.newString ?? "");
    return { adds: block.adds, dels: block.dels };
  }
  if (detail.unifiedDiff) return countUnifiedLines(detail.unifiedDiff);
  return { adds: 0, dels: 0 };
}

/** 任务类工具（如 TaskCreate）也会以 edit 详情出现，filePath 为 "file" 之类的非路径值，需过滤 */
function looksLikePath(filePath: string): boolean {
  if (/[/\\]/.test(filePath)) return true;
  return /^[^./\\]+\.[^./\\]+$/.test(filePath);
}

function recordFromToolCall(item: ToolCallTimelineItem, at: string): ChangeRecord | null {
  const detail = item.detail;
  if (detail.type !== "edit" && detail.type !== "write") return null;
  const filePath = detail.filePath?.trim();
  if (!filePath || !looksLikePath(filePath)) return null;
  if (detail.type === "edit") {
    const { adds, dels } = countsForEdit(detail);
    return {
      callId: item.callId,
      kind: "edit",
      filePath,
      oldText: detail.oldString,
      newText: detail.newString,
      unifiedDiff: detail.unifiedDiff,
      status: item.status,
      at,
      adds,
      dels,
    };
  }
  const content = detail.content;
  const adds = content === undefined || content === "" ? 0 : splitLines(content).length;
  return {
    callId: item.callId,
    kind: "write",
    filePath,
    newText: content,
    status: item.status,
    at,
    adds,
    dels: 0,
  };
}

export function ingestToolCall(agentId: string, item: ToolCallTimelineItem, at: string): void {
  const record = recordFromToolCall(item, at);
  if (!record) return;
  const store = storeFor(agentId);
  const existing = store.byCallId.get(record.callId);
  if (existing) record.at = existing.at;
  store.byCallId.set(record.callId, record);
  notify(store);
  scheduleHydration(agentId);
}

export function getAgentChanges(agentId: string): AgentChangesState {
  const store = stores.get(agentId);
  if (!store) return EMPTY_CHANGES;
  if (store.cached) return store.cached;

  const files = new Map<string, FileChangeState>();
  for (const record of store.byCallId.values()) {
    let file = files.get(record.filePath);
    if (!file) {
      file = { filePath: record.filePath, records: [], adds: 0, dels: 0 };
      files.set(record.filePath, file);
    }
    file.records.push(record);
    file.adds += record.adds;
    file.dels += record.dels;
  }

  const result: AgentChangesState = {
    files: [...files.values()],
    fileCount: files.size,
    adds: 0,
    dels: 0,
  };
  for (const file of result.files) {
    result.adds += file.adds;
    result.dels += file.dels;
  }
  store.cached = result;
  return result;
}

export function subscribeAgentChanges(agentId: string, listener: () => void): () => void {
  const store = storeFor(agentId);
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
  };
}

export function clearAgentChanges(agentId: string): void {
  const store = stores.get(agentId);
  if (!store) return;
  store.byCallId.clear();
  store.hydrationAttempts.clear();
  notify(store);
}

type EditDetailsInvoker = (input: EditDetailsInput) => Promise<EditDetailsOutput>;

let editDetailsInvoker: EditDetailsInvoker | null = null;

/** 提供方未上报行级差异时，由服务端组件从本地会话转录补齐（见 server/transcript.ts） */
export function configureEditDetailsRpc(invoker: EditDetailsInvoker | null): void {
  editDetailsInvoker = invoker;
}

type CheckpointsInvoker = (input: CheckpointsInput) => Promise<CheckpointsOutput>;
type RestoreInvoker = (input: RestoreInput) => Promise<RestoreOutput>;

let checkpointsInvoker: CheckpointsInvoker | null = null;
let restoreInvoker: RestoreInvoker | null = null;

export function configureCheckpointsRpc(
  list: CheckpointsInvoker | null,
  restore: RestoreInvoker | null,
): void {
  checkpointsInvoker = list;
  restoreInvoker = restore;
}

export async function fetchCheckpoints(agentId: string): Promise<CheckpointRecord[]> {
  if (!checkpointsInvoker) throw new Error("检查点服务不可用（插件未就绪）");
  const output = await checkpointsInvoker({ agentId });
  return output.checkpoints;
}

export async function restoreAgentCheckpoint(
  agentId: string,
  checkpointId: string,
): Promise<RestoreOutput> {
  if (!restoreInvoker) throw new Error("恢复服务不可用（插件未就绪）");
  return await restoreInvoker({ agentId, checkpointId });
}

const HYDRATION_DELAY_MS = 700;
const MAX_HYDRATION_ATTEMPTS = 3;

const hydrationTimers = new Map<string, ReturnType<typeof setTimeout>>();

function needsHydration(record: ChangeRecord): boolean {
  if (record.status === "running") return false;
  if (record.kind === "write") return record.newText === undefined;
  if (record.oldText !== undefined || record.newText !== undefined) return false;
  return record.adds + record.dels === 0;
}

function scheduleHydration(agentId: string): void {
  if (hydrationTimers.has(agentId)) return;
  const timer = setTimeout(() => {
    hydrationTimers.delete(agentId);
    void hydrate(agentId);
  }, HYDRATION_DELAY_MS);
  hydrationTimers.set(agentId, timer);
}

function mergeHydratedDetails(agentId: string, records: EditDetailRecord[]): boolean {
  const store = stores.get(agentId);
  if (!store) return false;
  let changed = false;
  for (const entry of records) {
    const record = store.byCallId.get(entry.callId);
    if (!record || !needsHydration(record)) continue;
    if (entry.diff) {
      record.unifiedDiff = entry.diff;
      const counts = countUnifiedLines(entry.diff);
      record.adds = entry.additions ?? counts.adds;
      record.dels = entry.deletions ?? counts.dels;
      changed = true;
    } else if (entry.oldText !== undefined || entry.newText !== undefined) {
      record.oldText = entry.oldText;
      record.newText = entry.newText;
      const block = buildDiff(entry.oldText, entry.newText);
      record.adds = block.adds;
      record.dels = block.dels;
      changed = true;
    } else if (entry.content !== undefined && record.kind === "write") {
      record.newText = entry.content;
      record.adds = entry.content === "" ? 0 : splitLines(entry.content).length;
      changed = true;
    }
  }
  if (changed) notify(store);
  return changed;
}

async function hydrate(agentId: string): Promise<void> {
  const invoker = editDetailsInvoker;
  const store = stores.get(agentId);
  if (!invoker || !store) return;
  const callIds: string[] = [];
  for (const record of store.byCallId.values()) {
    if (!needsHydration(record)) continue;
    if ((store.hydrationAttempts.get(record.callId) ?? 0) >= MAX_HYDRATION_ATTEMPTS) continue;
    callIds.push(record.callId);
  }
  if (callIds.length === 0) return;
  for (const callId of callIds) {
    store.hydrationAttempts.set(callId, (store.hydrationAttempts.get(callId) ?? 0) + 1);
  }
  let result: EditDetailsOutput;
  try {
    result = await invoker({ agentId, callIds });
  } catch (error) {
    console.warn(`[session-changes] edit details fetch failed for ${agentId}`, error);
    return;
  }
  if (stores.get(agentId) !== store) return;
  mergeHydratedDetails(agentId, result.records);
  for (const record of store.byCallId.values()) {
    if (needsHydration(record)) {
      scheduleHydration(agentId);
      return;
    }
  }
}

function ingestPage(agentId: string, page: TimelinePage): void {
  for (const entry of page.entries) {
    if (entry.item.type !== "tool_call") continue;
    ingestToolCall(agentId, entry.item as ToolCallTimelineItem, entry.timestamp);
  }
}

export function trackAgent(paseo: PaseoApi, agentId: string): void {
  if (trackers.has(agentId)) return;
  let stopped = false;

  const refetch = async (): Promise<void> => {
    try {
      const page = await paseo.agents.ref(agentId).timeline.refetch({
        direction: "tail",
        limit: TAIL_LIMIT,
      });
      if (stopped) return;
      ingestPage(agentId, page);
    } catch (error) {
      if (!stopped) console.warn(`[session-changes] timeline fetch failed for ${agentId}`, error);
    }
  };

  const handleEvent = (event: PaseoAgentTimelineEvent): void => {
    if (stopped) return;
    if (event.event.type === "timeline") {
      const stream = event as PaseoAgentStream;
      if (stream.event.type !== "timeline") return;
      if (stream.event.item.type !== "tool_call") return;
      ingestToolCall(agentId, stream.event.item as ToolCallTimelineItem, stream.timestamp);
      return;
    }
    if (event.event.type === "subscription_restored") {
      void refetch();
      return;
    }
    if (event.event.type === "replacement") {
      clearAgentChanges(agentId);
      void refetch();
    }
  };

  const subscription = paseo.agents.ref(agentId).timeline.subscribe(handleEvent);
  void subscription.ready.then(() => refetch()).catch(() => {});

  const release = (): void => {
    stopped = true;
    subscription();
    trackers.delete(agentId);
  };
  trackers.set(agentId, release);
}

export function ensureAgentTracked(paseo: PaseoApi, agentId: string): void {
  trackAgent(paseo, agentId);
}

export async function refreshAgent(paseo: PaseoApi, agentId: string): Promise<void> {
  try {
    const page = await paseo.agents.ref(agentId).timeline.refetch({
      direction: "tail",
      limit: TAIL_LIMIT,
    });
    ingestPage(agentId, page);
  } catch (error) {
    console.warn(`[session-changes] manual refresh failed for ${agentId}`, error);
  }
}

export function releaseAgent(agentId: string): void {
  trackers.get(agentId)?.();
}

export function releaseAllAgents(): void {
  for (const release of [...trackers.values()]) release();
  trackers.clear();
}

export function summarizeChanges(changes: AgentChangesState): string {
  if (changes.fileCount === 0) return "";
  const counts: string[] = [];
  if (changes.adds > 0) counts.push(`+${changes.adds}`);
  if (changes.dels > 0) counts.push(`-${changes.dels}`);
  return counts.length > 0
    ? `${changes.fileCount} 文件 ${counts.join(" ")}`
    : `${changes.fileCount} 文件`;
}
