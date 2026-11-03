import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { PaseoAgentHandle, PaseoApi } from "@getpaseo/client";
import type {
  PluginHookAgent,
  PluginHookContext,
  PluginLifecycleEvents,
  PluginTurnOutcome,
} from "@getpaseo/plugin/server";
import type { InjectorValues } from "../shared/settings";
import { providerAllowed } from "./inject";
import { resolveInheritedConfig } from "./subagent-tools";

/**
 * 自动标题：agent 每完成一轮，按间隔创建一次性「标题助手」agent，
 * 由它调用内置 update_agent 改名；workspace 标题由插件直接写入。
 * 插件本身没有改 agent 标题的 API，update_agent 也只能由模型调用，所以走助手。
 */

const HOUR_MS = 3_600_000;
/** 标题看最近 5 轮对话：用户消息 + 助手回复；工具调用、思考、命令输出都不进 prompt。 */
const DIGEST_TURNS = 5;
const DIGEST_MESSAGE_CHARS = 600;
const DIGEST_MAX_CHARS = 4_000;
/** 分页取时间线，直到凑够 5 轮；工具调用多的会话要翻更早的页。 */
const DIGEST_FETCH_LIMITS = [80, 240, 600] as const;
const MAX_TITLE_CHARS = 30;
const PROVISIONAL_TITLE_CHARS = 60;
/** 每个 workspace 保留多少个插件写过的标题，用于区分手动改名与多 agent 覆盖 */
const MAX_WRITTEN_TITLES = 20;
const HELPER_TITLE = "自动标题";

type AgentTitleState = {
  /** 已完成的回合数 */
  turns: number;
  /** 上次触发标题助手的时间（调度时刻，避免助手运行期间重复触发） */
  lastRunAt: number | null;
  /** 上次自动标题运行后的 agent 标题，用于识别用户手动改名 */
  lastTitle: string | null;
  /** 用户手动改过 agent 标题，永久跳过 */
  manual: boolean;
};

/**
 * workspace 标题状态按 workspace（而不是按 agent）存：一个 workspace 常被多个
 * agent 共用，按 agent 存基准会把别的 agent 写的标题当成「用户手动改名」。
 */
type WorkspaceTitleState = {
  /** 插件最后写入的标题 */
  lastTitle: string | null;
  /** 插件历史上写过的标题，用于区分「用户改名」与「另一个 agent 同步写的」 */
  written: string[];
  /** 用户手动改过标题，永久跳过 */
  manual: boolean;
};

type PendingHelper = {
  agentId: string;
  workspaceId: string | null;
  /** 助手运行前的标题，用于判断助手是否真的改了名 */
  beforeTitle: string | null;
  createdAt: number;
};

type AutoTitleState = {
  agents: Record<string, AgentTitleState>;
  workspaces: Record<string, WorkspaceTitleState>;
  helpers: Record<string, PendingHelper>;
};

type TimelineItem = { type: string; text?: string };
type TimelineEntry = { item: TimelineItem; turnId?: string };

type PermissionRequest = PluginLifecycleEvents["agent.permission_requested"]["request"];

type DigestMessage = { role: "user" | "assistant"; text: string };

function log(message: string): void {
  console.warn(`[agent-injector] ${message}`);
}

function statePath(): string {
  const home = process.env.PASEO_HOME?.trim() || join(homedir(), ".paseo");
  return join(home, "plugin-data", "agent-injector", "auto-title.json");
}

let cache: AutoTitleState | null = null;
/** 上次读盘时的 mtime；文件被外部改动时必须失效，否则会把内存里的旧状态写回去。 */
let cacheMtimeMs: number | null = null;

function fileMtimeMs(): number | null {
  try {
    return statSync(statePath()).mtimeMs;
  } catch {
    return null;
  }
}

function emptyEntry(): AgentTitleState {
  return {
    turns: 0,
    lastRunAt: null,
    lastTitle: null,
    manual: false,
  };
}

function emptyWorkspaceEntry(): WorkspaceTitleState {
  return { lastTitle: null, written: [], manual: false };
}

