import { usePaseo, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { Icon, Modal, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import type { CheckpointRecord, RestoreOutput } from "../shared/edit-details";
import { buildDiff, rowsFromUnified, type DiffRow } from "./diff";
import {
  ensureAgentTracked,
  fetchCheckpoints,
  getAgentChanges,
  refreshAgent,
  restoreAgentCheckpoint,
  subscribeAgentChanges,
  type AgentChangesState,
  type ChangeRecord,
  type FileChangeState,
} from "./store";

type PanelTheme = PluginAgentPanelProps["theme"];

const MONO_FONT = Platform.select({
  ios: "ui-monospace",
  default: "monospace",
  web: "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
});

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function formatTime(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function formatStamp(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${formatTime(at)}`;
}

function splitPath(filePath: string): { name: string; dir: string } {
  const normalized = filePath.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index === -1) return { name: normalized, dir: "" };
  return { name: normalized.slice(index + 1), dir: normalized.slice(0, index) };
}

/** status colors are #rrggbb, so a trailing alpha byte yields a light fill */
function tint(color: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? `${color}29` : color;
}

function recordRows(record: ChangeRecord): DiffRow[] {
  if (record.kind === "edit" && (record.oldText !== undefined || record.newText !== undefined)) {
    return buildDiff(record.oldText, record.newText).rows;
  }
  if (record.kind === "write" && record.newText !== undefined) {
    return buildDiff("", record.newText).rows;
  }
  if (record.unifiedDiff) return rowsFromUnified(record.unifiedDiff);
  return [];
}

function recordTitle(record: ChangeRecord, index: number): string {
  if (record.kind === "write") return index === 0 ? "整文件写入" : `写入 ${index + 1}`;
  return `修改 ${index + 1}`;
}

function statusLabel(record: ChangeRecord): string | null {
  if (record.status === "completed") return null;
  if (record.status === "running") return "进行中";
  if (record.status === "failed") return "失败";
  return "已取消";
}

function useStyles(theme: PanelTheme, compact: boolean) {
  return useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      header: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingHorizontal: compact ? 12 : 16,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderColor: theme.colors.border,
      },
      headerTitle: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
      headerMetaRow: {
        flex: 1,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
      },
      refreshButton: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 4,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        paddingHorizontal: 10,
        paddingVertical: 5,
      },
      refreshText: { color: theme.colors.foreground, fontSize: 12 },
      empty: {
        flex: 1,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        padding: compact ? 24 : 40,
        gap: 8,
      },
      emptyTitle: { color: theme.colors.foreground, fontSize: 14 },
      emptyNote: {
        color: theme.colors.foregroundMuted,
        fontSize: 12,
        lineHeight: 18,
        textAlign: "center" as const,
      },
      listContent: { paddingHorizontal: compact ? 8 : 12, paddingVertical: 8, gap: 2 },
      fileRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingVertical: 8,
        paddingHorizontal: 8,
        borderRadius: 8,
      },
      fileIcon: { marginTop: 1 },
      fileText: { flex: 1 },
      fileName: { color: theme.colors.foreground, fontSize: 13 },
      fileDir: { color: theme.colors.foregroundMuted, fontSize: 11, marginTop: 1 },
      fileCounts: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      statAdd: { color: theme.colors.statusSuccess, fontSize: 12 },
      statDel: { color: theme.colors.statusDanger, fontSize: 12 },
      backRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        paddingHorizontal: compact ? 12 : 16,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderColor: theme.colors.border,
      },
      backText: { color: theme.colors.foreground, fontSize: 13 },
      detailHeader: {
        paddingHorizontal: compact ? 12 : 16,
        paddingVertical: 10,
        gap: 4,
        borderBottomWidth: 1,
        borderColor: theme.colors.border,
      },
      detailPath: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
      detailMetaRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
      },
      detailMeta: { color: theme.colors.foregroundMuted, fontSize: 12 },
      recordBlock: {
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        overflow: "hidden" as const,
      },
      recordHeader: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingHorizontal: 10,
        paddingVertical: 7,
        backgroundColor: theme.colors.surface1,
      },
      recordTitle: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" as const },
      recordStatus: { color: theme.colors.foregroundMuted, fontSize: 11 },
      recordStatusFailed: { color: theme.colors.statusDanger, fontSize: 11 },
      recordTime: { color: theme.colors.foregroundMuted, fontSize: 11, flex: 1, textAlign: "right" as const },
      diffBlock: { backgroundColor: theme.colors.surface0 },
      diffRow: { flexDirection: "row" as const, alignItems: "flex-start" as const },
      rowAdd: { backgroundColor: tint(theme.colors.statusSuccess) },
      rowDel: { backgroundColor: tint(theme.colors.statusDanger) },
      gapRow: { paddingVertical: 3, paddingHorizontal: 10, backgroundColor: theme.colors.surface1 },
      gapText: { color: theme.colors.foregroundMuted, fontSize: 11 },
      gutter: {
        width: 16,
        textAlign: "center" as const,
        fontFamily: MONO_FONT,
        fontSize: 11,
        lineHeight: 18,
        color: theme.colors.foregroundMuted,
      },
      gutterAdd: { color: theme.colors.statusSuccess },
      gutterDel: { color: theme.colors.statusDanger },
      lineNo: {
        width: 34,
        textAlign: "right" as const,
        paddingRight: 6,
        fontFamily: MONO_FONT,
        fontSize: 11,
        lineHeight: 18,
        color: theme.colors.foregroundMuted,
      },
      code: {
        flex: 1,
        fontFamily: MONO_FONT,
        fontSize: 11,
        lineHeight: 18,
        color: theme.colors.foreground,
        paddingRight: 8,
      },
      unavailable: { color: theme.colors.foregroundMuted, fontSize: 12, padding: 10 },
      resultBlock: { padding: 10, gap: 6, backgroundColor: theme.colors.surface0 },
      resultNote: { color: theme.colors.foregroundMuted, fontSize: 11 },
      resultText: { fontFamily: MONO_FONT, fontSize: 11, lineHeight: 17, color: theme.colors.foreground },
      tabRow: {
        flexDirection: "row" as const,
        gap: 6,
        paddingHorizontal: compact ? 8 : 10,
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderColor: theme.colors.border,
      },
      tabButton: {
        borderRadius: 8,
        borderWidth: 1,
        borderColor: "transparent",
        paddingHorizontal: 10,
        paddingVertical: 5,
      },
      tabButtonActive: {
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
      },
      tabText: { color: theme.colors.foregroundMuted, fontSize: 12 },
      tabTextActive: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" as const },
      checkpointBlock: {
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        overflow: "hidden" as const,
      },
      checkpointHeader: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        backgroundColor: theme.colors.surface1,
      },
      checkpointToggle: {
        flex: 1,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
      },
      checkpointTexts: { flex: 1 },
      checkpointTime: {
        color: theme.colors.foreground,
        fontSize: 12,
        fontWeight: "600" as const,
        fontFamily: MONO_FONT,
      },
      checkpointMeta: { color: theme.colors.foregroundMuted, fontSize: 11, marginTop: 1 },
      restoreButton: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 4,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        paddingHorizontal: 10,
        paddingVertical: 5,
        backgroundColor: theme.colors.surface0,
      },
      restoreText: { color: theme.colors.foreground, fontSize: 12 },
      busyDim: { opacity: 0.5 },
      checkpointFiles: { paddingVertical: 4, paddingHorizontal: 6 },
      checkpointFileRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingHorizontal: 6,
        paddingVertical: 5,
      },
      checkpointFileText: { flex: 1 },
      checkpointFileName: { color: theme.colors.foreground, fontSize: 12 },
      checkpointFileDir: { color: theme.colors.foregroundMuted, fontSize: 11, marginTop: 1 },
      checkpointFileMark: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        fontFamily: MONO_FONT,
      },
      checkpointFileMarkNew: { color: theme.colors.statusWarning, fontSize: 11 },
      modalSummary: { color: theme.colors.foreground, fontSize: 13 },
      modalNote: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 },
      modalWarn: { color: theme.colors.statusWarning, fontSize: 12, lineHeight: 18 },
      modalOk: { color: theme.colors.statusSuccess, fontSize: 13, fontWeight: "600" as const },
      modalErr: { color: theme.colors.statusDanger, fontSize: 12, lineHeight: 18 },
      modalBusy: { color: theme.colors.foregroundMuted, fontSize: 12 },
      skippedLine: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        lineHeight: 16,
        fontFamily: MONO_FONT,
      },
      modalButtons: {
        flexDirection: "row" as const,
        justifyContent: "flex-end" as const,
        gap: 8,
      },
      modalButton: {
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        paddingHorizontal: 14,
        paddingVertical: 8,
      },
      modalButtonPrimary: {
        backgroundColor: theme.colors.accent,
        borderColor: theme.colors.accent,
      },
      modalButtonText: { color: theme.colors.foreground, fontSize: 13 },
      modalButtonTextPrimary: {
        color: theme.colors.accentForeground,
        fontSize: 13,
        fontWeight: "600" as const,
      },
    }),
    [theme, compact],
  );
}

type PanelStyles = ReturnType<typeof useStyles>;

function DiffRows({ rows, styles }: { rows: DiffRow[]; styles: PanelStyles }) {
  return (
    <View>
      {rows.map((row, index) => {
        if (row.kind === "gap") {
          return (
            <View key={index} style={styles.gapRow}>
              <Text style={styles.gapText}>{row.text}</Text>
            </View>
          );
        }
        const rowStyle = row.kind === "add" ? styles.rowAdd : row.kind === "del" ? styles.rowDel : null;
        return (
          <View key={index} style={[styles.diffRow, rowStyle]}>
            <Text
              style={[
                styles.gutter,
                row.kind === "add" && styles.gutterAdd,
                row.kind === "del" && styles.gutterDel,
              ]}
            >
              {row.kind === "add" ? "+" : row.kind === "del" ? "-" : " "}
            </Text>
            <Text style={styles.lineNo}>{row.oldNo ?? ""}</Text>
            <Text style={styles.lineNo}>{row.newNo ?? ""}</Text>
            <Text style={styles.code}>{row.text}</Text>
          </View>
        );
      })}
    </View>
  );
}

function RecordBlock({ record, index, styles }: { record: ChangeRecord; index: number; styles: PanelStyles }) {
  const rows = recordRows(record);
  const status = statusLabel(record);
  return (
    <View style={styles.recordBlock}>
      <View style={styles.recordHeader}>
        <Text style={styles.recordTitle}>{recordTitle(record, index)}</Text>
        {status ? (
          <Text style={record.status === "failed" ? styles.recordStatusFailed : styles.recordStatus}>
            {status}
          </Text>
        ) : null}
        {record.adds > 0 ? <Text style={styles.statAdd}>+{record.adds}</Text> : null}
        {record.dels > 0 ? <Text style={styles.statDel}>-{record.dels}</Text> : null}
        <Text style={styles.recordTime}>{formatTime(record.at)}</Text>
      </View>
      {rows.length > 0 ? (
        <DiffRows rows={rows} styles={styles} />
      ) : record.unifiedDiff ? (
        <View style={styles.resultBlock}>
          <Text style={styles.resultNote}>未解析出行级差异（该提供方可能未上报），以下为工具返回内容：</Text>
          <Text style={styles.resultText}>{record.unifiedDiff}</Text>
        </View>
      ) : (
        <Text style={styles.unavailable}>
          {record.kind === "write" ? "该提供方未上报文件内容。" : "该提供方未上报修改前后的文本。"}
        </Text>
      )}
    </View>
  );
}

function FileDetail({
  file,
  styles,
  theme,
  onBack,
}: {
  file: FileChangeState;
  styles: PanelStyles;
  theme: PanelTheme;
  onBack: () => void;
}) {
  return (
    <View style={{ flex: 1 }}>
      <Pressable accessibilityRole="button" onPress={onBack} style={styles.backRow}>
        <Icon name="ArrowLeft" size={14} color={theme.colors.foreground} />
        <Text style={styles.backText}>全部文件</Text>
      </Pressable>
      <View style={styles.detailHeader}>
        <Text style={styles.detailPath}>{file.filePath}</Text>
        <View style={styles.detailMetaRow}>
          <Text style={styles.detailMeta}>{file.records.length} 次修改</Text>
          {file.adds > 0 ? <Text style={styles.statAdd}>+{file.adds}</Text> : null}
          {file.dels > 0 ? <Text style={styles.statDel}>-{file.dels}</Text> : null}
        </View>
      </View>
      <ScrollView contentContainerStyle={{ padding: 10, gap: 10 }}>
        {file.records.map((record, index) => (
          <RecordBlock key={`${record.callId}-${index}`} record={record} index={index} styles={styles} />
        ))}
      </ScrollView>
    </View>
  );
}

function FileList({
  changes,
  styles,
  theme,
  refreshing,
  onRefresh,
  onOpen,
}: {
  changes: AgentChangesState;
  styles: PanelStyles;
  theme: PanelTheme;
  refreshing: boolean;
  onRefresh: () => void;
  onOpen: (filePath: string) => void;
}) {
  const title = changes.fileCount > 0 ? `${changes.fileCount} 个文件` : "会话文件变更";
  return (
    <View style={{ flex: 1 }}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{title}</Text>
        <View style={styles.headerMetaRow}>
          {changes.adds > 0 ? <Text style={styles.statAdd}>+{changes.adds}</Text> : null}
          {changes.dels > 0 ? <Text style={styles.statDel}>-{changes.dels}</Text> : null}
        </View>
        <Pressable accessibilityRole="button" onPress={onRefresh} style={styles.refreshButton}>
          <Icon name="RefreshCw" size={13} color={theme.colors.foreground} />
          <Text style={styles.refreshText}>{refreshing ? "扫描中…" : "重新扫描"}</Text>
        </Pressable>
      </View>
      {changes.fileCount === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>本会话暂无文件修改</Text>
          <Text style={styles.emptyNote}>
            数据来自聊天时间线中的编辑类工具调用（与编辑卡片同源），不依赖 git。{"\n"}
            通过 Shell 命令修改的文件不会出现在这里。
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.listContent}>
          {changes.files.map((file) => {
            const { name, dir } = splitPath(file.filePath);
            return (
              <Pressable
                key={file.filePath}
                accessibilityRole="button"
                onPress={() => onOpen(file.filePath)}
                style={styles.fileRow}
              >
                <View style={styles.fileIcon}>
                  <Icon
                    name={file.records[0]?.kind === "write" && file.records.length === 1 ? "FilePlus2" : "FileDiff"}
                    size={15}
                    color={theme.colors.foregroundMuted}
                  />
                </View>
                <View style={styles.fileText}>
                  <Text numberOfLines={1} style={styles.fileName}>
                    {name}
                    {file.records.length > 1 ? `  ×${file.records.length}` : ""}
                  </Text>
                  {dir ? (
                    <Text numberOfLines={1} style={styles.fileDir}>
                      {dir}
                    </Text>
                  ) : null}
                </View>
                <View style={styles.fileCounts}>
                  {file.adds > 0 ? <Text style={styles.statAdd}>+{file.adds}</Text> : null}
                  {file.dels > 0 ? <Text style={styles.statDel}>-{file.dels}</Text> : null}
                </View>
                <Icon name="ChevronRight" size={14} color={theme.colors.foregroundMuted} />
              </Pressable>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

function RestoreModal({
  checkpoint,
  agentId,
  styles,
  onClose,
}: {
  checkpoint: CheckpointRecord;
  agentId: string;
  styles: PanelStyles;
  onClose: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RestoreOutput | null>(null);
  const [error, setError] = useState<string | null>(null);

  const newCount = checkpoint.files.filter((file) => !file.backupFileName).length;

  const handleRestore = useCallback(() => {
    setRunning(true);
    setError(null);
    restoreAgentCheckpoint(agentId, checkpoint.id)
      .then((output) => setResult(output))
      .catch((restoreError: unknown) => {
        setError(restoreError instanceof Error ? restoreError.message : "恢复失败");
      })
      .finally(() => setRunning(false));
  }, [agentId, checkpoint.id]);

  return (
    <Modal
      title="恢复到此记录点"
      open
      onOpenChange={(open) => {
        if (!open && !running) onClose();
      }}
    >
      <Modal.Content>
        {result ? (
          <>
            <Text style={styles.modalOk}>已恢复 {result.restored.length} 个文件。</Text>
            {result.skipped.length > 0 ? (
              <>
                <Text style={styles.modalWarn}>
                  跳过 {result.skipped.length} 个（未改动其当前内容）：
                </Text>
                {result.skipped.map((item) => (
                  <Text key={item.path} style={styles.skippedLine}>
                    {item.path}：{item.reason}
                  </Text>
                ))}
              </>
            ) : null}
            <View style={styles.modalButtons}>
              <Pressable
                accessibilityRole="button"
                onPress={onClose}
                style={[styles.modalButton, styles.modalButtonPrimary]}
              >
                <Text style={styles.modalButtonTextPrimary}>完成</Text>
              </Pressable>
            </View>
          </>
        ) : (
          <>
            <Text style={styles.modalSummary}>
              {formatStamp(checkpoint.at)} · {checkpoint.files.length} 个文件
            </Text>
            <Text style={styles.modalNote}>
              把这些文件在该记录点时记录的内容写回工作目录，当前内容会被覆盖。此操作不依赖
              git，无法自动撤销，请确认后再继续。
            </Text>
            {newCount > 0 ? (
              <Text style={styles.modalWarn}>
                其中 {newCount} 个文件在该记录点尚不存在（本会话新建），恢复时将跳过，不会删除文件。
              </Text>
            ) : null}
            {error ? <Text style={styles.modalErr}>{error}</Text> : null}
            {running ? <Text style={styles.modalBusy}>正在恢复…</Text> : null}
            <View style={styles.modalButtons}>
              <Pressable
                accessibilityRole="button"
                disabled={running}
                onPress={onClose}
                style={[styles.modalButton, running && styles.busyDim]}
              >
                <Text style={styles.modalButtonText}>取消</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={running}
                onPress={handleRestore}
                style={[styles.modalButton, styles.modalButtonPrimary, running && styles.busyDim]}
              >
                <Text style={styles.modalButtonTextPrimary}>{running ? "恢复中…" : "确认恢复"}</Text>
              </Pressable>
            </View>
          </>
        )}
      </Modal.Content>
    </Modal>
  );
}

function CheckpointsView({
  agentId,
  styles,
  theme,
}: {
  agentId: string;
  styles: PanelStyles;
  theme: PanelTheme;
}) {
  const [checkpoints, setCheckpoints] = useState<CheckpointRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<CheckpointRecord | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    setError(null);
    try {
      const list = await fetchCheckpoints(agentId);
      setCheckpoints(list);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "加载记录点失败");
    } finally {
      setRefreshing(false);
    }
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const ordered = useMemo(
    () => (checkpoints ? [...checkpoints].reverse() : []),
    [checkpoints],
  );

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>
          {checkpoints ? `${checkpoints.length} 个记录点` : "记录点"}
        </Text>
        <View style={styles.headerMetaRow} />
        <Pressable accessibilityRole="button" onPress={() => void load()} style={styles.refreshButton}>
          <Icon name="RefreshCw" size={13} color={theme.colors.foreground} />
          <Text style={styles.refreshText}>{refreshing ? "加载中…" : "刷新"}</Text>
        </Pressable>
      </View>
      {error ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>记录点加载失败</Text>
          <Text style={styles.emptyNote}>{error}</Text>
        </View>
      ) : checkpoints === null ? (
        <View style={styles.empty}>
          <Text style={styles.emptyNote}>正在读取记录点…</Text>
        </View>
      ) : checkpoints.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>暂无记录点</Text>
          <Text style={styles.emptyNote}>
            每次向该会话发送消息时，CLI 会为已跟踪的文件生成一次记录点。{"\n"}
            发送一条消息后再回来查看。
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.listContent}>
          {ordered.map((checkpoint) => {
            const expanded = expandedId === checkpoint.id;
            const newCount = checkpoint.files.filter((file) => !file.backupFileName).length;
            return (
              <View key={checkpoint.id} style={styles.checkpointBlock}>
                <View style={styles.checkpointHeader}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => setExpandedId(expanded ? null : checkpoint.id)}
                    style={styles.checkpointToggle}
                  >
                    <Icon
                      name={expanded ? "ChevronDown" : "ChevronRight"}
                      size={14}
                      color={theme.colors.foregroundMuted}
                    />
                    <View style={styles.checkpointTexts}>
                      <Text style={styles.checkpointTime}>{formatStamp(checkpoint.at)}</Text>
                      <Text style={styles.checkpointMeta}>
                        {checkpoint.files.length} 个文件
                        {newCount > 0 ? ` · ${newCount} 个新建` : ""}
                      </Text>
                    </View>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => setRestoreTarget(checkpoint)}
                    style={styles.restoreButton}
                  >
                    <Icon name="History" size={13} color={theme.colors.foreground} />
                    <Text style={styles.restoreText}>恢复</Text>
                  </Pressable>
                </View>
                {expanded ? (
                  <View style={styles.checkpointFiles}>
                    {checkpoint.files.map((file) => {
                      const { name, dir } = splitPath(file.path);
                      return (
                        <View key={file.path} style={styles.checkpointFileRow}>
                          <View style={styles.checkpointFileText}>
                            <Text numberOfLines={1} style={styles.checkpointFileName}>
                              {name}
                            </Text>
                            {dir ? (
                              <Text numberOfLines={1} style={styles.checkpointFileDir}>
                                {dir}
                              </Text>
                            ) : null}
                          </View>
                          {file.backupFileName ? (
                            <Text style={styles.checkpointFileMark}>{`v${file.version}`}</Text>
                          ) : (
                            <Text style={styles.checkpointFileMarkNew}>新建</Text>
                          )}
                        </View>
                      );
                    })}
                  </View>
                ) : null}
              </View>
            );
          })}
        </ScrollView>
      )}
      {restoreTarget ? (
        <RestoreModal
          key={restoreTarget.id}
          checkpoint={restoreTarget}
          agentId={agentId}
          styles={styles}
          onClose={() => setRestoreTarget(null)}
        />
      ) : null}
    </View>
  );
}

export function ChangesPanel({ theme, layout, agentId }: PluginAgentPanelProps) {
  const paseo = usePaseo();
  const [changes, setChanges] = useState<AgentChangesState>(() => getAgentChanges(agentId));
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [view, setView] = useState<"changes" | "checkpoints">("changes");

  useEffect(() => {
    ensureAgentTracked(paseo, agentId);
    setChanges(getAgentChanges(agentId));
    return subscribeAgentChanges(agentId, () => setChanges(getAgentChanges(agentId)));
  }, [paseo, agentId]);

  const selected = selectedPath
    ? changes.files.find((file) => file.filePath === selectedPath) ?? null
    : null;

  const handleBack = useCallback(() => setSelectedPath(null), []);
  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    void refreshAgent(paseo, agentId).finally(() => setRefreshing(false));
  }, [paseo, agentId]);

  const styles = useStyles(theme, layout.compact);

  return (
    <View style={styles.screen}>
      {view === "changes" && selected ? (
        <FileDetail file={selected} styles={styles} theme={theme} onBack={handleBack} />
      ) : (
        <>
          <View style={styles.tabRow}>
            <Pressable
              accessibilityRole="button"
              onPress={() => setView("changes")}
              style={[styles.tabButton, view === "changes" && styles.tabButtonActive]}
            >
              <Text style={[styles.tabText, view === "changes" && styles.tabTextActive]}>
                文件变更
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => setView("checkpoints")}
              style={[styles.tabButton, view === "checkpoints" && styles.tabButtonActive]}
            >
              <Text style={[styles.tabText, view === "checkpoints" && styles.tabTextActive]}>
                记录点
              </Text>
            </Pressable>
          </View>
          {view === "changes" ? (
            <FileList
              changes={changes}
              styles={styles}
              theme={theme}
              refreshing={refreshing}
              onRefresh={handleRefresh}
              onOpen={setSelectedPath}
            />
          ) : (
            <CheckpointsView agentId={agentId} styles={styles} theme={theme} />
          )}
        </>
      )}
    </View>
  );
}
