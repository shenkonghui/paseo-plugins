import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Pressable, Text, View } from "react-native";
import { leaseFrame, type DomElementLike, type FrameLease } from "./frame-pool";
import { dispatchShortcut } from "./shortcut";

type Theme = PluginScreenProps["theme"];

/** 在内嵌视图中屏蔽的 ⌘ 组合键（小写）。 */
const BLOCKED_META_KEYS = new Set(["e", "l"]);

/** app 给会话输入框打的标记（`dataSet={{ composerInput: "" }}`），用来确认回车发生在输入框里。 */
const COMPOSER_INPUT_ATTR = "data-composer-input";
/** app 的 composer 根节点：工具栏和其中的「发送」按钮都在里面。 */
const COMPOSER_ROOT_SELECTOR = '[data-testid="message-input-root"]';

interface KeyEventLike {
  key?: unknown;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  /** 输入法组合中（中文选字时回车）：不能当成发送。 */
  isComposing?: boolean;
  keyCode?: number;
  defaultPrevented?: boolean;
  target?: unknown;
  preventDefault(): void;
  stopImmediatePropagation(): void;
}

interface EmbedWindow {
  addEventListener(type: string, listener: (event: KeyEventLike) => void, capture?: boolean): void;
  removeEventListener(type: string, listener: (event: KeyEventLike) => void, capture?: boolean): void;
}

/** 只用到的一点点 DOM 能力（插件 tsconfig 不带 lib.dom，所以自己声明）。 */
interface EmbedComposerElement {
  closest(selector: string): EmbedComposerElement | null;
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  click(): void;
  /** 输入框只读（会话只读 / 正在听写 / 实时语音）时不接管回车。 */
  readOnly?: boolean;
  disabled?: boolean;
  querySelectorAll(selector: string): { length: number; item(index: number): EmbedComposerElement | null };
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
  removeAttribute?(name: string): void;
  parentElement: EmbedElementLike | null;
  getBoundingClientRect?(): { width: number; height: number };
}

