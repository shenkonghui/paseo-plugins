import {
  openExternalUrl,
  useRpc,
  useSettings,
  type PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import { copyText, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  buildAccessUrl,
  forwardRulesDocument,
  makeRuleId,
  restartRpc,
  scanRpc,
  statusRpc,
  type ForwardRule,
  type ForwardState,
  type ScannedPort,
} from "../shared/rules";
import { emptyDraft, RuleModal, validateDraft, type RuleDraft } from "./rule-modal";

type Theme = PluginSurfaceProps["theme"];

interface StatusData {
  states: ForwardState[];
  hostname: string;
  hostIps: string[];
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function suggestListenPort(port: number): string {
  const candidate = port + 10000 <= 65535 ? port + 10000 : port > 10000 ? port - 10000 : 18080;
  return String(candidate);
}

function targetHostForScanned(port: ScannedPort): string {
  // 0.0.0.0/:: 表示监听所有网卡，转发目标用回环地址即可；其余绑定地址原样使用。
  return port.host === "0.0.0.0" ? "127.0.0.1" : port.host;
}

function useStyles(theme: Theme, compact: boolean) {
  return useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      centered: { flex: 1, alignItems: "center" as const, justifyContent: "center" as const },
      muted: { color: theme.colors.foregroundMuted },
      error: { color: theme.colors.statusDanger },
      toolbar: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        paddingHorizontal: compact ? 12 : 20,
        paddingTop: compact ? 12 : 20,
        gap: 8,
      },
      tabs: {
        flexDirection: "row" as const,
        backgroundColor: theme.colors.surface2,
        borderRadius: 8,
        padding: 2,
      },
      tab: { borderRadius: 6, paddingHorizontal: 12, paddingVertical: 6 },
      tabActive: {
        borderRadius: 6,
        paddingHorizontal: 12,
        paddingVertical: 6,
        backgroundColor: theme.colors.surface0,
      },
      tabText: { color: theme.colors.foregroundMuted, fontSize: 13 },
      tabTextActive: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
      spacer: { flex: 1 },
      ghostButton: {
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        paddingHorizontal: 10,
        paddingVertical: 6,
      },
      ghostButtonText: { color: theme.colors.foreground, fontSize: 13 },
      primaryButton: {
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 7,
        backgroundColor: theme.colors.accent,
      },
      primaryButtonText: {
        color: theme.colors.accentForeground,
        fontSize: 13,
        fontWeight: "600" as const,
      },
      listContent: { paddingHorizontal: compact ? 12 : 20, paddingBottom: 24, gap: 10 },
      hostRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        flexWrap: "wrap" as const,
        paddingHorizontal: compact ? 12 : 20,
        paddingTop: 10,
      },
      hostChip: {
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        paddingHorizontal: 8,
        paddingVertical: 4,
      },
      hostChipActive: {
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.accent,
        backgroundColor: theme.colors.surface2,
        paddingHorizontal: 8,
        paddingVertical: 4,
      },
      hostChipText: { color: theme.colors.foreground, fontSize: 12 },
      card: {
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        padding: 12,
        gap: 6,
      },
      cardTitleRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      statusDot: { width: 8, height: 8, borderRadius: 4 },
      cardTitle: {
        color: theme.colors.foreground,
        fontSize: 14,
        fontWeight: "600" as const,
        flex: 1,
      },
      badge: {
        borderRadius: 6,
        paddingHorizontal: 6,
        paddingVertical: 2,
        backgroundColor: theme.colors.surface2,
      },
      badgeText: { color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" as const },
      route: { color: theme.colors.foreground, fontSize: 13 },
      meta: { color: theme.colors.foregroundMuted, fontSize: 12 },
      cardError: { color: theme.colors.statusDanger, fontSize: 12 },
      actions: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        flexWrap: "wrap" as const,
        marginTop: 4,
      },
      smallButton: {
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
        paddingHorizontal: 10,
        paddingVertical: 6,
      },
      smallButtonText: { color: theme.colors.foreground, fontSize: 12 },
      dangerButton: {
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.statusDanger,
        paddingHorizontal: 10,
        paddingVertical: 6,
      },
      dangerButtonText: { color: theme.colors.statusDanger, fontSize: 12 },
      portMeta: { color: theme.colors.foregroundMuted, fontSize: 12 },
      searchRow: { paddingHorizontal: compact ? 12 : 20, paddingTop: 8 },
      searchInput: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        color: theme.colors.foreground,
        fontSize: 13,
      },
      portRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 10 },
      portBody: { flex: 1, gap: 4 },
      portActions: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      emptyBox: { alignItems: "center" as const, gap: 8, paddingVertical: 32 },
      emptyText: { color: theme.colors.foregroundMuted, fontSize: 13 },
    }),
    [theme, compact],
  );
}

