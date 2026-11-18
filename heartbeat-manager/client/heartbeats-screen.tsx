import { usePaseo, useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, Modal, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  heartbeatActionRpc,
  heartbeatCreateRpc,
  heartbeatListRpc,
  heartbeatUpdateRpc,
  type Heartbeat,
  type HeartbeatStatus,
} from "../shared/heartbeats";

type Theme = PluginScreenProps["theme"];

const POLL_MS = 15_000;
const RUNS_SHOWN = 3;
const DEFAULT_CRON = "*/30 * * * *";

const STATUS_LABELS: Record<HeartbeatStatus, string> = {
  active: "运行中",
  paused: "已暂停",
  completed: "已结束",
};

const RUN_LABELS: Record<string, string> = {
  running: "运行中",
  succeeded: "成功",
  failed: "失败",
};

interface AgentOption {
  id: string;
  label: string;
  detail: string;
}

interface FormValues {
  agentId: string;
  prompt: string;
  cron: string;
  timezone: string;
  name: string;
  maxRuns: string;
  expiresIn: string;
}

function defaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
  } catch {
    return "Asia/Shanghai";
  }
}

function emptyForm(agentId: string): FormValues {
  return {
    agentId,
    prompt: "",
    cron: DEFAULT_CRON,
    timezone: defaultTimezone(),
    name: "",
    maxRuns: "",
    expiresIn: "",
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "—";
  const diff = time - Date.now();
  const abs = Math.abs(diff);
  const amount =
    abs < 60_000
      ? Math.max(1, Math.round(abs / 1000))
      : abs < 3_600_000
        ? Math.round(abs / 60_000)
        : abs < 86_400_000
          ? Math.round(abs / 3_600_000)
          : Math.round(abs / 86_400_000);
  const unit = abs < 60_000 ? "秒" : abs < 3_600_000 ? "分钟" : abs < 86_400_000 ? "小时" : "天";
  return `${amount} ${unit}${diff >= 0 ? "后" : "前"}`;
}

function formatDateTime(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return iso;
  return new Date(time).toLocaleString("zh-CN", { hour12: false });
}

function parseOptionalInt(raw: string): number | null | "invalid" {
  const text = raw.trim();
  if (!text) return null;
  const value = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(value) || value <= 0) return "invalid";
  return value;
}

function parseOptionalDuration(raw: string): string | null | "invalid" {
  const text = raw.trim();
  if (!text) return null;
  return /^\d+[smhd]$/.test(text) ? text : "invalid";
}

function cronProblem(expression: string): string | null {
  return expression.trim().split(/\s+/).length === 5 ? null : "cron 需要 5 段（分 时 日 月 周）";
}

/* ------------------------------------------------------------------ */

function Field(props: {
  theme: Theme;
  label: string;
  hint?: string | null;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
  autoFocus?: boolean;
}) {
  const { theme, label, hint, value, onChangeText, placeholder, multiline } = props;
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.foregroundMuted}
        multiline={multiline}
        accessibilityLabel={label}
        style={{
          minHeight: multiline ? 84 : 36,
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: 6,
          paddingHorizontal: 10,
          paddingVertical: 8,
          fontSize: 13,
          color: theme.colors.foreground,
          backgroundColor: theme.colors.surface1,
          textAlignVertical: multiline ? "top" : "center",
        }}
      />
      {hint ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{hint}</Text> : null}
    </View>
  );
}

