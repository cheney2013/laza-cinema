'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useReactFlow, type OnResizeEnd } from '@xyflow/react';
import {
  DRAWER_SELECTOR,
  getNodeSizeSpec,
  openPanelsHeight,
  registerNodeSize,
  resolveMediaRatio,
  unregisterNodeSize,
  type NodeSizeSpec,
} from '@/lib/nodeSizing';
import { useChromeMetrics } from './useChromeMetrics';
import { snapNodeToRatio, useAutoFitNode } from './useAutoFitNode';

/**
 * 节点尺寸的一站式接线。
 *
 * 把 useChromeMetrics + getNodeSizeSpec + useAutoFitNode + 松手吸附四件事收在一起，
 * 每个节点只写一次调用。分开写的话每个节点要重复约 25 行样板，十几个节点抄下来，
 * 迟早有一个抄漏 —— 尤其是 `onResizeEnd` 必须 useCallback 那条（漏了拖拽当场断）。
 *
 * 详见 docs/node-sizing.md。
 */

/** The chrome row name of a node's settings drawer. */
export const DRAWER_ROW = 'settings';

export interface UseNodeSizingOptions {
  id: string;
  /** 节点类型，标定结果按它缓存 */
  type: string;
  /** 该节点声明的所有功能区行名，与 JSX 上的 data-chrome-row 对应 */
  rows: string[];
  /** 当前视图实际在场的行。缺省为全部 */
  activeRows?: string[];
  /** 卡片左右内边距之和，计入 minW */
  paddingX?: number;
  /** 当前视图的上下内边距之和，计入 chromeH */
  paddingY?: number;
  /**
   * 媒体比例的后备来源，按优先级排列，通常是 `[{ width: data.width, height: data.height }]`。
   *
   * 媒体的自然尺寸不用传：它由 `onMediaSize` 记在钩子内部，并且**永远排在最前**。
   * 让调用方传会形成先有鸡还是先有蛋 —— 自然尺寸是这个钩子的返回值之一。
   */
  ratioSources?: Array<{ width?: number | null; height?: number | null } | null | undefined>;
  /**
   * 当前视图是否真的在显示媒体。
   * 纯控件形态（没有画面框）要传 false，否则会按比例凭空造出一大片空白。
   */
  hasMedia?: boolean;
  /** Floor of the body when there is no media (default CONTENT_MIN_H); an audio strip passes AUDIO_CONTENT_H. */
  contentMinH?: number;
  /** 用户手动拖出来的宽度，通常是 data.userWidth */
  userWidth?: number | null;
  /** 这些值变化时重算尺寸 —— 视图模式、状态等 */
  deps?: unknown[];
  /**
   * 没有画面时也让 `.node-shell-content` 撑高节点（只长不缩到内容以下）。
   * 默认关：无媒体时高度归用户，内容区滚动。控件会展开的节点（换机位的机位面板）打开它。
   */
  growToContent?: boolean;
}

export interface UseNodeSizingResult {
  spec: NodeSizeSpec;
  /** 挂到 <NodeShell shellRef=...> */
  shellRef: (el: HTMLDivElement | null) => void;
  /** 挂到 <NodeShell onResizeEnd=...>，已经 useCallback 过 */
  onResizeEnd: OnResizeEnd;
  /** 媒体元素拿到自然尺寸时调用（<video> onLoadedMetadata / <img> onLoad） */
  onMediaSize: (width: number, height: number) => void;
  /** 已记录的媒体自然尺寸 */
  naturalSize: { width: number; height: number } | null;
}

