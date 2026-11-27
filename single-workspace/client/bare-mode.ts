/**
 * `?bare=1` 隐藏左侧栏，把单个 workspace 当成可嵌入的裸视图。
 *
 * app 没有隐藏侧栏的 URL 参数（`AppContainer` 只在 focus mode 下卸载侧栏，而 focus mode
 * 是本地持久化状态、不受 URL 控制），所以在自己的文档里注入样式 + 标记容器。
 * 这套选择器与 `multi-task` 插件内嵌面板用的是同一份，app 改版时一起失效、一起退化。
 *
 * 只藏**左侧**：右侧 Explorer、tab 行、composer 全部保留。
 * 首屏是 SPA 异步挂载的，用 rAF 节流的 MutationObserver 抢首帧，短轮询兜底后续重挂。
 */

const PARAM = "bare";
const HIDE_ATTR = "data-paseo-bare-hidden";
const STYLE_ID = "paseo-bare-mode-styles";
/** 左侧栏容器宽度上限：从 resize 手柄往上走，超过这个宽度就说明到主区域了。 */
const SIDEBAR_MAX_WIDTH = 460;
const POLL_MS = 400;
const POLL_ATTEMPTS = 40;

const BARE_CSS =
  `[${HIDE_ATTR}]{display:none!important}` +
  // 紧凑形态下左侧任务列表的抽屉宿主：隐藏后快捷键 / 菜单按钮 / 边缘手势都打不开。
  `#agent-list-gesture-host,[data-testid="menu-button"]{display:none!important}`;

function hasBareParam(search: string): boolean {
  const value = new URLSearchParams(search).get(PARAM);
  return value === "1" || value === "true" || value === "yes";
}

function ensureStyle(doc: Document): HTMLStyleElement | null {
  const existing = doc.getElementById(STYLE_ID);
  if (existing) return existing as HTMLStyleElement;
  if (!doc.head) return null;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = BARE_CSS;
  doc.head.appendChild(style);
  return style;
}

/** 从 resize 手柄向上找到左侧栏容器（比它更宽的就是主区域了），打上隐藏标记。 */
function markSidebarContainer(doc: Document): boolean {
  const marked = doc.querySelector(`[${HIDE_ATTR}]`);
  if (marked === doc.body || marked === doc.documentElement) {
    // 视口比侧栏阈值还窄时继续往上会藏到 body / html，整个页面变空白。
    marked.removeAttribute(HIDE_ATTR);
  } else if (marked) {
    // 已经藏在合法容器上：该容器 display:none 后宽度为 0，没法再靠宽度识别，保持现状即可。
    return true;
  }

  const handle = doc.querySelector('[data-testid="left-sidebar-resize-handle"]');
  if (!handle) return false;
  let node: Element | null = handle;
  let container: Element | null = null;
  let foundMainArea = false;
  while (node) {
    if (node === doc.body || node === doc.documentElement) break;
    const width = node.getBoundingClientRect().width;
    if (width >= SIDEBAR_MAX_WIDTH) {
      foundMainArea = true;
      break;
    }
    if (width > 0) container = node;
    node = node.parentElement;
  }
  if (!foundMainArea || !container) return false;
  container.setAttribute(HIDE_ATTR, "");
  return true;
}

/**
 * 参数一旦出现就锁存到本页生命周期结束：workspace 内部导航（打开 agent / 文件）
 * 会重写 URL 并丢掉 query，不能让侧栏在用户操作中途冒回来。
 */
export function installBareMode(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }
  const doc = document;
  let latched = hasBareParam(window.location.search);
  let marked = false;
  let style: HTMLStyleElement | null = null;
  let raf = 0;
  let observer: MutationObserver | null = null;

  const apply = () => {
    if (!latched && hasBareParam(window.location.search)) latched = true;
    if (!latched) return;
    style = ensureStyle(doc);
    marked = markSidebarContainer(doc);
    if (marked) {
      // 藏住之后只剩重挂兜底，交给轮询，observer 的每帧 querySelector 就不需要了。
      observer?.disconnect();
      observer = null;
    }
  };

  apply();

  if (!marked && typeof MutationObserver !== "undefined" && doc.documentElement) {
    observer = new MutationObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        try {
          apply();
        } catch {
          // 页面正在卸载 / 结构异常时忽略，轮询会再试。
        }
      });
    });
    observer.observe(doc.documentElement, { childList: true, subtree: true });
  }

  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    try {
      apply();
    } catch {
      // ignore
    }
    if (attempts >= POLL_ATTEMPTS && marked) clearInterval(timer);
  }, POLL_MS);

  return () => {
    clearInterval(timer);
    if (raf) cancelAnimationFrame(raf);
    observer?.disconnect();
    style?.remove();
    doc.querySelector(`[${HIDE_ATTR}]`)?.removeAttribute(HIDE_ATTR);
  };
}