interface EmbedDocumentLike {
  getElementById(id: string): unknown;
  createElement(tagName: string): EmbedStyleElement;
  head?: { appendChild(node: unknown): void } | null;
  body?: EmbedElementLike | null;
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

/** 从 composer 根节点里找「发送」按钮：它是工具栏右侧的最后一个按钮。 */
function findComposerSubmit(root: EmbedComposerElement): EmbedComposerElement | null {
  const buttons = root.querySelectorAll('[role="button"]');
  const last = buttons.length > 0 ? buttons.item(buttons.length - 1) : null;
  if (!last) return null;
  // 禁用时（输入框为空 / 正在加载）不代点，等同于桌面形态「没内容时回车不发送」。
  if (last.getAttribute("aria-disabled") === "true" || last.hasAttribute("disabled")) return null;
  return last;
}

/**
 * 内嵌的 app 在窄面板里会退化成「紧凑形态」：那里**回车只换行、不发送**
 * （app 的规则是 `submitOnEnter = isWeb && !isCompact`，而面板宽度基本都低于它的 md 断点，
 * 所以内嵌视图里永远只能点「发送」按钮）。这里把「回车发送」补回来：
 *
 * - 听 **keypress**（冒泡）：app 只在 keydown 上处理回车，一旦它 preventDefault（自动补全选词、
 *   桌面形态的直接发送），浏览器就不再派发 keypress——所以「收到 keypress」= app 没处理这次回车，
 *   不会重复发送 / 打断斜杠命令补全；
 * - 只接管**焦点在会话输入框**（`data-composer-input`）且输入框可编辑时的回车；
 * - 输入法组合中（中文选字）的回车不处理；
 * - 最后代替用户点一下 composer 的「发送」按钮，走 app 自己的发送逻辑（排队 / steering / 附件都不受影响）。
 *
 * 与侧栏注入一样，这是绕过 SDK 的 DOM 操作：app 改版可能失效，失效时退化成原来的「只能点按钮」。
 * 返回清理函数。
 */
function installEmbeddedEnterSubmit(win: unknown): () => void {
  if (!win || typeof win !== "object") return () => {};
  const target = win as EmbedWindow;
  const handler = (event: KeyEventLike) => {
    if (event.key !== "Enter") return;
    if (event.shiftKey === true || event.metaKey === true || event.ctrlKey === true) return;
    if (event.altKey === true) return;
    // 与 app 的 isImeComposingKeyboardEvent 保持一致：组合中的回车交给输入法。
    if (event.isComposing === true || event.keyCode === 229) return;
    if (event.defaultPrevented === true) return;
    const element = event.target as EmbedComposerElement | null;
    if (!element || typeof element.hasAttribute !== "function") return;
    if (!element.hasAttribute(COMPOSER_INPUT_ATTR)) return;
    // 只读（会话只读 / 听写 / 实时语音）时输入框不可编辑，此时回车不该发送。
    if (element.readOnly === true || element.disabled === true) return;
    const root = typeof element.closest === "function" ? element.closest(COMPOSER_ROOT_SELECTOR) : null;
    if (!root) return;
    const submit = findComposerSubmit(root);
    if (!submit) return;
    // 拦掉换行，然后代替用户点「发送」。
    event.preventDefault();
    submit.click();
  };
  try {
    target.addEventListener("keypress", handler);
  } catch {
    return () => {};
  }
  return () => {
    target.removeEventListener("keypress", handler);
  };
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
  const root = (doc.documentElement ?? null) as EmbedElementLike | null;
  const isDocRoot = (node: EmbedElementLike | null | undefined) =>
    node != null && (node === doc.body || (root != null && node === root));

  const marked = doc.querySelector(`[${HIDE_ATTR}]`);
  if (isDocRoot(marked)) {
    // 旧版本在面板窄于 460px 时可能把标记打到 body / html 上，整个内嵌页会变空白。
    marked?.removeAttribute?.(HIDE_ATTR);
  } else if (marked) {
    // 已经藏在合法容器上：该容器 display:none 后宽度为 0，没法再靠宽度识别，保持现状即可。
    return;
  }

  const handle = doc.querySelector('[data-testid="left-sidebar-resize-handle"]');
  if (!handle) return;
  let node: EmbedElementLike | null = handle;
  let container: EmbedElementLike | null = null;
  let foundMainArea = false;
  while (node) {
    // 必须先见到主区域再藏：面板本身比侧栏阈值还窄时继续往上会藏到 body / html。
    if (isDocRoot(node)) break;
    const width = node.getBoundingClientRect?.()?.width ?? 0;
    if (width >= SIDEBAR_MAX_WIDTH) {
      foundMainArea = true;
      break;
    }
    if (width > 0) container = node;
    node = node.parentElement;
  }
  if (!foundMainArea || !container) return;
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
 * 开销明显；无 DOM 平台由上层退化为自绘对话流，加载失败时在这里提供重试。
 */
export function EmbeddedAgent({
  src,
  theme,
  onActivate,
  clipRef,
}: {
  src: string;
  theme: Theme;
  onActivate: () => void;
  /** 滚动视口容器（panesWrap）：常驻 iframe 浮层要按它裁切。 */
  clipRef?: RefObject<View | null>;
}) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  // 「重新加载」：销毁这个 iframe 再建一个（正常情况下卸载只是隐藏，不重建）。
  const [reloadNonce, setReloadNonce] = useState(0);
  const reload = useCallback(() => {
    setStatus("loading");
    setReloadNonce((value) => value + 1);
  }, []);
  // 跨源时拿不到 contentDocument，所有 iframe 内的操作都会静默失效——显式提示出来。
  const [blocked, setBlocked] = useState(false);
  const slotRef = useRef<View>(null);
  const leaseRef = useRef<FrameLease | null>(null);
  const frameCleanup = useRef<(() => void) | null>(null);
  // 用 ref 拿最新的 onActivate，避免 iframe 监听器捕获旧闭包。
  const activateRef = useRef(onActivate);
  useEffect(() => {
    activateRef.current = onActivate;
  }, [onActivate]);

  // 挂载时借用（或新建）一个常驻 iframe；卸载时只把它搬回暂存容器——iframe 留在池里，
  // 再次进入界面直接复用，不会再重连、不会重新拉历史。
  // 必须用 layout effect：卸载时要在 React 把面板 DOM 删掉之前把 iframe 搬走。
  useLayoutEffect(() => {
    const slot = slotRef.current as unknown as DomElementLike | null;
    if (!slot || typeof slot.appendChild !== "function") return;
    const clip = (clipRef?.current as unknown as DomElementLike | null) ?? null;
    const lease = leaseFrame({
      src,
      slot,
      clip,
      fresh: reloadNonce > 0,
    });
    if (!lease) return;
    leaseRef.current = lease;

    const attach = () => {
      setStatus("ready");
      const frame = lease.frame as { contentWindow?: unknown };
      const doc = (frame.contentWindow as { document?: unknown } | null)?.document as {
        querySelector?: unknown;
      } | null;
      setBlocked(!doc || typeof doc.querySelector !== "function");
      frameCleanup.current?.();
      frameCleanup.current = combineCleanups(
        installSidebarHiding(frame.contentWindow),
        installFrameKeys(frame.contentWindow),
        installEmbeddedEnterSubmit(frame.contentWindow),
        watchFrameActivation(frame.contentWindow, () => activateRef.current()),
      );
    };
    // 复用的 iframe 已经加载过了，onLoad 会同步立刻回调一次。
    lease.onLoad(attach);
    const handleError = () => setStatus("error");
    lease.frame.addEventListener("error", handleError);

    return () => {
      lease.frame.removeEventListener("error", handleError);
      frameCleanup.current?.();
      frameCleanup.current = null;
      leaseRef.current = null;
      lease.release();
    };
  }, [src, reloadNonce, clipRef]);

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      {/* 占位：真正的 iframe 由 frame-pool 搬进这个元素（切界面时再搬走暂存） */}
      <View ref={slotRef} style={{ flex: 1 }} />
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
            // 压在被搬进来的 iframe 上面。
            zIndex: 5,
          }}
        >
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, textAlign: "center" }}>
            {status === "error" ? "原生视图加载失败" : "正在加载原生视图…"}
          </Text>
          {status === "error" ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="重新加载内嵌视图"
              onPress={reload}
              style={{
                borderRadius: 8,
                borderWidth: 1,
                borderColor: theme.colors.border,
                paddingHorizontal: 10,
                paddingVertical: 6,
              }}
            >
              <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>重新加载</Text>
            </Pressable>
          ) : null}
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
            zIndex: 5,
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
