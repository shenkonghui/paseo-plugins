import { useEffect, useRef, useState } from "react";
import { View, type ViewStyle } from "react-native";

/** 拖动用到的 DOM 事件/目标的最小结构，避免依赖 DOM 类型（插件 tsconfig 不带 lib.dom）。 */
interface PointerLike {
  button?: number;
  clientX?: number;
  clientY?: number;
  preventDefault?(): void;
  stopPropagation?(): void;
}

interface DomEventTarget {
  addEventListener(type: string, listener: (event: PointerLike) => void, capture?: boolean): void;
  removeEventListener(type: string, listener: (event: PointerLike) => void, capture?: boolean): void;
}

interface ResizeHandleProps {
  orientation: "vertical" | "horizontal";
  /** 手柄占用的间隙尺寸（与面板之间的 gap 一致）。 */
  size: number;
  color: string;
  hoverColor: string;
  onStart: (position: { x: number; y: number }) => void;
  onMove: (position: { x: number; y: number }) => void;
  onEnd: (position: { x: number; y: number }) => void;
}

/**
 * 面板之间的分隔条：拖拽自由改变相邻面板 / 行的尺寸。
 *
 * 用 DOM 层 pointer 事件（与面板头部拖动一致），拖动期间由外层盖一层透明遮罩，
 * 否则指针移到内嵌 iframe 上时事件会跑到另一个文档里，宿主收不到 pointermove。
 */
export function ResizeHandle({
  orientation,
  size,
  color,
  hoverColor,
  onStart,
  onMove,
  onEnd,
}: ResizeHandleProps) {
  const ref = useRef<View>(null);
  const [hovered, setHovered] = useState(false);
  const handlers = useRef({ onStart, onMove, onEnd });
  // 每次都拿最新回调，避免监听器里捕获旧闭包。
  handlers.current = { onStart, onMove, onEnd };

  useEffect(() => {
    const node = ref.current as unknown as DomEventTarget | null;
    const globalTarget = globalThis as unknown as DomEventTarget;
    if (!node || typeof node.addEventListener !== "function") return;
    if (typeof globalTarget.addEventListener !== "function") return;

    let detach: (() => void) | null = null;
    const onDown = (event: PointerLike) => {
      if (event.button != null && event.button !== 0) return;
      // 阻止选中文字，也避免触发外层 Pressable 的激活 / 滚动。
      event.preventDefault?.();
      event.stopPropagation?.();
      let lastX = event.clientX ?? 0;
      let lastY = event.clientY ?? 0;
      handlers.current.onStart({ x: lastX, y: lastY });
      const handleMove = (move: PointerLike) => {
        lastX = move.clientX ?? lastX;
        lastY = move.clientY ?? lastY;
        handlers.current.onMove({ x: lastX, y: lastY });
      };
      const finish = (event: PointerLike) => {
        lastX = event.clientX ?? lastX;
        lastY = event.clientY ?? lastY;
        detach?.();
        detach = null;
        handlers.current.onEnd({ x: lastX, y: lastY });
      };
      detach = () => {
        globalTarget.removeEventListener("pointermove", handleMove, true);
        globalTarget.removeEventListener("pointerup", finish, true);
        globalTarget.removeEventListener("pointercancel", finish, true);
      };
      globalTarget.addEventListener("pointermove", handleMove, true);
      globalTarget.addEventListener("pointerup", finish, true);
      globalTarget.addEventListener("pointercancel", finish, true);
    };

    node.addEventListener("pointerdown", onDown);
    return () => {
      detach?.();
      detach = null;
      node.removeEventListener("pointerdown", onDown);
    };
  }, []);

  const container = {
    width: orientation === "vertical" ? size : "100%",
    height: orientation === "vertical" ? "100%" : size,
    alignItems: "center",
    justifyContent: "center",
    // react-native 的类型只认 auto / pointer，这里直接用 CSS 光标。
    cursor: orientation === "vertical" ? "col-resize" : "row-resize",
  } as unknown as ViewStyle;
  const line = {
    width: orientation === "vertical" ? (hovered ? 2 : 1) : "100%",
    height: orientation === "vertical" ? "100%" : hovered ? 2 : 1,
    borderRadius: 1,
    backgroundColor: hovered ? hoverColor : color,
  } as ViewStyle;

  return (
    <View
      ref={ref}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      style={container}
    >
      <View style={line} />
    </View>
  );
}
