/**
 * 内嵌 iframe 池：切走「多任务」界面时，插件 screen 会被宿主卸载，而每个面板内嵌的是一整套
 * Paseo 实例——重建一次 = 重连 websocket + 重拉会话历史（表现就是内嵌页里一直「正在连接」）。
 *
 * 关键结论：**iframe 一旦创建就永不搬家**。
 * - 用 `moveBefore()` 在「面板占位」和「body 暂存容器」之间搬是行不通的：卸载时 iframe 已经
 *   随面板脱离文档（`invalid hierarchy`），只能退回 `appendChild`，等于重载。
 * - 所以 iframe 常驻在宿主的 `#overlay-root` 里的 `position: fixed` 容器中，面板里只留一个透明占位
 *   元素；容器按占位元素的 rect 对齐，并按滚动视口 `clip-path` 裁切。
 *   （放 overlay-root 而不是 body：宿主弹窗也在这个容器里，层号 20+，必须能压住 iframe。）
 *
 * 省资源的三条硬约束（之前踩过）：
 * 1. **不再常驻 rAF**：只在 scroll / resize / ResizeObserver / 拖动排序时才同步一次，
 *    静止时零开销（每帧 getBoundingClientRect 会强制布局，是纯烧 CPU）。
 * 2. **src 必须稳定**：上层要等 agent 列表就绪再决定 src，否则会先建「草稿页」实例再废弃。
 * 3. **立即释放不再需要的实例**：`setKnownSources()` 告诉池子当前还有哪些 src 有意义，
 *    其余空闲实例当场销毁——否则每个废弃实例都是一整套 app（内存 + 一个 websocket）。
 *
 * 插件 tsconfig 不带 lib.dom，所以这里只用自己声明的最小 DOM 接口。
 */

interface DomStyleLike {
  setProperty(name: string, value: string): void;
}

interface DomRectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface DomElementLike {
  style: DomStyleLike;
  isConnected?: boolean;
  setAttribute(name: string, value: string): void;
  appendChild(child: DomElementLike): void;
  remove?(): void;
  getBoundingClientRect(): DomRectLike;
  addEventListener(type: string, listener: () => void, capture?: boolean): void;
  removeEventListener(type: string, listener: () => void, capture?: boolean): void;
  contentWindow?: unknown;
}

interface DomDocumentLike {
  body: DomElementLike;
  createElement(tag: string): DomElementLike;
  getElementById?(id: string): DomElementLike | null;
  addEventListener(type: string, listener: () => void, capture?: boolean): void;
  removeEventListener(type: string, listener: () => void, capture?: boolean): void;
}

interface ObserverLike {
  observe(target: unknown): void;
  unobserve(target: unknown): void;
  disconnect(): void;
}

interface FrameEntry {
  src: string;
  host: DomElementLike;
  frame: DomElementLike;
  loaded: boolean;
  users: number;
  lastUsed: number;
  /** 上一次写入的几何值，避免重复动 style。 */
  lastKey: string;
  listeners: Set<() => void>;
}

interface Binding {
  entry: FrameEntry;
  slot: DomElementLike;
  clip: DomElementLike | null;
  /** 冻结的内容尺寸：窗口缩放时先保持不变，尺寸稳定 180ms 后才更新（否则内嵌 app 逐帧重排）。 */
  frozen: { width: number; height: number } | null;
  pendingSize: { width: number; height: number } | null;
  freezeTimer: number | null;
}

export interface FrameLease {
  frame: DomElementLike;
  isLoaded(): boolean;
  /** iframe 加载完成时回调；已经加载过则立即调用（复用时不会再有 load 事件）。 */
  onLoad(listener: () => void): void;
  release(): void;
}

/** 空闲 iframe 最多保留几个（每个都是一整套 app）。 */
const MAX_IDLE_ENTRIES = 4;

const entries: FrameEntry[] = [];
const bindings = new Set<Binding>();
const knownSources = new Set<string>();
let rafId: number | null = null;
let framesHidden = false;

let observer: ObserverLike | null = null;
let globalListeners = 0;

function getDocument(): DomDocumentLike | null {
  const doc = (globalThis as { document?: DomDocumentLike }).document;
  return doc && typeof doc.createElement === "function" ? doc : null;
}

function getWindow(): { addEventListener?: unknown; removeEventListener?: unknown; innerWidth?: number; innerHeight?: number } {
  return globalThis as never;
}

