import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { usePaseo, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import {
  ALWAYS_ENABLED_TOOLS,
  BUILTIN_TOOL_GROUPS,
  BUILTIN_TOOLS,
  isPolicyEnabled,
  isToolEnabled,
  unknownDisabledTools,
  type BuiltinTool,
  type PaseoToolsPolicy,
} from "../shared/builtin-tools";

type Theme = PluginSurfaceProps["theme"];

interface ProviderEntry {
  id: string;
  policy: PaseoToolsPolicy;
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; providers: ProviderEntry[] };

/** Provider 下拉里的伪选项：统一编辑所有 provider。 */
const ALL_PROVIDERS = "*";

const styles = StyleSheet.create({
  row: { paddingHorizontal: 16, paddingVertical: 12 },
  field: { gap: 8 },
  label: { fontSize: 14, lineHeight: 20 },
  hint: { fontSize: 12, lineHeight: 17 },
  messageRow: { paddingHorizontal: 16, paddingBottom: 12 },
  message: { fontSize: 12, lineHeight: 17 },
  listHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  listActions: { flexDirection: "row", alignItems: "center", gap: 14 },
  listAction: { fontSize: 13, lineHeight: 18 },
  groupHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 4,
  },
  groupActions: { flexDirection: "row", alignItems: "center", gap: 12 },
  groupLabel: {
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0.3,
    fontWeight: "600",
  },
  groupAction: { fontSize: 12, lineHeight: 16 },
  toolRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 5,
  },
  toolRowDisabled: { opacity: 0.45 },
  box: {
    width: 16,
    height: 16,
    borderRadius: 4,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  boxMark: { fontSize: 11, lineHeight: 14 },
  toolName: { fontSize: 13, lineHeight: 18 },
  toolTitle: { flex: 1, fontSize: 12, lineHeight: 16, textAlign: "right" },
});

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 归一化策略，用于判断是否有未保存改动。 */
function policyKey(policy: PaseoToolsPolicy): string {
  const disabled = Array.from(new Set(policy.disabledTools ?? [])).sort();
  return JSON.stringify({ enabled: isPolicyEnabled(policy), disabled });
}

function normalizePolicy(raw: unknown): PaseoToolsPolicy {
  if (!raw || typeof raw !== "object") return {};
  const record = raw as { enabled?: unknown; disabledTools?: unknown };
  return {
    ...(typeof record.enabled === "boolean" ? { enabled: record.enabled } : {}),
    ...(Array.isArray(record.disabledTools)
      ? {
          disabledTools: record.disabledTools.filter(
            (name): name is string => typeof name === "string",
          ),
        }
      : {}),
  };
}

function readProviders(config: unknown): ProviderEntry[] {
  const providers = (config as { providers?: Record<string, unknown> } | null)?.providers;
  if (!providers || typeof providers !== "object") return [];
  return Object.entries(providers)
    .filter(([, value]) => (value as { enabled?: unknown } | null)?.enabled !== false)
    .map(([id, value]) => ({
      id,
      policy: normalizePolicy((value as { paseoTools?: unknown } | null)?.paseoTools),
    }));
}

function ToolRow({
  tool,
  checked,
  disabled,
  theme,
  onToggle,
}: {
  tool: BuiltinTool;
  checked: boolean;
  disabled: boolean;
  theme: Theme;
  onToggle(name: string): void;
}) {
  const alwaysOn = ALWAYS_ENABLED_TOOLS.has(tool.name);
  const locked = disabled || alwaysOn;
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled: locked }}
      accessibilityLabel={tool.name}
      disabled={locked}
      onPress={() => onToggle(tool.name)}
      style={[styles.toolRow, (disabled || alwaysOn) && styles.toolRowDisabled]}
    >
      <View
        style={[
          styles.box,
          {
            borderColor: checked ? theme.colors.accent : theme.colors.border,
            backgroundColor: checked ? theme.colors.accent : "transparent",
          },
        ]}
      >
        {checked ? (
          <Text style={[styles.boxMark, { color: theme.colors.accentForeground }]}>✓</Text>
        ) : null}
      </View>
      <Text style={[styles.toolName, { color: theme.colors.foreground }]}>{tool.name}</Text>
      <Text style={[styles.toolTitle, { color: theme.colors.foregroundMuted }]}>
        {tool.title}
      </Text>
    </Pressable>
  );
}

