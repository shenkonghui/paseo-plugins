import { memo, useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { formatTokensDetailed } from "./format";

type Theme = PluginSurfaceProps["theme"];

export interface TokenBarChartDay {
  date: string;
  totalTokens: number;
}

const CHART_HEIGHT = 120;
const BAR_GAP = 2;
const MIN_BAR_WIDTH = 2;

function buildBars(width: number, count: number): { barWidth: number; gap: number } {
  if (count <= 0 || width <= 0) {
    return { barWidth: 0, gap: 0 };
  }
  const gap = Math.min(BAR_GAP, Math.max(0, (width / count) * 0.2));
  const barWidth = Math.max(MIN_BAR_WIDTH, (width - gap * (count - 1)) / count);
  return { barWidth, gap };
}

interface ChartBarProps {
  date: string;
  index: number;
  x: number;
  barWidth: number;
  barHeight: number;
  selected: boolean;
  color: string;
  selectedColor: string;
  onPress(index: number): void;
}

const ChartBar = memo(function ChartBar({
  date,
  index,
  x,
  barWidth,
  barHeight,
  selected,
  color,
  selectedColor,
  onPress,
}: ChartBarProps) {
  const handlePress = useCallback(() => {
    onPress(index);
  }, [index, onPress]);
  return (
    <Pressable
      onPress={handlePress}
      hitSlop={2}
      accessibilityLabel={date}
      style={{
        position: "absolute",
        left: x,
        bottom: 0,
        width: barWidth,
        height: Math.max(barHeight, 2),
      }}
    >
      <View
        style={{
          flex: 1,
          backgroundColor: selected ? selectedColor : color,
          borderRadius: Math.min(2, barWidth / 2),
        }}
      />
    </Pressable>
  );
});

interface TokenBarChartBarsProps {
  days: TokenBarChartDay[];
  width: number;
  barColor: string;
  barSelectedColor: string;
  labelColor: string;
}

const TokenBarChartBars = memo(function TokenBarChartBars({
  days,
  width,
  barColor,
  barSelectedColor,
  labelColor,
}: TokenBarChartBarsProps) {
  const [selected, setSelected] = useState<number | null>(null);
  const maxValue = Math.max(...days.map((day) => day.totalTokens), 1);
  const { barWidth, gap } = useMemo(() => buildBars(width, days.length), [width, days.length]);
  const selectedIndex = selected !== null && selected < days.length ? selected : null;
  const selectedDay = selectedIndex !== null ? days[selectedIndex] : null;

  const handleBarPress = useCallback(
    (index: number) => {
      setSelected((current) => (current === index ? null : index));
    },
    [],
  );

  const bars = useMemo(
    () =>
      days.map((day, index) => {
        const barHeight = Math.max(
          day.totalTokens > 0 ? 2 : 0,
          (day.totalTokens / maxValue) * (CHART_HEIGHT - 4),
        );
        return (
          <ChartBar
            key={day.date}
            date={day.date}
            index={index}
            x={index * (barWidth + gap)}
            barWidth={barWidth}
            barHeight={barHeight}
            selected={index === selectedIndex}
            color={barColor}
            selectedColor={barSelectedColor}
            onPress={handleBarPress}
          />
        );
      }),
    [days, barWidth, gap, maxValue, selectedIndex, barColor, barSelectedColor, handleBarPress],
  );

  return (
    <View>
      {selectedDay ? (
        <Text style={{ color: labelColor, fontSize: 12, marginBottom: 4 }}>
          {selectedDay.date} · {formatTokensDetailed(selectedDay.totalTokens)}
        </Text>
      ) : null}
      <View style={{ height: CHART_HEIGHT }}>{bars}</View>
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 4 }}>
        <Text style={{ color: labelColor, fontSize: 12 }}>{days[0]?.date ?? ""}</Text>
        <Text style={{ color: labelColor, fontSize: 12 }}>{days[days.length - 1]?.date ?? ""}</Text>
      </View>
    </View>
  );
});

export function TokenBarChart({
  days,
  theme,
}: {
  days: TokenBarChartDay[];
  theme: Theme;
}) {
  const [width, setWidth] = useState(0);
  const handleLayout = useCallback(
    (event: { nativeEvent: { layout: { width: number } } }) => {
      const measured = event.nativeEvent.layout.width;
      if (measured > 0) {
        setWidth(measured);
      }
    },
    [],
  );

  return (
    <View onLayout={handleLayout}>
      {width > 0 ? (
        <TokenBarChartBars
          days={days}
          width={width}
          barColor={theme.colors.accent}
          barSelectedColor={theme.colors.statusSuccess}
          labelColor={theme.colors.foregroundMuted}
        />
      ) : null}
    </View>
  );
}
