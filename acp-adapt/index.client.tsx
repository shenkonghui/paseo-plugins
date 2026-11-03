import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { SubagentsPanel } from "./client/panel";
import {
  configureSubagentsRpc,
  getSubagentsState,
  releaseAgent,
  refreshSubagents,
  runningCount,
  subscribeSubagents,
} from "./client/store";
import { subagentsRpc } from "./shared/subagents";

const PANEL_ID = "acp-adapt";
const PILL_ID = "acp-adapt-pill";

/** 需要适配的 provider（子任务只存在于 CLI 自己的本地存储里） */
const TRACKED_PROVIDER_PREFIXES = ["qoder"];

/** 有子任务在跑 / agent 在跑 / 全空闲 三档轮询间隔 */
const POLL_RUNNING_MS = 3_000;
const POLL_ACTIVE_MS = 5_000;
const POLL_IDLE_MS = 20_000;

function isTrackedProvider(provider: string): boolean {
  const normalized = provider.toLowerCase();
  return TRACKED_PROVIDER_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

interface PillEntry {
  registration: PluginButtonRegistration;
  unsubscribe: () => void;
  stopPolling: () => void;
  setAgentRunning: (running: boolean) => void;
}

export default function contributeClient(client: PluginClientContext) {
  configureSubagentsRpc((input) => client.rpc(subagentsRpc, input));

  const pills = new Map<string, PillEntry>();
  let stopped = false;
  const lifetime = new AbortController();

  client.addWorkspacePanel({
    id: PANEL_ID,
    title: "子任务",
    icon: "ListTodo",
    context: "agent",
    locations: ["workspace"],
    Component: SubagentsPanel,
  });

  const unregister = (agentId: string): void => {
    const entry = pills.get(agentId);
    if (!entry) return;
    entry.unsubscribe();
    entry.stopPolling();
    entry.registration.remove();
    pills.delete(agentId);
    releaseAgent(agentId);
  };

  const register = (agent: {
    id: string;
    provider?: string;
    workspaceId?: string | null;
    status?: string;
  }): void => {
    if (stopped) return;
    if (!agent.workspaceId) return;
    if (!isTrackedProvider(agent.provider ?? "")) return;

    const agentId = agent.id;
    const workspaceId = agent.workspaceId;
    let agentRunning = agent.status === "running";

    const existing = pills.get(agentId);
    if (existing) {
      existing.setAgentRunning(agentRunning);
      return;
    }

    const registration = client.addComposerPill({
      id: PILL_ID,
      workspaceId,
      agentId,
      button: {
        title: "ACP 子任务（来自 CLI 本地任务存储）",
        icon: "ListTodo",
        label: "子任务",
        visible: false,
        behavior: {
          kind: "action",
          onPress() {
            client.openPanel(PANEL_ID, { workspaceId, agentId });
          },
        },
      },
    });

    const syncPill = (): void => {
      const state = getSubagentsState(agentId);
      if (!state.supported) {
        registration.update({ visible: false });
        return;
      }
      const total = state.rows.length;
      const running = runningCount(state);
      if (total === 0) {
        registration.update({ visible: false });
        return;
      }
      const label = running > 0 ? `子任务 ${running}/${total}` : `子任务 ${total}`;
      const runningNames = state.rows
        .filter((row) => row.status === "running")
        .map((row) => row.name)
        .slice(0, 3)
        .join("、");
      registration.update({
        visible: true,
        label,
        title:
          running > 0
            ? `正在运行：${runningNames || `${running} 个子任务`}（点击查看）`
            : `${total} 个子任务，均已完成（点击查看）`,
      });
    };

    const unsubscribe = subscribeSubagents(agentId, syncPill);

    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const schedule = (): void => {
      if (disposed) return;
      const state = getSubagentsState(agentId);
      const delay =
        runningCount(state) > 0
          ? POLL_RUNNING_MS
          : agentRunning
            ? POLL_ACTIVE_MS
            : POLL_IDLE_MS;
      timer = setTimeout(() => {
        void refreshSubagents(agentId).finally(schedule);
      }, delay);
    };

    const stopPolling = (): void => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };

    pills.set(agentId, {
      registration,
      unsubscribe,
      stopPolling,
      setAgentRunning(next: boolean) {
        const becameRunning = next && !agentRunning;
        agentRunning = next;
        if (becameRunning) void refreshSubagents(agentId);
      },
    });

    syncPill();
    void refreshSubagents(agentId).finally(schedule);
  };

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          for (const entry of pills.values()) {
            entry.unsubscribe();
            entry.stopPolling();
            entry.registration.remove();
          }
          pills.clear();
          for (const { agent } of entries) register(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") unregister(update.agentId);
          else register(update.agent);
        },
      });
      return undefined;
    })
    .catch((error: unknown) => {
      if (!stopped) console.error("[acp-adapt] agent observation failed", error);
    });

  return () => {
    stopped = true;
    lifetime.abort();
    configureSubagentsRpc(null);
    for (const entry of pills.values()) {
      entry.unsubscribe();
      entry.stopPolling();
      entry.registration.remove();
    }
    pills.clear();
  };
}
