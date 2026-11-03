import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  useSettings,
  type PluginSurfaceProps,
  type SettingsState,
} from "@getpaseo/plugin/client";
import {
  Icon,
  ScrollView,
  SettingsAction,
  SettingsCard,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
  TextInput,
} from "@getpaseo/plugin/client/ui";
import {
  injectorSettings,
  mcpServersSchema,
  unwrapMcpServers,
  type InjectorValues,
} from "../shared/settings";
import { BuiltinToolsSection } from "./builtin-tools";
import { SubagentQueueEditor } from "./subagent-queue";

type ReadySettings = Extract<SettingsState<typeof injectorSettings.schema>, { status: "ready" }>;

const styles = StyleSheet.create({
  /** 与 SettingsRow 的行内边距对齐（16px），否则自定义控件会贴住卡片左边缘。 */
  row: { paddingHorizontal: 16, paddingVertical: 12 },
  field: { gap: 8 },
  label: { fontSize: 14, lineHeight: 20 },
  hint: { fontSize: 12, lineHeight: 17 },
  input: {
    minHeight: 88,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13,
    lineHeight: 19,
    textAlignVertical: "top",
  },
  inputSingle: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
  },
  message: { fontSize: 12, lineHeight: 17 },
  messageRow: { paddingHorizontal: 16, paddingBottom: 12 },
  screen: { flex: 1 },
  screenContent: { padding: 16, paddingBottom: 32 },
  split: { flex: 1, flexDirection: "row" },
  nav: {
    width: 168,
    borderRightWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 8,
    gap: 2,
  },
  navItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
  },
  navLabel: { fontSize: 13, lineHeight: 18 },
  splitContent: { flex: 1 },
  saveBar: { borderTopWidth: 1, paddingHorizontal: 16, paddingVertical: 10 },
});

function TextArea(props: {
  label: string;
  hint?: string;
  value: string;
  placeholder?: string;
  editable: boolean;
  onChangeText(text: string): void;
  theme: PluginSurfaceProps["theme"];
}) {
  const { theme, label, hint, value, placeholder, editable, onChangeText } = props;
  const inputStyle = useMemo(
    () => [
      styles.input,
      {
        color: theme.colors.foreground,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
        opacity: editable ? 1 : 0.55,
      },
    ],
    [theme, editable],
  );
  return (
    <View style={styles.row}>
      <View style={styles.field}>
        <Text style={[styles.label, { color: theme.colors.foreground }]}>{label}</Text>
        {hint ? (
          <Text style={[styles.hint, { color: theme.colors.foregroundMuted }]}>{hint}</Text>
        ) : null}
        <TextInput
          accessibilityLabel={label}
          multiline
          value={value}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.foregroundMuted}
          editable={editable}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          onChangeText={onChangeText}
          style={inputStyle}
        />
      </View>
    </View>
  );
}

function NumberField(props: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  editable: boolean;
  onChange(value: number): void;
  theme: PluginSurfaceProps["theme"];
}) {
  const { label, hint, value, min, max, editable, onChange, theme } = props;
  const [text, setText] = useState(String(value));
  // 外部值变化（撤销 / 其他客户端保存）时同步输入框，但不打断正在输入的内容。
  useEffect(() => {
    setText((current) => (Number.parseInt(current, 10) === value ? current : String(value)));
  }, [value]);
  const inputStyle = useMemo(
    () => [
      styles.inputSingle,
      {
        color: theme.colors.foreground,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
        opacity: editable ? 1 : 0.55,
      },
    ],
    [theme, editable],
  );
  return (
    <View style={styles.row}>
      <View style={styles.field}>
        <Text style={[styles.label, { color: theme.colors.foreground }]}>{label}</Text>
        {hint ? (
          <Text style={[styles.hint, { color: theme.colors.foregroundMuted }]}>{hint}</Text>
        ) : null}
        <TextInput
          accessibilityLabel={label}
          value={text}
          editable={editable}
          keyboardType="numeric"
          onChangeText={(next) => {
            setText(next);
            const parsed = Number.parseInt(next, 10);
            if (Number.isFinite(parsed)) onChange(Math.min(max, Math.max(min, parsed)));
          }}
          style={inputStyle}
        />
      </View>
    </View>
  );
}

function StatusMessage({
  text,
  tone = "muted",
  theme,
}: {
  text: string;
  tone?: "muted" | "danger";
  theme: PluginSurfaceProps["theme"];
}) {
  return (
    <View style={styles.messageRow}>
      <Text
        style={[
          styles.message,
          {
            color: tone === "danger" ? theme.colors.statusDanger : theme.colors.foregroundMuted,
          },
        ]}
      >
        {text}
      </Text>
    </View>
  );
}

