import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { dispatchShortcut } from "./shortcut";

type Theme = PluginScreenProps["theme"];

/** 在内嵌视图中屏蔽的 ⌘ 组合键（小写）。 */
const BLOCKED_META_KEYS = new Set(["e", "l"]);

interface KeyEventLike {
  key?: unknown;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  preventDefault(): void;
  stopImmediatePropagation(): void;
}

interface EmbedWindow {
  addEventListener(type: string, listener: (event: KeyEventLike) => void, capture?: boolean): void;
  removeEventListener(type: string, listener: (event: KeyEventLike) => void, capture?: boolean): void;
}

/** 只藏左侧栏：命中的容器打上这个属性，由注入的样式隐藏（!important 压过 React 的内联样式）。 */
const HIDE_ATTR = "data-multi-task-hide-left";
const STYLE_ID = "multi-task-embed-styles";
const EMBED_CSS = `[${HIDE_ATTR}]{display:none!important}`;
/** 左侧栏容器宽度上限：从 resize 手柄往上走，超过这个宽度就说明到主区域了。 */
const SIDEBAR_MAX_WIDTH = 460;

interface EmbedStyleElement {
  id: string;
  textContent: string;
}

interface EmbedElementLike {
  setAttribute(name: string, value: string): void;
  hasAttribute(name: string): boolean;
  parentElement: EmbedElementLike | null;
  getBoundingClientRect?(): { width: number; height: number };
}

interface EmbedDocumentLike {
  getElementById(id: string): unknown;
  createElement(tagName: string): EmbedStyleElement;
  head?: { appendChild(node: unknown): void } | null;
  querySelector(selector: string): EmbedElementLike | null;
  documentElement?: unknown;
}

interface EmbedObserverLike {
  observe(target: unknown, options: unknown): void;
  disconnect(): void;
}

/**
 * 在 iframe 的 window 上捕获 keydown：
 * 1. 转发插件自己的快捷键（焦点在 iframe 里时按键不会冒泡到宿主，只能在这里代转）；
 * 2. 吃掉指定的 ⌘ 组合键。
 * 捕获阶段早于 app 的冒泡监听，stopImmediatePropagation 让它收不到。
 * 返回清理函数。跨源或 Electron 主进程级菜单加速键无法拦截。
 */
