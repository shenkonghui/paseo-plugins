import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SubmodulePanel } from "./client/submodules";
import { WorktreeSurface } from "./client/worktrees";

export default function contribute(client: PluginClientContext) {
  client.addSurface("worktrees", WorktreeSurface);
  client.addSidebarItem({
    id: "worktrees",
    title: "Worktrees",
    icon: "GitBranch",
    surface: "worktrees",
  });
  client.addWorkspacePanel({
    id: "submodules",
    title: "变更",
    icon: "FolderGit2",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: SubmodulePanel,
  });
  client.addCommandCenterItem({
    id: "open-worktrees",
    title: "打开 Worktrees",
    icon: "GitBranch",
    context: "global",
    onSelect({ openSurface }) {
      openSurface("worktrees");
    },
  });
  client.addCommandCenterItem({
    id: "open-submodules",
    title: "打开变更面板",
    icon: "FolderGit2",
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("submodules", { location: "explorer" });
    },
  });
  return () => {};
}
