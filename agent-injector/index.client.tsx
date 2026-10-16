import type { PluginClientContext } from "@getpaseo/plugin/client";
import { InjectorSidebarItem } from "./client/sidebar-item";
import { InjectorSettingsScreen } from "./client/settings-screen";

export default function contributeClient(client: PluginClientContext) {
  // 左侧菜单栏入口（render 在 Workspaces 上方的 sidebar header）
  client.addScreen({ id: "injector", title: "Agent 注入", Component: InjectorSettingsScreen });
  client.addSidebarHeaderItem({
    id: "injector",
    title: "Agent 注入",
    Component: InjectorSidebarItem,
  });

  // Settings → Plugins 里的设置界面
  client.addSettingsScreen({
    id: "injector",
    title: "Agent 注入",
    icon: "Wand2",
    Component: InjectorSettingsScreen,
  });

  client.addCommandCenterItem({
    id: "injector-settings",
    title: "配置全局 agent 注入",
    icon: "Wand2",
    context: "global",
    onSelect({ openSettings }) {
      openSettings("injector");
    },
  });

  return () => {};
}
