import { useQuery } from "@tanstack/react-query";
import {
  type PluginSurfaceProps,
  type SettingsState,
  usePaseo,
  useRpc,
  useSettings,
} from "@getpaseo/plugin/client";
import { useCallback, useMemo, useState } from "react";
import { Text } from "react-native";
import {
  SettingsCard,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { listDirectoriesRpc, wikiSources } from "../shared/wiki";

type Sources = Extract<SettingsState<typeof wikiSources.schema>, { status: "ready" }>;

function DirectorySwitch({
  directory,
  checked,
  disabled,
  onToggle,
}: {
  directory: string;
  checked: boolean;
  disabled: boolean;
  onToggle: (directory: string, value: boolean) => void;
}) {
  const handleChange = useCallback(
    (value: boolean) => onToggle(directory, value),
    [onToggle, directory],
  );
  return (
    <SettingsSwitch
      label={directory}
      value={checked}
      disabled={disabled}
      onValueChange={handleChange}
    />
  );
}

function ProjectSources({
  projectId,
  rootPath,
  settings,
  style,
}: {
  projectId: string;
  rootPath: string;
  settings: Sources;
  style: { color: string };
}) {
  const listDirectories = useRpc(listDirectoriesRpc);
  const directoriesQuery = useQuery({
    queryKey: ["wiki-directories", rootPath],
    queryFn: () => listDirectories({ rootPath }),
  });
  const selected = settings.values.directories[projectId] ?? [];

  const toggle = useCallback(
    (directory: string, value: boolean) => {
      const current = settings.values.directories[projectId] ?? [];
      const next = value ? [...current, directory] : current.filter((d) => d !== directory);
      void settings.save(
        {
          directories: { ...settings.values.directories, [projectId]: next.sort() },
        },
        settings.revision,
      );
    },
    [settings, projectId],
  );

  if (directoriesQuery.isPending) return <Text style={style}>Scanning directories…</Text>;
  if (directoriesQuery.isError) return <Text style={style}>Failed to scan {rootPath}</Text>;
  if (directoriesQuery.data.directories.length === 0)
    return <Text style={style}>No directories with Markdown files under {rootPath}</Text>;
  return (
    <SettingsCard>
      {directoriesQuery.data.directories.map((directory) => (
        <DirectorySwitch
          key={directory}
          directory={directory}
          checked={selected.includes(directory)}
          disabled={settings.saving}
          onToggle={toggle}
        />
      ))}
    </SettingsCard>
  );
}

export function WikiSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(wikiSources);
  const paseo = usePaseo();
  const style = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  const [projectId, setProjectId] = useState<string | null>(null);

  const projectsQuery = useQuery({
    queryKey: ["wiki-projects"],
    queryFn: () => paseo.projects.list(),
  });
  const projects = useMemo(() => projectsQuery.data?.projects ?? [], [projectsQuery.data]);
  const project = projects.find((p) => p.projectId === projectId) ?? projects[0];
  const projectOptions = useMemo(
    () =>
      projects.map((p) => ({
        label: p.projectCustomName ?? p.projectDisplayName,
        value: p.projectId,
      })),
    [projects],
  );

  if (settings.status === "loading") return <Text style={style}>Loading settings…</Text>;
  if (settings.status !== "ready")
    return (
      <SettingsSection title="Sources">
        <Text style={style}>{settings.error}</Text>
      </SettingsSection>
    );

  return (
    <SettingsSection
      title="Sources"
      info="Markdown files inside the selected directories appear in the Wiki workspace panel."
    >
      <SettingsCard>
        <SettingsSelect
          label="Project"
          value={project?.projectId ?? ""}
          options={projectOptions}
          onValueChange={setProjectId}
        />
      </SettingsCard>
      {project ? (
        <ProjectSources
          projectId={project.projectId}
          rootPath={project.projectRootPath}
          settings={settings}
          style={style}
        />
      ) : (
        <Text style={style}>No projects on this host</Text>
      )}
      {settings.saveError ? (
        <Text accessibilityRole="alert" style={style}>
          {settings.saveError}
        </Text>
      ) : null}
    </SettingsSection>
  );
}
