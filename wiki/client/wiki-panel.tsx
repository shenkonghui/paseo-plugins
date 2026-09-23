import { useQuery } from "@tanstack/react-query";
import { type PluginSurfaceProps, usePaseo, useRpc, useSettings } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { listFilesRpc, readFileRpc, wikiSources } from "../shared/wiki";
import { FileTree } from "./file-tree";
import { Markdown } from "./markdown";

interface WikiFile {
  directory: string;
  path: string;
  name: string;
}
const NO_FILES: WikiFile[] = [];
type Styles = ReturnType<typeof createStyles>;

function createStyles(theme: PluginSurfaceProps["theme"], compact: boolean) {
  return {
    screen: { flex: 1, backgroundColor: theme.colors.surface0 },
    picker: { padding: compact ? 8 : 16, maxWidth: 420 },
    list: { padding: compact ? 8 : 16 },
    row: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 6 },
    rowActive: { backgroundColor: theme.colors.surface2 },
    heading: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
      marginTop: 12,
      marginBottom: 4,
      paddingHorizontal: 12,
    },
    name: { color: theme.colors.foreground },
    detail: { color: theme.colors.foregroundMuted },
    detailPadded: { color: theme.colors.foregroundMuted, padding: 16 },
    listTop: { flex: 0, maxHeight: "40%" as const },
    listFull: { flex: 1 },
    body: { flex: 1, padding: compact ? 12 : 24 },
    content: { color: theme.colors.foreground },
  };
}

function FileList({
  files,
  pending,
  failed,
  selected,
  styles,
  onSelect,
}: {
  files: WikiFile[];
  pending: boolean;
  failed: boolean;
  selected: string | null;
  styles: Styles;
  onSelect: (path: string) => void;
}) {
  return (
    <ScrollView style={selected ? styles.listTop : styles.listFull}>
      <View style={styles.list}>
        <FileTree files={files} selected={selected} styles={styles} onSelect={onSelect} />
        {pending ? <Text style={styles.detail}>Loading files…</Text> : null}
        {failed ? <Text style={styles.detail}>Failed to list files</Text> : null}
      </View>
    </ScrollView>
  );
}

function FileContent({
  rootPath,
  path,
  styles,
  theme,
}: {
  rootPath: string;
  path: string;
  styles: Styles;
  theme: PluginSurfaceProps["theme"];
}) {
  const readFile = useRpc(readFileRpc);
  const fileQuery = useQuery({
    queryKey: ["wiki-file", rootPath, path],
    queryFn: () => readFile({ rootPath, path }),
  });
  const markdownTheme = useMemo(
    () => ({
      foreground: theme.colors.foreground,
      foregroundMuted: theme.colors.foregroundMuted,
      surface1: theme.colors.surface1,
      border: theme.colors.border,
    }),
    [theme],
  );
  return (
    <ScrollView style={styles.body}>
      {fileQuery.data ? (
        <Markdown text={fileQuery.data.content} theme={markdownTheme} />
      ) : (
        <Text style={styles.content}>{fileQuery.isPending ? "Loading…" : "Failed to load"}</Text>
      )}
      {fileQuery.data?.truncated ? (
        <Text style={styles.detail}>File truncated at 256 KB</Text>
      ) : null}
    </ScrollView>
  );
}

export function WikiSurface({ theme, layout }: PluginSurfaceProps) {
  const settings = useSettings(wikiSources);
  const paseo = usePaseo();
  const listFiles = useRpc(listFilesRpc);
  const [selected, setSelected] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);
  const onSelect = useCallback((path: string) => setSelected(path), []);

  const projectsQuery = useQuery({
    queryKey: ["wiki-projects"],
    queryFn: () => paseo.projects.list(),
  });
  const projects = useMemo(() => projectsQuery.data?.projects ?? [], [projectsQuery.data]);
  const configured = useMemo(
    () =>
      settings.status === "ready"
        ? projects.filter((p) => (settings.values.directories[p.projectId] ?? []).length > 0)
        : [],
    [settings, projects],
  );
  const project = configured.find((p) => p.projectId === projectId) ?? configured[0];
  const projectOptions = useMemo(
    () =>
      configured.map((p) => ({
        label: p.projectCustomName ?? p.projectDisplayName,
        value: p.projectId,
      })),
    [configured],
  );
  const selectProject = useCallback((value: string) => {
    setProjectId(value);
    setSelected(null);
  }, []);

  const directories =
    (settings.status === "ready" && project
      ? settings.values.directories[project.projectId]
      : undefined) ?? [];

  const filesQuery = useQuery({
    queryKey: ["wiki-files", project?.projectRootPath, directories],
    enabled: Boolean(project && directories.length > 0),
    queryFn: () => listFiles({ rootPath: project!.projectRootPath, directories }),
  });

  if (!project) {
    return (
      <View style={styles.screen}>
        <Text style={styles.detailPadded}>
          No wiki directories configured. Open Settings → Plugins → wiki → Sources to pick
          directories under a project root.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      {configured.length > 1 ? (
        <View style={styles.picker}>
          <SettingsSelect
            label="Project"
            value={project.projectId}
            options={projectOptions}
            onValueChange={selectProject}
          />
        </View>
      ) : null}
      <FileList
        files={filesQuery.data?.files ?? NO_FILES}
        pending={filesQuery.isPending}
        failed={filesQuery.isError}
        selected={selected}
        styles={styles}
        onSelect={onSelect}
      />
      {selected ? (
        <FileContent
          rootPath={project.projectRootPath}
          path={selected}
          styles={styles}
          theme={theme}
        />
      ) : null}
    </View>
  );
}