function SmallButton(props: {
  theme: Theme;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: "default" | "accent" | "danger";
}) {
  const { theme, label, onPress, disabled, tone = "default" } = props;
  const accent = theme.colors.accent;
  const color = disabled ? theme.colors.foregroundMuted : tone === "accent" ? accent : theme.colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={{
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: tone === "accent" && !disabled ? accent : theme.colors.border,
        backgroundColor: tone === "accent" && !disabled ? theme.colors.surface2 : "transparent",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text style={{ color: tone === "danger" && !disabled ? accent : color, fontSize: 12 }}>{label}</Text>
    </Pressable>
  );
}

function AgentPicker(props: {
  theme: Theme;
  agents: AgentOption[];
  value: string;
  onChange: (agentId: string) => void;
  error: string | null;
}) {
  const { theme, agents, value, onChange, error } = props;
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return agents;
    return agents.filter(
      (agent) =>
        agent.label.toLowerCase().includes(needle) ||
        agent.detail.toLowerCase().includes(needle) ||
        agent.id.toLowerCase().includes(needle),
    );
  }, [agents, query]);

  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>归属 agent</Text>
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="筛选 agent（名称 / provider / id）"
        placeholderTextColor={theme.colors.foregroundMuted}
        accessibilityLabel="筛选 agent"
        style={{
          minHeight: 36,
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: 6,
          paddingHorizontal: 10,
          paddingVertical: 6,
          fontSize: 13,
          color: theme.colors.foreground,
          backgroundColor: theme.colors.surface1,
        }}
      />
      {error ? <Text style={{ color: theme.colors.foreground, fontSize: 11 }}>{error}</Text> : null}
      {agents.length === 0 && !error ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>正在读取 agent 列表…</Text>
      ) : null}
      <ScrollView style={{ maxHeight: 168 }}>
        <View style={{ gap: 4 }}>
          {filtered.map((agent) => {
            const selected = agent.id === value;
            const accent = theme.colors.accent;
            return (
              <Pressable
                key={agent.id}
                accessibilityRole="button"
                accessibilityLabel={`选择 agent ${agent.label}`}
                accessibilityState={{ selected }}
                onPress={() => onChange(agent.id)}
                style={{
                  paddingHorizontal: 8,
                  paddingVertical: 6,
                  borderRadius: 6,
                  borderWidth: 1,
                  borderColor: selected ? accent : theme.colors.border,
                  backgroundColor: selected ? theme.colors.surface2 : "transparent",
                  gap: 1,
                }}
              >
                <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 12 }}>
                  {agent.label}
                </Text>
                <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
                  {agent.detail}
                </Text>
              </Pressable>
            );
          })}
          {filtered.length === 0 && agents.length > 0 ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>没有匹配的 agent</Text>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

/* ------------------------------------------------------------------ */

function HeartbeatCard(props: {
  theme: Theme;
  heartbeat: Heartbeat;
  agentLabel: string;
  busy: boolean;
  pendingDelete: boolean;
  expanded: boolean;
  onToggleRuns: () => void;
  onPause: () => void;
  onResume: () => void;
  onRunOnce: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const {
    theme,
    heartbeat,
    agentLabel,
    busy,
    pendingDelete,
    expanded,
    onToggleRuns,
    onPause,
    onResume,
    onRunOnce,
    onEdit,
    onDelete,
  } = props;
  const accent = theme.colors.accent;
  const succeeded = heartbeat.runs.filter((run) => run.status === "succeeded").length;
  const failed = heartbeat.runs.filter((run) => run.status === "failed").length;
  const runs = heartbeat.runs.slice(-RUNS_SHOWN).reverse();

  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        padding: 12,
        gap: 6,
        backgroundColor: theme.colors.surface0,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600", flexShrink: 1 }}>
          {heartbeat.name || "未命名心跳"}
        </Text>
        <View style={{ flex: 1 }} />
        <Text
          style={{
            color: heartbeat.status === "active" ? accent : theme.colors.foregroundMuted,
            fontSize: 11,
          }}
        >
          {STATUS_LABELS[heartbeat.status]}
        </Text>
      </View>

      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
        {agentLabel} · {heartbeat.agentId.slice(0, 8)}
      </Text>
      <Text numberOfLines={2} style={{ color: theme.colors.foreground, fontSize: 12, lineHeight: 17 }}>
        {heartbeat.prompt}
      </Text>
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
        cron {heartbeat.cron || "—"}
        {heartbeat.timezone ? ` (${heartbeat.timezone})` : ""}
      </Text>
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
        下次 {formatRelative(heartbeat.nextRunAt)} · 上次 {formatRelative(heartbeat.lastRunAt)} · 成功 {succeeded} / 失败{" "}
        {failed}
      </Text>
      {heartbeat.maxRuns != null || heartbeat.expiresAt ? (
        <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
          {heartbeat.maxRuns != null ? `上限 ${heartbeat.maxRuns} 次` : ""}
          {heartbeat.maxRuns != null && heartbeat.expiresAt ? " · " : ""}
          {heartbeat.expiresAt ? `${formatDateTime(heartbeat.expiresAt)} 到期` : ""}
        </Text>
      ) : null}

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 2 }}>
        {heartbeat.status === "paused" ? (
          <SmallButton theme={theme} label="恢复" onPress={onResume} disabled={busy} tone="accent" />
        ) : (
          <SmallButton
            theme={theme}
            label="暂停"
            onPress={onPause}
            disabled={busy || heartbeat.status === "completed"}
          />
        )}
        <SmallButton theme={theme} label={busy ? "处理中…" : "立即运行"} onPress={onRunOnce} disabled={busy} />
        <SmallButton theme={theme} label="编辑" onPress={onEdit} disabled={busy} />
        <SmallButton
          theme={theme}
          label={pendingDelete ? "确认删除" : "删除"}
          onPress={onDelete}
          disabled={busy}
          tone="danger"
        />
        <SmallButton
          theme={theme}
          label={expanded ? "收起记录" : `运行记录 (${heartbeat.runs.length})`}
          onPress={onToggleRuns}
        />
      </View>

      {expanded ? (
        <View style={{ gap: 4, marginTop: 2 }}>
          {runs.length === 0 ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>还没有运行记录</Text>
          ) : (
            runs.map((run) => (
              <View key={run.id} style={{ gap: 1 }}>
                <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 11 }}>
                  {RUN_LABELS[run.status] ?? run.status} · {formatDateTime(run.startedAt)}
                  {run.endedAt ? ` → ${formatDateTime(run.endedAt)}` : ""}
                </Text>
                {run.error ? (
                  <Text numberOfLines={2} style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
                    {run.error}
                  </Text>
                ) : null}
              </View>
            ))
          )}
        </View>
      ) : null}
    </View>
  );
}

