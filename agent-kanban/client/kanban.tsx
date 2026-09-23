import { usePaseo, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Modal, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  formatRelativeTime,
  groupAgents,
  KANBAN_COLUMNS,
  PENDING_PROMPT_LABEL,
  type KanbanAgent,
  type KanbanCard,
  type KanbanColumnId,
} from "./board";

type AgentMap = ReadonlyMap<string, KanbanAgent>;
type Theme = PluginSurfaceProps["theme"];

function toAgentMap(agents: readonly KanbanAgent[]): AgentMap {
  return new Map(agents.map((agent) => [agent.id, agent]));
}

type AgentUpdate = Parameters<ReturnType<typeof usePaseo>["agents"]["subscribe"]>[0] extends (
  update: infer U,
) => void
  ? U
  : never;

function useAgents(paseo: ReturnType<typeof usePaseo>, nonce: number) {
  const [agents, setAgents] = useState<AgentMap | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const lifetime = new AbortController();
    let unsubscribe: (() => void) | null = null;
    setAgents(null);
    setError(null);
    const applyUpdate = (update: AgentUpdate) => {
      setAgents((current) => {
        if (!current) return current;
        const next = new Map(current);
        if (update.kind === "remove") next.delete(update.agentId);
        else next.set(update.agent.id, update.agent);
        return next;
      });
    };
    // ponytail: the board caps at 200 agents; fetch_agents paginates if it ever matters
    void paseo.agents
      .list({ subscribe: {}, signal: lifetime.signal, page: { limit: 200 } })
      .then((result) => {
        if (lifetime.signal.aborted) {
          void result.subscription?.release();
          return;
        }
        setAgents(toAgentMap(result.entries.map((entry) => entry.agent)));
        if (result.subscription) {
          // SDK >= 0.9: owned subscription replays the snapshot after reconnect.
          result.subscription.subscribe({
            snapshot: (snapshot) =>
              setAgents(toAgentMap(snapshot.entries.map((entry) => entry.agent))),
            update: (message) => {
              if (message.type === "agent_update") applyUpdate(message.payload);
            },
          });
        } else {
          // SDK 0.8.x: list() returns no handle; agent_update arrives through the
          // shared session stream, scoped by the subscriptionId it echoes back.
          const subscriptionId = result.subscriptionId;
          unsubscribe = paseo.agents.subscribe((update) => {
            if (
              subscriptionId &&
              "subscriptionId" in update &&
              typeof update.subscriptionId === "string" &&
              update.subscriptionId !== subscriptionId
            )
              return;
            applyUpdate(update);
          });
        }
        return undefined;
      })
      .catch((failure: unknown) => {
        if (!lifetime.signal.aborted)
          setError(failure instanceof Error ? failure.message : String(failure));
      });
    return () => {
      lifetime.abort();
      unsubscribe?.();
    };
  }, [paseo, nonce]);

  return { agents, error };
}

/** Display label for a workspace: project-qualified when the descriptor carries it. */
function workspaceLabel(workspace: { name: string; projectName?: string | null }): string {
  return workspace.projectName ? `${workspace.projectName}/${workspace.name}` : workspace.name;
}

interface WorkspaceInfo {
  label: string;
  projectId: string | null;
}

function workspaceInfo(workspace: {
  name: string;
  projectName?: string | null;
  projectId?: string | null;
}): WorkspaceInfo {
  return { label: workspaceLabel(workspace), projectId: workspace.projectId ?? null };
}

