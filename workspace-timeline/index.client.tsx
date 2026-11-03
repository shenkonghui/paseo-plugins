import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { WorkspaceTimelineScreen } from "./client/timeline-screen";

const SCREEN_ID = "workspace-timeline";

function TimelineSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Clock"
      label="时间线"
      active={currentScreen?.screenId === SCREEN_ID}
      onPress={() => openScreen({ screenId: SCREEN_ID })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({
    id: SCREEN_ID,
    title: "Workspace 时间线",
    Component: WorkspaceTimelineScreen,
  });
  client.addSidebarHeaderItem({
    id: SCREEN_ID,
    title: "Workspace 时间线",
    Component: TimelineSidebarItem,
  });
  client.addCommandCenterItem({
    id: "open-workspace-timeline",
    title: "打开 Workspace 时间线",
    icon: "Clock",
    keywords: ["timeline", "workspace", "时间线"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: SCREEN_ID });
    },
  });
  return () => {};
}
