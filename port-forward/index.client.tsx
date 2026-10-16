import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ForwardSurface } from "./client/forward-surface";

export default function contributeClient(client: PluginClientContext) {
  client.addSurface("port-forward", ForwardSurface);
  client.addSidebarItem({
    id: "port-forward",
    title: "端口转发",
    icon: "ArrowRightLeft",
    surface: "port-forward",
  });
  client.addCommandCenterItem({
    id: "open-port-forward",
    title: "端口转发：管理 daemon 主机的 TCP 转发规则",
    icon: "ArrowRightLeft",
    keywords: ["port", "forward", "隧道", "端口", "转发"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("port-forward");
    },
  });
  return () => {};
}
