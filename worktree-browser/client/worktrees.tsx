import { usePaseo, useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Modal, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  createWorktreeRpc,
  listWorktreesRpc,
  sanitizePathSegment,
  worktreeBranchesRpc,
  type Worktree,
} from "../shared/worktrees";

type Theme = PluginSurfaceProps["theme"];

interface ProjectOption {
  projectId: string;
  name: string;
  rootPath: string;
  kind: "git" | "non_git" | "directory";
}

interface WorkspaceLink {
  id: string;
  name: string;
}

function basename(path: string): string {
  return path.split(/[\\/]/).findLast((part) => part.length > 0) ?? path;
}

function shortHead(head: string | null): string | null {
  return head ? head.slice(0, 7) : null;
}

function formatRelativeTime(mtimeMs: number | null, now = Date.now()): string {
  if (mtimeMs == null) return "";
  const seconds = Math.max(0, Math.floor((now - mtimeMs) / 1000));
  if (seconds < 60) return "刚刚";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function useProjects(paseo: ReturnType<typeof usePaseo>) {
  const [projects, setProjects] = useState<ProjectOption[] | null>(null);

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
  }, [paseo]);

  return projects;
}

function useWorkspaceIndex(paseo: ReturnType<typeof usePaseo>, nonce: number) {
  const [index, setIndex] = useState<ReadonlyMap<string, WorkspaceLink>>(new Map());

  useEffect(() => {
    let cancelled = false;
    void paseo.workspaces
      .list()
      .then((result) => {
        if (cancelled) return undefined;
        const byCwd = new Map<string, WorkspaceLink>();
        for (const workspace of result.entries) {
          if (workspace.workspaceDirectory) {
            byCwd.set(workspace.workspaceDirectory, { id: workspace.id, name: workspace.name });
          }
        }
        setIndex(byCwd);
        return undefined;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [paseo, nonce]);

  return index;
}

function useWorktrees(
  listWorktrees: (input: { repoRoot: string }) => Promise<{ worktrees: Worktree[] }>,
  repoRoot: string | null,
  nonce: number,
) {
  const [worktrees, setWorktrees] = useState<Worktree[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!repoRoot) return;
    let cancelled = false;
    setWorktrees(null);
    setError(null);
    void listWorktrees({ repoRoot })
      .then((result) => {
        if (cancelled) return undefined;
        const sorted = [...result.worktrees].sort(
          (a, b) => Number(b.main) - Number(a.main) || (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0),
        );
        setWorktrees(sorted);
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
  }, [listWorktrees, repoRoot, nonce]);

  return { worktrees, error };
}

function useStyles(theme: Theme, compact: boolean) {
  return useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      centeredScreen: { flex: 1, alignItems: "center" as const, justifyContent: "center" as const },
      mutedText: { color: theme.colors.foregroundMuted },
      errorText: { color: theme.colors.statusDanger },
      retryText: { color: theme.colors.accent },
      toolbar: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        paddingHorizontal: compact ? 12 : 20,
        paddingTop: compact ? 12 : 20,
        gap: 8,
      },
      toolbarLabel: { color: theme.colors.foregroundMuted, fontSize: 13 },
      searchRow: {
        paddingHorizontal: compact ? 12 : 20,
        paddingTop: 8,
      },
      searchInput: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        color: theme.colors.foreground,
        fontSize: 13,
      },
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
      list: { flex: 1 },
      listContent: { padding: compact ? 12 : 20, gap: 10 },
      card: {
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        padding: 12,
        gap: 6,
      },
      cardTitleRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      cardTitle: {
        color: theme.colors.foreground,
        fontSize: 14,
        fontWeight: "600" as const,
        flex: 1,
      },
      mainBadge: {
        borderRadius: 6,
        paddingHorizontal: 6,
        paddingVertical: 2,
        backgroundColor: theme.colors.surface2,
      },
      mainBadgeText: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        fontWeight: "600" as const,
      },
      cardPath: { color: theme.colors.foregroundMuted, fontSize: 12 },
      cardMeta: { color: theme.colors.foregroundMuted, fontSize: 12 },
      actionRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 8,
        marginTop: 4,
      },
      linkText: { color: theme.colors.foregroundMuted, fontSize: 12, flex: 1 },
      actionButton: {
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 7,
        backgroundColor: theme.colors.accent,
      },
      actionButtonSecondary: {
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
      },
      actionButtonText: {
        color: theme.colors.accentForeground,
        fontSize: 13,
        fontWeight: "600" as const,
      },
      actionButtonSecondaryText: {
        color: theme.colors.foreground,
        fontSize: 13,
        fontWeight: "600" as const,
      },
      refreshButton: {
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        paddingHorizontal: 10,
        paddingVertical: 6,
      },
      refreshText: { color: theme.colors.foreground, fontSize: 13 },
      fieldLabel: { color: theme.colors.foregroundMuted, fontSize: 12 },
      fieldInput: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        color: theme.colors.foreground,
        fontSize: 13,
      },
      branchList: {
        maxHeight: 180,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
      },
      branchRow: {
        paddingHorizontal: 10,
        paddingVertical: 7,
        borderRadius: 7,
      },
      branchRowSelected: {
        paddingHorizontal: 10,
        paddingVertical: 7,
        borderRadius: 7,
        backgroundColor: theme.colors.surface2,
      },
      branchRowText: { color: theme.colors.foreground, fontSize: 13 },
      submitRow: {
        flexDirection: "row" as const,
        justifyContent: "flex-end" as const,
        gap: 8,
      },
    }),
    [theme, compact],
  );
}

