import type {
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Heartbeat } from "../shared/heartbeats";
import { heartbeatActionRpc, heartbeatListRpc } from "../shared/heartbeats";

const PILL_ID = "heartbeat-pill";
const POLL_MS = 20_000;

type ListRpc = (input: Record<string, never>) => Promise<{ error: string | null; heartbeats: Heartbeat[] }>;
type ActionRpc = (input: {
  id: string;
  action: "pause" | "resume" | "run-once" | "delete";
}) => Promise<{ error: string | null }>;

interface PillSnapshot {
  heartbeats: Heartbeat[];
  error: string | null;
  loading: boolean;
  updatedAt: number | null;
}

let snapshot: PillSnapshot = { heartbeats: [], error: null, loading: true, updatedAt: null };
const listeners = new Set<() => void>();
let listRpc: ListRpc | null = null;
let actionRpc: ActionRpc | null = null;
let openManager: (() => void) | null = null;
let refreshing = false;

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

async function refreshPills(): Promise<void> {
  if (!listRpc || refreshing) return;
  refreshing = true;
  try {
    const result = await listRpc({});
    snapshot = {
      heartbeats: result.heartbeats,
      error: result.error,
      loading: false,
      updatedAt: Date.now(),
    };
  } catch (cause) {
    snapshot = { ...snapshot, error: errorText(cause), loading: false };
  } finally {
    refreshing = false;
    notify();
  }
}

async function runAction(id: string, action: "pause" | "resume" | "run-once"): Promise<void> {
  if (!actionRpc) return;
  try {
    const result = await actionRpc({ id, action });
    snapshot = { ...snapshot, error: result.error };
    notify();
  } catch (cause) {
    snapshot = { ...snapshot, error: errorText(cause) };
    notify();
    return;
  }
  await refreshPills();
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "未知错误";
}

function enabledFor(agentId: string, heartbeats: Heartbeat[]): Heartbeat[] {
  return heartbeats
    .filter((heartbeat) => heartbeat.agentId === agentId && heartbeat.status !== "completed")
    .sort((left, right) => {
      if (left.status !== right.status) return left.status === "active" ? -1 : 1;
      return (left.nextRunAt ?? "9999").localeCompare(right.nextRunAt ?? "9999");
    });
}

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const diff = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(diff)) return "—";
  const minutes = Math.round(Math.abs(diff) / 60_000);
  const text =
    minutes < 1 ? "刚刚" : minutes < 60 ? `${minutes} 分钟` : minutes < 1440 ? `${Math.round(minutes / 60)} 小时` : `${Math.round(minutes / 1440)} 天`;
  return diff >= 0 ? `${text}后` : `${text}前`;
}