export function useNodeSizing({
  id,
  type,
  rows,
  activeRows,
  paddingX = 28,
  paddingY = 0,
  ratioSources = [],
  hasMedia = true,
  contentMinH,
  userWidth,
  deps = [],
  growToContent = false,
}: UseNodeSizingOptions): UseNodeSizingResult {
  const { setNodes, updateNodeData } = useReactFlow();
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);

  const chrome = useChromeMetrics(type, { rows, paddingX });
  // Panels (the settings drawer, collapsible blocks) grow the node by their own
  // height and give it back on close. With media the equation does it: the drawer
  // is a chrome row, a block is part of contentH. Without media NodeShell does it
  // without touching the saved size, so here they are left out -- counted here
  // too, they would raise minH / the grown height for good and the node would not
  // shrink on close.
  const [contentH, contentRef] = useContentHeight(chrome.shellRef, hasMedia || growToContent, !hasMedia);
  const presentRows = (activeRows ?? rows).filter((r) => hasMedia || r !== DRAWER_ROW);
  // With media, an open drawer hides the picture (the node marks it data-node-media)
  // and the node becomes chrome + drawer + content.
  const mediaHidden = hasMedia && presentRows.includes(DRAWER_ROW);
  const [liveChromeH, shellRef] = useLiveChromeHeight(contentRef, presentRows, paddingY);

  // 自然尺寸永远优先：它是真实画面，data.width/height 只是即将生成的目标分辨率
  const ratio = resolveMediaRatio(naturalSize, ...ratioSources);
  // 实测优先：按类型缓存的那份是估算值，只在本实例还没量到时兜底
  const chromeH = liveChromeH ?? chrome.chromeHeightFor(presentRows, paddingY);

  const spec = useMemo(
    () => getNodeSizeSpec(type, ratio, chrome.metrics, { hasMedia, mediaHidden, chromeH, contentMinH }),
    [type, ratio, chrome.metrics, hasMedia, mediaHidden, chromeH, contentMinH],
  );

  const specRef = useRef(spec);
  specRef.current = spec;

  // 登记给画布：拖拽期的等比例约束在 onNodesChange 里生效，那里拿不到组件作用域
  registerNodeSize(id, spec);
  useEffect(() => () => unregisterNodeSize(id), [id]);

  // Media going away with the drawer open: the equation had the drawer in the
  // saved height, and from here on NodeShell adds it on top -- so that share is
  // taken off the saved height once, or closing the drawer would leave the node
  // a drawer taller. Measured in a layout effect: the DOM is the new view, the
  // drawer still open, and useAutoFitNode's effect has not run yet.
  const shellElRef = useRef<HTMLDivElement | null>(null);
  const shrinkOnceRef = useRef(0);
  const hadMediaRef = useRef(hasMedia);
  useLayoutEffect(() => {
    const el = shellElRef.current;
    shrinkOnceRef.current = hadMediaRef.current && !hasMedia && el ? openPanelsHeight(el, el, DRAWER_SELECTOR) : 0;
    hadMediaRef.current = hasMedia;
  }, [hasMedia]);
  const setShellRef = useCallback(
    (el: HTMLDivElement | null) => {
      shellElRef.current = el;
      shellRef(el);
    },
    [shellRef],
  );

  useAutoFitNode(id, spec, { userWidth: userWidth ?? null, contentH, deps, growToContent, shrinkOnceRef });

  // ⚠ 必须 useCallback：ResizeControl 的 useEffect 依赖含 onResizeEnd，
  // cleanup 会 destroy 掉 d3 drag handler。内联箭头函数会让拖拽在第一帧就断掉。
  const onResizeEnd = useCallback<OnResizeEnd>(
    (_, params) => {
      const width = Math.round(params.width);
      updateNodeData(id, { userWidth: width });
      snapNodeToRatio(setNodes, id, width, specRef.current);
    },
    [id, setNodes, updateNodeData],
  );

  const onMediaSize = useCallback((width: number, height: number) => {
    if (!width || !height) return;
    setNaturalSize((prev) =>
      prev && prev.width === width && prev.height === height ? prev : { width, height },
    );
  }, []);

  return { spec, shellRef: setShellRef, onResizeEnd, onMediaSize, naturalSize };
}

/**
 * 本实例功能区的真实高度，喂给尺寸方程的 chromeH 项。
 *
 * useChromeMetrics 量的那份是**按类型缓存**的：谁先挂载谁说了算，之后再不重量。
 * 而同一类型的标题栏高度会随视图（有没有素材、有没有参数条）、字体加载时机变化，
 * 早期还会被画布缩放整体乘一遍。少算一像素，媒体框就比素材比例扁一像素，
 * object-contain 在左右补黑；多算一像素就在上下补黑。那份缓存适合用来定 minW
 * （"图标态排一行有多宽"是真常量），不适合用来定画面高度。
 *
 * 所以高度按实例实测、随布局变化跟着走。不会形成反馈环：行高由内容和节点宽度决定，
 * 与节点高度无关，改完高度再量还是同一个数，一帧收敛。
 */
