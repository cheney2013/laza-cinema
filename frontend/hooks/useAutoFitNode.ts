'use client';

import { useEffect, type MutableRefObject } from 'react';
import { useReactFlow } from '@xyflow/react';
import { clampNodeSize, solveNodeSize, type NodeSizeSpec } from '@/lib/nodeSizing';

export interface UseAutoFitNodeOptions {
  /** 用户手动拖过的宽度。一自由度模型下只需记宽度，高度永远由方程算 */
  userWidth?: number | null;
  /** 内容区自然高度。只进"自然高"，不进下限 */
  contentH?: number;
  /** 这些值变化时重算尺寸 —— 视图模式、比例、状态 */
  deps?: unknown[];
  enabled?: boolean;
  /** 无媒体时高度至少容下功能区 + 内容区自然高（见 useNodeSizing 同名项） */
  growToContent?: boolean;
  /** Taken off the kept height once, the next time there is no media (see useNodeSizing) */
  shrinkOnceRef?: MutableRefObject<number>;
}

/**
 * 让节点尺寸跟着尺寸方程走。
 *
 * 取代各节点里那段 `useEffect + setNodes` 样板（`fitNodeToContent`）。两点关键：
 *
 * 1. 写 **top-level `node.width` / `node.height`**，不是 `node.style.width`。
 *    ReactFlow v12 里 ResizeObserver 一旦写过 `node.width`，`style.width` 就被忽略。
 * 2. `node.resizing` 为真时**一律跳过**。用户正在拖，这时候写尺寸会和 resizer 打架。
 *
 * 宽度取 `userWidth ?? spec.defaultW` —— 用户拖出来的宽度不会被系统改掉；
 * 高度永远重算，所以换素材、改分辨率时画面比例立刻跟上，宽度纹丝不动。
 */
export function useAutoFitNode(
  id: string,
  spec: NodeSizeSpec,
  { userWidth, contentH = 0, deps = [], enabled = true, growToContent = false, shrinkOnceRef }: UseAutoFitNodeOptions = {},
) {
  const { setNodes } = useReactFlow();

  // deps 折成一个定长的 key，而不是 `...deps` 展开进依赖数组。
  // 展开写法有两个毛病：调用方传的数组长度一变就报 "changed size between renders"，
  // 而且以后往内部依赖里加一项，热更新当场就会踩到同一个警告。
  const depsKey = deps
    .map((d) => (d !== null && typeof d === 'object' ? JSON.stringify(d) : String(d)))
    .join('');

  useEffect(() => {
    if (!enabled) return;
    const shrink = !spec.hasMedia && shrinkOnceRef ? shrinkOnceRef.current : 0;
    if (shrinkOnceRef) shrinkOnceRef.current = 0;

    setNodes((nds) =>
      nds.map((n) => {
        if (n.id !== id) return n;
        if (n.resizing) return n; // 用户正在拖，别插手

        // 宽度是黏着的：优先用记下来的手动宽度，其次保留节点现有宽度，都没有才用默认值。
        // 保留现有宽度这一档很关键 —— 老工程的节点没有 userWidth，少了它一打开就被推回
        // 默认宽度，用户之前拖出来的尺寸就丢了。
        const width = userWidth ?? n.width ?? spec.defaultW;
        // 没有画面时高度归内容管，方程只守下限 —— 硬按比例算会造出一大片空白
        let target = spec.hasMedia
          ? solveNodeSize(spec, width, contentH)
          : clampNodeSize(spec, width, (n.height ?? 0) - shrink);
        if (!spec.hasMedia && growToContent && contentH > 0) {
          target = { ...target, height: Math.max(target.height, Math.round(spec.chromeH + contentH)) };
        }
        // Tolerance, not equality: ReactFlow writes the DOM-measured size back
        // (e.g. 228) while the equation yields 227, and the two fought on every
        // drag start -- 50 cards x one setNodes each, the whole canvas
        // re-rendering 50 times (measured 2026-09-05). A sub-3px difference is
        // rounding, not a resize.
        // (the DOM-measured height carries the card's 1px top+bottom borders,
        //  so the honest gap is 2px: 166 measured vs 164 solved)
        if (Math.abs((n.width ?? 0) - target.width) < 3 && Math.abs((n.height ?? 0) - target.height) < 3) return n;
        return { ...n, width: target.width, height: target.height };
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    id,
    setNodes,
    spec.minW,
    spec.minH,
    spec.ratio,
    spec.chromeH,
    spec.defaultW,
    spec.maxW,
    spec.hasMedia,
    spec.mediaHidden,
    userWidth,
    contentH,
    enabled,
    growToContent,
    depsKey,
  ]);
}

/**
 * 松手吸附：按 H(W) 把高度咬合回去，拖拽中出现的黑边消失。
 *
 * ⚠ 调用方必须把它包在 `useCallback` 里再交给 `<NodeResizer onResizeEnd>`。
 * ResizeControl 的 useEffect 依赖数组含 onResizeStart/onResize/onResizeEnd/minWidth/minHeight 等十项，
 * cleanup 会 `destroy()` 掉 d3 drag handler —— 传内联箭头函数会让拖拽在第一帧就断掉。
 */
export function snapNodeToRatio(
  setNodes: ReturnType<typeof useReactFlow>['setNodes'],
  id: string,
  width: number,
  spec: NodeSizeSpec,
  contentH = 0,
) {
  setNodes((nds) =>
    nds.map((n) => {
      if (n.id !== id) return n;
      // 无媒体时不吸附高度：用户刚拖出来的高度是他要的，方程只把它拉回合法区间
      const target = spec.hasMedia
        ? solveNodeSize(spec, width, contentH)
        : clampNodeSize(spec, width, n.height);
      if (n.width === target.width && n.height === target.height) return n;
      return { ...n, width: target.width, height: target.height };
    }),
  );
}
