import type { PluginClientContext } from "@getpaseo/plugin/client";
import { KanbanSurface } from "./client/kanban";

export default function contribute(client: PluginClientContext) {
  client.addSurface("kanban", KanbanSurface);
  client.addSidebarItem({
    id: "kanban",
    title: "看板",
    icon: "SquareKanban",
    surface: "kanban",
  });
  client.addCommandCenterItem({
    id: "open-kanban",
    title: "打开看板",
    icon: "SquareKanban",
    context: "global",
    onSelect({ openSurface }) {
      openSurface("kanban");
    },
  });
  return () => {};
}
