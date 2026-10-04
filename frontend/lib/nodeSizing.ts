import { DEFAULT_NODE_DIMENSIONS } from './types';
import nodeFloors from './nodeFloors.json';

/**
 * 节点尺寸的唯一事实源。
 *
 * 模型：节点只有**一个自由度 —— 宽度**，高度是因变量。
 *
 *   下限（拖拽 / NodeResizer）：minH = chromeH + minW / ratio
 *   自然高（新建 / 适配内容）：H(W) = chromeH + contentH + W / ratio
 *
 * 两个式子的差别就是内容区：它进得了"自然高"，进不了"下限"。于是节点被拖到最小时，
 * 功能区与媒体区完好，内容区滚动收起 —— 内容区不需要任何退化形态。
 *
 * 比例项只在**画面在场**时成立（spec.hasMedia）。纯控件形态的视图硬按比例算高度，
 * 只会造出一大片空白，还会把 minH 抬到拖不小 —— 那时高度归内容管。
 *
 * 详见 docs/node-sizing.md。
 */

/** 功能区（节点内的按钮控件）在最简化形态下的尺寸。由 useChromeMetrics 运行时标定。 */
export interface ChromeMetrics {
  /** 紧凑态按钮排布所需的最小宽度，已含节点左右 padding */
  minW: number;
  // 注意 chromeH / rows 都是**不含上下 padding** 的净行高：
  // 上下内边距按视图不同（预览态画面满铺、编辑态有 p-3.5），由调用方自己加。
  /** 紧凑态各功能区行高之和 */
  chromeH: number;
  /**
   * 逐行的实测高度，键是节点声明的行名。
   *
   * 必须逐行而不是只留一个总高：同一个节点的不同视图在场的行不一样 ——
   * H3 预览态只有标题栏，编辑态还有 seed 与生成按钮。拿总高去套预览态会多算 60 多像素。
   */
  rows?: Record<string, number>;
}

export interface NodeSizeSpec {
  /** 功能区最简化时的最小宽度 */
  minW: number;
  /** = chromeH + minW / ratio。算出来的，不是常量 */
  minH: number;
  chromeH: number;
  /** 媒体宽高比 w/h */
  ratio: number;
  /**
   * 该节点当前是否真的在显示媒体。
   *
   * 关键区分：比例项只在**画面在场**时成立。像 H3 编辑视图这种全是控件与文本的形态，
   * 按比例给高度会凭空造出一大片空白 —— 9:16 会算出 675 高的空壳，minH 还高达 500，
   * 拖都拖不小。没有画面时高度归内容管，尺寸方程只负责守住下限。
   */
  hasMedia: boolean;
  /**
   * The node has media but its settings drawer is open: the picture is hidden
   * (and paused) and the node is chrome + drawer + content, no media term. Closing
   * the drawer brings the media height back through the same equation.
   */
  mediaHidden?: boolean;
  /** 未被用户拖过时的舒适宽度 */
  defaultW: number;
  maxW: number;
}

export const FALLBACK_RATIO = nodeFloors.fallbackRatio;

/**
 * 标定完成前的兜底值，也是标定结果的下限。
 *
 * 这些数字是按字号与字数估的（见 docs/node-sizing.md §3），只用于首帧不闪，
 * 真正的值由 useChromeMetrics 实测。**不要**把它们当成权威 —— 一旦有人改了按钮文案，
 * 估算值就失真了，而实测值不会。
 */
export const CHROME_FLOOR: ChromeMetrics = nodeFloors.chromeFloorDefault;

// Shared with backend/node_sizing.py, which enforces the same floors on every canvas save.
const CHROME_FLOOR_BY_TYPE: Record<string, ChromeMetrics> = nodeFloors.chromeFloorByType;

const MAX_W_BY_TYPE: Record<string, number> = {
  video: 540,
  videoEdit: 600,
  videoReshot: 720,
  videoBridge: 720,
  videoContinue: 640,
  videoFrames: 640,
  preview: 560,
  chainPreview: 720,
  image: 500,
};

const DEFAULT_MAX_W = 560;

/** 媒体区再窄的比例也不该细成一条缝 */
export const MEDIA_MIN_H = nodeFloors.mediaMinH;

/** 无媒体时内容区的最小可用高度 */
export const CONTENT_MIN_H = 120;
/** An audio clip's body: one player row (play button, seek bar, time). It has no
 *  picture, so the node is a strip -- header plus this -- not a media card. */
export const AUDIO_CONTENT_H = nodeFloors.audioContentH;

export function getChromeFloor(type: string | undefined): ChromeMetrics {
  return (type && CHROME_FLOOR_BY_TYPE[type]) || CHROME_FLOOR;
}

export function getMaxWidth(type: string | undefined): number {
  return (type && MAX_W_BY_TYPE[type]) || DEFAULT_MAX_W;
}

export function getDefaultWidth(type: string | undefined): number {
  return (type && DEFAULT_NODE_DIMENSIONS[type]?.width) || 320;
}

type RatioSource = { width?: number | null; height?: number | null } | null | undefined;

