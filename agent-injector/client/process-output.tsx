import { useEffect, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import type { ProcessOutput } from "../shared/processes";
import { fetchProcessOutput } from "./processes-store";

type Theme = PluginHostProps["theme"];

/** 展开期间每 2s 重新读取一次尾部。 */
const REFRESH_MS = 2_000;

export function useProcessTail(
  agentId: string,
  pid: number,
  stream: "stdout" | "stderr",
): { output: ProcessOutput | null; error: string | null } {
  const [output, setOutput] = useState<ProcessOutput | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const next = await fetchProcessOutput({ agentId, pid, stream });
        if (cancelled) return;
        setOutput(next);
        setError(null);
      } catch (caught) {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    };
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [agentId, pid, stream]);

  return { output, error };
}

export function ProcessOutputBlock(props: {
  agentId: string;
  pid: number;
  stream: "stdout" | "stderr";
  label?: string;
  theme: Theme;
  maxHeight?: number;
}) {
  const { agentId, pid, stream, theme, maxHeight = 260 } = props;
  const label = props.label ?? stream;
  const { output, error } = useProcessTail(agentId, pid, stream);
  const scrollRef = useRef<ScrollView>(null);
  const stickToBottom = useRef(true);

  const metaStyle = { color: theme.colors.foregroundMuted, fontSize: 11 };
  const message = error ?? output?.error;

  if (message) {
    return <Text style={[metaStyle, { color: theme.colors.statusDanger }]}>{`${label}: ${message}`}</Text>;
  }
  if (!output) return <Text style={metaStyle}>{`${label}: 读取中…`}</Text>;
  if (!output.readable) {
    return (
      <Text style={metaStyle}>
        {`${label} → ${output.target ?? "未知目标"}（由 CLI 通过管道 / socket 捕获，插件读不到）`}
      </Text>
    );
  }

  return (
    <View style={{ gap: 4, flexShrink: 1 }}>
      <Text style={metaStyle} numberOfLines={1}>
        {`${label} · ${(output.size / 1024).toFixed(1)}KB${output.truncated ? " · 仅显示尾部" : ""} · ${output.path ?? ""}`}
      </Text>
      <ScrollView
        ref={scrollRef}
        onScroll={(event) => {
          const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
          stickToBottom.current =
            contentSize.height - contentOffset.y - layoutMeasurement.height < 24;
        }}
        scrollEventThrottle={120}
        onContentSizeChange={() => {
          if (stickToBottom.current) scrollRef.current?.scrollToEnd({ animated: false });
        }}
        style={{
          maxHeight,
          backgroundColor: theme.colors.surface1,
          borderRadius: 6,
          padding: 8,
        }}
      >
        <Text
          style={{
            color: theme.colors.foreground,
            fontSize: 11,
            lineHeight: 15,
            fontFamily: "monospace",
          }}
        >
          {output.content || "（暂无输出）"}
        </Text>
      </ScrollView>
    </View>
  );
}
