import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type {
  PluginAgentPanelContribution,
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { processOutputRpc, processesSnapshotRpc, type AgentProcessRow } from "../shared/processes";
import { configureProcessesRpc, getAgentProcesses, getProcessesState, refreshProcesses, subscribeProcesses } from "./processes-store";
import { configureProcessPanel, openProcessOutput, ProcessOutputPanel, PROCESS_PANEL_ID } from "./process-panel";

const PILL_ID = "agent-processes";

/** 有子进程时 5s 一次；全空闲 15s 一次（一次 RPC 覆盖所有 agent）。 */
const POLL_ACTIVE_MS = 5_000;
const POLL_IDLE_MS = 15_000;

const STATE_LABELS: Record<string, string> = {
  R: "运行",
  S: "等待",
  D: "不可中断",
  T: "暂停",
  Z: "僵尸",
};

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

function ProcessesPopover(props: PluginButtonContentProps) {
  const { theme, close } = props;
  // pill 是按 agent 注册的，运行时必定是 agent 上下文；类型上仍是 workspace | agent 联合。
  const agentId = props.context === "agent" ? props.agentId : "";
  const { workspaceId } = props;
  const [, forceUpdate] = useState(0);
  const { status, snapshot, error } = getProcessesState();
  const data = getAgentProcesses(agentId);

  useEffect(() => {
    if (!agentId) return;
    const unsubscribe = subscribeProcesses(() => forceUpdate((value) => value + 1));
    void refreshProcesses([agentId]);
    return unsubscribe;
  }, [agentId]);

  const styles = useMemo(
    () => ({
      body: { gap: 10, minWidth: 340, maxWidth: 560 },
      header: { gap: 2 },
      title: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const },
      hint: { color: theme.colors.foregroundMuted, fontSize: 12 },
      row: {
        gap: 2,
        paddingTop: 8,
        marginTop: 2,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
      },
      command: { color: theme.colors.foreground, fontSize: 12 },
      meta: { color: theme.colors.foregroundMuted, fontSize: 11 },
      metaRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      action: { color: theme.colors.accent, fontSize: 11 },
      close: {
        alignSelf: "flex-start" as const,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 6,
        backgroundColor: theme.colors.surface2,
      },
    }),
    [theme],
  );

  const rows = data?.rows ?? [];

  return (
    <View style={styles.body}>
      <View style={styles.header}>
        <Text style={styles.title}>后台进程</Text>
        <Text style={styles.hint}>
          {snapshot && !snapshot.supported
            ? "当前平台不支持（仅 Linux 可读 /proc）"
            : data?.rootPid
              ? `agent pid ${data.rootPid} · ${rows.length} 个后台任务`
              : status === "loading"
                ? "正在读取进程树…"
                : "没有可显示的后台任务（已过滤 MCP / 前台命令）"}
        </Text>
      </View>

      {error ? <Text style={[styles.hint, { color: theme.colors.statusDanger }]}>{error}</Text> : null}

      {rows.length > 0 ? (
        <ScrollView style={{ maxHeight: 360 }}>
          {rows.map((row: AgentProcessRow) => (
            <View key={row.pid} style={[styles.row, { paddingLeft: Math.min(row.depth - 1, 3) * 12 }]}>
              <Text style={styles.command} numberOfLines={2}>
                {row.command}
              </Text>
              <View style={styles.metaRow}>
                <Text style={[styles.meta, { flexShrink: 1 }]} numberOfLines={1}>
                  pid {row.pid} · {formatElapsed(row.elapsedMs)} ·{" "}
                  {STATE_LABELS[row.state] ?? row.state}
                  {row.cwd ? ` · ${row.cwd}` : ""}
                </Text>
                <View style={{ flex: 1 }} />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`在侧边栏查看 pid ${row.pid} 的输出`}
                  onPress={() => openProcessOutput(agentId, workspaceId, row.pid)}
                >
                  <Text style={styles.action}>输出</Text>
                </Pressable>
              </View>
            </View>
          ))}
        </ScrollView>
      ) : null}

      <Pressable accessibilityRole="button" accessibilityLabel="关闭后台进程面板" onPress={close} style={styles.close}>
        <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>关闭</Text>
      </Pressable>
    </View>
  );
}

