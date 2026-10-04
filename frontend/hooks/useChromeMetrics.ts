'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getChromeFloor, type ChromeMetrics } from '@/lib/nodeSizing';

/**
 * 功能区最小尺寸的运行时自标定。
 *
 * 为什么不写常量：`minW` 是"按钮在最简化形态下排成一行有多宽"。这个值取决于按钮个数、
 * 文案、字号、字体。原先满仓库的 `minWidth={280}` 就是当年量出来后写死、之后再没人跟着改的产物。
 * 与其再写一批注定失真的常量，不如让它自己量自己：改一句按钮文案，下限自动跟着走。
 *
 * 做法是**就地测量**，不渲染镜像：给节点根临时加一个测量类，强制功能区走图标态并
 * `width: max-content`，读回 `scrollWidth` 与行高，同一帧内把类摘掉。整个过程在
 * `useLayoutEffect` 里完成，浏览器绘制前就已还原，看不到闪动。
 *
 * （早先的版本是把 header/actions 抽成变量再在隐藏镜像里渲染一遍。那样每个接入的节点
 * 都要先做一次 JSX 抽取，推到十几个节点上成本过高，而且等于把同一棵子树渲染两次。）
 *
 * **逐行标定**是必需的，不是精细化：同一个节点的不同视图在场的行不一样。H3 节点预览态
 * 只有标题栏，编辑态还有底部的 seed 与生成按钮 —— 拿一个总高去套预览态会多算 60 多像素，
 * 画面因此永远差一截。所以量的是每一行，用哪几行由节点按当前视图自己点名。
 *
 * 行用 `data-chrome-row="<名字>"` 在 JSX 上标出来。某个视图没渲染的行这次量不到，
 * 会留到渲染了它的视图挂载时补齐 —— 结果按类型累积，不会互相覆盖。
 */

const cache = new Map<string, ChromeMetrics>();
const listeners = new Set<() => void>();

/** 测量期给节点根挂的类。样式在 globals.css 里 */
export const CHROME_MEASURING_CLASS = 'node-chrome-measuring';

function publish(type: string, minW: number, rows: Record<string, number>) {
  const prev = cache.get(type);
  const mergedRows = { ...(prev?.rows || {}), ...rows };
  const next: ChromeMetrics = {
    minW: Math.max(prev?.minW ?? 0, minW),
    chromeH: Object.values(mergedRows).reduce((a, b) => a + b, 0),
    rows: mergedRows,
  };
  const prevRowCount = Object.keys(prev?.rows || {}).length;
  if (
    prev &&
    prev.minW === next.minW &&
    prev.chromeH === next.chromeH &&
    prevRowCount === Object.keys(mergedRows).length
  ) {
    return;
  }
  cache.set(type, next);
  listeners.forEach((fn) => fn());
}

/** 测试与热更新用：丢掉标定结果，下次挂载重新量 */
export function resetChromeMetrics(type?: string) {
  if (type) cache.delete(type);
  else cache.clear();
  listeners.forEach((fn) => fn());
}

export interface UseChromeMetricsOptions {
  /** 功能区各行的名字，与 JSX 上的 `data-chrome-row` 对应 */
  rows: string[];
  /** 节点卡片的左右内边距之和，计入 minW */
  paddingX?: number;
}

export interface ChromeMetricsResult {
  /** 当前可用的功能区尺寸：已标定则是实测值，否则是兜底估算值 */
  metrics: ChromeMetrics;
  /** 取指定几行的高度之和，再加上该视图自己的上下内边距 */
  chromeHeightFor: (rows: string[], paddingY?: number) => number;
  /** 挂到 NodeShell 上，测量时用它找到各功能区行 */
  shellRef: (el: HTMLDivElement | null) => void;
}

