import type { PluginServerContext } from "@getpaseo/plugin/server";
import { multiTaskSettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  // 面板列表由客户端读写，宿主侧仅负责持久化存储。
  server.registerSettings(multiTaskSettings);
  return () => {};
}
