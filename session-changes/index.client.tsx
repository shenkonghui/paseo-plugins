import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { ChangesPanel } from "./client/panel";
import {
  clearAgentChanges,
  configureCheckpointsRpc,
  configureEditDetailsRpc,
  getAgentChanges,
  releaseAgent,
  releaseAllAgents,
  subscribeAgentChanges,
  summarizeChanges,
  trackAgent,
} from "./client/store";
import { checkpointsRpc, editDetailsRpc, restoreRpc } from "./shared/edit-details";

const PANEL_ID = "session-changes";
const PILL_ID = "session-changes-pill";

interface PillEntry {
  registration: PluginButtonRegistration;
  unsubscribe: () => void;
}

export default function contributeClient(client: PluginClientContext) {
  const pills = new Map<string, PillEntry>();
  let stopped = false;
  const lifetime = new AbortController();

  configureEditDetailsRpc((input) => client.rpc(editDetailsRpc, input));
  configureCheckpointsRpc(
    (input) => client.rpc(checkpointsRpc, input),
    (input) => client.rpc(restoreRpc, input),
  );

  client.addWorkspacePanel({
    id: PANEL_ID,
    title: "会话变更",
    icon: "FileDiff",
    context: "agent",
    locations: ["workspace", "explorer"],
    Component: ChangesPanel,
  });

  client.addCommandCenterItem({
    id: "open-session-changes",
    title: "会话变更：本会话修改的文件",
    icon: "FileDiff",
    keywords: ["changes", "diff", "变更", "文件"],
    context: "agent",
    onSelect({ openPanel }) {
      try {
        openPanel(PANEL_ID, { location: "explorer" });
      } catch {
        openPanel(PANEL_ID);
      }
    },
  });

  const unregister = (agentId: string): void => {
    const entry = pills.get(agentId);
    if (entry) {
      entry.unsubscribe();
      entry.registration.remove();
      pills.delete(agentId);
    }
    releaseAgent(agentId);
    clearAgentChanges(agentId);
  };

  const register = (agent: { id: string; workspaceId?: string | null; status?: string }): void => {
    if (stopped || !agent.workspaceId) return;
    const agentId = agent.id;
    const workspaceId = agent.workspaceId;

    const existing = pills.get(agentId);
    if (existing) {
      // idle agents are tracked lazily (panel open), so a fresh run must start tracking here
      if (agent.status === "running") trackAgent(client.paseo, agentId);
      return;
    }

    if (agent.status === "running") trackAgent(client.paseo, agentId);

    const registration = client.addComposerPill({
      id: PILL_ID,
      workspaceId,
      agentId,
      button: {
        title: "查看本会话的文件变更（来自编辑工具调用，不依赖 git）",
        icon: "FileDiff",
        label: "会话变更",
        visible: false,
        behavior: {
          kind: "action",
          onPress() {
            try {
              client.openPanel(PANEL_ID, { workspaceId, agentId, location: "explorer" });
            } catch {
              client.openPanel(PANEL_ID, { workspaceId, agentId });
            }
          },
        },
      },
    });

    const syncPill = (): void => {
      const changes = getAgentChanges(agentId);
      const summary = summarizeChanges(changes);
      registration.update({
        visible: changes.fileCount > 0,
        label: summary === "" ? "会话变更" : summary,
        title:
          changes.fileCount > 0
            ? `本会话已修改 ${changes.fileCount} 个文件，点击查看变更`
            : "查看本会话的文件变更（来自编辑工具调用，不依赖 git）",
      });
    };
    const unsubscribe = subscribeAgentChanges(agentId, syncPill);
    pills.set(agentId, { registration, unsubscribe });
    syncPill();
  };

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          for (const entry of pills.values()) {
            entry.unsubscribe();
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
    .catch((error) => {
      if (!stopped) console.error("[session-changes] agent observation failed", error);
    });

  return () => {
    stopped = true;
    lifetime.abort();
    configureEditDetailsRpc(null);
    configureCheckpointsRpc(null, null);
    for (const entry of pills.values()) {
      entry.unsubscribe();
      entry.registration.remove();
    }
    pills.clear();
    releaseAllAgents();
  };
}