type SectionId = "general" | "inject" | "subagent" | "autoTitle" | "builtin";

/** 宽屏全屏页的左侧分类导航；每个 tab 对应下方一个或多个 SettingsSection。 */
const SECTION_TABS: { id: SectionId; label: string; icon: string }[] = [
  { id: "general", label: "通用", icon: "SlidersHorizontal" },
  { id: "inject", label: "规则与 MCP", icon: "Syringe" },
  { id: "subagent", label: "子代理工具", icon: "Bot" },
  { id: "autoTitle", label: "自动标题", icon: "Type" },
  { id: "builtin", label: "内置工具", icon: "Wrench" },
];

function Editor({
  settings,
  theme,
  tabbed,
}: {
  settings: ReadySettings;
  theme: PluginSurfaceProps["theme"];
  /** true 时按左侧分类 tab 分页显示；false/缺省为整页堆叠（Settings → Plugins 嵌入页）。 */
  tabbed?: boolean;
}) {
  const [draft, setDraft] = useState(() => ({
    values: settings.values,
    revision: settings.revision,
  }));
  const lastRevision = useRef(settings.revision);

  // 外部（其他客户端 / 直接改文件）保存后，用最新持久化值覆盖草稿。
  useEffect(() => {
    if (lastRevision.current === settings.revision) return;
    lastRevision.current = settings.revision;
    setDraft({ values: settings.values, revision: settings.revision });
  }, [settings.revision, settings.values]);

  const update = useCallback(
    <K extends keyof InjectorValues>(key: K, value: InjectorValues[K]) => {
      setDraft((current) => ({ ...current, values: { ...current.values, [key]: value } }));
    },
    [],
  );

  const save = useCallback(async () => {
    if (await settings.save(draft.values, draft.revision)) {
      lastRevision.current = settings.revision;
    }
  }, [settings, draft]);

  const discard = useCallback(() => {
    setDraft({ values: settings.values, revision: settings.revision });
  }, [settings]);

  const mcpState = useMemo(() => {
    const raw = draft.values.mcpServersJson.trim();
    if (!raw) return { count: 0, error: null as string | null };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { count: 0, error: "不是合法 JSON" };
    }
    const result = mcpServersSchema.safeParse(unwrapMcpServers(parsed));
    if (!result.success) {
      const detail = result.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ");
      return { count: 0, error: detail };
    }
    return { count: Object.keys(result.data).length, error: null };
  }, [draft.values.mcpServersJson]);

  const disabled = settings.saving;

  const [tab, setTab] = useState<SectionId>("general");
  const show = useCallback((id: SectionId) => !tabbed || tab === id, [tabbed, tab]);

  const saveArea = (
    <>
      <SettingsCard>
        <SettingsAction
          label="保存全部改动"
          actionLabel={settings.saving ? "保存中…" : "保存"}
          disabled={disabled}
          onPress={save}
        />
        <SettingsAction
          label="放弃未保存的改动"
          actionLabel="还原"
          disabled={disabled}
          onPress={discard}
        />
      </SettingsCard>
      {settings.saveError ? (
        <StatusMessage text={settings.saveError} tone="danger" theme={theme} />
      ) : null}
    </>
  );

  const sections = (
    <>
      {show("general") ? (
        <>
      <SettingsSection title="总开关">
        <SettingsCard>
          <SettingsSwitch
            label="启用扩展"
            hint="关闭后不再注入全局规则、MCP server 与子代理工具"
            value={draft.values.enabled}
            disabled={disabled}
            onValueChange={(value) => update("enabled", value)}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="生效范围">
        <SettingsCard>
          <TextArea
            label="Provider 白名单"
            hint="留空表示对所有 provider 生效；多个用逗号或换行分隔"
            value={draft.values.providers}
            placeholder="codex, claude, pi"
            editable={!disabled}
            onChangeText={(text) => update("providers", text)}
            theme={theme}
          />
        </SettingsCard>
      </SettingsSection>
        </>
      ) : null}

      {show("inject") ? (
        <>
      <SettingsSection title="全局规则">
        <SettingsCard>
          <TextArea
            label="内联规则（markdown）"
            hint="写入新 agent 的 systemPrompt"
            value={draft.values.rules}
            placeholder="例如：始终用中文回复；改动前先跑测试。"
            editable={!disabled}
            onChangeText={(text) => update("rules", text)}
            theme={theme}
          />
          <SettingsSwitch
            label="规则放在 systemPrompt 最前面"
            hint="关闭时追加到末尾"
            value={draft.values.prependRules}
            disabled={disabled}
            onValueChange={(value) => update("prependRules", value)}
          />
          <TextArea
            label="规则文件"
            hint="每行一个路径，支持 ~；按顺序拼接"
            value={draft.values.ruleFiles}
            placeholder="~/.paseo/global-rules.md"
            editable={!disabled}
            onChangeText={(text) => update("ruleFiles", text)}
            theme={theme}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="MCP Servers">
        <SettingsCard>
          <TextArea
            label="MCP server 配置（JSON）"
            hint="可直接粘贴含 mcpServers 的片段，创建 agent 时合并进 mcpServers"
            value={draft.values.mcpServersJson}
            placeholder={'{\n  "company": { "type": "http", "url": "https://tools.example.com/mcp" }\n}'}
            editable={!disabled}
            onChangeText={(text) => update("mcpServersJson", text)}
            theme={theme}
          />
          <StatusMessage
            text={
              mcpState.error
                ? `配置错误：${mcpState.error}`
                : `已配置 ${mcpState.count} 个 MCP server`
            }
            tone={mcpState.error ? "danger" : "muted"}
            theme={theme}
          />
        </SettingsCard>
      </SettingsSection>
        </>
      ) : null}

      {show("subagent") ? (
      <SettingsSection
        title="子代理工具"
        info="会话打开时向模型注入 create_subagent，让 agent 自行派生子代理：默认继承父 agent 的配置，也可按模型队列选择。opencode provider 走 bridge，暂不暴露插件注入的工具。"
      >
        <SettingsCard>
          <SettingsSwitch
            label="启用子代理工具"
            hint="在 agent 会话打开时注入 create_subagent"
            value={draft.values.subagentEnabled}
            disabled={disabled || !draft.values.enabled}
            onValueChange={(value) => update("subagentEnabled", value)}
          />
          <SettingsSwitch
            label="create_subagent"
            hint="让 agent 自行派生子代理，默认继承自己的配置"
            value={draft.values.subagentCreateTool}
            disabled={disabled || !draft.values.enabled || !draft.values.subagentEnabled}
            onValueChange={(value) => update("subagentCreateTool", value)}
          />
          <SettingsSelect
            label="新建子代理的默认配置"
            hint="继承 = 复用父 agent 的 provider/model/mode/thinking；自定义 = 按下方队列（可拖动排序）取第一个可用项"
            value={draft.values.subagentConfigMode}
            options={[
              { label: "继承父 agent", value: "inherit" },
              { label: "自定义模型队列", value: "custom" },
            ]}
            disabled={disabled || !draft.values.enabled || !draft.values.subagentEnabled}
            onValueChange={(value) => update("subagentConfigMode", value)}
          />
          {draft.values.subagentConfigMode === "custom" ? (
            <>
              <SubagentQueueEditor
                value={draft.values.subagentModelQueue}
                editable={!disabled && draft.values.enabled && draft.values.subagentEnabled}
                theme={theme}
                onChange={(text) => update("subagentModelQueue", text)}
              />
              <NumberField
                label="失败重置时间（小时）"
                hint="队列项创建失败或子代理运行失败后暂时跳过，到期自动恢复；0 表示不跳过"
                value={draft.values.subagentFailureCooldownHours}
                min={0}
                max={720}
                editable={!disabled}
                onChange={(value) => update("subagentFailureCooldownHours", value)}
                theme={theme}
              />
            </>
          ) : (
            <StatusMessage
              text="当前继承父 agent；队列配置会保留但不生效。"
              theme={theme}
            />
          )}
          <StatusMessage
            text="工具在会话打开时注入；修改后对新建 agent 生效，已运行的 agent 需 reload 或重开。"
            theme={theme}
          />
        </SettingsCard>
      </SettingsSection>
      ) : null}

      {show("autoTitle") ? (
      <SettingsSection
        title="自动标题"
        info="agent 每完成一轮，按间隔创建一个一次性标题助手，读取最近 5 轮对话（不含工具调用）后调用 update_agent 改名。插件无法直接改 agent 标题，只能由助手完成；workspace 标题由插件直接写入。"
      >
        <SettingsCard>
          <SettingsSwitch
            label="根据对话自动更新 agent 标题"
            hint="首轮完成后触发一次，之后每 N 轮且间隔足够时才再次触发"
            value={draft.values.autoTitleEnabled}
            disabled={disabled || !draft.values.enabled}
            onValueChange={(value) => update("autoTitleEnabled", value)}
          />
          <NumberField
            label="触发间隔（轮）"
            hint="每完成多少轮检查一次；1 表示每轮都检查（仍受下方时间间隔限制）"
            value={draft.values.autoTitleTurns}
            min={1}
            max={100}
            editable={!disabled && draft.values.enabled && draft.values.autoTitleEnabled}
            onChange={(value) => update("autoTitleTurns", value)}
            theme={theme}
          />
          <NumberField
            label="最小间隔（分钟）"
            hint="两次自动标题之间的最短时间；0 表示不限制"
            value={draft.values.autoTitleIntervalMinutes}
            min={0}
            max={1440}
            editable={!disabled && draft.values.enabled && draft.values.autoTitleEnabled}
            onChange={(value) => update("autoTitleIntervalMinutes", value)}
            theme={theme}
          />
          <SettingsSwitch
            label="同步更新 workspace 标题"
            hint="用生成的标题改写所在 workspace；已手动改名过的 agent / workspace 不会被覆盖"
            value={draft.values.autoTitleWorkspace}
            disabled={disabled || !draft.values.enabled || !draft.values.autoTitleEnabled}
            onValueChange={(value) => update("autoTitleWorkspace", value)}
          />
          <StatusMessage
            text="标题要求读所在仓库根目录 paseo.json 的 metadataGeneration.title.instructions（与 Paseo 生成 workspace 标题用的是同一份配置），读不到时用内置默认：中文、不超过 30 字。"
            theme={theme}
          />
          <StatusMessage
            text="标题助手使用父 agent 的 provider/model 运行一轮，会产生额外调用；仅对顶层 agent 生效，子代理与助手自身不改名。"
            theme={theme}
          />
        </SettingsCard>
      </SettingsSection>
      ) : null}

      {show("builtin") ? <BuiltinToolsSection theme={theme} /> : null}
    </>
  );

  if (!tabbed) {
    return (
      <View>
        {sections}
        {saveArea}
      </View>
    );
  }

  return (
    <View style={styles.split}>
      <View style={[styles.nav, { borderRightColor: theme.colors.border }]}>
        {SECTION_TABS.map((item) => {
          const active = item.id === tab;
          const color = active ? theme.colors.foreground : theme.colors.foregroundMuted;
          return (
            <Pressable
              key={item.id}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              onPress={() => setTab(item.id)}
              style={[styles.navItem, active && { backgroundColor: theme.colors.surface2 }]}
            >
              <Icon name={item.icon} size={15} color={color} />
              <Text style={[styles.navLabel, { color }]}>{item.label}</Text>
            </Pressable>
          );
        })}
      </View>
      <View style={styles.splitContent}>
        <ScrollView style={styles.screen} contentContainerStyle={styles.screenContent}>
          {sections}
        </ScrollView>
        <View style={[styles.saveBar, { borderTopColor: theme.colors.border }]}>
          {saveArea}
        </View>
      </View>
    </View>
  );
}

