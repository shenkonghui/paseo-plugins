import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listDirectories, listFiles, readFile } from "./server/wiki";
import { listDirectoriesRpc, listFilesRpc, readFileRpc, wikiSources } from "./shared/wiki";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(wikiSources);
  server.handle(listDirectoriesRpc, listDirectories);
  server.handle(listFilesRpc, listFiles);
  server.handle(readFileRpc, readFile);
  return () => {};
}
