import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import {
  useSettings,
  type PluginSurfaceProps,
  type SettingsState,
} from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import {
  SettingsAction,
  SettingsCard,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { injectorSettings, mcpServersSchema, unwrapMcpServers, type InjectorValues } from "../shared/settings";

type ReadySettings = Extract<SettingsState<typeof injectorSettings.schema>, { status: "ready" }>;

const styles = StyleSheet.create({
  field: { gap: 6 },
  label: { fontSize: 13 },
  input: {
    minHeight: 96,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    textAlignVertical: "top",
  },
  message: { fontSize: 12 },
});

function TextArea(props: {
  label: string;
  value: string;
  placeholder?: string;
  editable: boolean;
  onChangeText(text: string): void;
  theme: PluginSurfaceProps["theme"];
}) {
  const { theme, label, value, placeholder, editable, onChangeText } = props;
  const inputStyle = useMemo(
    () => [styles.input, { color: theme.colors.foreground, borderColor: theme.colors.border }],
    [theme],
  );
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: theme.colors.foreground }]}>{label}</Text>
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
  );
}

function Editor({
  settings,
  theme,
}: {
  settings: ReadySettings;
  theme: PluginSurfaceProps["theme"];
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

  return (
    <View style={styles.field}>
      <SettingsSection title="总开关">
        <SettingsCard>
          <SettingsSwitch
            label="启用注入"
            value={draft.values.enabled}
            disabled={disabled}
            onValueChange={(value) => update("enabled", value)}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="生效范围">
        <SettingsCard>
          <TextArea
            label="Provider 白名单（留空 = 全部）"
            value={draft.values.providers}
            placeholder="codex, claude, pi"
            editable={!disabled}
            onChangeText={(text) => update("providers", text)}
            theme={theme}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="全局规则">
        <SettingsCard>
          <TextArea
            label="内联规则（markdown）"
            value={draft.values.rules}
            placeholder="例如：始终用中文回复；改动前先跑测试。"
            editable={!disabled}
            onChangeText={(text) => update("rules", text)}
            theme={theme}
          />
          <SettingsSwitch
            label="规则放在 systemPrompt 最前面"
            value={draft.values.prependRules}
            disabled={disabled}
            onValueChange={(value) => update("prependRules", value)}
          />
          <TextArea
            label="规则文件（每行一个，支持 ~）"
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
            label="MCP server 配置（JSON，可直接粘贴含 mcpServers 的片段）"
            value={draft.values.mcpServersJson}
            placeholder={'{\n  "company": { "type": "http", "url": "https://tools.example.com/mcp" }\n}'}
            editable={!disabled}
            onChangeText={(text) => update("mcpServersJson", text)}
            theme={theme}
          />
          <Text
            style={[
              styles.message,
              { color: mcpState.error ? theme.colors.statusDanger : theme.colors.foregroundMuted },
            ]}
          >
            {mcpState.error ? `配置错误：${mcpState.error}` : `已配置 ${mcpState.count} 个 MCP server`}
          </Text>
        </SettingsCard>
      </SettingsSection>

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
        <Text style={[styles.message, { color: theme.colors.statusDanger }]}>
          {settings.saveError}
        </Text>
      ) : null}
    </View>
  );
}

export function InjectorSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(injectorSettings);
  const mutedStyle = useMemo(() => ({ color: theme.colors.foregroundMuted }), [theme]);

  if (settings.status === "loading") return <Text style={mutedStyle}>加载中…</Text>;
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Agent 注入">
        <SettingsCard>
          <Text style={mutedStyle}>{settings.error}</Text>
          <SettingsAction label="重新读取" actionLabel="重试" onPress={settings.reload} />
          {settings.status === "invalid" ? (
            <SettingsAction label="恢复默认配置" actionLabel="重置" onPress={settings.reset} />
          ) : null}
        </SettingsCard>
      </SettingsSection>
    );
  }
  return <Editor settings={settings} theme={theme} />;
}
