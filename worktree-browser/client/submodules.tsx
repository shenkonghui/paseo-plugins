import { useRpc, useWorkspace, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  repoCommitFilesRpc,
  repoFileDiffRpc,
  repoOverviewRpc,
  submoduleFileDiffRpc,
  submoduleFilesRpc,
  type RepoCommit,
  type SubmoduleChange,
} from "../shared/worktrees";

type Theme = PluginWorkspacePanelProps["theme"];

interface Overview {
  branch: string | null;
  changes: SubmoduleChange[];
  commits: RepoCommit[];
  submodulePaths: string[];
}

type SelectedFile =
  | { kind: "repo"; sha: string | null; file: string }
  | { kind: "sub"; sha: string | null; subPath: string; file: string };

/** null sha = 未提交的工作区更改 */
function subKey(sha: string | null, subPath: string): string {
  return `${sha ?? "worktree"}:${subPath}`;
}

function selectedEquals(a: SelectedFile | null, b: SelectedFile): boolean {
  if (!a || a.kind !== b.kind) return false;
  if (b.kind === "repo") return a.kind === "repo" && a.sha === b.sha && a.file === b.file;
  return a.kind === "sub" && a.sha === b.sha && a.subPath === b.subPath && a.file === b.file;
}

function useStyles(theme: Theme, compact: boolean) {
  return useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      mutedText: { color: theme.colors.foregroundMuted },
      errorText: { color: theme.colors.statusDanger },
      retryText: { color: theme.colors.accent },
      body: { flex: 1, flexDirection: "row" as const },
      bodyCompact: { flex: 1, flexDirection: "column" as const },
      leftPane: {
        flex: 1,
        borderRightWidth: 1,
        borderColor: theme.colors.border,
      },
      leftPaneCompact: { flex: 1 },
      paneHeader: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        paddingHorizontal: compact ? 12 : 16,
        paddingVertical: 10,
      },
      paneHeaderText: { color: theme.colors.foregroundMuted, fontSize: 12 },
      refreshButton: {
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        paddingHorizontal: 10,
        paddingVertical: 5,
      },
      refreshText: { color: theme.colors.foreground, fontSize: 12 },
      listFlex: { flex: 1 },
      listContent: { paddingHorizontal: compact ? 12 : 16, paddingBottom: 16 },
      sectionRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        paddingVertical: 8,
      },
      sectionTitle: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
      sectionCount: { color: theme.colors.foregroundMuted, fontSize: 12 },
      commitRow: {
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        marginBottom: 2,
      },
      commitRowActive: {
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        marginBottom: 2,
        backgroundColor: theme.colors.surface2,
      },
      commitSubject: { color: theme.colors.foreground, fontSize: 13 },
      commitMeta: { color: theme.colors.foregroundMuted, fontSize: 11, marginTop: 2 },
      fileList: {
        marginLeft: 14,
        borderLeftWidth: 1,
        borderColor: theme.colors.border,
        paddingLeft: 8,
        marginBottom: 6,
        gap: 2,
      },
      fileRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingVertical: 4,
        paddingHorizontal: 6,
        borderRadius: 6,
      },
      fileRowActive: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingVertical: 4,
        paddingHorizontal: 6,
        borderRadius: 6,
        backgroundColor: theme.colors.surface2,
      },
      fileBadge: {
        width: 20,
        height: 20,
        borderRadius: 5,
        backgroundColor: theme.colors.surface2,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      fileBadgeText: {
        fontSize: 11,
        fontWeight: "700" as const,
        color: theme.colors.statusWarning,
      },
      fileName: { color: theme.colors.foreground, fontSize: 12, flex: 1 },
      chevron: { color: theme.colors.foregroundMuted, fontSize: 11 },
      rightPane: { flex: 1 },
      diffHeader: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        paddingHorizontal: compact ? 12 : 16,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderColor: theme.colors.border,
      },
      diffTitle: {
        color: theme.colors.foreground,
        fontSize: 13,
        fontWeight: "600" as const,
        flex: 1,
      },
      diffClose: { paddingHorizontal: 6, paddingVertical: 2 },
      diffCloseText: { color: theme.colors.foregroundMuted, fontSize: 16 },
      diffScroll: { flex: 1 },
      diffContent: { padding: compact ? 12 : 16 },
      diffAdd: {
        fontFamily: "monospace" as const,
        fontSize: 11,
        color: theme.colors.statusSuccess,
      },
      diffDel: {
        fontFamily: "monospace" as const,
        fontSize: 11,
        color: theme.colors.statusDanger,
      },
      diffHunk: {
        fontFamily: "monospace" as const,
        fontSize: 11,
        color: theme.colors.accent,
      },
      diffContext: {
        fontFamily: "monospace" as const,
        fontSize: 11,
        color: theme.colors.foregroundMuted,
      },
      emptyPane: { flex: 1, alignItems: "center" as const, justifyContent: "center" as const },
    }),
    [theme, compact],
  );
}

