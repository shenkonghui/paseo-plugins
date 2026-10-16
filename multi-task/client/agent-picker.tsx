import type { PaseoAgent, PaseoWorkspace } from "@getpaseo/client";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Modal, TextInput } from "@getpaseo/plugin/client/react-native";
import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

type Theme = PluginScreenProps["theme"];

export function workspaceLabel(workspace: PaseoWorkspace): string {
  const base = workspace.title ?? workspace.name;
  return workspace.projectDisplayName ? `${workspace.projectDisplayName}/${base}` : base;
}

function activityTime(agent: PaseoAgent): number {
  const raw = agent.lastUserMessageAt ?? agent.updatedAt;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

interface WorkspacePickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  theme: Theme;
  workspaces: PaseoWorkspace[] | null;
  agents: PaseoAgent[] | null;
  existingWorkspaceIds: ReadonlySet<string>;
  onAdd: (workspaceId: string) => void;
}

export function WorkspacePicker({
  open,
  onOpenChange,
  theme,
  workspaces,
  agents,
  existingWorkspaceIds,
  onAdd,
}: WorkspacePickerProps) {
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    if (!workspaces || !agents) return null;
    const q = query.trim().toLowerCase();
    return workspaces
      .map((workspace) => {
        const label = workspaceLabel(workspace);
        const wsAgents = agents.filter(
          (agent) => agent.workspaceId === workspace.id && !agent.archivedAt,
        );
        return {
          workspace,
          label,
          agentCount: wsAgents.length,
          // 只要有 agent 在跑，就算「运行中」。
          running: wsAgents.some((agent) => agent.status === "running"),
          activity: wsAgents.reduce((max, agent) => Math.max(max, activityTime(agent)), 0),
          agentTitles: wsAgents.map((agent) => agent.title ?? ""),
        };
      })
      .filter((row) => {
        if (q.length === 0) return true;
        if (row.label.toLowerCase().includes(q)) return true;
        return row.agentTitles.some((title) => title.toLowerCase().includes(q));
      })
      // 运行中的排最前，其余按最近更新时间倒序，最后按名字。
      .sort((a, b) => {
        if (a.running !== b.running) return a.running ? -1 : 1;
        if (b.activity !== a.activity) return b.activity - a.activity;
        return a.label.localeCompare(b.label);
      });
  }, [workspaces, agents, query]);

  const handleAdd = useCallback(
    (workspaceId: string) => {
      onAdd(workspaceId);
    },
    [onAdd],
  );

  return (
    <Modal title="添加 workspace" open={open} onOpenChange={onOpenChange}>
      <Modal.Content>
        <TextInput
          accessibilityLabel="搜索 workspace"
          value={query}
          onChangeText={setQuery}
          placeholder="搜索 workspace…"
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          style={{
            borderWidth: 1,
            borderColor: theme.colors.border,
            borderRadius: 8,
            paddingHorizontal: 10,
            paddingVertical: 8,
            color: theme.colors.foreground,
            fontSize: 14,
          }}
        />
        {rows === null ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>正在加载…</Text>
        ) : rows.length === 0 ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>
            {workspaces && workspaces.length === 0 ? "没有可用的 workspace。" : "无匹配的 workspace。"}
          </Text>
        ) : (
          <ScrollView style={{ maxHeight: 360 }}>
            {rows.map((row) => {
              const added = existingWorkspaceIds.has(row.workspace.id);
              return (
                <Pressable
                  key={row.workspace.id}
                  accessibilityRole="button"
                  accessibilityLabel={`添加 workspace ${row.label}${row.running ? "（运行中）" : ""}`}
                  disabled={added}
                  onPress={() => handleAdd(row.workspace.id)}
                  style={{
                    borderWidth: 1,
                    // 运行中的用 accent 描边 + 状态点，一眼可分。
                    borderColor: row.running ? theme.colors.accent : theme.colors.border,
                    borderRadius: 8,
                    paddingHorizontal: 10,
                    paddingVertical: 8,
                    marginBottom: 6,
                    opacity: added ? 0.5 : 1,
                  }}
                >
                  <View
                    style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
                  >
                    <View
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 4,
                        backgroundColor: row.running
                          ? theme.colors.accent
                          : theme.colors.foregroundMuted,
                      }}
                    />
                    <Text
                      style={{ color: theme.colors.foreground, fontSize: 13, flexShrink: 1 }}
                      numberOfLines={1}
                    >
                      {row.label}
                    </Text>
                  </View>
                  <Text
                    style={{
                      color: row.running ? theme.colors.accent : theme.colors.foregroundMuted,
                      fontSize: 11,
                      marginTop: 2,
                    }}
                    numberOfLines={1}
                  >
                    {added
                      ? "已添加"
                      : row.running
                        ? `运行中 · ${row.agentCount} 个 agent`
                        : `${row.agentCount} 个 agent`}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        )}
      </Modal.Content>
    </Modal>
  );
}
