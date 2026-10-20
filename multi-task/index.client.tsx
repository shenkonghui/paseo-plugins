import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { MultiTaskScreen } from "./client/multi-task";
import { MultiTaskSettings } from "./client/multi-task-settings";
import { registerGlobalShortcut } from "./client/shortcut";

const SCREEN_ID = "multi-task";
const SETTINGS_ID = "display";

function MultiTaskSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="LayoutGrid"
      label="多任务"
      active={currentScreen?.screenId === SCREEN_ID}
      onPress={() => openScreen({ screenId: SCREEN_ID })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  // 左侧栏顶部（Workspaces 分组上方）的「多任务」入口：打开多任务窗口屏幕。
  client.addScreen({ id: SCREEN_ID, title: "多任务", Component: MultiTaskScreen });
  client.addSidebarHeaderItem({
    id: SCREEN_ID,
    title: "多任务",
    Component: MultiTaskSidebarItem,
  });
  client.addSettingsScreen({
    id: SETTINGS_ID,
    title: "多任务",
    icon: "LayoutGrid",
    Component: MultiTaskSettings,
  });

  client.addCommandCenterItem({
    id: "open-multi-task",
    title: "打开多任务窗口（⌘⇧M）",
    icon: "LayoutGrid",
    keywords: ["multi-task", "多任务", "会话"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: SCREEN_ID });
    },
  });
  client.addCommandCenterItem({
    id: "open-multi-task-settings",
    title: "多任务设置",
    icon: "Settings",
    keywords: ["multi-task", "多任务", "设置", "toolbar", "工具栏"],
    context: "global",
    onSelect({ openSettings }) {
      openSettings(SETTINGS_ID);
    },
  });

  // 全局快捷键 ⌘⇧M / Ctrl+Shift+M：直接切到多任务窗口。
  const unregisterShortcut = registerGlobalShortcut(() => {
    client.openScreen({ screenId: SCREEN_ID });
  });

  return () => {
    unregisterShortcut();
  };
}
