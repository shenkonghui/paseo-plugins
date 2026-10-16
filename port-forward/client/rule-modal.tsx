import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon, Modal, TextInput } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";

type Theme = PluginSurfaceProps["theme"];

export interface RuleDraft {
  id: string | null;
  name: string;
  listenHost: string;
  listenPort: string;
  targetHost: string;
  targetPort: string;
  enabled: boolean;
}

export interface ParsedDraft {
  name: string;
  listenHost: string;
  listenPort: number;
  targetHost: string;
  targetPort: number;
  enabled: boolean;
}

export function emptyDraft(): RuleDraft {
  return {
    id: null,
    name: "",
    listenHost: "127.0.0.1",
    listenPort: "",
    targetHost: "127.0.0.1",
    targetPort: "",
    enabled: true,
  };
}

function parsePort(value: string): number | null {
  if (!/^\d{1,5}$/u.test(value.trim())) return null;
  const port = Number(value.trim());
  return port >= 1 && port <= 65535 ? port : null;
}

export function validateDraft(draft: RuleDraft): { parsed: ParsedDraft | null; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (!draft.listenHost.trim()) errors.listenHost = "监听地址不能为空";
  if (!draft.targetHost.trim()) errors.targetHost = "目标地址不能为空";
  const listenPort = parsePort(draft.listenPort);
  if (listenPort === null) errors.listenPort = "监听端口需为 1-65535";
  const targetPort = parsePort(draft.targetPort);
  if (targetPort === null) errors.targetPort = "目标端口需为 1-65535";
  if (Object.keys(errors).length > 0 || listenPort === null || targetPort === null) {
    return { parsed: null, errors };
  }
  return {
    parsed: {
      name: draft.name.trim(),
      listenHost: draft.listenHost.trim(),
      listenPort,
      targetHost: draft.targetHost.trim(),
      targetPort,
      enabled: draft.enabled,
    },
    errors,
  };
}

interface RuleModalProps {
  open: boolean;
  draft: RuleDraft;
  saving: boolean;
  onClose: () => void;
  onSubmit: (draft: RuleDraft) => void;
  theme: Theme;
  compact: boolean;
}