function useWorkspaceNames(paseo: ReturnType<typeof usePaseo>) {
  const [names, setNames] = useState<ReadonlyMap<string, WorkspaceInfo>>(new Map());

  useEffect(() => {
    let cancelled = false;
    let release: (() => Promise<void>) | null = null;
    let unsubscribe: (() => void) | null = null;
    const applyUpdate = (update: {
      kind: "upsert" | "remove";
      workspace?: { id: string; name: string; projectName?: string | null; projectId?: string };
      id?: string;
    }) => {
      setNames((current) => {
        const next = new Map(current);
        if (update.kind === "remove") {
          if (update.id) next.delete(update.id);
        } else if (update.workspace) {
          next.set(update.workspace.id, workspaceInfo(update.workspace));
        }
        return next;
      });
    };
    void paseo.workspaces
      .list({ subscribe: {} })
      .then((result) => {
        if (cancelled) {
          void result.subscription?.release();
          return undefined;
        }
        const subscription = result.subscription;
        release = subscription ? () => subscription.release() : null;
        setNames(
          new Map(result.entries.map((workspace) => [workspace.id, workspaceInfo(workspace)])),
        );
        if (subscription) {
          subscription.subscribe({
            snapshot: (snapshot) =>
              setNames(
                new Map(
                  snapshot.entries.map((workspace) => [workspace.id, workspaceInfo(workspace)]),
                ),
              ),
            update: (message) => {
              if (message.type === "workspace_update") applyUpdate(message.payload);
            },
          });
        } else {
          // SDK 0.8.x fallback: shared session stream, see useAgents.
          unsubscribe = paseo.workspaces.subscribe(applyUpdate);
        }
        return undefined;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unsubscribe?.();
      void release?.().catch(() => {});
    };
  }, [paseo]);

  return names;
}

interface ProjectFilterOption {
  projectId: string;
  name: string;
}

function useFilterProjects(paseo: ReturnType<typeof usePaseo>) {
  const [projects, setProjects] = useState<ProjectFilterOption[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void paseo.projects
      .list()
      .then((result) => {
        if (cancelled) return undefined;
        setProjects(
          result.projects.map((project) => ({
            projectId: project.projectId,
            name: project.projectCustomName ?? project.projectDisplayName,
          })),
        );
        return undefined;
      })
      .catch(() => {
        if (!cancelled) setProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, [paseo]);

  return projects;
}

function useStyles(theme: Theme, compact: boolean) {
  return useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      centeredScreen: {
        flex: 1,
        backgroundColor: theme.colors.surface0,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        gap: 12,
        padding: 24,
      },
      errorText: { color: theme.colors.statusDanger },
      retryText: { color: theme.colors.accent },
      mutedText: { color: theme.colors.foregroundMuted },
      board: { flex: 1 },
      toolbar: {
        flexDirection: "row" as const,
        justifyContent: "flex-end" as const,
        paddingHorizontal: compact ? 12 : 20,
        paddingTop: compact ? 12 : 20,
      },
      createButton: {
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        backgroundColor: theme.colors.accent,
      },
      createButtonText: {
        color: theme.colors.accentForeground,
        fontSize: 13,
        fontWeight: "600" as const,
      },
      filterRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        paddingHorizontal: compact ? 12 : 20,
        paddingTop: 8,
        gap: 8,
      },
      filterLabel: { color: theme.colors.foregroundMuted, fontSize: 13 },
      chipsScroll: { flex: 1 },
      chips: { gap: 6 },
      chip: {
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        paddingHorizontal: 10,
        paddingVertical: 6,
      },
      chipSelected: {
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.accent,
        paddingHorizontal: 10,
        paddingVertical: 6,
        backgroundColor: theme.colors.surface2,
      },
      chipText: { color: theme.colors.foreground, fontSize: 13 },
      boardContent: { padding: compact ? 12 : 20, gap: 12 },
      column: {
        width: compact ? 240 : 280,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        overflow: "hidden" as const,
      },
      columnHeader: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      },
      columnTitle: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
      columnCount: { color: theme.colors.foregroundMuted, fontSize: 12 },
      columnCards: { padding: 10, gap: 10 },
      emptyColumn: {
        color: theme.colors.foregroundMuted,
        fontSize: 12,
        textAlign: "center" as const,
        paddingVertical: 16,
      },
    }),
    [theme, compact],
  );
}

