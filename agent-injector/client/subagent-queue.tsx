import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanResponder, Pressable, StyleSheet, Text, View } from "react-native";
import { usePaseo, useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Modal, SettingsAction, SettingsSelect } from "@getpaseo/plugin/client/ui";
import {
  isInheritEntry,
  parseSubagentQueue,
  type SubagentModelEntry,
  type SubagentQueueEntry,
} from "../shared/settings";
import { queueStatusRpc, resetQueueFailuresRpc } from "../shared/queue-status";

type Theme = PluginSurfaceProps["theme"];

/** 行高固定，拖动时按半行阈值换位。 */
const ROW_HEIGHT = 46;

interface ModelOption {
  id: string;
  label: string;
  isDefault?: boolean;
  defaultThinkingOptionId?: string;
  thinkingOptions: { id: string; label: string }[];
}

interface ProviderOption {
  id: string;
  label: string;
  models: ModelOption[];
}

type CatalogState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; providers: ProviderOption[] };

interface QueueRow {
  id: string;
  entry: SubagentQueueEntry;
}

type QueueEntryStatus = {
  key: string;
  state: "ready" | "cooldown" | "unavailable";
  detail: string | null;
  retryAt: number | null;
  failedAt: number | null;
};

type QueueStatus = {
  error: string | null;
  activeIndex: number | null;
  entries: QueueEntryStatus[];
};

const INHERIT_LABEL = "继承父 agent 配置";
const STATUS_REFRESH_MS = 250;