/* ------------------------------------------------------------------ */

function CreateForm(props: {
  theme: Theme;
  agents: AgentOption[];
  agentsError: string | null;
  create: (input: {
    agentId: string;
    prompt: string;
    cron: string;
    timezone?: string | null;
    name?: string | null;
    maxRuns?: number | null;
    expiresIn?: string | null;
  }) => Promise<{ error: string | null; heartbeat: Heartbeat | null }>;
  onCreated: () => void;
}) {
  const { theme, agents, agentsError, create, onCreated } = props;
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<FormValues>(() => emptyForm(""));
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    setValues((current) => (current.agentId ? current : { ...current, agentId: agents[0]?.id ?? "" }));
  }, [agents]);

  const patch = useCallback((part: Partial<FormValues>) => {
    setValues((current) => ({ ...current, ...part }));
  }, []);

  const submit = useCallback(async () => {
    setFormError(null);
    if (!values.agentId) {
      setFormError("请选择归属 agent");
      return;
    }
    if (!values.prompt.trim()) {
      setFormError("prompt 不能为空");
      return;
    }
    const cron = cronProblem(values.cron);
    if (cron) {
      setFormError(cron);
      return;
    }
    const maxRuns = parseOptionalInt(values.maxRuns);
    if (maxRuns === "invalid") {
      setFormError("最大运行次数需为正整数");
      return;
    }
    const expiresIn = parseOptionalDuration(values.expiresIn);
    if (expiresIn === "invalid") {
      setFormError("过期时间形如 7d、12h、30m");
      return;
    }

    setBusy(true);
    try {
      const result = await create({
        agentId: values.agentId,
        prompt: values.prompt.trim(),
        cron: values.cron.trim(),
        timezone: values.timezone.trim() || null,
        name: values.name.trim() || null,
        maxRuns,
        expiresIn,
      });
      if (result.error) {
        setFormError(result.error);
        return;
      }
      setValues((current) => ({ ...current, prompt: "", name: "", maxRuns: "", expiresIn: "" }));
      setOpen(false);
      onCreated();
    } catch (error) {
      setFormError(errorText(error));
    } finally {
      setBusy(false);
    }
  }, [create, onCreated, values]);

  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        padding: 12,
        gap: 10,
        backgroundColor: theme.colors.surface0,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600" }}>新建心跳</Text>
        <View style={{ flex: 1 }} />
        <SmallButton
          theme={theme}
          label={open ? "收起" : "展开"}
          onPress={() => setOpen((value) => !value)}
          tone={open ? "default" : "accent"}
        />
      </View>

      {open ? (
        <>
          <AgentPicker
            theme={theme}
            agents={agents}
            error={agentsError}
            value={values.agentId}
            onChange={(agentId) => patch({ agentId })}
          />
          <Field
            theme={theme}
            label="Prompt"
            value={values.prompt}
            onChangeText={(prompt) => patch({ prompt })}
            placeholder="每次心跳要发给该 agent 的内容"
            multiline
          />
          <Field
            theme={theme}
            label="Cron"
            hint="5 段 cron，例如 */30 * * * * 或 0 9 * * 1-5"
            value={values.cron}
            onChangeText={(cron) => patch({ cron })}
          />
          <Field
            theme={theme}
            label="时区"
            hint="IANA 时区，留空则用 daemon 的 UTC 默认"
            value={values.timezone}
            onChangeText={(timezone) => patch({ timezone })}
          />
          <Field
            theme={theme}
            label="名称（可选）"
            value={values.name}
            onChangeText={(name) => patch({ name })}
          />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Field
                theme={theme}
                label="最大运行次数（可选）"
                value={values.maxRuns}
                onChangeText={(maxRuns) => patch({ maxRuns })}
                placeholder="正整数"
              />
            </View>
            <View style={{ flex: 1 }}>
              <Field
                theme={theme}
                label="过期时间（可选）"
                value={values.expiresIn}
                onChangeText={(expiresIn) => patch({ expiresIn })}
                placeholder="7d / 12h"
              />
            </View>
          </View>
          {formError ? <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{formError}</Text> : null}
          <View style={{ flexDirection: "row", gap: 8 }}>
            <SmallButton
              theme={theme}
              label={busy ? "创建中…" : "创建心跳"}
              onPress={() => void submit()}
              disabled={busy}
              tone="accent"
            />
          </View>
        </>
      ) : null}
    </View>
  );
}

