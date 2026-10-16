import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";

/** 左侧菜单栏入口，渲染在 Workspaces 上方（sidebar header）。 */
export function InjectorSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Wand2"
      label="Agent 注入"
      active={currentScreen?.screenId === "injector"}
      onPress={() => openScreen({ screenId: "injector" })}
    />
  );
}