function schedule(callback: () => void): number {
  const global = globalThis as { requestAnimationFrame?: (cb: () => void) => number };
  if (typeof global.requestAnimationFrame === "function") return global.requestAnimationFrame(callback);
  return setTimeout(callback, 16) as unknown as number;
}

function cancel(id: number): void {
  const global = globalThis as { cancelAnimationFrame?: (handle: number) => void };
  if (typeof global.cancelAnimationFrame === "function") global.cancelAnimationFrame(id);
  else clearTimeout(id);
}

function viewport(): DomRectLike {
  const global = globalThis as { innerWidth?: number; innerHeight?: number };
  const width = global.innerWidth ?? 0;
  const height = global.innerHeight ?? 0;
  return { left: 0, top: 0, right: width, bottom: height, width, height };
}

/**
 * 宿主的弹窗 / 浮层都 portal 到 `#overlay-root`（position: fixed; inset: 0; pointer-events: none;
 * z-index: 1），弹窗自身再用 20+ 的层号压住它。我们把 iframe 也放进这个容器：
 * - iframe 依然盖在 app 内容之上（overlay-root 整体就高于 #root）；
 * - 宿主弹窗（层号 20+）盖在 iframe 之上 —— 否则「移除面板」确认弹窗会被 iframe 完全遮住，
 *   看起来就是「点了没反应」。
 */
function ensureOverlayRoot(doc: DomDocumentLike): DomElementLike {
  const existing = doc.getElementById?.("overlay-root");
  if (existing) return existing;
  const root = doc.createElement("div");
  root.setAttribute("id", "overlay-root");
  root.style.setProperty("position", "fixed");
  root.style.setProperty("inset", "0px");
  root.style.setProperty("pointer-events", "none");
  root.style.setProperty("z-index", "1");
  doc.body.appendChild(root);
  return root;
}