type Styles = ReturnType<typeof useStyles>;

function diffLineStyle(line: string, styles: Styles) {
  if (line.startsWith("+")) return styles.diffAdd;
  if (line.startsWith("-")) return styles.diffDel;
  if (line.startsWith("@@")) return styles.diffHunk;
  return styles.diffContext;
}

function DiffLines({ diff, styles }: { diff: string; styles: Styles }) {
  const lines = useMemo(() => {
    const seen = new Map<string, number>();
    return diff.split("\n").map((line) => {
      const occurrence = seen.get(line) ?? 0;
      seen.set(line, occurrence + 1);
      return { key: `${line}#${occurrence}`, line };
    });
  }, [diff]);
  if (!diff) return <Text style={styles.mutedText}>无 diff 内容</Text>;
  return (
    <View>
      {lines.map(({ key, line }) => (
        <Text key={key} style={diffLineStyle(line, styles)}>
          {line || " "}
        </Text>
      ))}
    </View>
  );
}

function DiffPane({
  repoRoot,
  selected,
  onClose,
  styles,
}: {
  repoRoot: string;
  selected: SelectedFile;
  onClose: () => void;
  styles: Styles;
}) {
  const repoFileDiff = useRpc(repoFileDiffRpc);
  const subFileDiff = useRpc(submoduleFileDiffRpc);
  const [diff, setDiff] = useState<string | null>(null);

  const title = selected.kind === "repo" ? selected.file : `${selected.subPath}/${selected.file}`;

  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    const request =
      selected.kind === "repo"
        ? repoFileDiff({
            repoRoot,
            file: selected.file,
            mode: selected.sha ? "commit" : "worktree",
            sha: selected.sha ?? undefined,
          })
        : subFileDiff({
            repoRoot,
            path: selected.subPath,
            file: selected.file,
            mode: selected.sha ? "commit" : "worktree",
            sha: selected.sha ?? undefined,
          });
    void request
      .then((result) => {
        if (!cancelled) setDiff(result.diff);
        return undefined;
      })
      .catch(() => {
        if (!cancelled) setDiff("");
      });
    return () => {
      cancelled = true;
    };
  }, [repoFileDiff, subFileDiff, repoRoot, selected]);

  return (
    <View style={styles.rightPane}>
      <View style={styles.diffHeader}>
        <Text style={styles.diffTitle} numberOfLines={1}>
          {title}
        </Text>
        <Pressable accessibilityRole="button" onPress={onClose} style={styles.diffClose}>
          <Text style={styles.diffCloseText}>✕</Text>
        </Pressable>
      </View>
      <ScrollView style={styles.diffScroll} contentContainerStyle={styles.diffContent}>
        {diff === null ? (
          <Text style={styles.mutedText}>正在加载…</Text>
        ) : (
          <DiffLines diff={diff} styles={styles} />
        )}
      </ScrollView>
    </View>
  );
}

function FileRow({
  badge,
  path,
  selected,
  chevron,
  onSelect,
  styles,
}: {
  badge: string;
  path: string;
  selected: boolean;
  chevron: string | null;
  onSelect: (path: string) => void;
  styles: Styles;
}) {
  const handlePress = useCallback(() => onSelect(path), [onSelect, path]);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={handlePress}
      style={selected ? styles.fileRowActive : styles.fileRow}
    >
      <View style={styles.fileBadge}>
        <Text style={styles.fileBadgeText}>{badge}</Text>
      </View>
      <Text style={styles.fileName} numberOfLines={1}>
        {path}
      </Text>
      {chevron ? <Text style={styles.chevron}>{chevron}</Text> : null}
    </Pressable>
  );
}