function PolicyEditor({
  provider,
  policy,
  saving,
  theme,
  onChange,
}: {
  provider: string;
  policy: PaseoToolsPolicy;
  saving: boolean;
  theme: Theme;
  onChange(next: PaseoToolsPolicy): void;
}) {
  const policyEnabled = isPolicyEnabled(policy);
  const unknown = useMemo(() => unknownDisabledTools(policy), [policy]);
  const checkedCount = useMemo(
    () => BUILTIN_TOOLS.filter((tool) => isToolEnabled(policy, tool.name)).length,
    [policy],
  );
  const disabledNames = useMemo(
    () => new Set(policy.disabledTools ?? []),
    [policy.disabledTools],
  );

  const toggleTool = useCallback(
    (name: string) => {
      if (ALWAYS_ENABLED_TOOLS.has(name)) return;
      const next = new Set(disabledNames);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      onChange({ ...policy, disabledTools: Array.from(next) });
    },
    [disabledNames, policy, onChange],
  );

  const selectAll = useCallback(() => {
    onChange({ ...policy, enabled: true, disabledTools: [...unknown] });
  }, [policy, unknown, onChange]);

  const selectNone = useCallback(() => {
    const all = BUILTIN_TOOLS.filter((tool) => !ALWAYS_ENABLED_TOOLS.has(tool.name)).map(
      (tool) => tool.name,
    );
    onChange({ ...policy, enabled: true, disabledTools: [...all, ...unknown] });
  }, [policy, unknown, onChange]);

  const applyGroup = useCallback(
    (tools: readonly BuiltinTool[], enabled: boolean) => {
      const next = new Set(disabledNames);
      for (const tool of tools) {
        if (ALWAYS_ENABLED_TOOLS.has(tool.name)) continue;
        if (enabled) next.delete(tool.name);
        else next.add(tool.name);
      }
      onChange({ ...policy, disabledTools: Array.from(next) });
    },
    [disabledNames, policy, onChange],
  );

  const groups = useMemo(
    () =>
      BUILTIN_TOOL_GROUPS.map((group) => ({
        ...group,
        tools: BUILTIN_TOOLS.filter((tool) => tool.group === group.id),
      })).filter((group) => group.tools.length > 0),
    [],
  );

  const groupActionsDisabled = saving || !policyEnabled;

  return (
    <SettingsCard>
      <SettingsSwitch
        label="启用 paseo 内置工具"
        hint="关闭后该 provider 的新会话不再获得任何 paseo 工具（含 speak）；只想禁部分工具请用下方清单"
        value={policyEnabled}
        disabled={saving}
        onValueChange={(value) => onChange({ ...policy, enabled: value })}
      />
      <View style={styles.listHeader}>
        <Text style={[styles.label, { color: theme.colors.foreground }]}>
          工具（{checkedCount}/{BUILTIN_TOOLS.length}）
        </Text>
        <View style={styles.listActions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="全选内置工具"
            disabled={saving || !policyEnabled}
            onPress={selectAll}
          >
            <Text style={[styles.listAction, { color: theme.colors.accent }]}>全选</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="全不选内置工具"
            disabled={saving || !policyEnabled}
            onPress={selectNone}
          >
            <Text style={[styles.listAction, { color: theme.colors.accent }]}>全不选</Text>
          </Pressable>
        </View>
      </View>
      {groups.map(({ id, label, tools }) => {
        const enabledInGroup = policyEnabled
          ? tools.filter((tool) => isToolEnabled(policy, tool.name)).length
          : 0;
        return (
          <View key={id}>
            <View style={styles.groupHeader}>
              <Text style={[styles.groupLabel, { color: theme.colors.foregroundMuted }]}>
                {label}（{enabledInGroup}/{tools.length}）
              </Text>
              <View style={styles.groupActions}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`全选 ${label}`}
                  disabled={groupActionsDisabled}
                  onPress={() => applyGroup(tools, true)}
                >
                  <Text style={[styles.groupAction, { color: theme.colors.accent }]}>全选</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`全不选 ${label}`}
                  disabled={groupActionsDisabled}
                  onPress={() => applyGroup(tools, false)}
                >
                  <Text style={[styles.groupAction, { color: theme.colors.accent }]}>
                    全不选
                  </Text>
                </Pressable>
              </View>
            </View>
            {tools.map((tool) => (
              <ToolRow
                key={tool.name}
                tool={tool}
                checked={policyEnabled && isToolEnabled(policy, tool.name)}
                disabled={saving || !policyEnabled}
                theme={theme}
                onToggle={toggleTool}
              />
            ))}
          </View>
        );
      })}
      <View style={styles.messageRow}>
        <Text style={[styles.message, { color: theme.colors.foregroundMuted }]}>
          {policyEnabled
            ? `${provider}：${checkedCount} 个工具可用（speak 不受单个禁用影响）`
            : `${provider}：内置工具已整体关闭，speak 也一并下线`}
        </Text>
      </View>
    </SettingsCard>
  );
}