/**
 * 媒体比例的权威来源，按优先级取第一个有效的：
 *   1. 已渲染媒体的自然尺寸（<video> onLoadedMetadata 的 videoWidth/videoHeight）
 *   2. data.width / data.height —— 即将生成的目标分辨率
 *   3. 16:9
 *
 * 第 2 档顺带让节点在生成之前就长成成片的形状，生成完不跳变。
 *
 * 注意第 1 档必须取**已挂载并渲染**的元素：上传前 new 出来的临时 <video>
 * 对不少编码返回 0。
 */
export function resolveMediaRatio(...sources: RatioSource[]): number {
  for (const s of sources) {
    if (!s) continue;
    const { width, height } = s;
    if (width && height && width > 0 && height > 0) return width / height;
  }
  return FALLBACK_RATIO;
}

export function getNodeSizeSpec(
  type: string | undefined,
  ratio: number,
  metrics?: ChromeMetrics | null,
  { hasMedia = true, mediaHidden = false, chromeH: chromeHOverride, contentMinH = CONTENT_MIN_H }: { hasMedia?: boolean; mediaHidden?: boolean; chromeH?: number; contentMinH?: number } = {},
): NodeSizeSpec {
  const floor = getChromeFloor(type);
  const safeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : FALLBACK_RATIO;

  // 实测值只会比兜底值更权威，但不允许低于兜底 —— 标定被字体加载打断时不至于塌掉
  const minW = Math.round(Math.max(metrics?.minW ?? 0, floor.minW));
  // 视图相关的功能区高度由调用方按当前在场的行算好传进来；没传才退回总高
  const chromeH = Math.round(
    chromeHOverride ?? Math.max(metrics?.chromeH ?? 0, floor.chromeH),
  );
  const maxW = Math.max(getMaxWidth(type), minW);

  const minH = Math.round(
    chromeH + (hasMedia ? (mediaHidden ? 0 : Math.max(minW / safeRatio, MEDIA_MIN_H)) : contentMinH),
  );

  return {
    minW,
    minH,
    chromeH,
    ratio: safeRatio,
    hasMedia,
    mediaHidden: hasMedia && mediaHidden,
    defaultW: Math.min(Math.max(getDefaultWidth(type), minW), maxW),
    maxW,
  };
}

/**
 * 解方程，不是取 max。
 *
 * @param width 目标宽度，缺省用 spec.defaultW（用户拖过的话传 data.userWidth）
 * @param contentH 内容区的自然高度。只进"自然高"，不进下限 —— 传 0 就是最小骨架。
 */
export function solveNodeSize(
  spec: NodeSizeSpec,
  width?: number | null,
  contentH = 0,
): { width: number; height: number } {
  const w = clamp(width || spec.defaultW, spec.minW, spec.maxW);
  const mediaH = spec.hasMedia && !spec.mediaHidden ? Math.max(w / spec.ratio, MEDIA_MIN_H) : 0;
  return {
    width: Math.round(w),
    height: Math.round(Math.max(spec.chromeH + contentH + mediaH, spec.minH)),
  };
}