function SubmoduleEntry({
  sha,
  subPath,
  expanded,
  files,
  selectedFile,
  onToggle,
  onSelectFile,
  styles,
}: {
  sha: string | null;
  subPath: string;
  expanded: boolean;
  files: SubmoduleChange[] | null;
  selectedFile: SelectedFile | null;
  onToggle: (sha: string | null, subPath: string) => void;
  onSelectFile: (selected: SelectedFile) => void;
  styles: Styles;
}) {
  const handleToggle = useCallback(
    (_path: string) => onToggle(sha, subPath),
    [onToggle, sha, subPath],
  );
  const handleFile = useCallback(
    (file: string) => onSelectFile({ kind: "sub", sha, subPath, file }),
    [onSelectFile, sha, subPath],
  );

  let inner = null;
  if (expanded) {
    if (!files) inner = <Text style={styles.mutedText}>正在加载…</Text>;
    else if (files.length === 0) inner = <Text style={styles.mutedText}>无文件变更</Text>;
    else {
      inner = (
        <View>
          {files.map((change) => (
            <FileRow
              key={change.path}
              badge={change.code.trim().slice(0, 1) || "?"}
              path={change.path}
              selected={selectedEquals(selectedFile, {
                kind: "sub",
                sha,
                subPath,
                file: change.path,
              })}
              chevron={null}
              onSelect={handleFile}
              styles={styles}
            />
          ))}
        </View>
      );
    }
  }

  return (
    <View>
      <FileRow
        badge="S"
        path={subPath}
        selected={false}
        chevron={expanded ? "▾" : "▸"}
        onSelect={handleToggle}
        styles={styles}
      />
      {inner ? <View style={styles.fileList}>{inner}</View> : null}
    </View>
  );
}

function RepoFiles({
  sha,
  files,
  submodulePaths,
  expandedSubs,
  subFiles,
  selectedFile,
  onSelectFile,
  onToggleSub,
  styles,
}: {
  sha: string | null;
  files: SubmoduleChange[];
  submodulePaths: ReadonlySet<string>;
  expandedSubs: ReadonlySet<string>;
  subFiles: ReadonlyMap<string, SubmoduleChange[]>;
  selectedFile: SelectedFile | null;
  onSelectFile: (selected: SelectedFile) => void;
  onToggleSub: (sha: string | null, subPath: string) => void;
  styles: Styles;
}) {
  const handleRepoFile = useCallback(
    (file: string) => onSelectFile({ kind: "repo", sha, file }),
    [onSelectFile, sha],
  );
  return (
    <View>
      {files.map((change) =>
        submodulePaths.has(change.path) ? (
          <SubmoduleEntry
            key={change.path}
            sha={sha}
            subPath={change.path}
            expanded={expandedSubs.has(subKey(sha, change.path))}
            files={subFiles.get(subKey(sha, change.path)) ?? null}
            selectedFile={selectedFile}
            onToggle={onToggleSub}
            onSelectFile={onSelectFile}
            styles={styles}
          />
        ) : (
          <FileRow
            key={change.path}
            badge={change.code.trim().slice(0, 1) || "?"}
            path={change.path}
            selected={selectedEquals(selectedFile, { kind: "repo", sha, file: change.path })}
            chevron={null}
            onSelect={handleRepoFile}
            styles={styles}
          />
        ),
      )}
    </View>
  );
}