function ProjectChip({
  project,
  selected,
  onSelect,
  styles,
}: {
  project: ProjectOption;
  selected: boolean;
  onSelect: (id: string) => void;
  styles: ReturnType<typeof useStyles>;
}) {
  const handlePress = useCallback(() => onSelect(project.projectId), [onSelect, project.projectId]);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={handlePress}
      style={selected ? styles.chipSelected : styles.chip}
    >
      <Text style={styles.chipText}>{project.name}</Text>
    </Pressable>
  );
}

function WorktreeCard({
  worktree,
  workspace,
  creating,
  onCreate,
  onOpen,
  styles,
}: {
  worktree: Worktree;
  workspace: WorkspaceLink | null;
  creating: boolean;
  onCreate: (worktree: Worktree) => void;
  onOpen: (workspaceId: string) => void;
  styles: ReturnType<typeof useStyles>;
}) {
  const handleCreate = useCallback(() => onCreate(worktree), [onCreate, worktree]);
  const handleOpen = useCallback(() => workspace && onOpen(workspace.id), [onOpen, workspace]);
  const title = worktree.branch ?? "(detached)";
  const meta = [
    worktree.head ? `HEAD ${shortHead(worktree.head)}` : null,
    formatRelativeTime(worktree.mtimeMs),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <View style={styles.card}>
      <View style={styles.cardTitleRow}>
        <Text style={styles.cardTitle} numberOfLines={1}>
          {title}
        </Text>
        {worktree.main ? (
          <View style={styles.mainBadge}>
            <Text style={styles.mainBadgeText}>主 worktree</Text>
          </View>
        ) : null}
      </View>
      <Text style={styles.cardPath} numberOfLines={1}>
        {worktree.path}
      </Text>
      {meta ? <Text style={styles.cardMeta}>{meta}</Text> : null}
      <View style={styles.actionRow}>
        <Text style={styles.linkText} numberOfLines={1}>
          {workspace ? `workspace: ${workspace.name}` : "未关联 workspace"}
        </Text>
        {workspace ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`打开 ${workspace.name}`}
            onPress={handleOpen}
            style={styles.actionButtonSecondary}
          >
            <Text style={styles.actionButtonSecondaryText}>打开</Text>
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`基于 ${title} 创建 workspace`}
            disabled={creating}
            onPress={handleCreate}
            style={styles.actionButton}
          >
            <Text style={styles.actionButtonText}>{creating ? "创建中…" : "+ 创建 workspace"}</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

function BranchRow({
  branch,
  selected,
  onSelect,
  styles,
}: {
  branch: string;
  selected: boolean;
  onSelect: (branch: string) => void;
  styles: ReturnType<typeof useStyles>;
}) {
  const handlePress = useCallback(() => onSelect(branch), [onSelect, branch]);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={handlePress}
      style={selected ? styles.branchRowSelected : styles.branchRow}
    >
      <Text style={styles.branchRowText}>{branch}</Text>
    </Pressable>
  );
}