function normalizeEntry(input: Partial<AgentTitleState> | undefined): AgentTitleState {
  return {
    turns: typeof input?.turns === "number" ? input.turns : 0,
    lastRunAt: typeof input?.lastRunAt === "number" ? input.lastRunAt : null,
    lastTitle: typeof input?.lastTitle === "string" ? input.lastTitle : null,
    manual: input?.manual === true,
  };
}

function normalizeWorkspaceEntry(
  input: Partial<WorkspaceTitleState> | undefined,
): WorkspaceTitleState {
  const written = Array.isArray(input?.written)
    ? input.written.filter((name): name is string => typeof name === "string")
    : [];
  return {
    lastTitle: typeof input?.lastTitle === "string" ? input.lastTitle : null,
    written,
    manual: input?.manual === true,
  };
}

function load(): AutoTitleState {
  const mtime = fileMtimeMs();
  if (cache && cacheMtimeMs === mtime) return cache;
  try {
    const parsed = JSON.parse(readFileSync(statePath(), "utf8")) as Partial<AutoTitleState>;
    const agents: Record<string, AgentTitleState> = {};
    for (const [id, entry] of Object.entries(parsed.agents ?? {})) {
      agents[id] = normalizeEntry(entry as Partial<AgentTitleState>);
    }
    const workspaces: Record<string, WorkspaceTitleState> = {};
    for (const [id, entry] of Object.entries(parsed.workspaces ?? {})) {
      workspaces[id] = normalizeWorkspaceEntry(entry as Partial<WorkspaceTitleState>);
    }
    cache = {
      agents,
      workspaces,
      helpers: parsed.helpers && typeof parsed.helpers === "object" ? parsed.helpers : {},
    };
  } catch {
    cache = { agents: {}, workspaces: {}, helpers: {} };
  }
  cacheMtimeMs = mtime;
  return cache;
}

function save(state: AutoTitleState): void {
  cache = state;
  try {
    const file = statePath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch {
    // 忽略：状态丢失最多让自动标题晚一点触发或重复触发一次
  }
  cacheMtimeMs = fileMtimeMs();
}

function getEntry(state: AutoTitleState, agentId: string): AgentTitleState {
  state.agents[agentId] ??= emptyEntry();
  return state.agents[agentId];
}

function getWorkspaceEntry(state: AutoTitleState, workspaceId: string): WorkspaceTitleState {
  state.workspaces[workspaceId] ??= emptyWorkspaceEntry();
  return state.workspaces[workspaceId];
}

function hasPendingHelper(state: AutoTitleState, agentId: string): boolean {
  return Object.values(state.helpers).some((helper) => helper.agentId === agentId);
}

/** 助手没跑完、进程重启或事件丢失时，避免 pending 永远占位。 */
function pruneStaleHelpers(state: AutoTitleState, now: number): void {
  for (const [id, helper] of Object.entries(state.helpers)) {
    if (now - helper.createdAt > HOUR_MS) delete state.helpers[id];
  }
}

/** 与 create-agent-title.ts 一致的初始标题推导：首条 prompt 第一个非空行截 60 字。 */
function deriveInitialTitle(prompt: string): string | null {
  const firstLine = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return null;
  const normalized = firstLine.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, PROVISIONAL_TITLE_CHARS).trim() || null : null;
}

function findFirstUserText(entries: readonly TimelineEntry[]): string | null {
  for (const entry of entries) {
    if (entry.item.type === "user_message" && typeof entry.item.text === "string") {
      const text = entry.item.text.trim();
      if (text) return text;
    }
  }
  return null;
}

