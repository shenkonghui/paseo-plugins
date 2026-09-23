import type { PluginClientContext } from "@getpaseo/plugin/client";
import { WikiSurface } from "./client/wiki-panel";
import { WikiSettings } from "./client/wiki-settings";

export default function contribute(client: PluginClientContext) {
  client.addSurface("main", WikiSurface);
  client.addSidebarItem({
    id: "main",
    title: "Wiki",
    icon: "BookOpen",
    surface: "main",
  });
  client.addSettingsScreen({
    id: "sources",
    title: "Sources",
    icon: "FolderCog",
    Component: WikiSettings,
  });
  client.addCommandCenterItem({
    id: "configure-wiki",
    title: "Configure wiki sources",
    icon: "FolderCog",
    context: "global",
    onSelect({ openSettings }) {
      openSettings("sources");
    },
  });
  return () => {};
}