function CommitFiles({
  sha,
  files,
  submodulePaths,
  expandedSubs,
  subFiles,
  selectedFile,
  onSelectFile,
  onToggleSub,
  styles,
}: {
  sha: string;
  files: SubmoduleChange[] | null;
  submodulePaths: ReadonlySet<string>;
  expandedSubs: ReadonlySet<string>;
  subFiles: ReadonlyMap<string, SubmoduleChange[]>;
  selectedFile: SelectedFile | null;
  onSelectFile: (selected: SelectedFile) => void;
  onToggleSub: (sha: string | null, subPath: string) => void;
  styles: Styles;
}) {
  if (!files) return <Text style={styles.mutedText}>正在加载…</Text>;
  if (files.length === 0) return <Text style={styles.mutedText}>无文件变更</Text>;
  return (
    <RepoFiles
      sha={sha}
      files={files}
      submodulePaths={submodulePaths}
      expandedSubs={expandedSubs}
      subFiles={subFiles}
      selectedFile={selectedFile}
      onSelectFile={onSelectFile}
      onToggleSub={onToggleSub}
      styles={styles}
    />
  );
}

function CommitRow({
  commit,
  expanded,
  files,
  submodulePaths,
  expandedSubs,
  subFiles,
  selectedFile,
  onToggle,
  onSelectFile,
  onToggleSub,
  styles,
}: {
  commit: RepoCommit;
  expanded: boolean;
  files: SubmoduleChange[] | null;
  submodulePaths: ReadonlySet<string>;
  expandedSubs: ReadonlySet<string>;
  subFiles: ReadonlyMap<string, SubmoduleChange[]>;
  selectedFile: SelectedFile | null;
  onToggle: (sha: string) => void;
  onSelectFile: (selected: SelectedFile) => void;
  onToggleSub: (sha: string | null, subPath: string) => void;
  styles: Styles;
}) {
  const handleToggle = useCallback(() => onToggle(commit.sha), [onToggle, commit.sha]);
  const meta = [commit.sha.slice(0, 7), commit.author, commit.relativeDate]
    .filter(Boolean)
    .join("  ");
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        onPress={handleToggle}
        style={expanded ? styles.commitRowActive : styles.commitRow}
      >
        <Text style={styles.commitSubject} numberOfLines={2}>
          {commit.subject}
        </Text>
        <Text style={styles.commitMeta} numberOfLines={1}>
          {meta}
        </Text>
      </Pressable>
      {expanded ? (
        <View style={styles.fileList}>
          <CommitFiles
            sha={commit.sha}
            files={files}
            submodulePaths={submodulePaths}
            expandedSubs={expandedSubs}
            subFiles={subFiles}
            selectedFile={selectedFile}
            onSelectFile={onSelectFile}
            onToggleSub={onToggleSub}
            styles={styles}
          />
        </View>
      ) : null}
    </View>
  );
}

