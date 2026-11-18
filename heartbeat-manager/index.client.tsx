import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { HeartbeatsScreen } from "./client/heartbeats-screen";
import { contributeHeartbeatPills } from "./client/heartbeat-pill";

const SCREEN_ID = "heartbeat-manager";

function HeartbeatSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="HeartPulse"
      label="心跳"
      active={currentScreen?.screenId === SCREEN_ID}
      onPress={() => openScreen({ screenId: SCREEN_ID })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  const removeScreen = client.addScreen({
    id: SCREEN_ID,
    title: "心跳管理",
    Component: HeartbeatsScreen,
  });
  const removeSidebar = client.addSidebarHeaderItem({
    id: SCREEN_ID,
    title: "心跳",
    Component: HeartbeatSidebarItem,
  });
  const removeCommand = client.addCommandCenterItem({
    id: "open-heartbeats",
    title: "打开心跳管理",
    icon: "HeartPulse",
    keywords: ["heartbeat", "心跳", "schedule"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: SCREEN_ID });
    },
  });
  const removePills = contributeHeartbeatPills(client, () => client.openScreen({ screenId: SCREEN_ID }));
  return () => {
    removePills();
    removeCommand();
    removeSidebar();
    removeScreen();
  };
}