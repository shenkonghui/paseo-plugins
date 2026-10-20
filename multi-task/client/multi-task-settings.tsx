import { useCallback, useMemo } from "react";
import { Text } from "react-native";
import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { SettingsState } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsSection,
  SettingsSelect,
} from "@getpaseo/plugin/client/ui";
import { multiTaskSettings, type MultiTaskToolbarSize } from "../shared/settings";

const toolbarSizeOptions = [
  { label: "紧凑", value: "compact" },
  { label: "舒适", value: "comfortable" },
] as const;

type MultiTaskPreferences = Extract<SettingsState<typeof multiTaskSettings.schema>, { status: "ready" }>;

function MultiTaskSettingsControls({ settings }: { settings: MultiTaskPreferences }) {
  const changeToolbarSize = useCallback(
    (toolbarSize: MultiTaskToolbarSize) => {
      void settings.save({ ...settings.values, toolbarSize }, settings.revision);
    },
    [settings],
  );
  return (
    <SettingsSection title="多任务" info="设置存储在宿主侧，所有客户端共享。">
      <SettingsCard>
        <SettingsSelect
          label="工具栏尺寸"
          hint="紧凑（默认）缩短「刷新 / + 添加 workspace」工具栏；舒适保留较大的间距与字号。"
          value={settings.values.toolbarSize}
          options={toolbarSizeOptions}
          disabled={settings.saving}
          onValueChange={changeToolbarSize}
        />
      </SettingsCard>
      {settings.saveError ? <Text accessibilityRole="alert">{settings.saveError}</Text> : null}
    </SettingsSection>
  );
}

export function MultiTaskSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(multiTaskSettings);
  const style = useMemo(() => ({ color: theme.colors.foreground }), [theme]);

  if (settings.status === "loading") return <Text style={style}>正在加载设置…</Text>;
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="多任务">
        <Text style={style}>{settings.error}</Text>
        <SettingsAction label="加载失败" actionLabel="重新加载" onPress={settings.reload} />
        {settings.status === "invalid" ? (
          <SettingsAction label="配置无效" actionLabel="恢复默认" onPress={settings.reset} />
        ) : null}
      </SettingsSection>
    );
  }
  return <MultiTaskSettingsControls settings={settings} />;
}
