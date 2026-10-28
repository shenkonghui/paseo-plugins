/**
 * 内嵌 iframe 池：切走「多任务」界面时，插件 screen 会被宿主卸载，而每个面板内嵌的是一整套
 * Paseo 实例——重建一次 = 重连 websocket + 重拉会话历史，很慢。
 *
 * 做法：iframe 不跟 React 树销毁，而是在两处之间「搬运」：
 * - 面板里放一个透明占位元素（slot），挂载时把 iframe 搬进 slot；
 * - 卸载时把 iframe 搬回 `document.body` 下的隐藏暂存容器（holder）。
 *
 * 搬运用 Chromium 133+ 的 `moveBefore()`（state-preserving），iframe 的文档、websocket、
 * 滚动位置全部保留，再次进入界面直接复用，不重连。浏览器不支持 `moveBefore()` 时回退
 * `appendChild()`——那会重载 iframe，等于旧行为（功能正常，只是没缓存）。
 *
 * 插件 tsconfig 不带 lib.dom，所以这里只用自己声明的最小 DOM 接口。
 */

interface DomStyleLike {
  setProperty(name: string, value: string): void;
}

export interface DomElementLike {
  style: DomStyleLike;
  setAttribute(name: string, value: string): void;
  appendChild(child: DomElementLike): void;
  remove?(): void;
  addEventListener(type: string, listener: () => void, capture?: boolean): void;
  removeEventListener(type: string, listener: () => void, capture?: boolean): void;
  /** Chromium 133+：同文档内搬运节点且保留状态（iframe 文档不会重载）。 */
  moveBefore?(node: DomElementLike, reference: DomElementLike | null): void;
  contentWindow?: unknown;
}

interface DomDocumentLike {
  body: DomElementLike;
  createElement(tag: string): DomElementLike;
}

interface FrameEntry {
  src: string;
  /** body 下的隐藏暂存容器：面板卸载后 iframe 暂住这里，保持存活。 */
  holder: DomElementLike;
  frame: DomElementLike;
  loaded: boolean;
  users: number;
  lastUsed: number;
  listeners: Set<() => void>;
}

export interface FrameLease {
  frame: DomElementLike;
  /** false = 这个浏览器不支持 state-preserving 搬运，跨界面复用会重新加载。 */
  preservesState: boolean;
  isLoaded(): boolean;
  /** iframe 加载完成时回调；已经加载过则立即调用（复用时不会再有 load 事件）。 */
  onLoad(listener: () => void): void;
  /** 绑定后的内容尺寸（窗口缩放时上层会先冻结再更新），null = 撑满占位元素。 */
  setContentSize(size: { width: number; height: number } | null): void;
  release(): void;
}

/** 空闲 iframe 最多保留几个（每个都是一整套 app，太多会吃内存）。 */
const MAX_IDLE_ENTRIES = 6;

const entries: FrameEntry[] = [];

function getDocument(): DomDocumentLike | null {
  const doc = (globalThis as { document?: DomDocumentLike }).document;
  return doc && typeof doc.createElement === "function" ? doc : null;
}

/** 支持原子搬运就用 moveBefore（保留 iframe 状态），否则退回 appendChild（会重载）。 */
function place(frame: DomElementLike, parent: DomElementLike): boolean {
  if (typeof parent.moveBefore === "function") {
    try {
      parent.moveBefore(frame, null);
      return true;
    } catch {
      // 跨文档等不支持的情况：退回普通插入。
    }
  }
  parent.appendChild(frame);
  return false;
}

function applySize(entry: FrameEntry, size: { width: number; height: number } | null): void {
  const style = entry.frame.style;
  style.setProperty("width", size ? `${Math.max(1, Math.round(size.width))}px` : "100%");
  style.setProperty("height", size ? `${Math.max(1, Math.round(size.height))}px` : "100%");
}