/* ------------------------------------------------------------------ */

function EditModal(props: {
  theme: Theme;
  heartbeat: Heartbeat | null;
  agentLabel: string;
  update: (input: {
    id: string;
    cron: string;
    timezone?: string | null;
    name?: string | null;
    prompt?: string;
    maxRuns?: number | null;
    expiresIn?: string | null;
  }) => Promise<{ error: string | null; heartbeat: Heartbeat | null }>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { theme, heartbeat, agentLabel, update, onClose, onSaved } = props;
  const [values, setValues] = useState<FormValues>(() => emptyForm(""));
  const [clearExpiry, setClearExpiry] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!heartbeat) return;
    setValues({
      agentId: heartbeat.agentId,
      prompt: heartbeat.prompt,
      cron: heartbeat.cron,
      timezone: heartbeat.timezone ?? defaultTimezone(),
      name: heartbeat.name ?? "",
      maxRuns: heartbeat.maxRuns != null ? String(heartbeat.maxRuns) : "",
      expiresIn: "",
    });
    setClearExpiry(false);
    setFormError(null);
  }, [heartbeat]);

  const patch = useCallback((part: Partial<FormValues>) => {
    setValues((current) => ({ ...current, ...part }));
  }, []);

  const submit = useCallback(async () => {
    if (!heartbeat) return;
    setFormError(null);
    const cron = cronProblem(values.cron);
    if (cron) {
      setFormError(cron);
      return;
    }
    const maxRuns = parseOptionalInt(values.maxRuns);
    if (maxRuns === "invalid") {
      setFormError("最大运行次数需为正整数");
      return;
    }
    const expiresIn = parseOptionalDuration(values.expiresIn);
    if (expiresIn === "invalid") {
      setFormError("过期时间形如 7d、12h、30m");
      return;
    }

    setBusy(true);
    try {
      const result = await update({
        id: heartbeat.id,
        cron: values.cron.trim(),
        timezone: values.timezone.trim() || null,
        name: values.name.trim(),
        prompt: values.prompt.trim() || undefined,
        maxRuns,
        expiresIn: clearExpiry ? null : expiresIn,
      });
      if (result.error) {
        setFormError(result.error);
        return;
      }
      onSaved();
      onClose();
    } catch (error) {
      setFormError(errorText(error));
    } finally {
      setBusy(false);
    }
  }, [clearExpiry, heartbeat, onClose, onSaved, update, values]);

  return (
    <Modal
      title={heartbeat ? `编辑心跳 · ${heartbeat.name || heartbeat.id}` : "编辑心跳"}
      open={heartbeat !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Modal.Content>
        <View style={{ gap: 10 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            归属 agent：{agentLabel}（编辑时不可改归属）
          </Text>
          <Field
            theme={theme}
            label="Prompt"
            value={values.prompt}
            onChangeText={(prompt) => patch({ prompt })}
            multiline
          />
          <Field
            theme={theme}
            label="Cron"
            hint="5 段 cron，例如 */30 * * * *"
            value={values.cron}
            onChangeText={(cron) => patch({ cron })}
          />
          <Field
            theme={theme}
            label="时区"
            value={values.timezone}
            onChangeText={(timezone) => patch({ timezone })}
          />
          <Field
            theme={theme}
            label="名称（留空即清除）"
            value={values.name}
            onChangeText={(name) => patch({ name })}
          />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Field
                theme={theme}
                label="最大运行次数（留空即清除）"
                value={values.maxRuns}
                onChangeText={(maxRuns) => patch({ maxRuns })}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Field
                theme={theme}
                label="过期时间"
                hint="留空保持不变"
                value={values.expiresIn}
                onChangeText={(expiresIn) => patch({ expiresIn })}
                placeholder="7d / 12h"
              />
            </View>
          </View>
          {heartbeat?.expiresAt ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={clearExpiry ? "取消清除过期时间" : "清除过期时间"}
              onPress={() => setClearExpiry((value) => !value)}
            >
              <Text
                style={{
                  color: clearExpiry ? theme.colors.accent : theme.colors.foregroundMuted,
                  fontSize: 12,
                }}
              >
                {clearExpiry ? "✓ 保存时清除过期时间（点击取消）" : "清除过期时间"}
              </Text>
            </Pressable>
          ) : null}
          {formError ? <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{formError}</Text> : null}
          <View style={{ flexDirection: "row", gap: 8 }}>
            <SmallButton
              theme={theme}
              label={busy ? "保存中…" : "保存"}
              onPress={() => void submit()}
              disabled={busy}
              tone="accent"
            />
            <SmallButton theme={theme} label="取消" onPress={onClose} disabled={busy} />
          </View>
        </View>
      </Modal.Content>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

export function HeartbeatsScreen({ theme, layout }: PluginScreenProps) {
  const paseo = usePaseo();
  const listRpc = useRpc(heartbeatListRpc);
  const createRpc = useRpc(heartbeatCreateRpc);
  const updateRpc = useRpc(heartbeatUpdateRpc);
  const actionRpc = useRpc(heartbeatActionRpc);

  const listRef = useRef(listRpc);
  listRef.current = listRpc;
  const createRef = useRef(createRpc);
  createRef.current = createRpc;
  const updateRef = useRef(updateRpc);
  updateRef.current = updateRpc;
  const actionRef = useRef(actionRpc);
  actionRef.current = actionRpc;

  const [heartbeats, setHeartbeats] = useState<Heartbeat[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<Heartbeat | null>(null);
  const deleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await listRef.current({});
      setHeartbeats(result.heartbeats);
      setError(result.error);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    let alive = true;
    void paseo.agents
      .list()
      .then(({ entries }) => {
        if (!alive) return;
        const options: AgentOption[] = [];
        for (const entry of entries) {
          const agent = entry.agent;
          if (agent.archivedAt) continue;
          options.push({
            id: agent.id,
            label: agent.title?.trim() || agent.id.slice(0, 8),
            detail: `${agent.provider}${agent.model ? ` / ${agent.model}` : ""}`,
          });
        }
        setAgents(options);
        setAgentsError(null);
      })
      .catch((cause: unknown) => {
        if (alive) setAgentsError(`读取 agent 列表失败：${errorText(cause)}`);
      });
    return () => {
      alive = false;
    };
  }, [paseo]);

  useEffect(
    () => () => {
      if (deleteTimer.current) clearTimeout(deleteTimer.current);
    },
    [],
  );

  const agentLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agents) map.set(agent.id, agent.label);
    return map;
  }, [agents]);

  const labelFor = useCallback(
    (agentId: string) => agentLabels.get(agentId) ?? agentId.slice(0, 8),
    [agentLabels],
  );

  const create = useCallback(
    (input: Parameters<typeof createRef.current>[0]) => createRef.current(input),
    [],
  );
  const update = useCallback(
    (input: Parameters<typeof updateRef.current>[0]) => updateRef.current(input),
    [],
  );

  const runAction = useCallback(
    async (heartbeat: Heartbeat, action: "pause" | "resume" | "run-once" | "delete") => {
      setBusyId(heartbeat.id);
      try {
        const result = await actionRef.current({ id: heartbeat.id, action });
        if (result.error) setError(result.error);
        else setError(null);
      } catch (cause) {
        setError(errorText(cause));
      } finally {
        setBusyId(null);
        setPendingDelete(null);
        if (deleteTimer.current) {
          clearTimeout(deleteTimer.current);
          deleteTimer.current = null;
        }
        await refresh();
      }
    },
    [refresh],
  );

  const handleDelete = useCallback(
    (heartbeat: Heartbeat) => {
      if (pendingDelete !== heartbeat.id) {
        setPendingDelete(heartbeat.id);
        if (deleteTimer.current) clearTimeout(deleteTimer.current);
        deleteTimer.current = setTimeout(() => {
          setPendingDelete(null);
          deleteTimer.current = null;
        }, 3_000);
        return;
      }
      void runAction(heartbeat, "delete");
    },
    [pendingDelete, runAction],
  );

  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        backgroundColor: theme.colors.surface0,
      },
      header: {
        paddingHorizontal: 16,
        paddingTop: 16,
        paddingBottom: 10,
        gap: 4,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      },
      headerRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      title: { color: theme.colors.foreground, fontSize: 18, fontWeight: "600" as const },
      hint: { color: theme.colors.foregroundMuted, fontSize: 12 },
      error: {
        marginHorizontal: 16,
        marginTop: 10,
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 6,
        backgroundColor: theme.colors.surface2,
      },
      errorText: { color: theme.colors.foreground, fontSize: 12, lineHeight: 17 },
      content: {
        padding: layout.compact ? 12 : 16,
        gap: 10,
        paddingBottom: 32,
      },
      empty: { color: theme.colors.foregroundMuted, fontSize: 13, paddingVertical: 12 },
    }),
    [theme, layout.compact],
  );

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <Icon name="HeartPulse" size={16} color={theme.colors.accent} />
          <Text style={styles.title}>心跳</Text>
          <View style={{ flex: 1 }} />
          <SmallButton theme={theme} label="刷新" onPress={() => void refresh()} />
        </View>
        <Text style={styles.hint}>
          {`心跳 = 面向某个 agent 的定时 prompt，运行时会向该 agent 发送消息。每 ${POLL_MS / 1000}s 自动刷新。`}
        </Text>
      </View>

      {error ? (
        <View style={styles.error}>
          <Text style={styles.errorText}>错误：{error}</Text>
        </View>
      ) : null}

      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.content}>
        <CreateForm
          theme={theme}
          agents={agents}
          agentsError={agentsError}
          create={create}
          onCreated={() => void refresh()}
        />

        {loading ? (
          <Text style={styles.empty}>正在读取心跳…</Text>
        ) : heartbeats.length === 0 ? (
          <Text style={styles.empty}>
            当前没有心跳。新建一条，或让 agent 用 `paseo heartbeat create` 自己创建后回到这里刷新。
          </Text>
        ) : (
          heartbeats.map((heartbeat) => (
            <HeartbeatCard
              key={heartbeat.id}
              theme={theme}
              heartbeat={heartbeat}
              agentLabel={labelFor(heartbeat.agentId)}
              busy={busyId === heartbeat.id}
              pendingDelete={pendingDelete === heartbeat.id}
              expanded={Boolean(expanded[heartbeat.id])}
              onToggleRuns={() =>
                setExpanded((current) => ({ ...current, [heartbeat.id]: !current[heartbeat.id] }))
              }
              onPause={() => void runAction(heartbeat, "pause")}
              onResume={() => void runAction(heartbeat, "resume")}
              onRunOnce={() => void runAction(heartbeat, "run-once")}
              onEdit={() => setEditing(heartbeat)}
              onDelete={() => handleDelete(heartbeat)}
            />
          ))
        )}
      </ScrollView>

      <EditModal
        theme={theme}
        heartbeat={editing}
        agentLabel={editing ? labelFor(editing.agentId) : ""}
        update={update}
        onClose={() => setEditing(null)}
        onSaved={() => void refresh()}
      />
    </View>
  );
}