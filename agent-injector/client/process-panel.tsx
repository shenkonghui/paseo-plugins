import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { PluginAgentPanelProps, PluginClientContext } from "@getpaseo/plugin/client";
import type { AgentProcessRow } from "../shared/processes";
import { ProcessOutputBlock } from "./process-output";
import { getAgentProcesses, refreshProcesses, subscribeProcesses } from "./processes-store";

export const PROCESS_PANEL_ID = "agent-process-output";

const POLL_MS = 4_000;

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

/* ------------------------------------------------------------------ */
/* 选择状态：pill 浮层点「输出」时先写这里，再打开侧边栏面板。          */
/* ------------------------------------------------------------------ */

const selection = new Map<string, number>();
const selectionListeners = new Set<() => void>();
let activeClient: PluginClientContext | null = null;

export function configureProcessPanel(client: PluginClientContext | null): void {
  activeClient = client;
}

export function getSelectedProcessPid(agentId: string): number | null {
  return selection.get(agentId) ?? null;
}

export function selectProcess(agentId: string, pid: number): void {
  selection.set(agentId, pid);
  for (const listener of selectionListeners) listener();
}

export function openProcessOutput(agentId: string, workspaceId: string, pid: number): void {
  selectProcess(agentId, pid);
  activeClient?.openPanel(PROCESS_PANEL_ID, { workspaceId, agentId, location: "explorer" });
}

function subscribeSelection(listener: () => void): () => void {
  selectionListeners.add(listener);
  return () => {
    selectionListeners.delete(listener);
  };
}

/* ------------------------------------------------------------------ */

function ProcessRow(props: {
  row: AgentProcessRow;
  selected: boolean;
  theme: PluginAgentPanelProps["theme"];
  onPress: () => void;
}) {
  const { row, selected, theme, onPress } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`查看 pid ${row.pid} 的输出`}
      onPress={onPress}
      style={{
        gap: 2,
        paddingHorizontal: 8,
        paddingVertical: 6,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: selected ? theme.colors.accent : "transparent",
        backgroundColor: selected ? theme.colors.surface2 : "transparent",
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: 12 }} numberOfLines={1}>
        {row.command}
      </Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }} numberOfLines={1}>
        pid {row.pid} · {formatElapsed(row.elapsedMs)} · {STATE_LABELS[row.state] ?? row.state}
        {row.stdoutPath || row.stderrPath ? " · 输出可读" : ""}
      </Text>
    </Pressable>
  );
}

export function ProcessOutputPanel(props: PluginAgentPanelProps) {
  const { theme } = props;
  // app 0.12 只传顶层 agentId（SDK 标记 deprecated），不传 params；新版走 params.agentId。
  const agentId = props.params?.agentId ?? props.agentId;
  const [, forceUpdate] = useState(0);
  const [stream, setStream] = useState<"stdout" | "stderr">("stdout");

  useEffect(() => {
    const unsubProcesses = subscribeProcesses(() => forceUpdate((value) => value + 1));
    const unsubSelection = subscribeSelection(() => forceUpdate((value) => value + 1));
    return () => {
      unsubProcesses();
      unsubSelection();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      await refreshProcesses([agentId]);
      if (!cancelled) forceUpdate((value) => value + 1);
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [agentId]);

  const data = getAgentProcesses(agentId);
  const rows = data?.rows ?? [];
  const selectedPid = getSelectedProcessPid(agentId);
  const selected =
    rows.find((row) => row.pid === selectedPid) ??
    rows.find((row) => row.stdoutPath || row.stderrPath) ??
    rows[0] ??
    null;

  const handleSelect = useCallback(
    (pid: number) => {
      selectProcess(agentId, pid);
    },
    [agentId],
  );

  const styles = useMemo(
    () => ({
      body: { flex: 1, padding: 12, gap: 10 },
      header: { gap: 2 },
      title: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const },
      hint: { color: theme.colors.foregroundMuted, fontSize: 11 },
      list: { maxHeight: 220 },
      sectionTitle: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" as const },
      tabs: { flexDirection: "row" as const, gap: 6 },
      tab: {
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 6,
        borderWidth: 1,
      },
      tabText: { fontSize: 11 },
      output: { flex: 1, minHeight: 120 },
    }),
    [theme],
  );

  const sameFile = Boolean(selected?.stdoutPath) && selected?.stdoutPath === selected?.stderrPath;

  return (
    <View style={styles.body}>
      <View style={styles.header}>
        <Text style={styles.title}>后台进程</Text>
        <Text style={styles.hint}>
          {data?.rootPid
            ? `agent pid ${data.rootPid} · ${rows.length} 个后台任务 · 每 ${POLL_MS / 1000}s 刷新`
            : "该 agent 当前没有正在运行的子进程"}
        </Text>
      </View>

      {rows.length === 0 ? (
        <Text style={styles.hint}>
          已过滤 MCP / CLI helper 和前台命令，只显示输出重定向到文件的后台任务。
          更深的 make / sh / ginkgo 等不展开；结束的任务不保留记录。
        </Text>
      ) : (
        <ScrollView style={styles.list}>
          {rows.map((row) => (
            <ProcessRow
              key={row.pid}
              row={row}
              selected={selected?.pid === row.pid}
              theme={theme}
              onPress={() => handleSelect(row.pid)}
            />
          ))}
        </ScrollView>
      )}

      {selected ? (
        <View style={styles.output}>
          <View style={styles.tabs}>
            <Text style={styles.sectionTitle}>输出</Text>
            {!sameFile ? (
              <>
                <View style={{ flex: 1 }} />
                {(["stdout", "stderr"] as const).map((option) => {
                  const active = stream === option;
                  return (
                    <Pressable
                      key={option}
                      accessibilityRole="button"
                      accessibilityLabel={`查看 ${option}`}
                      onPress={() => setStream(option)}
                      style={[
                        styles.tab,
                        {
                          borderColor: active ? theme.colors.accent : theme.colors.border,
                          backgroundColor: active ? theme.colors.surface2 : "transparent",
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.tabText,
                          {
                            color: active ? theme.colors.accent : theme.colors.foregroundMuted,
                          },
                        ]}
                      >
                        {option}
                      </Text>
                    </Pressable>
                  );
                })}
              </>
            ) : null}
          </View>

          <ProcessOutputBlock
            agentId={agentId}
            pid={selected.outputPid}
            /* 包装 shell 的 fd 可能是 socket，服务端已给出真正写文件的 pid。 */
            stream={sameFile ? "stdout" : stream}
            label={sameFile ? "stdout + stderr" : undefined}
            theme={theme}
            maxHeight={520}
          />
        </View>
      ) : null}
    </View>
  );
}
