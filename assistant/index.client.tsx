import type {
  PluginClientContext,
  PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { AssistantScreen } from "./client/assistant";
import { AssistantOutputPanel, OUTPUT_PANEL_ID } from "./client/output-panel";
import { setOutputTarget } from "./client/output-store";
import { dispatchAssistantRpc } from "./shared/assistant";

function AssistantSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Bot"
      active={currentScreen?.screenId === "assistant"}
      onPress={() => openScreen({ screenId: "assistant" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  // 左侧栏顶部「助理」入口：打开 $PASEO_HOME/default 下唯一的会话。
  client.addScreen({ id: "assistant", title: "助理", Component: AssistantScreen });
  client.addSidebarHeaderItem({
    id: "assistant",
    title: "助理",
    Component: AssistantSidebarItem,
  });

  // 右侧 Explorer 面板：实时显示被 /send 派发到的 agent 的输出。
  client.addWorkspacePanel({
    id: OUTPUT_PANEL_ID,
    title: "助理输出",
    icon: "Activity",
    context: "workspace",
    locations: ["explorer"],
    Component: AssistantOutputPanel,
  });

  // `/send [workspace] <消息>`：workspace 可省略，自动挑 workspace/agent 后直接发送。
  client.addSlashCommand({
    name: "send",
    description: "把消息派发到自动挑选的 workspace/agent，并在右侧显示执行输出",
    argumentHint: "<消息>",
    context: "agent",
    async onSubmit({ args, workspace, agent, rpc }) {
      const text = args.trim();
      if (text.length === 0) {
        throw new Error("用法：/send [workspace] <消息>");
      }
      const result = await rpc(dispatchAssistantRpc, {
        args: text,
        excludeWorkspaceId: workspace.id,
        excludeAgentId: agent.id,
      });
      setOutputTarget({
        agentId: result.agentId,
        agentTitle: result.agentTitle,
        workspaceId: result.workspaceId,
        workspaceName: result.workspaceName,
        dispatchedAt: Date.now(),
      });
      client.openPanel(OUTPUT_PANEL_ID, { workspaceId: workspace.id, location: "explorer" });
    },
  });

  return () => {};
}
