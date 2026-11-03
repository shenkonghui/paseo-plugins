import { usePaseo, useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  createWorktreeRpc,
  listDirsRpc,
  listSubmodulesRpc,
  listWorktreesRpc,
  removeWorktreeRpc,
  worktreeBranchesRpc,
  type TopDir,
  type Worktree,
} from "../shared/worktrees";
import {
  createLocalBackend,
  createRemoteBackend,
  type RemotePaseoApi,
  type WorktreeBackend,
} from "./backends";
import {
  basename,
  formatRelativeTime,
  hostRuntime,
  useConfiguredHosts,
  useProjects,
  useProviderChoices,
  useStyles,
  useWorkspaceIndex,
  type HostSummary,
} from "./worktrees";

type PaseoApi = ReturnType<typeof usePaseo>;
type Styles = ReturnType<typeof useStyles>;
type Theme = PluginSurfaceProps["theme"];

interface DirOption {
  key: string;
  path: string;
  label: string;
  badge: string | null;
  meta: string | null;
  blocked: boolean;
}

function useDirCandidates(
  backend: WorktreeBackend,
  repoRoot: string | null,
  includeWorktrees: boolean,
  nonce: number,
) {
  const [worktrees, setWorktrees] = useState<Worktree[] | null>(null);
  const [dirs, setDirs] = useState<TopDir[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!repoRoot) {
      setWorktrees([]);
      setDirs([]);
      setError(null);
      return;
    }
    let cancelled = false;
    setWorktrees(null);
    setDirs(null);
    setError(null);
    void Promise.all([
      includeWorktrees ? backend.listWorktrees(repoRoot) : Promise.resolve([]),
      backend.listDirs(repoRoot),
    ])
      .then(([wt, sub]) => {
        if (cancelled) return undefined;
        setWorktrees(wt);
        setDirs(sub);
        return undefined;
      })
      .catch((failure: unknown) => {
        if (!cancelled) {
          setError(failure instanceof Error ? failure.message : String(failure));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [backend, repoRoot, includeWorktrees, nonce]);

  return { worktrees, dirs, error };
}

function buildDirOptions(
  project: { rootPath: string },
  worktrees: Worktree[] | null,
  dirs: TopDir[] | null,
): DirOption[] {
  const root = project.rootPath.replace(/[\\/]+$/, "");
  const options: DirOption[] = [
    { key: "root", path: root, label: "项目根目录", badge: null, meta: null, blocked: false },
  ];
  for (const worktree of worktrees ?? []) {
    if (worktree.main || worktree.path === root) continue;
    options.push({
      key: `wt:${worktree.path}`,
      path: worktree.path,
      label: worktree.branch ?? "(detached)",
      badge: "worktree",
      meta: [
        worktree.head ? `HEAD ${worktree.head.slice(0, 7)}` : null,
        formatRelativeTime(worktree.mtimeMs),
      ]
        .filter(Boolean)
        .join(" · "),
      blocked: false,
    });
  }
  for (const dir of dirs ?? []) {
    options.push({
      key: `dir:${dir.path}`,
      path: `${root}/${dir.path}`,
      label: dir.path,
      badge: "子目录",
      meta: null,
      blocked: false,
    });
  }
  return options;
}

interface PickerItem {
  key: string;
  primary: string;
  secondary?: string;
  badge?: string;
  disabled?: boolean;
  note?: string;
}

interface ModeChoice {
  id: string;
  label: string;
  description?: string;
}

function useProviderModes(
  api: PaseoApi,
  provider: string | null,
  cwd: string,
): ModeChoice[] | null {
  const [modes, setModes] = useState<ModeChoice[] | null>(null);

  useEffect(() => {
    if (!provider) {
      setModes(null);
      return;
    }
    let cancelled = false;
    setModes(null);
    void api.providers
      .listModes(provider, cwd ? { cwd } : undefined)
      .then((result) => {
        if (cancelled) return undefined;
        setModes(
          (result.modes ?? []).map((mode) => ({
            id: mode.id,
            label: mode.label,
            description: mode.description,
          })),
        );
        return undefined;
      })
      .catch(() => {
        if (!cancelled) setModes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api, provider, cwd]);

  return modes;
}

interface AnchorRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PickerGroup {
  title: string;
  items: readonly PickerItem[];
}

interface PickerSpec {
  items?: readonly PickerItem[];
  groups?: readonly PickerGroup[];
  selectedKey?: string;
  searchable?: boolean;
  onSelect: (key: string) => void;
}

/**
 * 原生风格的下拉 pill：只负责触发，按下时测量自身在窗口中的位置上报给
 * surface，菜单由 surface 在最顶层渲染（见 PickerMenu）。
 */
function DropdownPill({
  open,
  onToggle,
  icon,
  label,
  title,
  disabled,
  styles,
}: {
  open: boolean;
  onToggle: (rect: AnchorRect | null) => void;
  icon?: React.ReactNode;
  label: string;
  title: string;
  disabled?: boolean;
  styles: Styles;
}) {
  const anchorRef = useRef<View>(null);
  const handlePress = useCallback(() => {
    if (disabled) return;
    if (open) {
      onToggle(null);
      return;
    }
    anchorRef.current?.measureInWindow((x, y, w, h) => onToggle({ x, y, w, h }));
  }, [disabled, open, onToggle]);
  return (
    <View ref={anchorRef} collapsable={false} style={styles.dropdownAnchor}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        disabled={disabled}
        onPress={handlePress}
        style={[styles.pill, disabled && { opacity: 0.5 }]}
      >
        {icon}
        <Text style={styles.pillText} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.pillCaret}>{open ? "⌃" : "⌄"}</Text>
      </Pressable>
    </View>
  );
}

/** 菜单渲染在 surface 根部、按 pill 的测量位置定位，保证置顶不被遮挡。 */
// shortcut: 菜单只向下展开、不钳制右缘溢出，需要更精确时需测量容器宽度
function PickerMenu({
  spec,
  rect,
  onPick,
  styles,
}: {
  spec: PickerSpec;
  rect: AnchorRect;
  onPick: (key: string) => void;
  styles: Styles;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const filterItems = (list: readonly PickerItem[]) =>
    spec.searchable && needle
      ? list.filter((item) =>
          [item.primary, item.secondary ?? ""].join(" ").toLowerCase().includes(needle),
        )
      : list;
  const groups: readonly PickerGroup[] = spec.groups
    ? spec.groups
        .map((group) => ({ title: group.title, items: filterItems(group.items) }))
        .filter((group) => group.items.length > 0)
    : [{ title: "", items: filterItems(spec.items ?? []) }];
  const empty = groups.every((group) => group.items.length === 0);
  return (
    <View
      style={[styles.dropdownMenu, { left: rect.x, top: rect.y + rect.h + 6 }]}
    >
      {spec.searchable ? (
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="搜索…"
          placeholderTextColor="#888"
          style={[styles.searchInput, { margin: 8 }]}
          autoCapitalize="none"
          autoCorrect={false}
        />
      ) : null}
      {empty ? (
        <Text style={[styles.mutedText, { padding: 12 }]}>无可选项</Text>
      ) : (
        <ScrollView style={styles.dropdownScroll} keyboardShouldPersistTaps="handled">
          {groups.map((group) => (
            <View key={group.title || "_"}>
              {group.title ? (
                <Text style={[styles.sectionHeader, { paddingHorizontal: 10, paddingTop: 8 }]}>
                  {group.title}
                </Text>
              ) : null}
              {group.items.map((item) => (
            <Pressable
              key={item.key}
              accessibilityRole="button"
              disabled={item.disabled}
              onPress={() => onPick(item.key)}
              style={[
                item.key === spec.selectedKey ? styles.branchRowSelected : styles.branchRow,
                item.disabled && { opacity: 0.45 },
              ]}
            >
              <View style={styles.cardTitleRow}>
                <Text style={styles.branchRowText} numberOfLines={1}>
                  {item.primary}
                </Text>
                {item.badge ? (
                  <View style={styles.mainBadge}>
                    <Text style={styles.mainBadgeText}>{item.badge}</Text>
                  </View>
                ) : null}
                {item.note ? (
                  <Text style={styles.linkText} numberOfLines={1}>
                    {item.note}
                  </Text>
                ) : null}
              </View>
              {item.secondary ? (
                <Text style={styles.cardPath} numberOfLines={1}>
                  {item.secondary}
                </Text>
              ) : null}
            </Pressable>
              ))}
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}


interface AgentProfileLite {
  id: string;
  name: string;
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
}

function useAgentProfiles(api: PaseoApi): AgentProfileLite[] | null {
  const [profiles, setProfiles] = useState<AgentProfileLite[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.config
      .get()
      .then((result) => {
        if (cancelled) return undefined;
        setProfiles(
          (result.config as { daemon?: { agentProfiles?: AgentProfileLite[] } }).daemon
            ?.agentProfiles ?? [],
        );
        return undefined;
      })
      .catch(() => {
        if (!cancelled) setProfiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  return profiles;
}

function hostStatusColor(host: HostSummary, theme: Theme): string {
  if (host.status === "online") return theme.colors.statusSuccess;
  if (host.status === "connecting" || host.status === "idle") return theme.colors.statusWarning;
  return theme.colors.statusDanger;
}

/**
 * 「选目录建工作区」：仿内置新建工作区页 —— 项目/主机/目录三个下拉 pill，
 * composer 里写初始提示词（可选）并选择 provider/model，发送即建 workspace。
 * 目录来源：项目根目录、repo 的 worktree、已检出子模块。
 */
export function DirWorkspaceSurface({ theme, host, layout, navigation }: PluginSurfaceProps) {
  const paseo = usePaseo();
  const listWorktrees = useRpc(listWorktreesRpc);
  const listSubmodulesRpcFn = useRpc(listSubmodulesRpc);
  const listDirsRpcFn = useRpc(listDirsRpc);
  const listBranchesRpcFn = useRpc(worktreeBranchesRpc);
  const createWorktreeRpcFn = useRpc(createWorktreeRpc);
  const removeWorktreeRpcFn = useRpc(removeWorktreeRpc);
  const toast = useToast();
  const styles = useStyles(theme, layout.compact);

  const configuredHosts = useConfiguredHosts();
  const installationHostId = host?.id ?? "";
  const hostOptions = useMemo<readonly HostSummary[]>(() => {
    if (configuredHosts.length > 0) return configuredHosts;
    return [{ serverId: installationHostId, label: host?.label ?? "本机", status: "online" }];
  }, [configuredHosts, installationHostId, host?.label]);
  const [selectedHostId, setSelectedHostId] = useState(installationHostId);
  const selectedHost =
    hostOptions.find((option) => option.serverId === selectedHostId) ?? hostOptions[0];
  const isLocalHost = selectedHost.serverId === installationHostId;
  const hostReachable = isLocalHost || selectedHost.status === "online";

  const getApi = useCallback((): PaseoApi => {
    if (isLocalHost) return paseo;
    const getHostClient = hostRuntime.getPaseoClient;
    if (!getHostClient) throw new Error("当前 Paseo 版本不支持访问其它主机");
    return getHostClient(selectedHost.serverId);
  }, [isLocalHost, paseo, selectedHost.serverId]);
  const api = useMemo(() => {
    try {
      return getApi();
    } catch {
      return paseo;
    }
  }, [getApi, paseo]);

  const projects = useProjects(getApi);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [providerId, setProviderId] = useState<string | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [thinkingId, setThinkingId] = useState<string | null>(null);
  const [modeId, setModeId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [pickerState, setPickerState] = useState<{ id: string; rect: AnchorRect } | null>(null);
  const rootRef = useRef<View>(null);
  const closePicker = useCallback(() => setPickerState(null), []);
  const togglePicker = useCallback((id: string, rect: AnchorRect | null) => {
    if (!rect) {
      setPickerState(null);
      return;
    }
    const root = rootRef.current;
    if (!root) {
      setPickerState({ id, rect });
      return;
    }
    root.measureInWindow((rx, ry) => {
      setPickerState({ id, rect: { x: rect.x - rx, y: rect.y - ry, w: rect.w, h: rect.h } });
    });
  }, []);

  const project = useMemo(
    () => projects?.find((option) => option.projectId === projectId) ?? projects?.[0] ?? null,
    [projects, projectId],
  );
  const isGitProject = project?.kind === "git";

  const backend = useMemo<WorktreeBackend>(
    () =>
      isLocalHost
        ? createLocalBackend({
            listWorktrees,
            listSubmodules: listSubmodulesRpcFn,
            listDirs: listDirsRpcFn,
            listBranches: listBranchesRpcFn,
            createWorktree: createWorktreeRpcFn,
            removeWorktree: removeWorktreeRpcFn,
          })
        : createRemoteBackend(() => getApi() as unknown as RemotePaseoApi),
    [
      isLocalHost,
      getApi,
      listWorktrees,
      listSubmodulesRpcFn,
      listDirsRpcFn,
      listBranchesRpcFn,
      createWorktreeRpcFn,
      removeWorktreeRpcFn,
    ],
  );

  const repoRoot = hostReachable && project ? project.rootPath : null;
  const { worktrees, dirs, error } = useDirCandidates(
    backend,
    repoRoot,
    Boolean(isGitProject),
    nonce,
  );
  const workspaceIndex = useWorkspaceIndex(getApi, nonce);

  const options = useMemo(
    () => (project ? buildDirOptions(project, worktrees, dirs) : []),
    [project, worktrees, dirs],
  );
  const selectedOption =
    options.find((option) => option.key === selected) ?? options[0] ?? null;
  const linkedWorkspace = selectedOption
    ? (workspaceIndex.get(selectedOption.path) ?? null)
    : null;

  const trimmedPrompt = prompt.trim();
  const dirCwd = selectedOption?.path ?? "";
  const providerChoices = useProviderChoices(api, dirCwd, true);
  const selectedChoice =
    providerChoices?.find((choice) => choice.id === providerId) ??
    providerChoices?.find((choice) => choice.isDefault) ??
    providerChoices?.[0] ??
    null;
  const thinkingOptions = selectedChoice?.thinkingOptions ?? [];
  const effectiveThinkingId =
    (thinkingId && thinkingOptions.some((option) => option.id === thinkingId)
      ? thinkingId
      : null) ??
    selectedChoice?.defaultThinkingOptionId ??
    thinkingOptions.find((option) => option.isDefault)?.id ??
    thinkingOptions[0]?.id ??
    null;
  const modes = useProviderModes(api, selectedChoice?.provider ?? null, dirCwd);
  const effectiveModeId =
    (modeId && modes?.some((mode) => mode.id === modeId) ? modeId : null) ??
    modes?.[0]?.id ??
    null;
  const profiles = useAgentProfiles(api);
  const selectedProfile =
    profiles?.find((profile) => profile.id === selectedProfileId) ?? null;

  const selectProject = useCallback((id: string) => {
    setProjectId(id);
    setSelected(null);
  }, []);
  const selectHost = useCallback(
    (serverId: string) => {
      if (serverId === selectedHostId) return;
      setSelectedHostId(serverId);
      setProjectId(null);
      setSelected(null);
      setNonce((value) => value + 1);
    },
    [selectedHostId],
  );
  const openWorkspace = useCallback(
    (workspaceId: string) => {
      navigation?.openWorkspace?.({ workspaceId, serverId: selectedHost.serverId });
    },
    [navigation, selectedHost.serverId],
  );

  const canSubmit =
    Boolean(project && selectedOption && !selectedOption.blocked) &&
    (trimmedPrompt.length === 0 || Boolean(selectedChoice)) &&
    !submitting;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit || !project || !selectedOption) return;
    setSubmitting(true);
    try {
      const workspace = await getApi().workspaces.create({
        title: basename(selectedOption.path),
        source: {
          kind: "directory",
          path: selectedOption.path,
          projectId: project.projectId,
        },
      });
      if (trimmedPrompt && selectedChoice) {
        await workspace.agents.create({
          config: {
            provider: selectedChoice.id,
            modeId: effectiveModeId ?? undefined,
            thinkingOptionId: effectiveThinkingId ?? undefined,
            featureValues: selectedProfile?.featureValues,
          },
          prompt: trimmedPrompt,
        });
      }
      toast.show("工作区已创建", { variant: "success" });
      setNonce((value) => value + 1);
      navigation?.openWorkspace?.({
        workspaceId: workspace.id,
        serverId: selectedHost.serverId,
      });
    } catch (failure) {
      toast.show(failure instanceof Error ? failure.message : String(failure), {
        variant: "error",
      });
    } finally {
      setSubmitting(false);
    }
  }, [
    canSubmit,
    project,
    selectedOption,
    trimmedPrompt,
    selectedChoice,
    selectedProfile,
    effectiveModeId,
    effectiveThinkingId,
    getApi,
    toast,
    navigation,
    selectedHost.serverId,
  ]);

  const dirItems = useMemo<readonly PickerItem[]>(
    () =>
      options.map((option) => ({
        key: option.key,
        primary: option.label,
        secondary: option.meta ? `${option.path} · ${option.meta}` : option.path,
        badge: option.badge ?? undefined,
        disabled: option.blocked,
        note: workspaceIndex.get(option.path) ? "已关联 workspace" : undefined,
      })),
    [options, workspaceIndex],
  );
  const toPickerItem = useCallback(
    (option: DirOption): PickerItem => ({
      key: option.key,
      primary: option.label,
      secondary: option.meta ? `${option.path} · ${option.meta}` : option.path,
      badge: option.badge ?? undefined,
      note: workspaceIndex.get(option.path) ? "已关联 workspace" : undefined,
    }),
    [workspaceIndex],
  );
  const worktreeItems = useMemo<readonly PickerItem[]>(
    () => options.filter((option) => option.key.startsWith("wt:")).map(toPickerItem),
    [options, toPickerItem],
  );
  const subdirItems = useMemo<readonly PickerItem[]>(
    () => options.filter((option) => !option.key.startsWith("wt:")).map(toPickerItem),
    [options, toPickerItem],
  );

  const projectItems = useMemo<readonly PickerItem[]>(
    () =>
      (projects ?? []).map((option) => ({
        key: option.projectId,
        primary: option.name,
        secondary: option.rootPath,
      })),
    [projects],
  );
  const hostItems = useMemo<readonly PickerItem[]>(
    () =>
      hostOptions.map((option) => ({
        key: option.serverId,
        primary: option.label,
        secondary: option.status === "online" ? undefined : option.status,
        disabled: option.status !== "online" && option.serverId !== installationHostId,
      })),
    [hostOptions, installationHostId],
  );
  const providerNames = useMemo(
    () => [...new Set((providerChoices ?? []).map((choice) => choice.provider))],
    [providerChoices],
  );
  const providerItems = useMemo<readonly PickerItem[]>(
    () => providerNames.map((name) => ({ key: name, primary: name })),
    [providerNames],
  );
  const selectProvider = useCallback(
    (name: string) => {
      setSelectedProfileId(null);
      const choice = providerChoices?.find((entry) => entry.provider === name);
      if (choice) setProviderId(choice.id);
    },
    [providerChoices],
  );
  const modelItems = useMemo<readonly PickerItem[]>(
    () =>
      (providerChoices ?? [])
        .filter((choice) => choice.provider === selectedChoice?.provider)
        .map((choice) => ({
          key: choice.id,
          primary: choice.label,
          secondary: choice.id,
          badge: choice.isDefault ? "默认" : undefined,
        })),
    [providerChoices, selectedChoice],
  );
  const thinkingItems = useMemo<readonly PickerItem[]>(
    () => thinkingOptions.map((option) => ({ key: option.id, primary: option.label })),
    [thinkingOptions],
  );
  const modeItems = useMemo<readonly PickerItem[]>(
    () =>
      (modes ?? []).map((mode) => ({
        key: mode.id,
        primary: mode.label,
        secondary: mode.description,
      })),
    [modes],
  );

  const applyProfile = useCallback(
    (profileId: string) => {
      setSelectedProfileId(profileId);
      const profile = profiles?.find((entry) => entry.id === profileId);
      if (!profile) return;
      const choice = providerChoices?.find(
        (candidate) =>
          candidate.provider === profile.provider &&
          (!profile.model || candidate.model === profile.model),
      );
      if (choice) setProviderId(choice.id);
      if (profile.modeId) setModeId(profile.modeId);
      if (profile.thinkingOptionId) setThinkingId(profile.thinkingOptionId);
    },
    [profiles, providerChoices],
  );
  const agentItems = useMemo<readonly PickerItem[]>(
    () =>
      (profiles ?? []).map((profile) => ({
        key: profile.id,
        primary: profile.name,
        secondary: [profile.provider, profile.model].filter(Boolean).join("/"),
      })),
    [profiles],
  );
  const pickerSpecs: Record<string, PickerSpec> = {
    project: { items: projectItems, selectedKey: project?.projectId, onSelect: selectProject },
    host: { items: hostItems, selectedKey: selectedHost.serverId, onSelect: selectHost },
    worktree: {
      items: worktreeItems,
      selectedKey: selectedOption?.key.startsWith("wt:") ? selectedOption.key : undefined,
      searchable: true,
      onSelect: setSelected,
    },
    dir: {
      items: subdirItems,
      selectedKey: selectedOption?.key.startsWith("wt:") ? undefined : selectedOption?.key,
      searchable: true,
      onSelect: setSelected,
    },
    provider: {
      items: providerItems,
      selectedKey: selectedChoice?.provider,
      onSelect: selectProvider,
    },
    model: { items: modelItems, selectedKey: selectedChoice?.id, onSelect: setProviderId },
    thinking: {
      items: thinkingItems,
      selectedKey: effectiveThinkingId ?? undefined,
      onSelect: setThinkingId,
    },
    mode: { items: modeItems, selectedKey: effectiveModeId ?? undefined, onSelect: setModeId },
    agent: {
      items: agentItems,
      selectedKey: selectedProfileId ?? undefined,
      onSelect: applyProfile,
    },
  };

  const projectAvatar = (
    <View style={styles.pillAvatar}>
      <Text style={styles.pillAvatarText}>
        {(project?.name ?? "?").slice(0, 1).toUpperCase()}
      </Text>
    </View>
  );
  const hostDot = (
    <View
      style={[
        { width: 7, height: 7, borderRadius: 4 },
        { backgroundColor: hostStatusColor(selectedHost, theme) },
      ]}
    />
  );
  const modelLabel =
    providerChoices === null ? "加载模型…" : (selectedChoice?.label ?? "选择模型");
  const thinkingLabel =
    thinkingOptions.find((option) => option.id === effectiveThinkingId)?.label ?? "思考";
  const modeLabel =
    modes === null
      ? "加载权限…"
      : (modes.find((mode) => mode.id === effectiveModeId)?.label ?? "权限模式");

  return (
    <View style={styles.screen} ref={rootRef} collapsable={false}>
      <ScrollView
        contentContainerStyle={{ flexGrow: 1, alignItems: "center", justifyContent: "center" }}
        onScroll={pickerState ? closePicker : undefined}
        scrollEventThrottle={16}
      >
        <View style={styles.pageColumn}>
          <Text style={styles.pageTitle}>新建工作区</Text>
          <View style={styles.pillsRow}>
            <DropdownPill
              open={pickerState?.id === "project"}
              onToggle={(rect) => togglePicker("project", rect)}
              icon={projectAvatar}
              label={project?.name ?? "选择项目"}
              title="选择项目"
              disabled={!projects || projects.length === 0}
              styles={styles}
            />
            {hostOptions.length > 1 ? (
              <DropdownPill
                open={pickerState?.id === "host"}
                onToggle={(rect) => togglePicker("host", rect)}
                icon={hostDot}
                label={selectedHost.label}
                title="选择主机"
                styles={styles}
              />
            ) : null}
            {isGitProject && worktreeItems.length > 0 ? (
            <DropdownPill
              open={pickerState?.id === "worktree"}
              onToggle={(rect) => togglePicker("worktree", rect)}
              icon={<Icon icon="GitBranch" size={13} color={theme.colors.foregroundMuted} />}
              label={
                selectedOption?.key.startsWith("wt:") ? selectedOption.label : "Worktree"
              }
              title="选择 worktree 作为 cwd"
              disabled={!project || !hostReachable}
              styles={styles}
            />
            ) : null}
            <DropdownPill
              open={pickerState?.id === "dir"}
              onToggle={(rect) => togglePicker("dir", rect)}
              icon={<Icon icon="FolderOpen" size={13} color={theme.colors.foregroundMuted} />}
              label={
                selectedOption && !selectedOption.key.startsWith("wt:")
                  ? selectedOption.label
                  : "选择目录"
              }
              title="选择一级子目录作为 cwd"
              disabled={!project || !hostReachable}
              styles={styles}
            />
            {agentItems.length > 0 ? (
              <DropdownPill
                open={pickerState?.id === "agent"}
                onToggle={(rect) => togglePicker("agent", rect)}
                icon={<Icon icon="Cpu" size={13} color={theme.colors.foregroundMuted} />}
                label={selectedProfile?.name ?? "Agent"}
                title="Agent 预设"
                disabled={profiles === null}
                styles={styles}
              />
            ) : null}
          </View>
          {error ? (
            <View style={styles.belowComposer}>
              <Text accessibilityRole="alert" style={styles.errorText}>
                {error}
              </Text>
            </View>
          ) : null}
          {!hostReachable ? (
            <View style={styles.belowComposer}>
              <Text style={styles.mutedText}>
                主机 {selectedHost.label} 未连接，请先在 Paseo 中连接该主机
              </Text>
            </View>
          ) : null}
          <View style={styles.composer}>
            <TextInput
              value={prompt}
              onChangeText={setPrompt}
              placeholder="给 Agent 发消息（可选，留空只创建 workspace）…"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.composerInput}
              multiline
            />
            <View style={styles.composerToolbar}>
              <View style={styles.composerTools}>
                <DropdownPill
                  open={pickerState?.id === "provider"}
                  onToggle={(rect) => togglePicker("provider", rect)}
                  icon={<Icon icon="Cpu" size={13} color={theme.colors.foregroundMuted} />}
                  label={selectedChoice?.provider ?? "Agent"}
                  title="Agent（provider）"
                  disabled={providerChoices === null}
                  styles={styles}
                />
                <DropdownPill
                  open={pickerState?.id === "model"}
                  onToggle={(rect) => togglePicker("model", rect)}
                  icon={<Icon icon="Bot" size={13} color={theme.colors.foregroundMuted} />}
                  label={modelLabel}
                  title="模型"
                  styles={styles}
                />
                {thinkingOptions.length > 0 ? (
                  <DropdownPill
                    open={pickerState?.id === "thinking"}
                    onToggle={(rect) => togglePicker("thinking", rect)}
                    icon={<Icon icon="Brain" size={13} color={theme.colors.foregroundMuted} />}
                    label={thinkingLabel}
                    title="思考强度"
                    styles={styles}
                  />
                ) : null}
                {modes && modes.length > 0 ? (
                  <DropdownPill
                    open={pickerState?.id === "mode"}
                    onToggle={(rect) => togglePicker("mode", rect)}
                    icon={<Icon icon="Shield" size={13} color={theme.colors.foregroundMuted} />}
                    label={modeLabel}
                    title="权限模式"
                    styles={styles}
                  />
                ) : null}
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="创建工作区"
                disabled={!canSubmit}
                onPress={handleSubmit}
                style={[styles.sendButton, !canSubmit && { opacity: 0.4 }]}
              >
                <Text style={styles.sendButtonText}>{submitting ? "…" : "↑"}</Text>
              </Pressable>
            </View>
          </View>
          <View style={styles.belowComposer}>
            {linkedWorkspace ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => openWorkspace(linkedWorkspace.id)}
                style={[styles.pill, { alignSelf: "flex-start" }]}
              >
                <Text style={styles.pillText}>打开已有 workspace：{linkedWorkspace.name}</Text>
              </Pressable>
            ) : null}
            {!isLocalHost ? (
              <Text style={styles.hintText}>
                远程主机：git 通过该主机上的临时终端执行，需要该项目在此主机上至少有一个 workspace。
              </Text>
            ) : null}
          </View>
        </View>
      </ScrollView>
      {pickerState ? (
        <Pressable style={styles.pickerBackdrop} onPress={closePicker} />
      ) : null}
      {pickerState && pickerSpecs[pickerState.id] ? (
        <PickerMenu
          spec={pickerSpecs[pickerState.id]}
          rect={pickerState.rect}
          onPick={(key) => {
            pickerSpecs[pickerState.id].onSelect(key);
            closePicker();
          }}
          styles={styles}
        />
      ) : null}
    </View>
  );
}