function createEntry(doc: DomDocumentLike, src: string): FrameEntry {
  const host = doc.createElement("div");
  // 放在宿主的 overlay-root 里、层号 1：低于弹窗（20+），高于 app 内容。
  host.style.setProperty("position", "fixed");
  host.style.setProperty("left", "0px");
  host.style.setProperty("top", "0px");
  host.style.setProperty("width", "0px");
  host.style.setProperty("height", "0px");
  host.style.setProperty("z-index", "1");
  host.style.setProperty("overflow", "hidden");
  host.style.setProperty("border-radius", "12px");
  host.style.setProperty("visibility", "hidden");
  host.style.setProperty("pointer-events", "none");

  const frame = doc.createElement("iframe");
  frame.setAttribute("src", src);
  frame.setAttribute("title", "原生会话");
  frame.setAttribute("frameborder", "0");
  frame.style.setProperty("width", "100%");
  frame.style.setProperty("height", "100%");
  frame.style.setProperty("border", "0");
  frame.style.setProperty("display", "block");
  host.appendChild(frame);
  ensureOverlayRoot(doc).appendChild(host);

  const entry: FrameEntry = {
    src,
    host,
    frame,
    loaded: false,
    users: 0,
    lastUsed: Date.now(),
    lastKey: "",
    listeners: new Set(),
  };
  frame.addEventListener("load", () => {
    entry.loaded = true;
    // 取出来就清空：不然会一直持有已卸载组件的闭包（内存泄漏）。
    const listeners = [...entry.listeners];
    entry.listeners.clear();
    for (const listener of listeners) {
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

function destroyEntry(entry: FrameEntry): void {
  entry.host.remove?.();
  const index = entries.indexOf(entry);
  if (index >= 0) entries.splice(index, 1);
}

/** 销毁「不再被需要」或超量的空闲实例（每个都是一整套 app，必须及时释放）。 */
function trimIdle(): void {
  for (const entry of [...entries]) {
    if (entry.users > 0) continue;
    if (knownSources.size > 0 && !knownSources.has(entry.src)) destroyEntry(entry);
  }
  const idle = entries
    .filter((entry) => entry.users === 0)
    .sort((left, right) => left.lastUsed - right.lastUsed);
  while (idle.length > MAX_IDLE_ENTRIES) {
    const victim = idle.shift();
    if (!victim) break;
    destroyEntry(victim);
  }
}

/** 尺寸变化后等 180ms 稳定再一次性应用，避免内嵌 app 在拖动窗口期间逐帧重排。 */
function scheduleFreeze(binding: Binding, size: { width: number; height: number }): void {
  binding.pendingSize = size;
  if (binding.freezeTimer != null) clearTimeout(binding.freezeTimer);
  binding.freezeTimer = setTimeout(() => {
    binding.freezeTimer = null;
    if (binding.pendingSize) {
      binding.frozen = binding.pendingSize;
      binding.pendingSize = null;
    }
    binding.entry.lastKey = "";
    requestSync();
  }, 180) as unknown as number;
}

function applyGeometry(binding: Binding, area: DomRectLike): void {
  const { entry, slot } = binding;
  if (slot.isConnected === false) return;
  const rect = slot.getBoundingClientRect();

  // 尺寸取「占位元素」的尺寸（不是面板尺寸：面板还含标题栏，那样会把底部输入框裁掉）。
  const measured = {
    width: Math.max(0, Math.round(rect.width)),
    height: Math.max(0, Math.round(rect.height)),
  };
  // 首次（或量到 0 尺寸，布局还没完成）直接采用，别等冻结窗口，否则首屏要多等 180ms。
  if (!binding.frozen || binding.frozen.width === 0 || binding.frozen.height === 0) {
    binding.frozen = measured;
  } else if (binding.frozen.width !== measured.width || binding.frozen.height !== measured.height) {
    scheduleFreeze(binding, measured);
  }
  const width = binding.frozen?.width ?? measured.width;
  const height = binding.frozen?.height ?? measured.height;
  const left = Math.round(rect.left);
  const top = Math.round(rect.top);

  // 可见区域 = 占位元素 ∩ 裁切容器（滚动视口）∩ 内容尺寸。
  const visibleLeft = Math.max(rect.left, area.left, left);
  const visibleTop = Math.max(rect.top, area.top, top);
  const visibleRight = Math.min(rect.right, area.right, left + width);
  const visibleBottom = Math.min(rect.bottom, area.bottom, top + height);
  const offscreen =
    width <= 0 || height <= 0 || visibleRight <= visibleLeft || visibleBottom <= visibleTop;

  const key = offscreen
    ? "offscreen"
    : `${left},${top},${width},${height},${Math.round(visibleLeft - left)},${Math.round(
        visibleTop - top,
      )},${Math.round(left + width - visibleRight)},${Math.round(top + height - visibleBottom)},${framesHidden}`;
  if (entry.lastKey === key) return;
  entry.lastKey = key;

  const style = entry.host.style;
  if (offscreen) {
    style.setProperty("visibility", "hidden");
    return;
  }
  style.setProperty("left", `${left}px`);
  style.setProperty("top", `${top}px`);
  style.setProperty("width", `${width}px`);
  style.setProperty("height", `${height}px`);
  style.setProperty(
    "clip-path",
    `inset(${Math.round(visibleTop - top)}px ${Math.round(
      left + width - visibleRight,
    )}px ${Math.round(top + height - visibleBottom)}px ${Math.round(visibleLeft - left)}px)`,
  );
  style.setProperty("visibility", framesHidden ? "hidden" : "visible");
  style.setProperty("opacity", "1");
  style.setProperty("pointer-events", framesHidden ? "none" : "auto");
}

function syncAll(): void {
  const area = viewport();
  for (const binding of bindings) applyGeometry(binding, area);
}

/** 合并同一帧内的多次同步请求（只在真的有变化时才读 rect）。 */
function requestSync(): void {
  if (rafId != null) return;
  rafId = schedule(() => {
    rafId = null;
    syncAll();
  });
}

function getObserver(): ObserverLike | null {
  if (observer) return observer;
  const Ctor = (globalThis as {
    ResizeObserver?: new (callback: () => void) => ObserverLike;
  }).ResizeObserver;
  if (!Ctor) return null;
  observer = new Ctor(() => requestSync());
  return observer;
}

function installGlobalListeners(doc: DomDocumentLike): void {
  globalListeners += 1;
  if (globalListeners > 1) return;
  // 滚动（含内部滚动容器）/ 窗口尺寸变化都要重新对齐；capture 才能收到任意滚动容器。
  doc.addEventListener("scroll", requestSync, true);
  const win = getWindow() as {
    addEventListener?: (type: string, listener: () => void) => void;
  };
  win.addEventListener?.("resize", requestSync);
}

function removeGlobalListeners(doc: DomDocumentLike): void {
  globalListeners -= 1;
  if (globalListeners > 0) return;
  doc.removeEventListener("scroll", requestSync, true);
  const win = getWindow() as {
    removeEventListener?: (type: string, listener: () => void) => void;
  };
  win.removeEventListener?.("resize", requestSync);
}

/**
 * 告诉池子「还有哪些 src 是有意义的」（当前面板列表用到的）。
 * 不在这个集合里的空闲实例会被立刻销毁——避免废弃实例长期占着内存和一个 websocket。
 */
export function setKnownSources(sources: string[]): void {
  knownSources.clear();
  for (const source of sources) knownSources.add(source);
  trimIdle();
}

/** 拖动排序 / 分隔条拖拽期间：位置在变但尺寸不变，需要连续同步。 */
export function requestFrameSync(): void {
  requestSync();
}

export function leaseFrame(input: {
  src: string;
  slot: DomElementLike;
  clip?: DomElementLike | null;
  fresh?: boolean;
}): FrameLease | null {
  const doc = getDocument();
  if (!doc) return null;

  if (input.fresh) {
    for (const entry of [...entries]) {
      if (entry.src !== input.src || entry.users > 0) continue;
      destroyEntry(entry);
    }
  }

  const reusable = input.fresh
    ? undefined
    : entries.find((entry) => entry.src === input.src && entry.users === 0);
  const entry = reusable ?? createEntry(doc, input.src);
  entry.users += 1;
  entry.lastUsed = Date.now();

  const binding: Binding = {
    entry,
    slot: input.slot,
    clip: input.clip ?? null,
    frozen: null,
    pendingSize: null,
    freezeTimer: null,
  };
  bindings.add(binding);
  entry.lastKey = "";
  entry.host.style.setProperty("visibility", "visible");
  entry.host.style.setProperty("opacity", "1");
  entry.host.style.setProperty("pointer-events", framesHidden ? "none" : "auto");

  // 尺寸变化（面板布局 / 窗口缩放）时重新对齐；位置变化靠 scroll/resize + 拖动时的显式同步。
  const resizeObserver = getObserver();
  resizeObserver?.observe(input.slot);
  if (input.clip) resizeObserver?.observe(input.clip);
  installGlobalListeners(doc);
  requestSync();

  const attachedListeners = new Set<() => void>();

  return {
    frame: entry.frame,
    isLoaded: () => entry.loaded,
    onLoad(listener) {
      if (entry.loaded) {
        listener();
        return;
      }
      entry.listeners.add(listener);
      attachedListeners.add(listener);
    },

    release() {
      if (binding.freezeTimer != null) clearTimeout(binding.freezeTimer);
      binding.freezeTimer = null;
      for (const listener of attachedListeners) entry.listeners.delete(listener);
      attachedListeners.clear();
      bindings.delete(binding);
      observer?.unobserve(input.slot);
      if (input.clip) observer?.unobserve(input.clip);
      removeGlobalListeners(doc);
      entry.users = Math.max(0, entry.users - 1);
      entry.lastUsed = Date.now();
      const style = entry.host.style;
      // 留在原地、几乎全透明：看不见也不挡操作，但几何上仍在视口内，
      // 不会被 Chromium 当作 offscreen 冻结（那会让内嵌 app 心跳超时断连）。
      style.setProperty("opacity", "0.001");
      style.setProperty("pointer-events", "none");
      style.setProperty("visibility", "visible");
      entry.lastKey = "";
      if (entry.users === 0) trimIdle();
      if (bindings.size === 0) observer?.disconnect();
    },
  };
}

/** 面板里的浮层（下拉菜单等）打开时，先把常驻 iframe 藏起来，免得盖住浮层。 */
export function setFramesHidden(hidden: boolean): void {
  if (framesHidden === hidden) return;
  framesHidden = hidden;
  for (const entry of entries) entry.lastKey = "";
  if (bindings.size > 0) requestSync();
}

/** 插件卸载（disable / reload）时销毁所有常驻 iframe。 */
export function disposeAllFrames(): void {
  if (rafId != null) {
    cancel(rafId);
    rafId = null;
  }
  observer?.disconnect();
  observer = null;
  bindings.clear();
  knownSources.clear();
  for (const entry of [...entries]) destroyEntry(entry);
}