export function SubmodulePanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const directory = useWorkspace(workspaceId, (workspace) => workspace.directory);
  const repoOverview = useRpc(repoOverviewRpc);
  const commitFiles = useRpc(repoCommitFilesRpc);
  const submoduleFiles = useRpc(submoduleFilesRpc);
  const styles = useStyles(theme, layout.compact);

  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uncommittedOpen, setUncommittedOpen] = useState(true);
  const [expandedSha, setExpandedSha] = useState<string | null>(null);
  const [filesBySha, setFilesBySha] = useState<ReadonlyMap<string, SubmoduleChange[]>>(new Map());
  const [expandedSubs, setExpandedSubs] = useState<ReadonlySet<string>>(new Set());
  const [subFiles, setSubFiles] = useState<ReadonlyMap<string, SubmoduleChange[]>>(new Map());
  const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!directory) return;
    let cancelled = false;
    void repoOverview({ repoRoot: directory })
      .then((result) => {
        if (cancelled) return undefined;
        setOverview(result);
        setError(null);
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
  }, [repoOverview, directory, nonce]);

  const refresh = useCallback(() => {
    setFilesBySha(new Map());
    setSubFiles(new Map());
    setNonce((value) => value + 1);
  }, []);

  const toggleCommit = useCallback(
    (sha: string) => {
      if (expandedSha === sha) {
        setExpandedSha(null);
        return;
      }
      setExpandedSha(sha);
      if (!directory || filesBySha.has(sha)) return;
      void commitFiles({ repoRoot: directory, sha })
        .then((result) => {
          setFilesBySha((prev) => new Map(prev).set(sha, result.files));
          return undefined;
        })
        .catch(() => {});
    },
    [expandedSha, directory, filesBySha, commitFiles],
  );

  const toggleSub = useCallback(
    (sha: string | null, subPath: string) => {
      const key = subKey(sha, subPath);
      setExpandedSubs((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      if (!directory || subFiles.has(key)) return;
      void submoduleFiles({
        repoRoot: directory,
        path: subPath,
        mode: sha ? "commit" : "worktree",
        sha: sha ?? undefined,
      })
        .then((result) => {
          setSubFiles((prev) => new Map(prev).set(key, result.files));
          return undefined;
        })
        .catch(() => {});
    },
    [directory, subFiles, submoduleFiles],
  );

  const selectFile = useCallback((selected: SelectedFile) => setSelectedFile(selected), []);
  const closeDiff = useCallback(() => setSelectedFile(null), []);
  const toggleUncommitted = useCallback(() => setUncommittedOpen((v) => !v), []);

  const submodulePathSet = useMemo(() => new Set(overview?.submodulePaths ?? []), [overview]);

  let content = <Text style={styles.mutedText}>正在加载…</Text>;
  if (!directory) {
    content = <Text style={styles.mutedText}>workspace 不可用</Text>;
  } else if (error) {
    content = (
      <View style={styles.emptyPane}>
        <Text accessibilityRole="alert" style={styles.errorText}>
          {error}
        </Text>
        <Pressable accessibilityRole="button" onPress={refresh}>
          <Text style={styles.retryText}>重试</Text>
        </Pressable>
      </View>
    );
  } else if (!overview) {
    content = <Text style={styles.mutedText}>正在加载…</Text>;
  } else {
    const header = `${overview.branch ?? "detached"} · ${overview.commits.length} 个提交`;
    const listPane = (
      <View style={layout.compact ? styles.leftPaneCompact : styles.leftPane}>
        <View style={styles.paneHeader}>
          <Text style={styles.paneHeaderText}>{header}</Text>
          <Pressable accessibilityRole="button" onPress={refresh} style={styles.refreshButton}>
            <Text style={styles.refreshText}>刷新</Text>
          </Pressable>
        </View>
        <ScrollView style={styles.listFlex} contentContainerStyle={styles.listContent}>
          <Pressable
            accessibilityRole="button"
            onPress={toggleUncommitted}
            style={styles.sectionRow}
          >
            <Text style={styles.chevron}>{uncommittedOpen ? "▾" : "▸"}</Text>
            <Text style={styles.sectionTitle}>未提交的变更</Text>
            <Text style={styles.sectionCount}>{overview.changes.length} 个变更</Text>
          </Pressable>
          {uncommittedOpen ? (
            <View style={styles.fileList}>
              {overview.changes.length === 0 ? (
                <Text style={styles.mutedText}>无变更</Text>
              ) : (
                <RepoFiles
                  sha={null}
                  files={overview.changes}
                  submodulePaths={submodulePathSet}
                  expandedSubs={expandedSubs}
                  subFiles={subFiles}
                  selectedFile={selectedFile}
                  onSelectFile={selectFile}
                  onToggleSub={toggleSub}
                  styles={styles}
                />
              )}
            </View>
          ) : null}
          {overview.commits.map((commit) => (
            <CommitRow
              key={commit.sha}
              commit={commit}
              expanded={expandedSha === commit.sha}
              files={filesBySha.get(commit.sha) ?? null}
              submodulePaths={submodulePathSet}
              expandedSubs={expandedSubs}
              subFiles={subFiles}
              selectedFile={selectedFile}
              onToggle={toggleCommit}
              onSelectFile={selectFile}
              onToggleSub={toggleSub}
              styles={styles}
            />
          ))}
        </ScrollView>
      </View>
    );

    let diffPane = null;
    if (selectedFile) {
      diffPane = (
        <DiffPane
          repoRoot={directory}
          selected={selectedFile}
          onClose={closeDiff}
          styles={styles}
        />
      );
    } else if (!layout.compact) {
      diffPane = (
        <View style={styles.emptyPane}>
          <Text style={styles.mutedText}>选择文件查看差异</Text>
        </View>
      );
    }

    content = (
      <View style={layout.compact ? styles.bodyCompact : styles.body}>
        {listPane}
        {diffPane}
      </View>
    );
  }

  return <View style={styles.screen}>{content}</View>;
}