function installFrameKeys(win: unknown): () => void {
  if (!win || typeof win !== "object") return () => {};
  const target = win as EmbedWindow;
  const handler = (event: KeyEventLike) => {
    if (dispatchShortcut(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const key = typeof event.key === "string" ? event.key.toLowerCase() : "";
    if (!BLOCKED_META_KEYS.has(key)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  try {
    target.addEventListener("keydown", handler, true);
  } catch {
    return () => {};
  }
  return () => target.removeEventListener("keydown", handler, true);
}

/**
 * 监听 iframe 内部的交互，回调用于把该面板标成「当前焦点」。
 * iframe 里的事件不会冒泡到宿主文档，所以只能听它自己的 window。
 */
function watchFrameActivation(win: unknown, onActivate: () => void): () => void {
  if (!win || typeof win !== "object") return () => {};
  const target = win as EmbedWindow;
  const handler = () => onActivate();
  try {
    target.addEventListener("mousedown", handler, true);
    target.addEventListener("focusin", handler, true);
  } catch {
    return () => {};
  }
  return () => {
    target.removeEventListener("mousedown", handler, true);
    target.removeEventListener("focusin", handler, true);
  };
}

/** 从 resize 手柄向上找到左侧栏容器（比它更宽的就是主区域了），打上隐藏标记。 */
function hideLeftSidebar(doc: EmbedDocumentLike): void {
  const handle = doc.querySelector('[data-testid="left-sidebar-resize-handle"]');
  if (!handle) return;
  let node: EmbedElementLike | null = handle;
  let container: EmbedElementLike | null = null;
  while (node) {
    const rect = node.getBoundingClientRect?.();
    const width = rect ? rect.width : 0;
    if (width >= SIDEBAR_MAX_WIDTH) break;
    if (width > 0) container = node;
    node = node.parentElement;
  }
  if (!container) return;
  if (!container.hasAttribute(HIDE_ATTR)) container.setAttribute(HIDE_ATTR, "");
}

/**
 * 内嵌的 app 是完整实例，自带左侧 workspace 栏。这里只藏**左侧**，右侧 Explorer 保留。
 * app 没有提供隐藏侧栏的 URL 参数，所以在同源 iframe 里注入样式 + 标记容器。
 * 首屏是 SPA 异步挂载的，用 MutationObserver + 短轮询兜底。
 * 跨源时拿不到 contentDocument，整段会安全跳过（不报错、也不生效）。
 */
function installSidebarHiding(win: unknown): () => void {
  const doc = (win as { document?: unknown } | null)?.document as EmbedDocumentLike | null;
  if (!doc || typeof doc.querySelector !== "function" || typeof doc.createElement !== "function") {
    return () => {};
  }
  try {
    if (!doc.getElementById(STYLE_ID)) {
      const style = doc.createElement("style");
      style.id = STYLE_ID;
      style.textContent = EMBED_CSS;
      doc.head?.appendChild(style);
    }
    hideLeftSidebar(doc);
  } catch {
    return () => {};
  }

  let observer: EmbedObserverLike | null = null;
  const ObserverCtor = (win as { MutationObserver?: new (cb: () => void) => EmbedObserverLike })
    .MutationObserver;
  if (ObserverCtor && doc.documentElement) {
    try {
      observer = new ObserverCtor(() => {
        try {
          hideLeftSidebar(doc);
        } catch {
          // ignore
        }
      });
      observer.observe(doc.documentElement, { childList: true, subtree: true });
    } catch {
      observer = null;
    }
  }

  // 挂载早期可能还没渲染出手柄，轮询几十次兜底。
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    try {
      hideLeftSidebar(doc);
    } catch {
      // ignore
    }
    if (tries >= 24) clearInterval(timer);
  }, 250);

  return () => {
    clearInterval(timer);
    observer?.disconnect();
  };
}

function combineCleanups(...cleanups: Array<() => void>): () => void {
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}

/**
 * 用 iframe 内嵌 Paseo 原生会话（存在 DOM 时）。
 *
 * 注意：这会把整个 app 再加载一次——每个面板一个完整实例（含独立 websocket 与订阅），
 * 开销明显；加载失败或无 DOM 平台由上层回退到自绘对话流。
 */
export function EmbeddedAgent({
  src,
  theme,
  onActivate,
  onFallback,
}: {
  src: string;
  theme: Theme;
  onActivate: () => void;
  onFallback: () => void;
}) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  // 跨源时拿不到 contentDocument，所有 iframe 内的操作都会静默失效——显式提示出来。
  const [blocked, setBlocked] = useState(false);
  const frameCleanup = useRef<(() => void) | null>(null);
  // 用 ref 拿最新的 onActivate，避免 iframe 监听器捕获旧闭包。
  const activateRef = useRef(onActivate);
  useEffect(() => {
    activateRef.current = onActivate;
  }, [onActivate]);

  useEffect(
    () => () => {
      frameCleanup.current?.();
      frameCleanup.current = null;
    },
    [],
  );

  const handleLoad = useCallback((event: { currentTarget: unknown }) => {
    setStatus("ready");
    const frame = event.currentTarget as { contentWindow?: unknown };
    const doc = (frame.contentWindow as { document?: unknown } | null)?.document as {
      querySelector?: unknown;
    } | null;
    setBlocked(!doc || typeof doc.querySelector !== "function");
    frameCleanup.current?.();
    frameCleanup.current = combineCleanups(
      installSidebarHiding(frame.contentWindow),
      installFrameKeys(frame.contentWindow),
      watchFrameActivation(frame.contentWindow, () => activateRef.current()),
    );
  }, []);
  const handleError = useCallback(() => setStatus("error"), []);

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <iframe
        src={src}
        title="原生会话"
        onLoad={handleLoad}
        onError={handleError}
        style={{ width: "100%", height: "100%", border: 0, display: "block" }}
      />
      {status !== "ready" ? (
        <View
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            padding: 16,
            backgroundColor: theme.colors.surface0,
          }}
        >
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, textAlign: "center" }}>
            {status === "error" ? "原生视图加载失败" : "正在加载原生视图…"}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="改用对话流"
            onPress={onFallback}
            style={{
              borderRadius: 8,
              borderWidth: 1,
              borderColor: theme.colors.border,
              paddingHorizontal: 10,
              paddingVertical: 6,
            }}
          >
            <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>改用对话流</Text>
          </Pressable>
        </View>
      ) : null}
      {blocked ? (
        <View
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            paddingHorizontal: 8,
            paddingVertical: 4,
            backgroundColor: theme.colors.surface2,
          }}
        >
          <Text style={{ color: theme.colors.statusWarning, fontSize: 10, textAlign: "center" }}>
            无法访问内嵌文档（跨源）：隐藏左侧栏 / 快捷键转发不生效
          </Text>
        </View>
      ) : null}
    </View>
  );
}