function StatusDot({ status, theme }: { status: ForwardState["status"] | "idle"; theme: Theme }) {
  const color =
    status === "running"
      ? theme.colors.statusSuccess
      : status === "error"
        ? theme.colors.statusDanger
        : theme.colors.foregroundMuted;
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />;
}

interface RuleCardProps {
  rule: ForwardRule;
  state: ForwardState | null;
  accessHost: string;
  busy: boolean;
  onToggle: (rule: ForwardRule) => void;
  onEdit: (rule: ForwardRule) => void;
  onDelete: (rule: ForwardRule) => void;
  onRetry: (rule: ForwardRule) => void;
  onOpen: (rule: ForwardRule) => void;
  onCopy: (rule: ForwardRule) => void;
  styles: ReturnType<typeof useStyles>;
  theme: Theme;
}

function RuleCard(props: RuleCardProps) {
  const { rule, state, accessHost, busy, styles, theme } = props;
  const status = state?.status ?? "stopped";
  const statusText = status === "running" ? "运行中" : status === "error" ? "错误" : "已停止";
  const stats = [
    `${state?.activeConnections ?? 0} 活动连接`,
    `累计 ${state?.totalConnections ?? 0}`,
    state && (state.bytesIn > 0 || state.bytesOut > 0)
      ? `↓${formatBytes(state.bytesIn)} ↑${formatBytes(state.bytesOut)}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <View style={styles.card}>
      <View style={styles.cardTitleRow}>
        <StatusDot status={status} theme={theme} />
        <Text style={styles.cardTitle} numberOfLines={1}>
          {rule.name || `转发 ${rule.listenPort}`}
        </Text>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{rule.listenHost === "0.0.0.0" ? "公开监听" : "仅本机监听"}</Text>
        </View>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{statusText}</Text>
        </View>
      </View>
      <Text style={styles.route}>
        {rule.listenHost}:{rule.listenPort} → {rule.targetHost}:{rule.targetPort}
      </Text>
      <Text style={styles.meta}>{stats}</Text>
      {state?.error ? <Text style={styles.cardError}>{state.error}</Text> : null}
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => props.onToggle(rule)}
          style={styles.smallButton}
        >
          <Text style={styles.smallButtonText}>{rule.enabled ? "停止" : "启用"}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={busy || status !== "running"}
          onPress={() => props.onOpen(rule)}
          style={styles.smallButton}
        >
          <Text style={styles.smallButtonText}>打开</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => props.onCopy(rule)}
          style={styles.smallButton}
        >
          <Text style={styles.smallButtonText}>复制地址</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => props.onRetry(rule)}
          style={styles.smallButton}
        >
          <Text style={styles.smallButtonText}>重试</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => props.onEdit(rule)}
          style={styles.smallButton}
        >
          <Text style={styles.smallButtonText}>编辑</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => props.onDelete(rule)}
          style={styles.dangerButton}
        >
          <Text style={styles.dangerButtonText}>删除</Text>
        </Pressable>
      </View>
      <Text style={styles.meta}>
        访问地址：{buildAccessUrl(rule, rule.listenHost === "0.0.0.0" ? accessHost : "localhost")}
      </Text>
    </View>
  );
}

export function ForwardSurface({ theme, layout }: PluginSurfaceProps) {
  const fetchStatus = useRpc(statusRpc);
  const fetchScan = useRpc(scanRpc);
  const restartForward = useRpc(restartRpc);
  const settings = useSettings(forwardRulesDocument);
  const toast = useToast();
  const styles = useStyles(theme, layout.compact);

  const [tab, setTab] = useState<"rules" | "ports">("rules");
  const [portQuery, setPortQuery] = useState("");
  const [statusData, setStatusData] = useState<StatusData | null>(null);
  const [scanPorts, setScanPorts] = useState<ScannedPort[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalKey, setModalKey] = useState(0);
  const [draft, setDraft] = useState<RuleDraft>(emptyDraft);
  const [accessHost, setAccessHost] = useState<string | null>(null);
  const statusTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const rules = settings.status === "ready" ? settings.values.rules : [];

  const refreshStatus = useCallback(async () => {
    try {
      const next = await fetchStatus({});
      setStatusData({
        states: next.states,
        hostname: next.hostname,
        hostIps: next.hostIps,
      });
      setAccessHost((current) => current ?? next.hostIps[0] ?? "localhost");
    } catch {
      // 连接中断时保留上一份状态，下一轮轮询重试。
    }
  }, [fetchStatus]);

  useEffect(() => {
    void refreshStatus();
    statusTimer.current = setInterval(() => void refreshStatus(), 3_000);
    return () => {
      if (statusTimer.current) clearInterval(statusTimer.current);
      statusTimer.current = null;
    };
  }, [refreshStatus]);

  const refreshScan = useCallback(async () => {
    setScanning(true);
    try {
      const result = await fetchScan({});
      setScanPorts(result.ports);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "扫描失败");
    } finally {
      setScanning(false);
    }
  }, [fetchScan, toast]);

  useEffect(() => {
    if (tab === "ports" && scanPorts === null && !scanning) void refreshScan();
  }, [tab, scanPorts, scanning, refreshScan]);

  const filteredPorts = useMemo(() => {
    const ports = scanPorts ?? [];
    const query = portQuery.trim().toLowerCase();
    if (!query) return ports;
    return ports.filter(
      (port) =>
        String(port.port).includes(query) ||
        port.host.toLowerCase().includes(query) ||
        (port.process ?? "").toLowerCase().includes(query) ||
        (port.pid !== null && String(port.pid).includes(query)),
    );
  }, [scanPorts, portQuery]);

  const stateByRule = useMemo(() => {
    const map = new Map<string, ForwardState>();
    for (const state of statusData?.states ?? []) map.set(state.ruleId, state);
    return map;
  }, [statusData]);

  const effectiveAccessHost = accessHost ?? statusData?.hostIps[0] ?? "localhost";

  const saveRules = useCallback(
    async (next: ForwardRule[]): Promise<boolean> => {
      if (settings.status !== "ready") {
        toast.error("规则尚未加载完成，请稍后重试");
        return false;
      }
      setBusy(true);
      try {
        const ok = await settings.save({ rules: next }, settings.revision);
        if (!ok) {
          toast.error("保存失败，可能存在并发修改，已刷新为最新数据");
          return false;
        }
        return true;
      } finally {
        setBusy(false);
      }
    },
    [settings, toast],
  );

  const openCreate = (preset?: Partial<RuleDraft>): void => {
    setDraft({ ...emptyDraft(), ...preset });
    setModalKey((value) => value + 1);
    setModalOpen(true);
  };

  const handleSubmit = async (submitted: RuleDraft): Promise<void> => {
    const { parsed } = validateDraft(submitted);
    if (!parsed) return;
    const next: ForwardRule[] = submitted.id
      ? rules.map((rule) => (rule.id === submitted.id ? { ...rule, ...parsed } : rule))
      : [...rules, { id: makeRuleId(), ...parsed }];
    const ok = await saveRules(next);
    if (ok) {
      setModalOpen(false);
      toast.show(submitted.id ? "规则已更新" : "规则已创建", { variant: "success" });
    }
  };

  const toggleRule = async (rule: ForwardRule): Promise<void> => {
    const ok = await saveRules(
      rules.map((item) => (item.id === rule.id ? { ...item, enabled: !item.enabled } : item)),
    );
    if (ok) void refreshStatus();
  };

  const deleteRule = async (rule: ForwardRule): Promise<void> => {
    const ok = await saveRules(rules.filter((item) => item.id !== rule.id));
    if (ok) {
      toast.show("规则已删除", { variant: "success" });
      void refreshStatus();
    }
  };

  const retryRule = async (rule: ForwardRule): Promise<void> => {
    try {
      await restartForward({ ruleId: rule.id });
      toast.show("已重新启动转发", { variant: "info" });
      void refreshStatus();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "重试失败");
    }
  };

  const openRule = async (rule: ForwardRule): Promise<void> => {
    const host = rule.listenHost === "0.0.0.0" ? effectiveAccessHost : "localhost";
    try {
      await openExternalUrl(buildAccessUrl(rule, host));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "打开失败");
    }
  };

  const copyRule = async (rule: ForwardRule): Promise<void> => {
    const host = rule.listenHost === "0.0.0.0" ? effectiveAccessHost : "localhost";
    try {
      await copyText(buildAccessUrl(rule, host));
      toast.show("地址已复制", { variant: "success" });
    } catch {
      toast.error("复制失败");
    }
  };

  const forwardScannedPort = (port: ScannedPort): void => {
    openCreate({
      name: `${port.process ?? "服务"} ${port.port}`,
      listenHost: "0.0.0.0",
      listenPort: suggestListenPort(port.port),
      targetHost: targetHostForScanned(port),
      targetPort: String(port.port),
      enabled: true,
    });
  };

  const openScannedPort = async (port: ScannedPort): Promise<void> => {
    const host = port.host === "0.0.0.0" ? effectiveAccessHost : port.host;
    try {
      await openExternalUrl(`http://${host}:${port.port}/`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "打开失败");
    }
  };

  return (
    <View style={styles.screen}>
      <View style={styles.toolbar}>
        <View style={styles.tabs}>
          <Pressable
            accessibilityRole="button"
            onPress={() => setTab("rules")}
            style={tab === "rules" ? styles.tabActive : styles.tab}
          >
            <Text style={tab === "rules" ? styles.tabTextActive : styles.tabText}>
              转发规则{settings.status === "ready" ? ` (${rules.length})` : ""}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => setTab("ports")}
            style={tab === "ports" ? styles.tabActive : styles.tab}
          >
            <Text style={tab === "ports" ? styles.tabTextActive : styles.tabText}>
              服务器端口{scanPorts ? ` (${scanPorts.length})` : ""}
            </Text>
          </Pressable>
        </View>
        <View style={styles.spacer} />
        {tab === "rules" ? (
          <Pressable
            accessibilityRole="button"
            disabled={settings.status !== "ready"}
            onPress={() => openCreate()}
            style={styles.primaryButton}
          >
            <Text style={styles.primaryButtonText}>新建规则</Text>
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            disabled={scanning}
            onPress={() => void refreshScan()}
            style={styles.ghostButton}
          >
            <Text style={styles.ghostButtonText}>{scanning ? "扫描中…" : "重新扫描"}</Text>
          </Pressable>
        )}
      </View>

      <View style={styles.hostRow}>
        <Text style={styles.meta}>
          访问主机{statusData?.hostname ? `（${statusData.hostname}）` : ""}：
        </Text>
        {(statusData?.hostIps ?? []).map((ip) => (
          <Pressable
            key={ip}
            accessibilityRole="button"
            onPress={() => setAccessHost(ip)}
            style={ip === effectiveAccessHost ? styles.hostChipActive : styles.hostChip}
          >
            <Text style={styles.hostChipText}>{ip}</Text>
          </Pressable>
        ))}
        <Pressable
          accessibilityRole="button"
          onPress={() => setAccessHost("localhost")}
          style={effectiveAccessHost === "localhost" ? styles.hostChipActive : styles.hostChip}
        >
          <Text style={styles.hostChipText}>localhost</Text>
        </Pressable>
      </View>

      {tab === "ports" ? (
        <View style={styles.searchRow}>
          <TextInput
            value={portQuery}
            onChangeText={setPortQuery}
            placeholder="搜索端口 / 进程 / 地址"
            placeholderTextColor={theme.colors.foregroundMuted}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.searchInput}
          />
        </View>
      ) : null}

      {tab === "rules" ? (
        <ScrollView contentContainerStyle={styles.listContent}>
          {settings.status === "loading" ? (
            <View style={styles.emptyBox}>
              <Text style={styles.emptyText}>加载规则中…</Text>
            </View>
          ) : settings.status === "invalid" ? (
            <View style={styles.emptyBox}>
              <Text style={styles.error}>规则数据无效：{settings.error}</Text>
            </View>
          ) : rules.length === 0 ? (
            <View style={styles.emptyBox}>
              <Text style={styles.emptyText}>
                还没有转发规则。新建一条规则，把 daemon 主机上的端口转发到本机或局域网可访问的地址。
              </Text>
            </View>
          ) : (
            rules.map((rule) => (
              <RuleCard
                key={rule.id}
                rule={rule}
                state={stateByRule.get(rule.id) ?? null}
                accessHost={effectiveAccessHost}
                busy={busy}
                onToggle={(item) => void toggleRule(item)}
                onEdit={(item) => {
                  setDraft({
                    id: item.id,
                    name: item.name,
                    listenHost: item.listenHost,
                    listenPort: String(item.listenPort),
                    targetHost: item.targetHost,
                    targetPort: String(item.targetPort),
                    enabled: item.enabled,
                  });
                  setModalKey((value) => value + 1);
                  setModalOpen(true);
                }}
                onDelete={(item) => void deleteRule(item)}
                onRetry={(item) => void retryRule(item)}
                onOpen={(item) => void openRule(item)}
                onCopy={(item) => void copyRule(item)}
                styles={styles}
                theme={theme}
              />
            ))
          )}
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={styles.listContent}>
          {scanPorts === null ? (
            <View style={styles.emptyBox}>
              <Text style={styles.emptyText}>{scanning ? "正在扫描监听端口…" : "点「重新扫描」加载端口列表"}</Text>
            </View>
          ) : scanPorts.length === 0 ? (
            <View style={styles.emptyBox}>
              <Text style={styles.emptyText}>没有扫描到监听中的 TCP 端口</Text>
            </View>
          ) : filteredPorts.length === 0 ? (
            <View style={styles.emptyBox}>
              <Text style={styles.emptyText}>没有匹配「{portQuery.trim()}」的端口</Text>
            </View>
          ) : (
            filteredPorts.map((port) => (
              <View key={`${port.host}:${port.port}`} style={styles.card}>
                <View style={styles.portRow}>
                  <View style={styles.portBody}>
                    <View style={styles.cardTitleRow}>
                      <Text style={styles.route}>
                        {port.host}:{port.port}
                      </Text>
                      <View style={styles.badge}>
                        <Text style={styles.badgeText}>{port.loopback ? "仅本机" : "公开"}</Text>
                      </View>
                    </View>
                    <Text style={styles.portMeta} numberOfLines={1}>
                      {port.process ?? "未知进程"}
                      {port.pid !== null ? ` · PID ${port.pid}` : ""}
                    </Text>
                  </View>
                  <View style={styles.portActions}>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => forwardScannedPort(port)}
                      style={styles.smallButton}
                    >
                      <Text style={styles.smallButtonText}>建转发</Text>
                    </Pressable>
                    {!port.loopback ? (
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => void openScannedPort(port)}
                        style={styles.smallButton}
                      >
                        <Text style={styles.smallButtonText}>打开</Text>
                      </Pressable>
                    ) : null}
                  </View>
                </View>
              </View>
            ))
          )}
        </ScrollView>
      )}

      <RuleModal
        key={modalKey}
        open={modalOpen}
        draft={draft}
        saving={busy}
        onClose={() => setModalOpen(false)}
        onSubmit={(submitted) => void handleSubmit(submitted)}
        theme={theme}
        compact={layout.compact}
      />
    </View>
  );
}