/** 把任意尺寸拉回合法区间。迁移旧工程与兜底用，只抬不降高度。 */
export function clampNodeSize(
  spec: NodeSizeSpec,
  width?: number | null,
  height?: number | null,
): { width: number; height: number } {
  const w = clamp(width || spec.defaultW, spec.minW, spec.maxW);
  return { width: Math.round(w), height: Math.round(Math.max(height || 0, spec.minH)) };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/* ══════════════════════════════════════════════════════════════════════
   拖拽期的等比例约束
   ══════════════════════════════════════════════════════════════════════ */

/**
 * 各节点当前的 spec，按节点 id 登记。
 *
 * 拖拽约束要在画布的 onNodesChange 里生效，而 spec 是各节点算出来的 ——
 * 需要一个跨组件的取用点。由 useNodeSizing 负责登记与注销。
 */
const specRegistry = new Map<string, NodeSizeSpec>();

export function registerNodeSize(id: string, spec: NodeSizeSpec) {
  specRegistry.set(id, spec);
}

export function unregisterNodeSize(id: string) {
  specRegistry.delete(id);
}

export function getRegisteredSpec(id: string): NodeSizeSpec | undefined {
  return specRegistry.get(id);
}

/** onNodesChange 里能拿到的最小形状，避免把 ReactFlow 的类型拖进这个纯模块 */
interface DimensionChangeLike {
  id: string;
  type: string;
  resizing?: boolean;
  /** true | 'width' | 'height' —— 由手柄的 resizeDirection 决定，就是这次拖拽的权威轴 */
  setAttributes?: boolean | 'width' | 'height';
  dimensions?: { width: number; height: number };
  position?: { x: number; y: number };
}

/**
 * 让有媒体的节点在**拖拽过程中**就锁死媒体比例。
 *
 * 为什么不用 NodeResizer 的 `keepAspectRatio`：它锁的是**节点框**的比例，而
 * 节点 = 功能区固定像素带 + 媒体区。锁住 W/H 意味着媒体高度 = W·(H₀/W₀) − chromeH，
 * 只有在拖拽起点那一个宽度上才等于 W/ratio，越拖偏得越多（误差趋近 chromeH）。
 * 而且它的比例取自拖拽起点的 node.width/height，没有权威来源 —— 一旦节点比例是错的，
 * 它会忠实地把错误保持下去。
 *
 * 也不能在 `onResize` 里改：那个回调跑在 `onChange` 之前，写进去当场被覆盖。
 * `shouldResize` 更只能整帧否决，改不了尺寸。
 *
 * 可行的切入点是 resizer 每帧派发出来的 `dimensions` 变更 —— 它要经过画布自己的
 * `onNodesChange`。在那里按方程改写高度，逐帧精确，且不和拖拽循环抢状态。
 *
 * 三件事：
 *  1. 横向拖 → 高度 = chromeH + 宽度/比例（宽度是自变量）
 *  2. 纵向拖 → 反解宽度 = (高度 − chromeH)·比例，否则纵向手柄会拖不动
 *  3. 顶边手柄 → resizer 按它自己的高度算过 y（底边不动），高度被改写后 y 要跟着补
 *
 * 轴向**必须**从变更自带的 `setAttributes` 读，不能靠"宽度这一帧变没变"去猜。
 * 猜会抖：拖上下边时 resizer 每帧交上来的宽度恒等于起点宽度，而上一帧我刚把 store 里的
 * 宽度反解成别的值，于是判断在"变了/没变"之间来回翻，宽度每帧在两个值之间弹。
 * `setAttributes` 由手柄的 `resizeDirection` 决定，是确定的信号 —— NodeShell 为此
 * 显式给左右边线挂 horizontal、上下边线挂 vertical。
 *
 * 改写后要把 `setAttributes` 置为 `true`：applyNodeChanges 用它决定写不写 width/height，
 * 留着 'height' 的话反解出来的宽度会被直接丢掉。
 */
export function constrainResizeChanges<T extends DimensionChangeLike>(
  changes: T[],
  getNode: (id: string) => { width?: number | null; height?: number | null; position?: { x: number; y: number } } | undefined,
): T[] {
  let touched = false;

  const next = changes.map((change) => {
    if (change.type !== 'dimensions' || !change.resizing || !change.dimensions) return change;

    const spec = specRegistry.get(change.id);
    if (!spec || !spec.hasMedia || spec.mediaHidden) return change;

    const { width: rawW, height: rawH } = change.dimensions;

    // 纵向手柄不改宽度，这时反过来由高度解宽度，否则上下边拖了没反应
    const width =
      change.setAttributes === 'height'
        ? clamp(Math.round((rawH - spec.chromeH) * spec.ratio), spec.minW, spec.maxW)
        : rawW;
    const solved = solveNodeSize(spec, width);
    if (
      change.setAttributes === true &&
      Math.abs(solved.width - rawW) < 0.5 &&
      Math.abs(solved.height - rawH) < 0.5
    ) {
      return change;
    }

    touched = true;
    heightDelta.set(change.id, rawH - solved.height);
    return {
      ...change,
      setAttributes: true,
      dimensions: { width: solved.width, height: solved.height },
    };
  });

  if (!touched) {
    heightDelta.clear();
    return changes;
  }

  // 顶边手柄：resizer 让底边不动地算了 y。高度被改写后按同一个底边重算 y
  const adjusted = next.map((change) => {
    if (change.type !== 'position' || !change.position) return change;
    const delta = heightDelta.get(change.id);
    if (delta === undefined || Math.abs(delta) < 0.5) return change;
    const prev = getNode(change.id);
    if (!prev?.position || Math.abs(change.position.y - prev.position.y) < 0.01) return change;
    return { ...change, position: { ...change.position, y: change.position.y + delta } };
  });

  heightDelta.clear();
  return adjusted;
}

/** 一帧之内在两个 map 之间传递高度修正量 */
const heightDelta = new Map<string, number>();

/** Panels that open and close: settings drawers and collapsible blocks. */
export const DRAWER_SELECTOR = '.node-shell-drawer';
export const PANEL_SELECTOR = `${DRAWER_SELECTOR}, [data-node-expand]`;

/**
 * Total height of the open panels directly in `root` (outermost ones only, so a
 * block nested in a drawer is not counted twice). offsetHeight, not the bounding
 * rect: the canvas is zoom-transformed.
 */
export function openPanelsHeight(root: HTMLElement, within: Element = root, selector = PANEL_SELECTOR): number {
  let total = 0;
  within.querySelectorAll<HTMLElement>(selector).forEach((p) => {
    if (p.closest('.node-shell') !== root) return;
    const outer = p.parentElement?.closest(PANEL_SELECTOR);
    if (outer && within.contains(outer)) return;
    const cs = getComputedStyle(p);
    total += p.offsetHeight + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
    // In a flex/grid column the block also brings one row gap with it
    const parent = p.parentElement;
    if (parent && parent.children.length > 1) {
      const ps = getComputedStyle(parent);
      const column = (ps.display.includes('flex') && ps.flexDirection.startsWith('column')) || ps.display.includes('grid');
      if (column) total += parseFloat(ps.rowGap) || 0;
    }
  });
  return Math.round(total);
}
