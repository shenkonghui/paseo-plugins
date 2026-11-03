import type { PluginClientContext } from "@getpaseo/plugin/client";
import { DirWorkspaceSurface } from "./client/dir-workspace";

export default function contribute(client: PluginClientContext) {
  client.addSurface("dir-workspace", DirWorkspaceSurface);
  client.addSidebarItem({
    id: "dir-workspace",
    title: "新建自定义工作区",
    icon: "FolderOpen",
    surface: "dir-workspace",
  });
  client.addCommandCenterItem({
    id: "open-dir-workspace",
    title: "新建自定义工作区",
    icon: "FolderOpen",
    context: "global",
    onSelect({ openSurface }) {
      openSurface("dir-workspace");
    },
  });
  return () => {};
}
