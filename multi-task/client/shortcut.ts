/**
 * 打开多任务窗口的快捷键。SDK 没有快捷键注册 API，所以自己在宿主 window 上监听；
 * 内嵌 iframe 里的按键不会冒泡到宿主，由 embedded-agent 在同一份逻辑里转发。
 */

export interface ShortcutKeyEvent {
  key?: unknown;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  preventDefault?(): void;
  stopImmediatePropagation?(): void;
}

/** 想换键就改这两行，例如 SHORTCUT_KEY = "u"、或把 shift 要求去掉。 */
const SHORTCUT_KEY = "m";
const REQUIRES_SHIFT = true;

/** 命中条件：⌘/Ctrl +（可选 Shift）+ 该字母，且不带 Alt。 */
export function matchesShortcut(event: ShortcutKeyEvent): boolean {
  if (event.metaKey !== true && event.ctrlKey !== true) return false;
  if (event.altKey === true) return false;
  if (REQUIRES_SHIFT && event.shiftKey !== true) return false;
  const key = typeof event.key === "string" ? event.key.toLowerCase() : "";
  return key === SHORTCUT_KEY;
}

let opener: (() => void) | null = null;

/** 处理一次按键：命中则触发已注册的动作并返回 true（防默认行为交给调用方）。 */
export function dispatchShortcut(event: ShortcutKeyEvent): boolean {
  if (!matchesShortcut(event)) return false;
  opener?.();
  return true;
}

interface EventTargetLike {
  addEventListener(type: string, listener: (event: ShortcutKeyEvent) => void, capture?: boolean): void;
  removeEventListener(type: string, listener: (event: ShortcutKeyEvent) => void, capture?: boolean): void;
}

/** 在宿主 window 上注册全局快捷键，返回清理函数；无 DOM 环境（原生）为 no-op。 */
export function registerGlobalShortcut(open: () => void): () => void {
  opener = open;
  const g = globalThis as { addEventListener?: unknown; removeEventListener?: unknown };
  if (typeof g.addEventListener !== "function" || typeof g.removeEventListener !== "function") {
    return () => {
      opener = null;
    };
  }
  const target = globalThis as unknown as EventTargetLike;
  const handler = (event: ShortcutKeyEvent) => {
    if (!dispatchShortcut(event)) return;
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
  };
  target.addEventListener("keydown", handler, true);
  return () => {
    target.removeEventListener("keydown", handler, true);
    opener = null;
  };
}