function useCardStyles(theme: Theme) {
  return useMemo(
    () => ({
      card: {
        gap: 6,
        padding: 12,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      cardTitleRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      cardTitle: {
        color: theme.colors.foreground,
        fontSize: 14,
        fontWeight: "600" as const,
        flex: 1,
      },
      badgeWarning: {
        borderRadius: 6,
        paddingHorizontal: 6,
        paddingVertical: 2,
        backgroundColor: theme.colors.statusWarning,
      },
      badgeDanger: {
        borderRadius: 6,
        paddingHorizontal: 6,
        paddingVertical: 2,
        backgroundColor: theme.colors.statusDanger,
      },
      badgeText: { color: theme.colors.surface0, fontSize: 11, fontWeight: "600" as const },
      cardMeta: { color: theme.colors.foregroundMuted, fontSize: 12 },
      startButton: {
        borderRadius: 8,
        paddingVertical: 7,
        alignItems: "center" as const,
        backgroundColor: theme.colors.accent,
        marginTop: 4,
      },
      startButtonText: {
        color: theme.colors.accentForeground,
        fontSize: 13,
        fontWeight: "600" as const,
      },
    }),
    [theme],
  );
}

type OpenAgent = NonNullable<PluginSurfaceProps["navigation"]>["openAgent"];

function AgentCard({
  card,
  theme,
  openAgent,
  onStart,
  starting,
}: {
  card: KanbanCard;
  theme: Theme;
  openAgent?: OpenAgent;
  onStart?: (card: KanbanCard) => void;
  starting?: boolean;
}) {
  const styles = useCardStyles(theme);
  const handleOpen = useCallback(() => {
    openAgent?.({ agentId: card.id });
  }, [openAgent, card.id]);
  const handleStart = useCallback(() => {
    onStart?.(card);
  }, [onStart, card]);
  const body = (
    <>
      <View style={styles.cardTitleRow}>
        <Text style={styles.cardTitle} numberOfLines={2}>
          {card.title}
        </Text>
        {card.badgeLabel ? (
          <View style={card.badgeTone === "danger" ? styles.badgeDanger : styles.badgeWarning}>
            <Text style={styles.badgeText}>{card.badgeLabel}</Text>
          </View>
        ) : null}
      </View>
      {card.workspaceName ? (
        <Text style={styles.cardMeta} numberOfLines={1}>
          {card.workspaceName}
        </Text>
      ) : null}
      <Text style={styles.cardMeta} numberOfLines={1}>
        {card.providerLabel} · {formatRelativeTime(card.updatedAt)}
      </Text>
      {card.pendingPrompt ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`开始执行 ${card.title}`}
          disabled={starting}
          onPress={handleStart}
          style={styles.startButton}
        >
          <Text style={styles.startButtonText}>{starting ? "启动中…" : "▶ 开始执行"}</Text>
        </Pressable>
      ) : null}
    </>
  );
  if (!openAgent) return <View style={styles.card}>{body}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`打开 agent ${card.title}`}
      onPress={handleOpen}
      style={styles.card}
    >
      {body}
    </Pressable>
  );
}

const COLUMN_COLORS: Record<KanbanColumnId, keyof Theme["colors"]> = {
  todo: "foregroundMuted",
  running: "accent",
  done: "statusSuccess",
  closed: "foregroundMuted",
};

interface AgentProfileOption {
  id: string;
  name: string;
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
}

interface ProjectOption {
  projectId: string;
  name: string;
  rootPath: string;
  kind: "git" | "non_git" | "directory";
}

function useProjects(paseo: ReturnType<typeof usePaseo>, active: boolean) {
  const [projects, setProjects] = useState<ProjectOption[] | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void paseo.projects
      .list()
      .then((result) => {
        if (cancelled) return undefined;
        setProjects(
          result.projects.map((project) => ({
            projectId: project.projectId,
            name: project.projectCustomName ?? project.projectDisplayName,
            rootPath: project.projectRootPath,
            kind: project.projectKind,
          })),
        );
        return undefined;
      })
      .catch(() => {
        if (!cancelled) setProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, [paseo, active]);

  return projects;
}

function useAgentProfiles(paseo: ReturnType<typeof usePaseo>, active: boolean) {
  const [options, setOptions] = useState<AgentProfileOption[] | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void paseo.config
      .get()
      .then((result) => {
        if (cancelled) return undefined;
        const profiles =
          (result.config as { agentProfiles?: AgentProfileOption[] }).agentProfiles ??
          (result.config as { daemon?: { agentProfiles?: AgentProfileOption[] } }).daemon
            ?.agentProfiles ??
          [];
        setOptions(
          profiles.map((profile) => ({
            id: profile.id,
            name: profile.name,
            provider: profile.provider,
            model: profile.model,
            modeId: profile.modeId,
            thinkingOptionId: profile.thinkingOptionId,
            featureValues: profile.featureValues,
          })),
        );
        return undefined;
      })
      .catch(() => {
        if (!cancelled) setOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [paseo, active]);

  return options;
}

function useModalStyles(theme: Theme) {
  return useMemo(
    () => ({
      fieldLabel: { color: theme.colors.foregroundMuted, fontSize: 12, marginBottom: 6 },
      input: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        color: theme.colors.foreground,
        fontSize: 14,
      },
      pickerRow: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
      },
      pickerRowSelected: {
        borderWidth: 1,
        borderColor: theme.colors.accent,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        backgroundColor: theme.colors.surface2,
      },
      pickerText: { color: theme.colors.foreground, fontSize: 13 },
      pickerGroup: { gap: 6 },
      dropdownScroll: { maxHeight: 220 },
      submitButton: {
        borderRadius: 10,
        paddingVertical: 12,
        alignItems: "center" as const,
        backgroundColor: theme.colors.accent,
      },
      submitButtonDisabled: {
        borderRadius: 10,
        paddingVertical: 12,
        alignItems: "center" as const,
        backgroundColor: theme.colors.surface2,
      },
      submitText: { color: theme.colors.accentForeground, fontWeight: "600" as const },
      errorText: { color: theme.colors.statusDanger, fontSize: 13 },
      mutedText: { color: theme.colors.foregroundMuted, fontSize: 13 },
    }),
    [theme],
  );
}