function CreateWorktreeModal({
  open,
  repoRoot,
  projectName,
  onClose,
  onCreated,
  styles,
}: {
  open: boolean;
  repoRoot: string;
  projectName: string;
  onClose: () => void;
  onCreated: () => void;
  styles: ReturnType<typeof useStyles>;
}) {
  const listBranches = useRpc(worktreeBranchesRpc);
  const createWorktree = useRpc(createWorktreeRpc);
  const toast = useToast();
  const [branches, setBranches] = useState<string[] | null>(null);
  const [branchesError, setBranchesError] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  const [directory, setDirectory] = useState("");
  const [dirDirty, setDirDirty] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const projectSlug = sanitizePathSegment(projectName) || "project";
  const defaultDirectory = useCallback(
    (branch: string) => {
      const slug = sanitizePathSegment(branch);
      return `~/.worktrees/${projectSlug}/${slug}`;
    },
    [projectSlug],
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setBranches(null);
    setBranchesError(null);
    setSource(null);
    setTarget("");
    setDirectory(defaultDirectory(""));
    setDirDirty(false);
    void listBranches({ repoRoot })
      .then((result) => {
        if (cancelled) return undefined;
        setBranches(result.branches);
        setSource(result.currentBranch ?? result.branches[0] ?? null);
        return undefined;
      })
      .catch((failure: unknown) => {
        if (!cancelled) {
          setBranchesError(failure instanceof Error ? failure.message : String(failure));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, repoRoot, listBranches, defaultDirectory]);

  const handleTargetChange = useCallback(
    (value: string) => {
      setTarget(value);
      setDirectory((current) => (dirDirty ? current : defaultDirectory(value)));
    },
    [dirDirty, defaultDirectory],
  );
  const handleDirectoryChange = useCallback((value: string) => {
    setDirDirty(true);
    setDirectory(value);
  }, []);

  const canSubmit = Boolean(source && target.trim() && directory.trim()) && !submitting;
  const handleSubmit = useCallback(async () => {
    if (!source || !canSubmit) return;
    setSubmitting(true);
    try {
      await createWorktree({
        repoRoot,
        sourceBranch: source,
        targetBranch: target.trim(),
        directory: directory.trim(),
      });
      toast.show("worktree 已创建", { variant: "success" });
      onCreated();
      onClose();
    } catch (failure) {
      toast.show(failure instanceof Error ? failure.message : String(failure), {
        variant: "error",
      });
    } finally {
      setSubmitting(false);
    }
  }, [source, canSubmit, createWorktree, repoRoot, target, directory, toast, onCreated, onClose]);
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) onClose();
    },
    [onClose],
  );

  let branchPicker = <Text style={styles.mutedText}>正在加载…</Text>;
  if (branchesError) {
    branchPicker = (
      <Text accessibilityRole="alert" style={styles.errorText}>
        {branchesError}
      </Text>
    );
  } else if (branches) {
    branchPicker = (
      <ScrollView style={styles.branchList} keyboardShouldPersistTaps="handled">
        {branches.map((branch) => (
          <BranchRow
            key={branch}
            branch={branch}
            selected={branch === source}
            onSelect={setSource}
            styles={styles}
          />
        ))}
      </ScrollView>
    );
  }

  return (
    <Modal title="新建 worktree" open={open} onOpenChange={handleOpenChange}>
      <Modal.Content>
        <Text style={styles.fieldLabel}>源分支</Text>
        {branchPicker}
        <Text style={styles.fieldLabel}>目标分支（新分支名）</Text>
        <TextInput
          value={target}
          onChangeText={handleTargetChange}
          placeholder="例如 feature/foo"
          placeholderTextColor={styles.mutedText.color}
          style={styles.fieldInput}
        />
        <Text style={styles.fieldLabel}>worktree 目录</Text>
        <TextInput
          value={directory}
          onChangeText={handleDirectoryChange}
          placeholder="~/.worktrees/…"
          placeholderTextColor={styles.mutedText.color}
          style={styles.fieldInput}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <View style={styles.submitRow}>
          <Pressable
            accessibilityRole="button"
            onPress={onClose}
            style={styles.actionButtonSecondary}
          >
            <Text style={styles.actionButtonSecondaryText}>取消</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="创建 worktree"
            disabled={!canSubmit}
            onPress={handleSubmit}
            style={styles.actionButton}
          >
            <Text style={styles.actionButtonText}>{submitting ? "创建中…" : "创建"}</Text>
          </Pressable>
        </View>
      </Modal.Content>
    </Modal>
  );
}