interface PillEntry {
  registration: PluginButtonRegistration;
  sync: () => void;
}

export function contributeAgentProcesses(client: PluginClientContext): () => void {
  configureProcessesRpc({
    snapshot: (input) => client.rpc(processesSnapshotRpc, input),
    output: (input) => client.rpc(processOutputRpc, input),
  });
  configureProcessPanel(client);

  // 右侧栏面板：单个 agent 的进程列表 + 输出尾部。
  // app 0.12 没有 addAgentPanel，退回 addWorkspacePanel({ context: "agent" }) 旧写法。
  const panelContribution: PluginAgentPanelContribution = {
    id: PROCESS_PANEL_ID,
    title: "后台进程输出",
    icon: "Terminal",
    locations: ["workspace", "explorer"],
    Component: ProcessOutputPanel,
  };
  const disposePanel =
    typeof client.addAgentPanel === "function"
      ? client.addAgentPanel(panelContribution)
      : client.addWorkspacePanel({ ...panelContribution, context: "agent" });

  const pills = new Map<string, PillEntry>();
  const lifetime = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const syncPill = (agentId: string, registration: PluginButtonRegistration): void => {
    const { snapshot } = getProcessesState();
    if (!snapshot || !snapshot.supported) {
      registration.update({ visible: false });
      return;
    }

    const rows = snapshot.agents[agentId]?.rows ?? [];
    if (rows.length === 0) {
      registration.update({ visible: false });
      return;
    }

    const running = rows.filter((row) => row.state === "R").length;
    const label = running > 0 ? `后台进程 ${running}/${rows.length}` : `后台进程 ${rows.length}`;
    const preview = rows
      .slice(0, 3)
      .map((row) => row.command.split(" ").slice(0, 2).join(" "))
      .join("、");
    registration.update({
      visible: true,
      label,
      title: `${rows.length} 个后台任务${running > 0 ? `（${running} 个在运行）` : ""}：${preview}`,
    });
  };

  const unsubscribeStore = subscribeProcesses(() => {
    for (const entry of pills.values()) entry.sync();
  });

  const schedule = (delay: number): void => {
    if (stopped) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => void tick(), delay);
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (pills.size === 0) {
      schedule(POLL_IDLE_MS);
      return;
    }
    await refreshProcesses([...pills.keys()]);
    const { snapshot } = getProcessesState();
    const active = snapshot
      ? [...pills.keys()].some((agentId) => (snapshot.agents[agentId]?.rows.length ?? 0) > 0)
      : false;
    schedule(active ? POLL_ACTIVE_MS : POLL_IDLE_MS);
  };

  const register = (agent: { id: string; workspaceId?: string | null }): void => {
    if (stopped || !agent.workspaceId || pills.has(agent.id)) return;
    const agentId = agent.id;
    const workspaceId = agent.workspaceId;

    const registration = client.addComposerPill({
      id: PILL_ID,
      workspaceId,
      agentId,
      button: {
        title: "后台任务（已过滤 MCP 与前台命令）",
        icon: "Terminal",
        label: "后台进程",
        visible: false,
        behavior: { kind: "popover", Content: ProcessesPopover },
      },
    });

    const entry: PillEntry = {
      registration,
      sync: () => syncPill(agentId, registration),
    };
    pills.set(agentId, entry);
    entry.sync();
    void refreshProcesses([...pills.keys()]);
  };

  const unregister = (agentId: string): void => {
    const entry = pills.get(agentId);
    if (!entry) return;
    entry.registration.remove();
    pills.delete(agentId);
  };

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          for (const agentId of [...pills.keys()]) unregister(agentId);
          for (const { agent } of entries) register(agent);
          schedule(0);
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
      if (!stopped) console.error("[agent-injector] 进程树订阅失败", error);
    });

  return () => {
    stopped = true;
    lifetime.abort();
    disposePanel();
    configureProcessPanel(null);
    if (timer !== null) clearTimeout(timer);
    timer = null;
    unsubscribeStore();
    configureProcessesRpc(null);
    for (const agentId of [...pills.keys()]) unregister(agentId);
  };
}