/** 用户消息里常夹带粘贴的代码 / 日志；标题只需要意图，所以整块去掉。 */
function stripAttachedContent(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 只收用户消息与助手回复，按 turnId 归轮取最近 5 轮；工具调用、思考、命令输出一律不进标题语料。
 * 老宿主没有 turnId 时，按「一条用户消息开启一轮」兜底。
 */
function collectDigest(entries: readonly TimelineEntry[]): { messages: DigestMessage[]; turns: number } {
  const messages: { key: string; message: DigestMessage }[] = [];
  let fallbackTurn = 0;
  for (const entry of entries) {
    const item = entry.item;
    if (item.type !== "user_message" && item.type !== "assistant_message") continue;
    if (typeof item.text !== "string") continue;
    if (item.type === "user_message") fallbackTurn += 1;
    const text = stripAttachedContent(item.text);
    if (!text) continue;
    messages.push({
      key: entry.turnId ?? `turn-${fallbackTurn}`,
      message: {
        role: item.type === "user_message" ? "user" : "assistant",
        text: text.slice(0, DIGEST_MESSAGE_CHARS),
      },
    });
  }

  const kept: { key: string; message: DigestMessage }[] = [];
  let turns = 0;
  let current: string | null = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    if (!entry) break;
    if (entry.key !== current) {
      if (turns === DIGEST_TURNS) break;
      turns += 1;
      current = entry.key;
    }
    kept.unshift(entry);
  }

  const digest: DigestMessage[] = [];
  let retainedTurns = 0;
  let total = 0;
  let lastKey: string | null = null;
  for (let index = kept.length - 1; index >= 0; index -= 1) {
    const entry = kept[index];
    if (!entry) break;
    total += entry.message.text.length;
    if (total > DIGEST_MAX_CHARS) break;
    if (entry.key !== lastKey) {
      retainedTurns += 1;
      lastKey = entry.key;
    }
    digest.unshift(entry.message);
  }
  return { messages: digest, turns: retainedTurns };
}

interface TurnDigest {
  messages: DigestMessage[];
  /** 收进来的轮数，最多 5 轮。 */
  turns: number;
  /** 窗口内最早的一条用户消息；首次运行判手动改名时要用。 */
  firstUserText: string | null;
}

/** 不够 5 轮就翻更大的窗口；没有更早的历史就停。 */
async function loadDigest(agentHandle: PaseoAgentHandle): Promise<TurnDigest> {
  let digest: TurnDigest = { messages: [], turns: 0, firstUserText: null };
  for (const limit of DIGEST_FETCH_LIMITS) {
    const timeline = await agentHandle.timeline
      .refetch({ direction: "tail", limit })
      .catch(() => null);
    const entries = (timeline?.entries ?? []) as readonly TimelineEntry[];
    const collected = collectDigest(entries);
    digest = {
      messages: collected.messages,
      turns: collected.turns,
      firstUserText: findFirstUserText(entries),
    };
    if (digest.turns >= DIGEST_TURNS || (digest.turns > 0 && timeline?.hasOlder === false)) {
      break;
    }
  }
  return digest;
}

const PROJECT_CONFIG_FILE = "paseo.json";

/**
 * 标题风格提示词跟着仓库走：读仓库根目录 `paseo.json` 的
 * `metadataGeneration.title.instructions`，与 Paseo 自己生成 workspace 标题时用的是同一份配置。
 * 它是「整体替换」语义，所以直接顶替内置的要求行；读不到就用内置默认。
 */
function resolveTitleInstructions(cwd: string): string | null {
  const configRoot = findProjectConfigRoot(cwd);
  if (!configRoot) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(configRoot, PROJECT_CONFIG_FILE), "utf8"));
    const trimmed = readNestedString(parsed, ["metadataGeneration", "title", "instructions"])?.trim();
    return trimmed ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * 仓库根（含 `.git` 的目录；worktree 里 `.git` 是文件）优先，和 Paseo 的
 * resolveRepoRoot 口径一致；不在 git 仓库里时，退回到向上找到的最近一个 paseo.json。
 */
