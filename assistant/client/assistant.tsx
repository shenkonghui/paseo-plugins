import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { ensureAssistantRpc } from "../shared/assistant";

/**
 * 「助理」入口本身只负责导航。点击后先确保 `~/.paseo/default` 下存在唯一会话，
 * 再打开 Paseo 原生的会话界面（不在此处自建聊天 UI）。
 */
export function AssistantScreen({ navigation, theme, layout }: PluginScreenProps) {
  const ensure = useRpc(ensureAssistantRpc);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    ensure({})
      .then((result) => {
        if (cancelled) return;
        if (!navigation) {
          setError("当前客户端版本不支持直接打开会话，请更新 Paseo 客户端后重试。");
          return;
        }
        navigation.openAgent({ agentId: result.agentId });
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [ensure, navigation, attempt]);

  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        gap: 12,
        padding: layout.compact ? 16 : 24,
        backgroundColor: theme.colors.surface0,
      },
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 16 : 18 },
      detail: {
        color: theme.colors.foregroundMuted,
        textAlign: "center" as const,
        maxWidth: 420,
      },
      button: {
        paddingVertical: 10,
        paddingHorizontal: 16,
        borderRadius: 10,
        backgroundColor: theme.colors.accent,
      },
      buttonText: { color: theme.colors.accentForeground },
    }),
    [theme, layout.compact],
  );

  if (!error) {
    return (
      <View style={styles.screen}>
        <ActivityIndicator color={theme.colors.foregroundMuted} />
        <Text style={styles.detail}>正在打开助理会话…</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>助理暂时不可用</Text>
      <Text style={styles.detail}>{error}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="重试"
        onPress={() => setAttempt((value) => value + 1)}
        style={styles.button}
      >
        <Text style={styles.buttonText}>重试</Text>
      </Pressable>
    </View>
  );
}