export function RuleModal({ open, draft, saving, onClose, onSubmit, theme, compact }: RuleModalProps) {
  // 父组件在每次打开弹窗时用新的 key 重新挂载本组件，因此这里以 draft 作为初始值即可。
  const [form, setForm] = useState<RuleDraft>(draft);
  const [touched, setTouched] = useState(false);

  const { parsed, errors } = useMemo(() => validateDraft(form), [form]);
  const showErrors = touched;

  const styles = useMemo(
    () => ({
      field: { gap: 4, marginBottom: 12 },
      label: { color: theme.colors.foregroundMuted, fontSize: 12 },
      input: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        color: theme.colors.foreground,
        fontSize: 13,
      },
      error: { color: theme.colors.statusDanger, fontSize: 12 },
      row: { flexDirection: "row" as const, gap: 10 },
      rowItem: { flex: 1, gap: 4 },
      hint: { color: theme.colors.foregroundMuted, fontSize: 12, marginBottom: 12 },
      enabledRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        marginBottom: 16,
      },
      checkbox: {
        width: 18,
        height: 18,
        borderRadius: 4,
        borderWidth: 1,
        borderColor: form.enabled ? theme.colors.accent : theme.colors.border,
        backgroundColor: form.enabled ? theme.colors.accent : "transparent",
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      checkmark: { color: theme.colors.accentForeground, fontSize: 12 },
      actions: {
        flexDirection: "row" as const,
        justifyContent: "flex-end" as const,
        gap: 8,
      },
      button: {
        borderRadius: 8,
        paddingHorizontal: compact ? 12 : 16,
        paddingVertical: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
      },
      buttonPrimary: {
        borderRadius: 8,
        paddingHorizontal: compact ? 12 : 16,
        paddingVertical: 8,
        backgroundColor: theme.colors.accent,
      },
      buttonText: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
      buttonPrimaryText: {
        color: theme.colors.accentForeground,
        fontSize: 13,
        fontWeight: "600" as const,
      },
    }),
    [theme, compact, form.enabled],
  );

  const update = (patch: Partial<RuleDraft>): void => {
    setForm((previous) => ({ ...previous, ...patch }));
  };

  const submit = (): void => {
    setTouched(true);
    if (!parsed) return;
    onSubmit(form);
  };

  return (
    <Modal
      title={draft.id ? "编辑转发规则" : "新建转发规则"}
      icon={<Icon name="ArrowRightLeft" size={18} color={theme.colors.foreground} />}
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Modal.Content>
        <Text style={styles.hint}>
          规则在 daemon 主机上生效：监听「本机地址:端口」，把 TCP 流量转发到「目标地址:端口」。
          监听 0.0.0.0 表示允许从其他机器访问。
        </Text>

        <View style={styles.field}>
          <Text style={styles.label}>名称（可选）</Text>
          <TextInput
            value={form.name}
            onChangeText={(value) => update({ name: value })}
            placeholder="例如：远程 Web 服务"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={styles.input}
          />
        </View>

        <View style={styles.row}>
          <View style={styles.rowItem}>
            <Text style={styles.label}>监听地址</Text>
            <TextInput
              value={form.listenHost}
              onChangeText={(value) => update({ listenHost: value })}
              placeholder="127.0.0.1"
              autoCapitalize="none"
              autoCorrect={false}
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.input}
            />
            {showErrors && errors.listenHost ? (
              <Text style={styles.error}>{errors.listenHost}</Text>
            ) : null}
          </View>
          <View style={styles.rowItem}>
            <Text style={styles.label}>监听端口</Text>
            <TextInput
              value={form.listenPort}
              onChangeText={(value) => update({ listenPort: value })}
              placeholder="8080"
              keyboardType="number-pad"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.input}
            />
            {showErrors && errors.listenPort ? (
              <Text style={styles.error}>{errors.listenPort}</Text>
            ) : null}
          </View>
        </View>

        <View style={{ height: 12 }} />

        <View style={styles.row}>
          <View style={styles.rowItem}>
            <Text style={styles.label}>目标地址</Text>
            <TextInput
              value={form.targetHost}
              onChangeText={(value) => update({ targetHost: value })}
              placeholder="127.0.0.1"
              autoCapitalize="none"
              autoCorrect={false}
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.input}
            />
            {showErrors && errors.targetHost ? (
              <Text style={styles.error}>{errors.targetHost}</Text>
            ) : null}
          </View>
          <View style={styles.rowItem}>
            <Text style={styles.label}>目标端口</Text>
            <TextInput
              value={form.targetPort}
              onChangeText={(value) => update({ targetPort: value })}
              placeholder="80"
              keyboardType="number-pad"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.input}
            />
            {showErrors && errors.targetPort ? (
              <Text style={styles.error}>{errors.targetPort}</Text>
            ) : null}
          </View>
        </View>

        <View style={{ height: 12 }} />

        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: form.enabled }}
          onPress={() => update({ enabled: !form.enabled })}
          style={styles.enabledRow}
        >
          <View style={styles.checkbox}>
            {form.enabled ? <Text style={styles.checkmark}>✓</Text> : null}
          </View>
          <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>创建后立即启用</Text>
        </Pressable>

        <View style={styles.actions}>
          <Pressable accessibilityRole="button" onPress={onClose} style={styles.button}>
            <Text style={styles.buttonText}>取消</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={submit}
            disabled={saving}
            style={styles.buttonPrimary}
          >
            <Text style={styles.buttonPrimaryText}>{saving ? "保存中…" : "保存"}</Text>
          </Pressable>
        </View>
      </Modal.Content>
    </Modal>
  );
}
