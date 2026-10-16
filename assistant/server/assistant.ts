import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  PaseoAgent,
  PaseoApi,
  PaseoAgentConfig,
  PaseoWorkspace,
  PaseoWorkspaceHandle,
} from "@getpaseo/client";
import type {
  AssistantRef,
  DispatchAssistantInput,
  DispatchResult,
} from "../shared/assistant";

const ASSISTANT_TITLE = "助理";

interface AssistantAgent {
  id: string;
  title: string | null;
}

/**
 * 会话固定在 `$PASEO_HOME/default`，默认即 `~/.paseo/default`。
 * 它不属于任何代码项目：Paseo 会为这个目录注册一个内置项目，但会话本身与用户的仓库无关。
 */
export function assistantDirectory(): string {
  const configured = process.env.PASEO_HOME?.trim();
  const home =
    configured && configured.length > 0 ? configured : path.join(os.homedir(), ".paseo");
  return path.join(home, "default");
}

async function openAssistantWorkspace(paseo: PaseoApi): Promise<PaseoWorkspaceHandle> {
  const directory = assistantDirectory();
  await mkdir(directory, { recursive: true });
  const workspace = await paseo.workspaces.open(directory);
  // 首次创建时给一个可读的名字，已存在则不动用户可能自定义过的标题。
  const current = workspace.current();
  if (current && !current.title) {
    await workspace.setTitle(ASSISTANT_TITLE).catch(() => {});
  }
  return workspace;
}

async function listWorkspaceAgents(
  paseo: PaseoApi,
  workspaceId: string,
): Promise<AssistantAgent[]> {
  const result = await paseo.agents.list({ page: { limit: 200 } });
  return result.entries
    .map((entry) => entry.agent)
    .filter((agent) => agent.workspaceId === workspaceId && !agent.archivedAt)
    .map((agent) => ({ id: agent.id, title: agent.title ?? null }));
}

function pickExistingAgent(agents: ReadonlyArray<AssistantAgent>): AssistantAgent | null {
  if (agents.length === 0) return null;
  return agents.find((agent) => agent.title === ASSISTANT_TITLE) ?? agents[0] ?? null;
}

async function resolveAgentConfig(paseo: PaseoApi): Promise<PaseoAgentConfig> {
  const { config } = await paseo.config.get();
  const profiles = config.agentProfiles ?? [];
  const profile = profiles.find(
    (entry) => entry.provider.trim().length > 0 && (entry.model ?? "").trim().length > 0,
  );
  if (!profile) {
    throw new Error(
      "未找到可用的 Agent Profile（需要 provider 和 model）。请先在 Paseo 设置里配置一个 Agent Profile，再点击「助理」。",
    );
  }
  const model = (profile.model ?? "").trim();
  return {
    provider: `${profile.provider.trim()}/${model}`,
    ...(profile.modeId ? { modeId: profile.modeId } : {}),
    ...(profile.thinkingOptionId ? { thinkingOptionId: profile.thinkingOptionId } : {}),
    ...(profile.featureValues ? { featureValues: profile.featureValues } : {}),
  };
}

async function createAssistantAgent(
  paseo: PaseoApi,
  workspace: PaseoWorkspaceHandle,
): Promise<string> {
  const handle = await workspace.agents.create({
    config: await resolveAgentConfig(paseo),
    title: ASSISTANT_TITLE,
  });
  return handle.id;
}

/** 复用 `~/.paseo/default` 下唯一的会话；不存在时才创建。 */
export async function ensureAssistant(paseo: PaseoApi): Promise<AssistantRef> {
  const workspace = await openAssistantWorkspace(paseo);
  const existing = pickExistingAgent(await listWorkspaceAgents(paseo, workspace.id));
  if (existing) {
    return { agentId: existing.id, workspaceId: workspace.id, created: false };
  }
  const agentId = await createAssistantAgent(paseo, workspace);
  return { agentId, workspaceId: workspace.id, created: true };
}

/** 归档当前会话并新建一个，用于会话过大或想重开时。 */
export async function resetAssistant(paseo: PaseoApi): Promise<AssistantRef> {
  const workspace = await openAssistantWorkspace(paseo);
  const existing = await listWorkspaceAgents(paseo, workspace.id);
  for (const agent of existing) {
    await paseo.agents.ref(agent.id).archive().catch(() => {});
  }
  const agentId = await createAssistantAgent(paseo, workspace);
  return { agentId, workspaceId: workspace.id, created: true };
}

function activityTime(agent: PaseoAgent): number {
  const raw = agent.lastUserMessageAt ?? agent.updatedAt;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pickAgent(pool: readonly PaseoAgent[], excludeAgentId?: string): PaseoAgent | null {
  const candidates = pool.length > 1 && excludeAgentId
    ? pool.filter((agent) => agent.id !== excludeAgentId)
    : pool;
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => activityTime(b) - activityTime(a))[0] ?? null;
}

/** 自动挑选：优先“最近有活动”的 workspace；并列/无从判断时取第一个。 */
function pickWorkspace(
  workspaces: readonly PaseoWorkspace[],
  agents: readonly PaseoAgent[],
  excludeWorkspaceId?: string,
): PaseoWorkspace {
  const withAgents = workspaces.filter((workspace) =>
    agents.some((agent) => agent.workspaceId === workspace.id),
  );
  if (withAgents.length === 0) {
    throw new Error("没有可用的 workspace（至少需要一个带 agent 的 workspace）。");
  }
  const candidates =
    withAgents.length > 1 && excludeWorkspaceId
      ? withAgents.filter((workspace) => workspace.id !== excludeWorkspaceId)
      : withAgents;
  const pool = candidates.length > 0 ? candidates : withAgents;
  const latest = (workspace: PaseoWorkspace): number =>
    agents
      .filter((agent) => agent.workspaceId === workspace.id)
      .reduce((max, agent) => Math.max(max, activityTime(agent)), 0);
  return [...pool].sort((a, b) => latest(b) - latest(a))[0] ?? pool[0]!;
}

/**
 * `/send` 的实现：自动（或指定）挑一个 workspace -> 在该 workspace 的未归档 agent 里挑一个 -> 发送。
 * agent 挑选规则：最近有活动(lastUserMessageAt / updatedAt)的优先；并列时取第一个。
 */
export async function dispatchToWorkspace(
  paseo: PaseoApi,
  input: DispatchAssistantInput,
): Promise<DispatchResult> {
  const workspaces = (await paseo.workspaces.list({ page: { limit: 200 } })).entries;
  const agents = (await paseo.agents.list({ page: { limit: 200 } })).entries
    .map((entry) => entry.agent)
    .filter((agent) => !agent.archivedAt);

  const workspace = pickWorkspace(workspaces, agents, input.excludeWorkspaceId);
  const text = input.args.trim();

  const inWorkspace = agents.filter((agent) => agent.workspaceId === workspace.id);
  if (inWorkspace.length === 0) {
    throw new Error(`workspace「${workspace.name}」里没有可用的 agent。`);
  }
  const chosen = pickAgent(inWorkspace, input.excludeAgentId);
  if (!chosen) {
    throw new Error(`workspace「${workspace.name}」里没有其它可用的 agent。`);
  }

  await paseo.agents.ref(chosen.id).send(text);

  return {
    agentId: chosen.id,
    agentTitle: chosen.title ?? null,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    agentCount: inWorkspace.length,
  };
}