function PickerRow({
  label,
  value,
  selected,
  onSelect,
  styles,
}: {
  label: string;
  value: string;
  selected: boolean;
  onSelect: (value: string) => void;
  styles: ReturnType<typeof useModalStyles>;
}) {
  const handlePress = useCallback(() => onSelect(value), [onSelect, value]);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={handlePress}
      style={selected ? styles.pickerRowSelected : styles.pickerRow}
    >
      <Text style={styles.pickerText} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function AgentProfilePicker({
  theme,
  options,
  value,
  onChange,
  styles,
}: {
  theme: Theme;
  options: AgentProfileOption[] | null;
  value: string | null;
  onChange: (value: string) => void;
  styles: ReturnType<typeof useModalStyles>;
}) {
  const [filter, setFilter] = useState("");

  const effectiveValue = value ?? options?.[0]?.id ?? null;

  useEffect(() => {
    if (value == null && effectiveValue) onChange(effectiveValue);
  }, [value, effectiveValue, onChange]);

  const filtered = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!options || !query) return options;
    return options.filter(
      (option) =>
        option.name.toLowerCase().includes(query) ||
        option.provider.toLowerCase().includes(query) ||
        option.model?.toLowerCase().includes(query),
    );
  }, [options, filter]);

  const select = useCallback((next: string) => onChange(next), [onChange]);

  if (!options) return <Text style={styles.mutedText}>正在加载…</Text>;
  if (options.length === 0)
    return (
      <Text style={styles.mutedText}>没有可用的 Agent 配置（在 daemon 配置 agentProfiles）</Text>
    );
  return (
    <View style={styles.pickerGroup}>
      <TextInput
        value={filter}
        onChangeText={setFilter}
        placeholder="搜索 Agent…"
        placeholderTextColor={theme.colors.foregroundMuted}
        style={styles.input}
      />
      <ScrollView style={styles.dropdownScroll}>
        {filtered && filtered.length > 0 ? (
          <View style={styles.pickerGroup}>
            {filtered.map((option) => (
              <PickerRow
                key={option.id}
                label={`${option.name} · ${option.provider}${option.model ? `/${option.model}` : ""}`}
                value={option.id}
                selected={option.id === effectiveValue}
                onSelect={select}
                styles={styles}
              />
            ))}
          </View>
        ) : (
          <Text style={styles.mutedText}>无匹配 Agent</Text>
        )}
      </ScrollView>
    </View>
  );
}