function findProjectConfigRoot(cwd: string): string | null {
  let dir = resolve(cwd);
  let nearest: string | null = null;
  for (;;) {
    if (nearest === null && exists(join(dir, PROJECT_CONFIG_FILE))) {
      nearest = dir;
    }
    if (exists(join(dir, ".git"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return nearest;
    }
    dir = parent;
  }
}

function exists(target: string): boolean {
  try {
    statSync(target);
    return true;
  } catch {
    return false;
  }
}

function readNestedString(value: unknown, keys: readonly string[]): string | null {
  let current: unknown = value;
  for (const key of keys) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : null;
}

function buildPrompt(input: {
  agentId: string;
  currentTitle: string | null;
  messages: readonly DigestMessage[];
  requirement?: string;
}): string {
  const requirement =
    input.requirement?.trim() ||
    `要求：中文，不超过 ${MAX_TITLE_CHARS} 个字；点出正在做的具体任务；不要引号、句号、emoji；现有标题已经准确时可以沿用。`;
  const lines = [
    "你是后台标题助手。根据这名 agent 最近几轮的用户需求与助手产出，为它拟一个简短标题。",
    requirement,
    `然后调用 paseo 的 update_agent 工具写入结果：agentId="${input.agentId}"，name="<标题>"。`,
    "只调用一次 update_agent，不要读取文件、不要执行其它命令；完成后直接回复 done。",
  ];
  if (input.currentTitle) lines.push(`当前标题：${input.currentTitle}`);
  lines.push("最近几轮对话：");
  for (const message of input.messages) {
    lines.push(`${message.role === "user" ? "用户" : "助手"}：${message.text}`);
  }
  return lines.join("\n");
}

/**
 * 判断标题是否被用户手动改过：
 * - 已有基准（lastTitle）时，当前标题与基准不一致即视为手动改名；
 * - 首次运行时，与首条 prompt 推导出的初始标题比较，不一致即视为手动改名。
 */
function isManuallyRenamed(
  entry: AgentTitleState,
  currentTitle: string | null,
  firstUserText: string | null,
): boolean {
  if (currentTitle === null) return false;
  if (entry.lastTitle !== null) return currentTitle !== entry.lastTitle;
  const provisional = firstUserText ? deriveInitialTitle(firstUserText) : null;
  return provisional !== null && currentTitle !== provisional;
}

function shouldRun(entry: AgentTitleState, values: InjectorValues, now: number): boolean {
  if (entry.turns === 1) return true;
  const interval = Math.max(1, values.autoTitleTurns);
  if (entry.turns % interval !== 0) return false;
  const waitMs = Math.max(0, values.autoTitleIntervalMinutes) * 60_000;
  return entry.lastRunAt === null || now - entry.lastRunAt >= waitMs;
}

async function finishHelper(
  paseo: PaseoApi,
  values: InjectorValues,
  helper: PendingHelper,
): Promise<void> {
  const agentHandle = paseo.agents.ref(helper.agentId);
  const snapshot = (await agentHandle.refresh().catch(() => null))?.agent;
  if (!snapshot) return;

  const state = load();
  const entry = getEntry(state, helper.agentId);
  const title = snapshot.title ?? null;
  if (title === null) {
    save(state);
    return;
  }
  entry.lastTitle = title;

  const changed = title !== helper.beforeTitle;
  if (changed && values.autoTitleWorkspace && helper.workspaceId) {
    const workspaceEntry = getWorkspaceEntry(state, helper.workspaceId);
    if (!workspaceEntry.manual) {
      const workspaceHandle = paseo.workspaces.ref(helper.workspaceId);
      try {
        const workspace = await workspaceHandle.refresh().catch(() => null);
        if (workspace) {
          const rawTitle = workspace.title ?? null;
          // 还没写过时无法区分 daemon 自动标题与用户标题，首次直接写入；
          // 写过之后，只有「不在插件写过历史里」的标题才算用户手动改名。
          const looksManual =
            workspaceEntry.written.length > 0 &&
            rawTitle !== null &&
            !workspaceEntry.written.includes(rawTitle);
          if (looksManual) {
            workspaceEntry.manual = true;
            log(`workspace ${helper.workspaceId} 的标题被手动修改，停止自动同步`);
          } else {
            await workspaceHandle.setTitle(title);
            workspaceEntry.lastTitle = title;
            workspaceEntry.written = [...workspaceEntry.written, title].slice(
              -MAX_WRITTEN_TITLES,
            );
          }
        }
      } catch (error) {
        log(
          `更新 workspace ${helper.workspaceId} 标题失败: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  save(state);
}

const UPDATE_AGENT_TOOL = "update_agent";

/** 助手只被要求调用 update_agent，用它判断某次权限请求是否属于正常流程。 */
function referencesUpdateAgent(request: PermissionRequest): boolean {
  const haystack = [
    request.name,
    request.title,
    JSON.stringify(request.input ?? {}),
    JSON.stringify(request.detail ?? {}),
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  return haystack.includes(UPDATE_AGENT_TOOL);
}

function pickActionId(
  request: PermissionRequest,
  behavior: "allow" | "deny",
): string | undefined {
  const actions = request.actions ?? [];
  return (
    actions.find((action) => action.behavior === behavior && action.id !== "allow_always") ??
    actions.find((action) => action.behavior === behavior)
  )?.id;
}

/**
 * 标题助手在部分 provider / 模式下会让 update_agent 走人工审批，助手会一直停在
 * permission 状态：本回合不会结束，插件也就拿不到 turn_ended，该 agent 的后续
 * 自动标题还会被 pending 占位挡住。这里自动放行 update_agent，其余请求一律拒绝。
 */
export async function handleHelperPermissionRequest(
  context: PluginHookContext,
  agent: PluginHookAgent,
  request: PermissionRequest,
): Promise<void> {
  const state = load();
  if (!state.helpers[agent.id]) return;

  const allowed = referencesUpdateAgent(request);
  const actionId = pickActionId(request, allowed ? "allow" : "deny");
  try {
    await context.paseo.agents.ref(agent.id).respondToPermission({
      requestId: request.id,
      response: allowed
        ? { behavior: "allow", ...(actionId ? { selectedActionId: actionId } : {}) }
        : {
            behavior: "deny",
            ...(actionId ? { selectedActionId: actionId } : {}),
            message: "标题助手只允许调用 update_agent",
          },
    });
    log(
      allowed
        ? `标题助手 ${agent.id} 的 update_agent 权限已自动放行`
        : `标题助手 ${agent.id} 请求了非 update_agent 权限（${request.title ?? request.name}），已拒绝`,
    );
  } catch (error) {
    log(
      `处理标题助手 ${agent.id} 的权限请求失败: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * agent.turn_ended 的统一入口：先处理标题助手自身的完成事件，再判断是否要为
 * 当前 agent 调度一次标题助手。所有失败只记日志，不影响主流程。
 */
export async function handleAutoTitleTurnEnded(
  context: PluginHookContext,
  values: InjectorValues,
  agent: PluginHookAgent,
  outcome: PluginTurnOutcome,
): Promise<void> {
  if (!values.enabled) return;

  const state = load();
  const helper = state.helpers[agent.id];
  if (helper) {
    delete state.helpers[agent.id];
    save(state);
    if (outcome.kind === "completed") await finishHelper(context.paseo, values, helper);
    else log(`标题助手 ${agent.id} 未正常完成（${outcome.kind}），本次跳过`);
    return;
  }

  if (outcome.kind !== "completed") return;
  // 子代理（含标题助手）不参与自动标题，避免递归
  if (agent.parentAgentId) return;
  if (!values.autoTitleEnabled) return;
  if (!providerAllowed(values.providers, agent.provider)) return;

  const now = Date.now();
  pruneStaleHelpers(state, now);
  const entry = getEntry(state, agent.id);
  entry.turns += 1;
  if (entry.manual || hasPendingHelper(state, agent.id) || !shouldRun(entry, values, now)) {
    save(state);
    return;
  }

  const agentHandle = context.paseo.agents.ref(agent.id);
  const snapshot = (await agentHandle.refresh().catch(() => null))?.agent;
  if (!snapshot || snapshot.internal === true || snapshot.archivedAt) {
    save(state);
    return;
  }

  const digest = await loadDigest(agentHandle);
  if (digest.messages.length === 0) {
    save(state);
    return;
  }

  const currentTitle = snapshot.title ?? null;
  if (isManuallyRenamed(entry, currentTitle, digest.firstUserText)) {
    entry.manual = true;
    save(state);
    log(`agent ${agent.id} 的标题被手动修改，停止自动标题`);
    return;
  }

  entry.lastRunAt = now;
  try {
    const config = await resolveInheritedConfig(context.paseo, snapshot);
    const helperAgent = await context.paseo.agents.create({
      cwd: snapshot.cwd,
      parent: agent.id,
      title: HELPER_TITLE,
      prompt: buildPrompt({
        agentId: agent.id,
        currentTitle,
        messages: digest.messages,
        requirement: resolveTitleInstructions(snapshot.cwd) ?? undefined,
      }),
      config,
      autoArchive: true,
    });
    state.helpers[helperAgent.id] = {
      agentId: agent.id,
      workspaceId: snapshot.workspaceId ?? null,
      beforeTitle: currentTitle,
      createdAt: now,
    };
  } catch (error) {
    log(
      `为 agent ${agent.id} 创建标题助手失败: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  save(state);
}