function createEntry(doc: DomDocumentLike, src: string): FrameEntry {
  const holder = doc.createElement("div");
  // 暂存容器只是把 iframe 移出可视区，不用 display:none——那样内嵌 app 会看到 0 尺寸，
  // 布局跟着塌掉；留在屏幕外、尺寸不变，再搬回面板时视觉上更接近「原样」。
  holder.style.setProperty("position", "fixed");
  holder.style.setProperty("left", "-20000px");
  holder.style.setProperty("top", "0px");
  holder.style.setProperty("overflow", "visible");
  doc.body.appendChild(holder);

  const frame = doc.createElement("iframe");
  frame.setAttribute("src", src);
  frame.setAttribute("title", "原生会话");
  frame.setAttribute("frameborder", "0");
  frame.style.setProperty("width", "100%");
  frame.style.setProperty("height", "100%");
  frame.style.setProperty("border", "0");
  frame.style.setProperty("display", "block");
  // 先不插进 holder：首次 load 就直接发生在面板槽位里，避免建好又搬一次白加载。

  const entry: FrameEntry = {
    src,
    holder,
    frame,
    loaded: false,
    users: 0,
    lastUsed: Date.now(),
    listeners: new Set(),
  };
  frame.addEventListener("load", () => {
    entry.loaded = true;
    for (const listener of entry.listeners) {
      try {
        listener();
      } catch {
        // 单个订阅者出错不影响其他订阅者。
      }
    }
  });
  entries.push(entry);
  return entry;
}

/** 空闲太久的实例直接销毁（连 iframe 文档一起丢掉，释放内存）。 */
function trimIdle(): void {
  const idle = entries
    .filter((entry) => entry.users === 0)
    .sort((left, right) => left.lastUsed - right.lastUsed);
  while (idle.length > MAX_IDLE_ENTRIES) {
    const victim = idle.shift();
    if (!victim) break;
    victim.holder.remove?.();
    const index = entries.indexOf(victim);
    if (index >= 0) entries.splice(index, 1);
  }
}

/**
 * 借用一个 iframe：优先复用同 src 且空闲的实例（`moveBefore` 搬进来，不会重连），
 * 没有就新建。`fresh` 用于「重新加载」——先丢掉同 src 的空闲实例再建新的。
 */
export function leaseFrame(input: {
  src: string;
  slot: DomElementLike;
  content?: { width: number; height: number } | null;
  fresh?: boolean;
}): FrameLease | null {
  const doc = getDocument();
  if (!doc) return null;

  if (input.fresh) {
    for (const entry of [...entries]) {
      if (entry.src !== input.src || entry.users > 0) continue;
      entry.holder.remove?.();
      const index = entries.indexOf(entry);
      if (index >= 0) entries.splice(index, 1);
    }
  }

  const reusable = input.fresh
    ? undefined
    : entries.find((entry) => entry.src === input.src && entry.users === 0);
  const entry = reusable ?? createEntry(doc, input.src);
  entry.users += 1;
  entry.lastUsed = Date.now();

  // 占位元素里的 iframe 尺寸按冻结后的内容尺寸走，父级负责 overflow: hidden。
  applySize(entry, input.content ?? null);
  const preservesState = place(entry.frame, input.slot);

  return {
    frame: entry.frame,
    preservesState,
    isLoaded: () => entry.loaded,
    onLoad(listener) {
      if (entry.loaded) {
        listener();
        return;
      }
      entry.listeners.add(listener);
    },
    setContentSize(size) {
      applySize(entry, size);
    },
    release() {
      entry.users = Math.max(0, entry.users - 1);
      entry.lastUsed = Date.now();
      // 搬回 body 的暂存容器：iframe 文档 / 连接 / 滚动位置都留着。
      place(entry.frame, entry.holder);
      if (entry.users === 0) trimIdle();
    },
  };
}

/** 插件卸载（disable / reload）时销毁所有常驻 iframe。 */
export function disposeAllFrames(): void {
  for (const entry of entries) entry.holder.remove?.();
  entries.length = 0;
}