function CreateTaskModal({
  theme,
  open,
  onOpenChange,
  paseo,
}: {
  theme: Theme;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  paseo: ReturnType<typeof usePaseo>;
}) {
  const styles = useModalStyles(theme);
  const toast = useToast();
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const projects = useProjects(paseo, open);
  const profiles = useAgentProfiles(paseo, open);

  const effectiveProject = useMemo(
    () => projects?.find((project) => project.projectId === projectId) ?? projects?.[0] ?? null,
    [projects, projectId],
  );

  const effectiveProfile = useMemo(
    () => profiles?.find((profile) => profile.id === profileId) ?? profiles?.[0] ?? null,
    [profiles, profileId],
  );

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const selectProject = useCallback((value: string) => setProjectId(value), []);

  let projectPicker = <Text style={styles.mutedText}>正在加载…</Text>;
  if (projects && projects.length === 0) {
    projectPicker = <Text style={styles.mutedText}>暂无项目，请先在 Paseo 中添加</Text>;
  } else if (projects) {
    projectPicker = (
      <View style={styles.pickerGroup}>
        {projects.map((project) => (
          <PickerRow
            key={project.projectId}
            label={project.name}
            value={project.projectId}
            selected={project.projectId === effectiveProject?.projectId}
            onSelect={selectProject}
            styles={styles}
          />
        ))}
      </View>
    );
  }

  const submit = useCallback(async () => {
    const trimmedPrompt = prompt.trim();
    const trimmedTitle = title.trim();
    if (!trimmedPrompt || !trimmedTitle || !effectiveProject || !effectiveProfile) {
      setError("请填写任务名和任务内容，并选择项目和 Agent");
      return;
    }
    if (!effectiveProfile.model) {
      setError("所选 Agent 配置缺少模型，请在 daemon 配置中补全");
      return;
    }
    // Ref-guard closes the window where a second press runs before the
    // submitting state re-render commits.
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const workspace = await paseo.workspaces.create({
        title: trimmedTitle,
        source:
          effectiveProject.kind === "git"
            ? {
                kind: "worktree",
                projectId: effectiveProject.projectId,
                cwd: effectiveProject.rootPath,
              }
            : {
                kind: "directory",
                path: effectiveProject.rootPath,
                projectId: effectiveProject.projectId,
              },
      });
      // Create without prompt: the task waits in 未开始 until the card's
      // 开始执行 button sends the deferred prompt stored in labels.
      await workspace.agents.create({
        config: {
          provider: `${effectiveProfile.provider}/${effectiveProfile.model}`,
          ...(effectiveProfile.modeId ? { modeId: effectiveProfile.modeId } : {}),
          ...(effectiveProfile.thinkingOptionId
            ? { thinkingOptionId: effectiveProfile.thinkingOptionId }
            : {}),
          ...(effectiveProfile.featureValues
            ? { featureValues: effectiveProfile.featureValues }
            : {}),
        },
        title: trimmedTitle,
        labels: { [PENDING_PROMPT_LABEL]: trimmedPrompt },
      });
      toast.show("任务已创建", { variant: "success" });
      setPrompt("");
      setTitle("");
      close();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [paseo, prompt, title, effectiveProject, effectiveProfile, toast, close]);

  return (
    <Modal title="新建任务" open={open} onOpenChange={onOpenChange}>
      <Modal.Content>
        <View>
          <Text style={styles.fieldLabel}>任务名</Text>
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder="将作为新 workspace 的名称"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={styles.input}
          />
        </View>
        <View>
          <Text style={styles.fieldLabel}>任务内容</Text>
          <TextInput
            value={prompt}
            onChangeText={setPrompt}
            placeholder="描述要完成的任务…"
            placeholderTextColor={theme.colors.foregroundMuted}
            multiline
            style={styles.input}
          />
        </View>
        <View>
          <Text style={styles.fieldLabel}>项目</Text>
          {projectPicker}
        </View>
        <View>
          <Text style={styles.fieldLabel}>Agent</Text>
          <AgentProfilePicker
            theme={theme}
            options={profiles}
            value={profileId}
            onChange={setProfileId}
            styles={styles}
          />
        </View>
        {error ? (
          <Text accessibilityRole="alert" style={styles.errorText}>
            {error}
          </Text>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="创建任务"
          disabled={submitting}
          onPress={submit}
          style={submitting ? styles.submitButtonDisabled : styles.submitButton}
        >
          <Text style={styles.submitText}>{submitting ? "创建中…" : "创建任务"}</Text>
        </Pressable>
      </Modal.Content>
    </Modal>
  );
}

function StatusDot({ columnId, theme }: { columnId: KanbanColumnId; theme: Theme }) {
  const style = useMemo(
    () => ({
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: theme.colors[COLUMN_COLORS[columnId]],
    }),
    [theme, columnId],
  );
  return <View style={style} />;
}

function ProjectChip({
  label,
  selected,
  onSelect,
  styles,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
  styles: ReturnType<typeof useStyles>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onSelect}
      style={selected ? styles.chipSelected : styles.chip}
    >
      <Text style={styles.chipText}>{label}</Text>
    </Pressable>
  );
}

function ProjectFilterChip({
  option,
  selected,
  onSelect,
  styles,
}: {
  option: ProjectFilterOption;
  selected: boolean;
  onSelect: (id: string) => void;
  styles: ReturnType<typeof useStyles>;
}) {
  const handlePress = useCallback(() => onSelect(option.projectId), [onSelect, option.projectId]);
  return (
    <ProjectChip label={option.name} selected={selected} onSelect={handlePress} styles={styles} />
  );
}

export function KanbanSurface({ theme, layout, navigation }: PluginSurfaceProps) {
  const paseo = usePaseo();
  const toast = useToast();
  const [nonce, setNonce] = useState(0);
  const [creating, setCreating] = useState(false);
  const [startingId, setStartingId] = useState<string | null>(null);
  const { agents, error } = useAgents(paseo, nonce);
  const workspaces = useWorkspaceNames(paseo);
  const projects = useFilterProjects(paseo);
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const retry = useCallback(() => setNonce((value) => value + 1), []);
  const openCreate = useCallback(() => setCreating(true), []);
  const showAllProjects = useCallback(() => setProjectFilter(null), []);
  const styles = useStyles(theme, layout.compact);
  const openAgent = navigation?.openAgent;
  const startAgent = useCallback(
    async (card: KanbanCard) => {
      if (!card.pendingPrompt) return;
      setStartingId(card.id);
      try {
        await paseo.agents.ref(card.id).send(card.pendingPrompt);
      } catch (failure) {
        toast.show(failure instanceof Error ? failure.message : String(failure), {
          variant: "error",
        });
      } finally {
        setStartingId(null);
      }
    },
    [paseo, toast],
  );

  const workspaceLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const [id, info] of workspaces) labels.set(id, info.label);
    return labels;
  }, [workspaces]);

  const board = useMemo(() => {
    if (!agents) return null;
    const visible = projectFilter
      ? [...agents.values()].filter(
          (agent) =>
            agent.workspaceId != null &&
            workspaces.get(agent.workspaceId)?.projectId === projectFilter,
        )
      : agents.values();
    return groupAgents(visible, workspaceLabels);
  }, [agents, workspaces, workspaceLabels, projectFilter]);

  if (error) {
    return (
      <View style={styles.centeredScreen}>
        <Text accessibilityRole="alert" style={styles.errorText}>
          {error}
        </Text>
        <Pressable accessibilityRole="button" onPress={retry}>
          <Text style={styles.retryText}>重试</Text>
        </Pressable>
      </View>
    );
  }
  if (!board) {
    return (
      <View style={styles.centeredScreen}>
        <Text style={styles.mutedText}>正在加载…</Text>
      </View>
    );
  }
  return (
    <View style={styles.screen}>
      <View style={styles.toolbar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="新建任务"
          onPress={openCreate}
          style={styles.createButton}
        >
          <Text style={styles.createButtonText}>+ 新建任务</Text>
        </Pressable>
      </View>
      {projects && projects.length > 0 ? (
        <View style={styles.filterRow}>
          <Text style={styles.filterLabel}>项目:</Text>
          <ScrollView horizontal style={styles.chipsScroll} contentContainerStyle={styles.chips}>
            <ProjectChip
              label="全部"
              selected={projectFilter === null}
              onSelect={showAllProjects}
              styles={styles}
            />
            {projects.map((option) => (
              <ProjectFilterChip
                key={option.projectId}
                option={option}
                selected={projectFilter === option.projectId}
                onSelect={setProjectFilter}
                styles={styles}
              />
            ))}
          </ScrollView>
        </View>
      ) : null}
      <ScrollView horizontal style={styles.board} contentContainerStyle={styles.boardContent}>
        {KANBAN_COLUMNS.map((column) => {
          const cards = board.get(column.id) ?? [];
          return (
            <View key={column.id} style={styles.column}>
              <View style={styles.columnHeader}>
                <StatusDot columnId={column.id} theme={theme} />
                <Text style={styles.columnTitle}>{column.title}</Text>
                <Text style={styles.columnCount}>{cards.length}</Text>
              </View>
              <ScrollView contentContainerStyle={styles.columnCards}>
                {cards.length === 0 ? (
                  <Text style={styles.emptyColumn}>暂无</Text>
                ) : (
                  cards.map((card) => (
                    <AgentCard
                      key={card.id}
                      card={card}
                      theme={theme}
                      openAgent={openAgent}
                      onStart={startAgent}
                      starting={startingId === card.id}
                    />
                  ))
                )}
              </ScrollView>
            </View>
          );
        })}
      </ScrollView>
      <CreateTaskModal theme={theme} open={creating} onOpenChange={setCreating} paseo={paseo} />
    </View>
  );
}
