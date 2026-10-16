import type { PluginClientContext } from "@getpaseo/plugin/client";
import { TokenUsageSurface } from "./client/token-usage-surface";

export default function contribute(client: PluginClientContext) {
  client.addSurface("token-usage", TokenUsageSurface);
  client.addSidebarItem({
    id: "token-usage",
    title: "Token 监控",
    icon: "BarChart3",
    surface: "token-usage",
  });
  client.addCommandCenterItem({
    id: "open-token-usage",
    title: "Token 监控：查看各 agent 的 token 用量与成本",
    icon: "BarChart3",
    keywords: ["token", "usage", "用量", "监控", "成本"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("token-usage");
    },
  });
  return () => {};
}