export function InjectorSettingsScreen({
  theme,
  tabbed,
}: PluginSurfaceProps & { tabbed?: boolean }) {
  const settings = useSettings(injectorSettings);
  const mutedStyle = useMemo(() => ({ color: theme.colors.foregroundMuted }), [theme]);

  if (settings.status === "loading") return <Text style={mutedStyle}>加载中…</Text>;
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Agent 扩展">
        <SettingsCard>
          <View style={styles.row}>
            <Text style={[styles.message, mutedStyle]}>{settings.error}</Text>
          </View>
          <SettingsAction label="重新读取" actionLabel="重试" onPress={settings.reload} />
          {settings.status === "invalid" ? (
            <SettingsAction label="恢复默认配置" actionLabel="重置" onPress={settings.reset} />
          ) : null}
        </SettingsCard>
      </SettingsSection>
    );
  }
  return <Editor settings={settings} theme={theme} tabbed={tabbed} />;
}

/** 左侧菜单打开的全屏页：宿主不提供 padding 和滚动容器，这里自己补上。 */
export function InjectorScreen({ theme, layout, host }: PluginSurfaceProps) {
  // 紧凑布局（手机）空间不够，回退为整页滚动；宽屏用左侧分类 tab。
  if (layout.compact) {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.screenContent}>
        <InjectorSettingsScreen theme={theme} layout={layout} host={host} />
      </ScrollView>
    );
  }
  return (
    <View style={styles.screen}>
      <InjectorSettingsScreen theme={theme} layout={layout} host={host} tabbed />
    </View>
  );
}