export function WorktreeSurface({ theme, layout, navigation }: PluginSurfaceProps) {
  const paseo = usePaseo();
  const listWorktrees = useRpc(listWorktreesRpc);
  const toast = useToast();
  const styles = useStyles(theme, layout.compact);
  const projects = useProjects(paseo);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [nonce, setNonce] = useState(0);
  const [creatingPath, setCreatingPath] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const openCreate = useCallback(() => setCreateOpen(true), []);
  const closeCreate = useCallback(() => setCreateOpen(false), []);

  const project = useMemo(
    () => projects?.find((option) => option.projectId === projectId) ?? projects?.[0] ?? null,
    [projects, projectId],
  );
  const isGitProject = project?.kind === "git";
  const { worktrees, error } = useWorktrees(
    listWorktrees,
    isGitProject ? project.rootPath : null,
    nonce,
  );
  const workspaceIndex = useWorkspaceIndex(paseo, nonce);

  const filteredWorktrees = useMemo(() => {
    if (!worktrees) return null;
    const needle = query.trim().toLowerCase();
    if (!needle) return worktrees;
    return worktrees.filter((worktree) => {
      const workspaceName = workspaceIndex.get(worktree.path)?.name ?? "";
      return [worktree.branch ?? "", worktree.path, workspaceName]
        .join("\n")
        .toLowerCase()
        .includes(needle);
    });
  }, [worktrees, query, workspaceIndex]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);
  const selectProject = useCallback((id: string) => setProjectId(id), []);
  const openWorkspace = useCallback(
    (workspaceId: string) => {
      navigation?.openWorkspace?.({ workspaceId });
    },
    [navigation],
  );
  const createWorkspace = useCallback(
    async (worktree: Worktree) => {
      if (!project) return;
      setCreatingPath(worktree.path);
      try {
        const workspace = await paseo.workspaces.create({
          title: worktree.branch ?? basename(worktree.path),
          source: { kind: "directory", path: worktree.path, projectId: project.projectId },
        });
        toast.show("workspace 已创建", { variant: "success" });
        refresh();
        navigation?.openWorkspace?.({ workspaceId: workspace.id });
      } catch (failure) {
        toast.show(failure instanceof Error ? failure.message : String(failure), {
          variant: "error",
        });
      } finally {
        setCreatingPath(null);
      }
    },
    [paseo, project, navigation, toast, refresh],
  );

  let body = <Text style={styles.mutedText}>正在加载…</Text>;
  if (!projects) {
    body = <Text style={styles.mutedText}>正在加载…</Text>;
  } else if (projects.length === 0) {
    body = <Text style={styles.mutedText}>暂无项目，请先在 Paseo 中添加</Text>;
  } else if (project && !isGitProject) {
    body = <Text style={styles.mutedText}>该项目不是 git 仓库，没有 worktree</Text>;
  } else if (error) {
    body = (
      <View style={styles.centeredScreen}>
        <Text accessibilityRole="alert" style={styles.errorText}>
          {error}
        </Text>
        <Pressable accessibilityRole="button" onPress={refresh}>
          <Text style={styles.retryText}>重试</Text>
        </Pressable>
      </View>
    );
  } else if (!worktrees) {
    body = <Text style={styles.mutedText}>正在加载…</Text>;
  } else if (worktrees.length === 0) {
    body = <Text style={styles.mutedText}>该项目没有 worktree</Text>;
  } else if (!filteredWorktrees || filteredWorktrees.length === 0) {
    body = <Text style={styles.mutedText}>无匹配 worktree</Text>;
  } else {
    body = (
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {filteredWorktrees.map((worktree) => (
          <WorktreeCard
            key={worktree.path}
            worktree={worktree}
            workspace={workspaceIndex.get(worktree.path) ?? null}
            creating={creatingPath === worktree.path}
            onCreate={createWorkspace}
            onOpen={openWorkspace}
            styles={styles}
          />
        ))}
      </ScrollView>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.toolbar}>
        <Text style={styles.toolbarLabel}>项目:</Text>
        <ScrollView horizontal style={styles.chipsScroll} contentContainerStyle={styles.chips}>
          {projects?.map((option) => (
            <ProjectChip
              key={option.projectId}
              project={option}
              selected={option.projectId === project?.projectId}
              onSelect={selectProject}
              styles={styles}
            />
          ))}
        </ScrollView>
        {isGitProject ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="新建 worktree"
            onPress={openCreate}
            style={styles.refreshButton}
          >
            <Text style={styles.refreshText}>+ 新建</Text>
          </Pressable>
        ) : null}
        <Pressable accessibilityRole="button" onPress={refresh} style={styles.refreshButton}>
          <Text style={styles.refreshText}>刷新</Text>
        </Pressable>
      </View>
      <View style={styles.searchRow}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="搜索分支、路径或 workspace…"
          placeholderTextColor={theme.colors.foregroundMuted}
          style={styles.searchInput}
        />
      </View>
      {body}
      {project && isGitProject ? (
        <CreateWorktreeModal
          open={createOpen}
          repoRoot={project.rootPath}
          projectName={project.name}
          onClose={closeCreate}
          onCreated={refresh}
          styles={styles}
        />
      ) : null}
    </View>
  );
}