export function BuiltinToolsSection({ theme }: { theme: Theme }) {
  const paseo = usePaseo();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  const applyConfig = useCallback((config: unknown) => {
    const providers = readProviders(config);
    setState({ status: "ready", providers });
    setBaseline(
      Object.fromEntries(providers.map((entry) => [entry.id, policyKey(entry.policy)])),
    );
    setSelectedId((current) =>
      current === ALL_PROVIDERS ||
      (current && providers.some((entry) => entry.id === current))
        ? current
        : (providers[0]?.id ?? null),
    );
  }, []);

  const load = useCallback(async () => {
    setState({ status: "loading" });
    setSaveError(null);
    try {
      const { config } = await paseo.config.get();
      applyConfig(config);
    } catch (error) {
      setState({ status: "error", message: errorText(error) });
    }
  }, [paseo, applyConfig]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(
    () =>
      state.status === "ready"
        ? (state.providers.find((p) => p.id === selectedId) ?? state.providers[0] ?? null)
        : null,
    [state, selectedId],
  );

  const editingAll = selectedId === ALL_PROVIDERS;

  /** 「全部 Provider」显示各 provider 的交集：只有所有人都启用的工具才算勾选。 */
  const unifiedPolicy = useMemo<PaseoToolsPolicy>(() => {
    if (state.status !== "ready" || state.providers.length === 0) return {};
    const disabled = new Set<string>();
    for (const entry of state.providers) {
      for (const name of entry.policy.disabledTools ?? []) disabled.add(name);
    }
    return {
      enabled: state.providers.every((entry) => isPolicyEnabled(entry.policy)),
      disabledTools: Array.from(disabled),
    };
  }, [state]);

  const policiesDiffer = useMemo(() => {
    if (state.status !== "ready" || state.providers.length < 2) return false;
    const first = state.providers[0];
    if (!first) return false;
    const firstKey = policyKey(first.policy);
    return state.providers.some((entry) => policyKey(entry.policy) !== firstKey);
  }, [state]);

  const updatePolicy = useCallback(
    (policy: PaseoToolsPolicy) => {
      setSavedNotice(null);
      setState((current) =>
        current.status === "ready" && selectedId
          ? {
              status: "ready",
              providers: current.providers.map((entry) =>
                entry.id === selectedId ? { ...entry, policy } : entry,
              ),
            }
          : current,
      );
    },
    [selectedId],
  );

  // 「全部 Provider」编辑：把统一后的已知工具状态写入每个 provider，各自的未知工具保持不动。
  const updateAll = useCallback((policy: PaseoToolsPolicy) => {
    setSavedNotice(null);
    setState((current) => {
      if (current.status !== "ready") return current;
      return {
        status: "ready",
        providers: current.providers.map((entry) => {
          const unknown = unknownDisabledTools(entry.policy);
          const disabledTools = new Set(
            (policy.disabledTools ?? []).filter((name) => !unknown.includes(name)),
          );
          for (const name of unknown) disabledTools.add(name);
          return {
            ...entry,
            policy: {
              enabled: isPolicyEnabled(policy),
              disabledTools: Array.from(disabledTools),
            },
          };
        }),
      };
    });
  }, []);

  const dirty = useMemo(() => {
    if (state.status !== "ready") return [];
    return state.providers.filter((entry) => policyKey(entry.policy) !== baseline[entry.id]);
  }, [state, baseline]);

  const save = useCallback(async () => {
    if (dirty.length === 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      const providersPatch = Object.fromEntries(
        dirty.map((entry) => [
          entry.id,
          {
            paseoTools: {
              enabled: isPolicyEnabled(entry.policy),
              disabledTools: Array.from(new Set(entry.policy.disabledTools ?? [])),
            },
          },
        ]),
      );
      const { config } = await paseo.config.patch({ providers: providersPatch });
      applyConfig(config);
      setSavedNotice(`已保存 ${dirty.length} 个 provider；新建或重开会话后生效。`);
    } catch (error) {
      setSaveError(errorText(error));
    } finally {
      setSaving(false);
    }
  }, [dirty, paseo, applyConfig]);

  const providerOptions = useMemo(
    () =>
      state.status === "ready"
        ? [
            { label: "全部 Provider（统一设置）", value: ALL_PROVIDERS },
            ...state.providers.map((entry) => ({ label: entry.id, value: entry.id })),
          ]
        : [],
    [state],
  );

  return (
    <SettingsSection
      title="内置工具"
      info="Paseo 自带的工具（含浏览器工具）按 provider 生效，写入 daemon 配置 agents.providers.<id>.paseoTools。选「全部 Provider」可一次统一编辑；单个禁用对 speak 无效，但整体关闭时 speak 也会下线；改动在新建或重开会话时生效。"
    >
      {state.status === "loading" ? (
        <SettingsCard>
          <View style={styles.row}>
            <Text style={[styles.message, { color: theme.colors.foregroundMuted }]}>
              正在读取 daemon 配置…
            </Text>
          </View>
        </SettingsCard>
      ) : state.status === "error" ? (
        <SettingsCard>
          <View style={styles.row}>
            <Text style={[styles.message, { color: theme.colors.statusDanger }]}>
              读取配置失败：{state.message}
            </Text>
          </View>
          <SettingsAction label="重新读取 daemon 配置" actionLabel="重试" onPress={load} />
        </SettingsCard>
      ) : state.providers.length === 0 ? (
        <SettingsCard>
          <View style={styles.row}>
            <Text style={[styles.message, { color: theme.colors.foregroundMuted }]}>
              没有已启用的 provider，先在 Paseo 设置里启用一个。
            </Text>
          </View>
        </SettingsCard>
      ) : (
        <>
          <SettingsCard>
            <SettingsSelect
              label="Provider"
              hint={
                editingAll
                  ? policiesDiffer
                    ? "当前各 provider 策略不一致，勾选状态按交集显示；这里的修改会统一写入所有 provider"
                    : "所有 provider 当前策略一致；这里的修改会统一写入所有 provider"
                  : "内置工具策略按 provider 保存，切换不会丢失未保存的改动；选「全部 Provider」可统一设置"
              }
              value={editingAll ? ALL_PROVIDERS : (selected?.id ?? ALL_PROVIDERS)}
              options={providerOptions}
              disabled={saving}
              onValueChange={setSelectedId}
            />
          </SettingsCard>
          {selected || editingAll ? (
            <PolicyEditor
              provider={
                editingAll ? `全部 ${state.providers.length} 个 provider` : (selected?.id ?? "")
              }
              policy={editingAll ? unifiedPolicy : (selected?.policy ?? {})}
              saving={saving}
              theme={theme}
              onChange={editingAll ? updateAll : updatePolicy}
            />
          ) : null}
          <SettingsCard>
            <SettingsAction
              label={
                dirty.length > 0 ? `${dirty.length} 个 provider 有未保存改动` : "内置工具配置"
              }
              actionLabel={saving ? "保存中…" : "保存"}
              disabled={saving || dirty.length === 0}
              onPress={save}
            />
          </SettingsCard>
          {saveError ? (
            <View style={styles.messageRow}>
              <Text style={[styles.message, { color: theme.colors.statusDanger }]}>
                保存失败：{saveError}
              </Text>
            </View>
          ) : null}
          {savedNotice ? (
            <View style={styles.messageRow}>
              <Text style={[styles.message, { color: theme.colors.statusSuccess }]}>
                {savedNotice}
              </Text>
            </View>
          ) : null}
        </>
      )}
    </SettingsSection>
  );
}