/**
 * 行高要连外边距一起算：标题条靠 marginBottom 和主体拉开距离，漏掉就会少算。
 *
 * 用 `offsetHeight` 而不是 `getBoundingClientRect().height` —— 后者返回的是**屏幕像素**，
 * 节点画在 React Flow 的缩放层里，量到的高度会被当前画布缩放整体乘一遍。画布缩到 0.8
 * 时量一次，标定结果就永远矮 20%，而节点高 = chromeH + 宽/比例，少算的部分全变成
 * 媒体区的黑边（比例扁了，object-contain 就在左右补黑）。offsetHeight 是布局像素，
 * 与 transform 无关。
 */
function outerHeight(el: HTMLElement): number {
  const cs = getComputedStyle(el);
  return el.offsetHeight + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
}

export function useChromeMetrics(
  type: string,
  { rows, paddingX = 0 }: UseChromeMetricsOptions,
): ChromeMetricsResult {
  const [, force] = useState(0);
  const elRef = useRef<HTMLDivElement | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const rowsKey = rows.join('|');

  // 订阅缓存变化：同类型的其它节点标定完成后，本节点也要拿到新的下限
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);

  const shellRef = useCallback((el: HTMLDivElement | null) => {
    elRef.current = el;
  }, []);

  // useLayoutEffect：加类、量、摘类必须走在同一帧里，否则会闪一下图标态
  useLayoutEffect(() => {
    const measureOnce = () => {
      const node = elRef.current;
      if (!node) return;
      const known = cache.get(type)?.rows || {};
      const pending = rowsRef.current.filter((n) => known[n] === undefined);
      if (pending.length === 0) return; // 这个类型已经量齐了

      /*
       * 高度量真实形态，宽度量图标态 —— 这两件事必须分开做。
       *
       * minW 的定义就是"图标态排成一行有多宽"，所以宽度必须在测量类下读。
       * 但高度不是：图标态把文案藏了（`[data-chrome='label'] {display:none}`），
       * 标题栏因此矮 5~7px。而节点高 = chromeH + 宽/比例，chromeH 少算多少，
       * 媒体盒就比素材比例扁多少 —— object-contain 把这几像素放大成画面左右两条黑边。
       * 两件事一起量，等于拿图标态的行高去算所有节点的画面高。
       */
      const found: Record<string, number> = {};
      for (const name of pending) {
        const row = node.querySelector<HTMLElement>(`[data-chrome-row="${name}"]`);
        if (!row) continue; // 当前视图没渲染这一行，等渲染它的视图挂载时再补
        found[name] = Math.ceil(outerHeight(row));
      }

      node.classList.add(CHROME_MEASURING_CLASS);
      let width = 0;
      for (const name of pending) {
        const row = node.querySelector<HTMLElement>(`[data-chrome-row="${name}"]`);
        if (!row) continue;
        width = Math.max(width, Math.ceil(row.scrollWidth));
      }
      node.classList.remove(CHROME_MEASURING_CLASS);

      if (width > 0 && Object.keys(found).length > 0) {
        publish(type, width + paddingX, found);
      }
    };

    measureOnce();
    // 字体未就位时量出来的宽度偏窄，等 webfont 落地后，若还有没量到的行再补一次
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    fonts?.ready?.then(() => measureOnce()).catch(() => {});
  }, [type, rowsKey, paddingX]);

  const cached = cache.get(type);
  const metrics = cached ?? getChromeFloor(type);

  const chromeHeightFor = useCallback(
    (names: string[], paddingY = 0) => {
      const measured = metrics.rows;
      const declared = rowsKey.split('|');
      const share = Math.round(metrics.chromeH / Math.max(declared.length, 1));
      const sum = names.reduce((acc, n) => {
        const v = measured?.[n];
        // 没量到的行按行数在兜底总高里分摊，宁可略高也别裁
        return acc + (v === undefined ? share : v);
      }, 0);
      return sum + paddingY;
    },
    [metrics, rowsKey],
  );

  return useMemo(
    () => ({ metrics, chromeHeightFor, shellRef }),
    [metrics, chromeHeightFor, shellRef],
  );
}