function useLiveChromeHeight(
  shellRef: (el: HTMLDivElement | null) => void,
  rowNames: string[],
  paddingY: number,
): [number | null, (el: HTMLDivElement | null) => void] {
  // Kept with the rows it was measured for: when the rows change (a view switch,
  // the drawer leaving the chrome when media goes away) the old number is stale
  // until the next measurement, and a stale number that includes the drawer
  // raises minH -- which the kept height then never gives back.
  const [measured, setMeasured] = useState<{ key: string; h: number } | null>(null);
  const elRef = useRef<HTMLDivElement | null>(null);
  const namesKey = rowNames.join('|');
  const chromeH = measured && measured.key === namesKey ? measured.h : null;

  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      elRef.current = el;
      shellRef(el);
    },
    [shellRef],
  );

  useEffect(() => {
    const el = elRef.current;
    const names = namesKey.split('|').filter(Boolean);
    if (!el || names.length === 0) return;

    let raf = 0;
    const measure = () => {
      raf = 0;
      let total = 0;
      for (const name of names) {
        const row = el.querySelector<HTMLElement>(`[data-chrome-row="${name}"]`);
        // 当前视图没渲染齐声明的行 —— 这次量到的是残缺值，交回给按类型的估算
        if (!row) return;
        const cs = getComputedStyle(row);
        total +=
          row.offsetHeight +
          (parseFloat(cs.marginTop) || 0) +
          (parseFloat(cs.marginBottom) || 0);
      }
      const next = Math.round(total + paddingY);
      setMeasured((prev) => (prev && prev.key === namesKey && Math.abs(prev.h - next) < 1 ? prev : { key: namesKey, h: next }));
    };
    // rAF 合并：ResizeObserver 回调里同步改状态会触发 "loop completed with
    // undelivered notifications"，而且标定类的加/摘也可能正好夹在中间
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };

    schedule();
    // Observe the rows, not the shell. The shell's size is what the equation
    // *sets* from this measurement, so observing it closed a loop: set height ->
    // shell resizes -> re-measure -> a different chromeH -> set height again.
    // Measured 2026-09-05: 110 measurements, 110 state changes, in one drag.
    const ro = new ResizeObserver(schedule);
    for (const name of names) {
      const row = el.querySelector<HTMLElement>(`[data-chrome-row="${name}"]`);
      if (row) ro.observe(row);
    }
    // 行可能随视图切换整块换掉，换进来的新行要重新盯住
    const mo = new MutationObserver(schedule);
    mo.observe(el, { childList: true, subtree: true });

    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
    };
  }, [namesKey, paddingY]);

  return [chromeH, setRef];
}

/**
 * 内容区的自然高度，喂给尺寸方程的 contentH 项。
 *
 * 不接这一项的话方程只算 chromeH + W/ratio，而 `.node-shell-content` 是
 * flex:0 1 auto，它要的高度只能从 flex:1 的媒体区里抢 —— 媒体框于是矮于 W/ratio，
 * object-contain 在左右留出两条黑边（演员掩码节点的候选列表就是这么把画面挤扁的）。
 *
 * 量的是 scrollHeight（内容本身的高），不是渲染高：渲染高会随节点高度变化，
 * 拿它当输入就成了反馈环。带 max-height 的滚动区按 max-height 封顶 —— 超出的部分
 * 本来就该自己滚。
 */
function useContentHeight(
  shellRef: (el: HTMLDivElement | null) => void,
  enabled: boolean,
  /** Leave open panels out (NodeShell adds them when there is no media) */
  withoutPanels: boolean,
): [number, (el: HTMLDivElement | null) => void] {
  const [contentH, setContentH] = useState(0);
  const elRef = useRef<HTMLDivElement | null>(null);

  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      elRef.current = el;
      shellRef(el);
    },
    [shellRef],
  );

  useEffect(() => {
    const el = elRef.current;
    if (!el || !enabled) {
      setContentH(0);
      return;
    }
    const measure = () => {
      let total = 0;
      el.querySelectorAll<HTMLElement>('.node-shell-content').forEach((c) => {
        const cs = getComputedStyle(c);
        const maxH = parseFloat(cs.maxHeight);
        const natural =
          c.scrollHeight -
          (withoutPanels ? openPanelsHeight(el, c) : 0) +
          (parseFloat(cs.marginTop) || 0) +
          (parseFloat(cs.marginBottom) || 0) +
          (parseFloat(cs.borderTopWidth) || 0) +
          (parseFloat(cs.borderBottomWidth) || 0);
        total += Number.isFinite(maxH) ? Math.min(natural, maxH) : natural;
      });
      setContentH((prev) => (Math.abs(prev - total) < 1 ? prev : Math.round(total)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const mo = new MutationObserver(measure);
    mo.observe(el, { childList: true, subtree: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [enabled, withoutPanels]);

  return [contentH, setRef];
}