function HeartbeatPopover(props: PluginButtonContentProps) {
  const { theme, layout, close } = props;
  const agentId = props.context === "agent" ? props.agentId : "";
  const [, forceUpdate] = useState(0);
  const [pendingId, setPendingId] = useState<string | null>(null);

  useEffect(() => subscribe(() => forceUpdate((value) => value + 1)), []);
  useEffect(() => {
    void refreshPills();
  }, [agentId]);

  const state = snapshot;
  const rows = useMemo(() => enabledFor(agentId, state.heartbeats), [agentId, state]);

  const styles = useMemo(
    () => ({
      body: { gap: 10, minWidth: layout.compact ? 260 : 340, maxWidth: 560 },
      header: { gap: 2 },
      title: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const },
      hint: { color: theme.colors.foregroundMuted, fontSize: 12 },
      row: {
        gap: 4,
        paddingTop: 10,
        marginTop: 2,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
      },
      rowHead: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      name: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const, flexShrink: 1 },
      status: { fontSize: 11, fontWeight: "600" as const },
      meta: { color: theme.colors.foregroundMuted, fontSize: 11 },
      prompt: { color: theme.colors.foregroundMuted, fontSize: 12 },
      actions: { flexDirection: "row" as const, alignItems: "center" as const, gap: 14, paddingTop: 2 },
      action: { color: theme.colors.accent, fontSize: 12 },
      footer: { flexDirection: "row" as const, alignItems: "center" as const, gap: 12, paddingTop: 4 },
      close: {
        alignSelf: "flex-start" as const,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 6,
        backgroundColor: theme.colors.surface2,
      },
    }),
    [theme, layout.compact],
  );

  const statusColor = (status: Heartbeat["status"]): string =>
    status === "active" ? theme.colors.statusSuccess : status === "paused" ? theme.colors.statusWarning : theme.colors.foregroundMuted;
  const statusLabel = (status: Heartbeat["status"]): string =>
    status === "active" ? "运行中" : status === "paused" ? "已暂停" : "已完成";

  const act = async (heartbeat: Heartbeat, action: "pause" | "resume" | "run-once"): Promise<void> => {
    setPendingId(heartbeat.id);
    try {
      await runAction(heartbeat.id, action);
    } finally {
      setPendingId(null);
    }
  };

  return (
    <View style={styles.body}>
      <View style={styles.header}>
        <Text style={styles.title}>已开启的心跳</Text>
        <Text style={styles.hint}>
          {state.error
            ? state.error
            : state.loading
              ? "正在读取…"
              : `${rows.length} 条 · ${state.updatedAt ? `${new Date(state.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} 刷新` : ""}`}
        </Text>
      </View>

      {rows.length > 0 ? (
        <ScrollView style={{ maxHeight: 360 }}>
          {rows.map((heartbeat) => {
            const busy = pendingId === heartbeat.id;
            return (
              <View key={heartbeat.id} style={styles.row}>
                <View style={styles.rowHead}>
                  <Text style={styles.name} numberOfLines={1}>
                    {heartbeat.name || heartbeat.id}
                  </Text>
                  <View style={{ flex: 1 }} />
                  <Text style={[styles.status, { color: statusColor(heartbeat.status) }]}>
                    {statusLabel(heartbeat.status)}
                  </Text>
                </View>
                <Text style={styles.meta} numberOfLines={1}>
                  {heartbeat.cron || "—"}
                  {heartbeat.timezone ? ` (${heartbeat.timezone})` : ""} · 下次 {formatRelative(heartbeat.nextRunAt)} · 上次{" "}
                  {formatRelative(heartbeat.lastRunAt)}
                </Text>
                <Text style={styles.prompt} numberOfLines={2}>
                  {heartbeat.prompt}
                </Text>
                <View style={styles.actions}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={heartbeat.status === "active" ? "暂停该心跳" : "恢复该心跳"}
                    disabled={busy}
                    onPress={() => void act(heartbeat, heartbeat.status === "active" ? "pause" : "resume")}
                  >
                    <Text style={styles.action}>{heartbeat.status === "active" ? "暂停" : "恢复"}</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="立即运行该心跳"
                    disabled={busy}
                    onPress={() => void act(heartbeat, "run-once")}
                  >
                    <Text style={styles.action}>立即运行</Text>
                  </Pressable>
                </View>
              </View>
            );
          })}
        </ScrollView>
      ) : (
        <Text style={styles.hint}>
          {snapshot.loading ? "正在读取…" : "该 agent 没有运行中或已暂停的心跳。可在「心跳」管理页新建。"}
        </Text>
      )}

      <View style={styles.footer}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="打开心跳管理页"
          onPress={() => {
            close();
            openManager?.();
          }}
        >
          <Text style={styles.action}>打开管理页</Text>
        </Pressable>
        <View style={{ flex: 1 }} />
        <Pressable accessibilityRole="button" accessibilityLabel="关闭心跳浮层" onPress={close} style={styles.close}>
          <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>关闭</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** 每个 agent 的 composer 左下角注册一个 pill：仅在存在未完成心跳时显示。 */
export function contributeHeartbeatPills(client: PluginClientContext, openScreen: () => void): () => void {
  listRpc = (input) => client.rpc(heartbeatListRpc, input);
  actionRpc = (input) => client.rpc(heartbeatActionRpc, input);
  openManager = openScreen;

  const pills = new Map<string, PluginButtonRegistration>();
  const lifetime = new AbortController();
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const syncPill = (agentId: string, registration: PluginButtonRegistration): void => {
    const items = enabledFor(agentId, snapshot.heartbeats);
    if (items.length === 0) {
      registration.update({ visible: false });
      return;
    }
    const active = items.filter((heartbeat) => heartbeat.status === "active").length;
    const paused = items.length - active;
    registration.update({
      visible: true,
      label: `心跳 ${items.length}`,
      title: `${active} 条运行中${paused > 0 ? `，${paused} 条已暂停` : ""}`,
    });
  };

  const syncAll = (): void => {
    for (const [agentId, registration] of pills) syncPill(agentId, registration);
  };

  const unsubscribe = subscribe(() => syncAll());

  const register = (agent: { id: string; workspaceId?: string | null }): void => {
    if (stopped || !agent.workspaceId || pills.has(agent.id)) return;
    const registration = client.addComposerPill({
      id: PILL_ID,
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      button: {
        title: "心跳",
        icon: "HeartPulse",
        label: "心跳",
        visible: false,
        behavior: { kind: "popover", Content: HeartbeatPopover },
      },
    });
    pills.set(agent.id, registration);
    syncPill(agent.id, registration);
  };

  const unregister = (agentId: string): void => {
    const registration = pills.get(agentId);
    if (!registration) return;
    registration.remove();
    pills.delete(agentId);
  };

  void refreshPills();
  timer = setInterval(() => void refreshPills(), POLL_MS);

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          for (const agentId of [...pills.keys()]) unregister(agentId);
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
      if (!stopped) console.error("[heartbeat-manager] agent 订阅失败", error);
    });

  return () => {
    stopped = true;
    lifetime.abort();
    unsubscribe();
    if (timer !== null) clearInterval(timer);
    timer = null;
    for (const agentId of [...pills.keys()]) unregister(agentId);
    listRpc = null;
    actionRpc = null;
    openManager = null;
  };
}