function formatRemaining(until: number): string {
  const minutes = Math.max(1, Math.ceil((until - Date.now()) / 60_000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours}h${rest > 0 ? `${rest}m` : ""}` : `${rest}m`;
}

function formatTime(value: number | null): string {
  if (!value) return "未知时间";
  const date = new Date(value);
  const pad = (part: number) => `${part}`.padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

let rowSeq = 0;

function toRows(entries: readonly SubagentQueueEntry[]): QueueRow[] {
  return entries.map((entry) => ({ id: `row-${++rowSeq}`, entry }));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readCatalog(payload: {
  entries?: readonly {
    provider: string;
    enabled?: boolean;
    label?: string;
    models?: readonly {
      id: string;
      label: string;
      isSelectable?: boolean;
      isDefault?: boolean;
      defaultThinkingOptionId?: string;
      thinkingOptions?: readonly { id: string; label: string }[];
    }[];
  }[];
}): ProviderOption[] {
  return (payload.entries ?? [])
    .filter((entry) => entry.enabled !== false)
    .map((entry) => ({
      id: entry.provider,
      label: entry.label ? `${entry.provider}（${entry.label}）` : entry.provider,
      models: (entry.models ?? [])
        .filter((model) => model.isSelectable !== false)
        .map((model) => ({
          id: model.id,
          label: model.label,
          ...(model.isDefault ? { isDefault: true } : {}),
          ...(model.defaultThinkingOptionId
            ? { defaultThinkingOptionId: model.defaultThinkingOptionId }
            : {}),
          thinkingOptions: (model.thinkingOptions ?? []).map((option) => ({
            id: option.id,
            label: option.label,
          })),
        })),
    }));
}

const styles = StyleSheet.create({
  row: { paddingHorizontal: 16, paddingVertical: 12 },
  hint: { fontSize: 12, lineHeight: 17 },
  queueHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 6,
  },
  queueTitle: { fontSize: 14, lineHeight: 20 },
  queueCount: { fontSize: 12, lineHeight: 16 },
  queueRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingLeft: 8,
    paddingRight: 12,
    minHeight: ROW_HEIGHT,
  },
  queueRowDragging: { opacity: 0.7 },
  handle: { paddingHorizontal: 6, paddingVertical: 10, borderRadius: 6 },
  handleText: { fontSize: 15, lineHeight: 18 },
  rank: { fontSize: 12, lineHeight: 16, minWidth: 14, textAlign: "center" },
  entry: { flex: 1, gap: 2 },
  entryHeader: { flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 },
  entryTitle: { fontSize: 13, lineHeight: 18, flexShrink: 1 },
  activeDot: { width: 6, height: 6, borderRadius: 3 },
  activeLabel: { fontSize: 11, lineHeight: 15 },
  entrySub: { fontSize: 11, lineHeight: 15 },
  action: {
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderRadius: 6,
    minWidth: 30,
    alignItems: "center",
  },
  actionText: { fontSize: 14, lineHeight: 18 },
  empty: { paddingHorizontal: 16, paddingVertical: 10 },
  message: { paddingHorizontal: 16, paddingBottom: 12, fontSize: 12, lineHeight: 17 },
  failedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  failedReset: { paddingHorizontal: 8, paddingVertical: 6, borderRadius: 6 },
  failedResetText: { fontSize: 13, lineHeight: 18 },
});

function QueueRowView({
  index,
  count,
  editable,
  theme,
  title,
  details,
  active,
  note,
  noteTone,
  onMove,
  onRemove,
}: {
  index: number;
  count: number;
  editable: boolean;
  theme: Theme;
  title: string;
  details: string[];
  active: boolean;
  note: string | null;
  noteTone: "muted" | "danger";
  onMove(from: number, to: number): boolean;
  onRemove(index: number): void;
}) {
  const indexRef = useRef(index);
  indexRef.current = index;
  const moveRef = useRef(onMove);
  moveRef.current = onMove;
  const offsetRef = useRef(0);
  const draggingRef = useRef(false);
  const [dragging, setDragging] = useState(false);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_event, gesture) => Math.abs(gesture.dy) > 3,
        onPanResponderGrant: () => {
          offsetRef.current = 0;
          draggingRef.current = true;
          setDragging(true);
        },
        onPanResponderMove: (_event, gesture) => {
          const delta = gesture.dy - offsetRef.current;
          if (delta > ROW_HEIGHT / 2) {
            if (moveRef.current(indexRef.current, indexRef.current + 1)) {
              offsetRef.current += ROW_HEIGHT;
            }
          } else if (delta < -ROW_HEIGHT / 2) {
            if (moveRef.current(indexRef.current, indexRef.current - 1)) {
              offsetRef.current -= ROW_HEIGHT;
            }
          }
        },
        onPanResponderTerminationRequest: () => !draggingRef.current,
        onPanResponderRelease: () => {
          offsetRef.current = 0;
          draggingRef.current = false;
          setDragging(false);
        },
        onPanResponderTerminate: () => {
          offsetRef.current = 0;
          draggingRef.current = false;
          setDragging(false);
        },
      }),
    [],
  );

  return (
    <View style={[styles.queueRow, dragging && styles.queueRowDragging]}>
      {editable ? (
        <View
          {...responder.panHandlers}
          style={styles.handle}
          accessibilityRole="adjustable"
          accessibilityLabel={`拖动调整第 ${index + 1} 项优先级`}
        >
          <Text style={[styles.handleText, { color: theme.colors.foregroundMuted }]}>⋮⋮</Text>
        </View>
      ) : (
        <View style={styles.handle} />
      )}
      <Text style={[styles.rank, { color: theme.colors.foregroundMuted }]}>{index + 1}</Text>
      <View style={styles.entry}>
        <View style={styles.entryHeader}>
          {active ? (
            <View style={[styles.activeDot, { backgroundColor: theme.colors.statusSuccess }]} />
          ) : null}
          <Text
            numberOfLines={1}
            style={[
              styles.entryTitle,
              { color: active ? theme.colors.statusSuccess : theme.colors.foreground },
            ]}
          >
            {title}
          </Text>
          {active ? (
            <Text style={[styles.activeLabel, { color: theme.colors.statusSuccess }]}>当前</Text>
          ) : null}
        </View>
        {details.length > 0 || note ? (
          <Text
            numberOfLines={1}
            style={[
              styles.entrySub,
              {
                color:
                  noteTone === "danger"
                    ? theme.colors.statusDanger
                    : theme.colors.foregroundMuted,
              },
            ]}
          >
            {(note ? [...details, note] : details).join(" · ")}
          </Text>
        ) : null}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`上移第 ${index + 1} 项`}
        disabled={!editable || index === 0}
        onPress={() => onMove(index, index - 1)}
        style={styles.action}
      >
        <Text
          style={[
            styles.actionText,
            { color: index === 0 ? theme.colors.foregroundMuted : theme.colors.foreground },
          ]}
        >
          ↑
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`下移第 ${index + 1} 项`}
        disabled={!editable || index === count - 1}
        onPress={() => onMove(index, index + 1)}
        style={styles.action}
      >
        <Text
          style={[
            styles.actionText,
            {
              color:
                index === count - 1 ? theme.colors.foregroundMuted : theme.colors.foreground,
            },
          ]}
        >
          ↓
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`移除第 ${index + 1} 项`}
        disabled={!editable}
        onPress={() => onRemove(index)}
        style={styles.action}
      >
        <Text style={[styles.actionText, { color: theme.colors.statusDanger }]}>✕</Text>
      </Pressable>
    </View>
  );
}

export function SubagentQueueEditor({
  value,
  editable,
  theme,
  onChange,
}: {
  value: string;
  editable: boolean;
  theme: Theme;
  onChange(text: string): void;
}) {
  const paseo = usePaseo();
  const rpc = useRpc(queueStatusRpc);
  const resetRpc = useRpc(resetQueueFailuresRpc);
  const parsed = useMemo(() => parseSubagentQueue(value), [value]);
  const [rows, setRows] = useState<QueueRow[]>(() => toRows(parsed.entries));
  const [catalog, setCatalog] = useState<CatalogState>({ status: "loading" });
  const [status, setStatus] = useState<QueueStatus | null>(null);
  const [statusVersion, setStatusVersion] = useState(0);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);
  const [thinkingId, setThinkingId] = useState<string>("");
  const [adding, setAdding] = useState(false);
  const [failedOpen, setFailedOpen] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const lastValue = useRef(value);

  useEffect(() => {
    let cancelled = false;
    setCatalog({ status: "loading" });
    void paseo.providers
      .snapshot()
      .then((payload) => {
        if (cancelled) return;
        setCatalog({ status: "ready", providers: readCatalog(payload) });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setCatalog({ status: "error", message: errorText(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [paseo]);

  // 外部改了设置（保存 / 还原 / 其他客户端）时，用新值重建列表和拖动顺序。
  useEffect(() => {
    if (value === lastValue.current) return;
    lastValue.current = value;
    const next = parseSubagentQueue(value);
    setRows(toRows(next.entries));
  }, [value]);

  // 由服务端给出「当前会选中哪一项、哪些在冷却 / 不可用」，拖动或增删后重新计算。
  useEffect(() => {
    if (parsed.error) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void rpc({ entries: rows.map((row) => row.entry) })
        .then((result) => {
          if (!cancelled) setStatus(result);
        })
        .catch(() => {
          if (!cancelled) setStatus(null);
        });
    }, STATUS_REFRESH_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [rows, parsed.error, rpc, statusVersion]);

  // 当前队列里处于失败冷却中的项，供「失败记录」弹窗展示。
  const coolingEntries = useMemo(() => {
    if (!status || status.entries.length !== rows.length) return [];
    const list: { row: QueueRow; index: number; entryStatus: QueueEntryStatus }[] = [];
    rows.forEach((row, index) => {
      const entryStatus = status.entries[index];
      if (entryStatus?.state === "cooldown") list.push({ row, index, entryStatus });
    });
    return list;
  }, [rows, status]);

  const resetFailures = useCallback(
    (keys?: string[]) => {
      setResetError(null);
      void resetRpc(keys ? { keys } : {})
        .then(() => {
          setStatusVersion((version) => version + 1);
        })
        .catch((error: unknown) => {
          setResetError(errorText(error));
        });
    },
    [resetRpc],
  );

  const commit = useCallback(
    (next: QueueRow[]) => {
      setRows(next);
      const serialized = JSON.stringify(next.map((row) => row.entry));
      lastValue.current = serialized;
      onChange(serialized);
    },
    [onChange],
  );

  const catalogProviders = catalog.status === "ready" ? catalog.providers : [];

  const describe = useCallback(
    (entry: SubagentQueueEntry) => {
      if (isInheritEntry(entry)) {
        return { title: INHERIT_LABEL, details: ["使用父 agent 的 provider/model/mode/思考"] };
      }
      const provider = catalogProviders.find((candidate) => candidate.id === entry.provider);
      const model = entry.model
        ? provider?.models.find((candidate) => candidate.id === entry.model)
        : undefined;
      const modelLabel = model?.label ?? entry.model;
      const title = entry.model
        ? `${entry.provider} / ${modelLabel}`
        : provider
          ? `${entry.provider}（${provider.label}）`
          : entry.provider;
      const details = [
        model && modelLabel !== entry.model ? entry.model : null,
        entry.modeId ? `模式 ${entry.modeId}` : null,
        entry.thinkingOptionId ? `思考 ${entry.thinkingOptionId}` : null,
      ].filter((value): value is string => Boolean(value));
      return { title, details };
    },
    [catalogProviders],
  );

  // 目录加载完成后选一个默认 provider/model。
  useEffect(() => {
    if (catalog.status !== "ready") return;
    const first = catalog.providers[0];
    if (!first) return;
    setProviderId((current) =>
      current && catalog.providers.some((provider) => provider.id === current) ? current : first.id,
    );
  }, [catalog]);

  const activeProvider = useMemo(
    () => catalogProviders.find((provider) => provider.id === providerId),
    [catalogProviders, providerId],
  );

  useEffect(() => {
    if (!activeProvider) return;
    const models = activeProvider.models;
    setModelId((current) =>
      current && models.some((model) => model.id === current)
        ? current
        : (models.find((model) => model.isDefault) ?? models[0])?.id ?? null,
    );
  }, [activeProvider]);

  const activeModel = useMemo(
    () => activeProvider?.models.find((model) => model.id === modelId),
    [activeProvider, modelId],
  );

  useEffect(() => {
    setThinkingId((current) =>
      current && activeModel?.thinkingOptions.some((option) => option.id === current)
        ? current
        : "",
    );
  }, [activeModel]);

  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const move = useCallback(
    (from: number, to: number): boolean => {
      if (!editable) return false;
      const current = rowsRef.current;
      if (to < 0 || to >= current.length || from === to) return false;
      const next = [...current];
      const [row] = next.splice(from, 1);
      if (!row) return false;
      next.splice(to, 0, row);
      commit(next);
      return true;
    },
    [editable, commit],
  );

  const remove = useCallback(
    (index: number) => {
      const next = rows.filter((_, i) => i !== index);
      commit(next);
    },
    [rows, commit],
  );

  const add = useCallback(() => {
    if (!activeProvider || !activeModel) return;
    const entry: SubagentModelEntry = {
      provider: activeProvider.id,
      model: activeModel.id,
      ...(thinkingId ? { thinkingOptionId: thinkingId } : {}),
    };
    commit([...rows, { id: `row-${++rowSeq}`, entry }]);
    setAdding(false);
    setThinkingId("");
  }, [activeProvider, activeModel, thinkingId, rows, commit]);

  const addInherit = useCallback(() => {
    const entry: SubagentQueueEntry = { inherit: true };
    commit([...rows, { id: `row-${++rowSeq}`, entry }]);
    setAdding(false);
  }, [rows, commit]);

  const providerOptions = useMemo(
    () => catalogProviders.map((provider) => ({ label: provider.label, value: provider.id })),
    [catalogProviders],
  );
  const modelOptions = useMemo(
    () =>
      (activeProvider?.models ?? []).map((model) => ({
        label: model.label === model.id ? model.id : `${model.label}（${model.id}）`,
        value: model.id,
      })),
    [activeProvider],
  );
  const thinkingOptions = useMemo(
    () => [
      { label: "默认", value: "" },
      ...(activeModel?.thinkingOptions ?? []).map((option) => ({
        label: option.label,
        value: option.id,
      })),
    ],
    [activeModel],
  );

  const addDisabled = !editable || !activeProvider || !activeModel;

  return (
    <View>
      <View style={styles.queueHeader}>
        <Text style={[styles.queueTitle, { color: theme.colors.foreground }]}>模型队列</Text>
        <Text style={[styles.queueCount, { color: theme.colors.foregroundMuted }]}>
          {rows.length} 项 · 拖动 ⋮⋮ 排序，越靠上优先级越高
        </Text>
      </View>
      {parsed.error ? (
        <View style={styles.row}>
          <Text style={[styles.hint, { color: theme.colors.statusDanger }]}>
            队列数据无法解析：{parsed.error}
          </Text>
        </View>
      ) : null}
      {rows.length === 0 ? (
        <Text style={[styles.empty, styles.hint, { color: theme.colors.foregroundMuted }]}>
          队列为空，创建子代理时会回退到继承父 agent。
        </Text>
      ) : (
        rows.map((row, index) => {
          const { title, details } = describe(row.entry);
          const entryStatus =
            status && status.entries.length === rows.length ? status.entries[index] : undefined;
          const active = Boolean(entryStatus) && status?.activeIndex === index;
          let note: string | null = null;
          let noteTone: "muted" | "danger" = "muted";
          if (entryStatus?.state === "cooldown" && entryStatus.retryAt) {
            note = `冷却中 · 剩余 ${formatRemaining(entryStatus.retryAt)}`;
          } else if (entryStatus?.state === "unavailable") {
            note = entryStatus.detail ? `不可用：${entryStatus.detail}` : "不可用";
            noteTone = "danger";
          }
          return (
            <QueueRowView
              key={row.id}
              index={index}
              count={rows.length}
              editable={editable}
              theme={theme}
              title={title}
              details={details}
              active={active}
              note={note}
              noteTone={noteTone}
              onMove={move}
              onRemove={remove}
            />
          );
        })
      )}
      {status && rows.length > 0 && status.entries.length === rows.length && status.activeIndex === null ? (
        <Text style={[styles.message, { color: theme.colors.foregroundMuted }]}>
          当前没有可用项（冷却中或 provider 不可用），创建子代理时会回退到继承父 agent。
        </Text>
      ) : null}
      {status?.error ? (
        <Text style={[styles.message, { color: theme.colors.statusDanger }]}>
          无法获取队列状态：{status.error}
        </Text>
      ) : null}
      <SettingsAction
        label="失败记录"
        hint={
          coolingEntries.length > 0
            ? `${coolingEntries.length} 项失败冷却中，可查看失败时间并手动重置`
            : "队列项创建失败、或子代理运行失败后会记录在这里"
        }
        actionLabel="查看"
        onPress={() => setFailedOpen(true)}
      />
      {editable ? (
        <SettingsAction
          label="添加队列项"
          hint="选择 provider/模型，或添加「继承父 agent」；添加后可用 ⋮⋮ 拖动排序"
          actionLabel="添加"
          onPress={() => setAdding(true)}
        />
      ) : null}
      {parsed.error && editable ? (
        <SettingsAction
          label="清空无法解析的队列数据"
          actionLabel="清空"
          onPress={() => commit([])}
        />
      ) : null}
      <Modal title="失败记录" open={failedOpen} onOpenChange={setFailedOpen}>
        <Modal.Content>
          {coolingEntries.length === 0 ? (
            <Text style={[styles.hint, { color: theme.colors.foregroundMuted }]}>
              当前没有处于失败冷却中的队列项。
            </Text>
          ) : (
            coolingEntries.map(({ row, index, entryStatus }) => (
              <View key={row.id} style={styles.failedRow}>
                <View style={styles.entry}>
                  <Text
                    numberOfLines={1}
                    style={[styles.entryTitle, { color: theme.colors.foreground }]}
                  >
                    {index + 1}. {describe(row.entry).title}
                  </Text>
                  <Text style={[styles.entrySub, { color: theme.colors.foregroundMuted }]}>
                    失败于 {formatTime(entryStatus.failedAt)}
                    {entryStatus.retryAt
                      ? ` · ${formatRemaining(entryStatus.retryAt)} 后自动恢复`
                      : ""}
                  </Text>
                </View>
                {editable ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`重置第 ${index + 1} 项的失败记录`}
                    onPress={() => resetFailures([entryStatus.key])}
                    style={styles.failedReset}
                  >
                    <Text style={[styles.failedResetText, { color: theme.colors.accent }]}>
                      重置
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            ))
          )}
          <SettingsAction
            label="重置全部失败记录"
            hint="清除后队列立即恢复按顺序选择，对已移出队列的项同样生效"
            actionLabel="重置"
            disabled={!editable}
            onPress={() => resetFailures()}
          />
          {resetError ? (
            <Text style={[styles.message, { color: theme.colors.statusDanger }]}>
              重置失败：{resetError}
            </Text>
          ) : null}
        </Modal.Content>
      </Modal>
      <Modal title="添加模型队列项" open={adding} onOpenChange={setAdding}>
        <Modal.Content>
          <SettingsAction
            label="继承父 agent 配置"
            hint="复用父 agent 当前的 provider/model/mode/思考；继承总是可用，通常放最后作兜底"
            actionLabel="添加"
            onPress={addInherit}
          />
          {catalog.status === "loading" ? (
            <Text style={[styles.hint, { color: theme.colors.foregroundMuted }]}>
              正在加载可用的 provider 与模型…
            </Text>
          ) : catalog.status === "error" ? (
            <Text style={[styles.hint, { color: theme.colors.statusDanger }]}>
              加载 provider 目录失败：{catalog.message}
            </Text>
          ) : catalogProviders.length === 0 ? (
            <Text style={[styles.hint, { color: theme.colors.foregroundMuted }]}>
              没有已启用的 provider，仍可添加「继承父 agent」。
            </Text>
          ) : (
            <>
              <SettingsSelect
                label="Provider"
                value={providerId ?? ""}
                options={providerOptions}
                onValueChange={(next) => {
                  setProviderId(next);
                  setModelId(null);
                  setThinkingId("");
                }}
              />
              <SettingsSelect
                label="模型"
                value={modelId ?? ""}
                options={modelOptions}
                disabled={!activeProvider || modelOptions.length === 0}
                onValueChange={(next) => {
                  setModelId(next);
                  setThinkingId("");
                }}
              />
              {activeModel && activeModel.thinkingOptions.length > 0 ? (
                <SettingsSelect
                  label="思考档位"
                  hint="留空使用模型默认档位"
                  value={thinkingId}
                  options={thinkingOptions}
                  onValueChange={setThinkingId}
                />
              ) : null}
              <SettingsAction
                label="添加到队列末尾"
                actionLabel="添加"
                disabled={addDisabled}
                onPress={add}
              />
            </>
          )}
        </Modal.Content>
      </Modal>
    </View>
  );
}
