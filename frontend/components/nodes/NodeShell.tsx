'use client';

import React, { createContext, memo, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { showAlert, showPrompt } from '@/components/ui/Dialog';
import {
  NodeResizeControl,
  useStore as useFlowStore,
  NodeResizer,
  ResizeControlVariant,
  useReactFlow,
  useUpdateNodeInternals,
  type OnResizeEnd,
} from '@xyflow/react';
import { openPanelsHeight, solveNodeSize, type NodeSizeSpec } from '@/lib/nodeSizing';
import { t } from '@/lib/i18n';
import { nodePreview } from '@/lib/nodePreview';
import { posterUrl } from '@/lib/config';

/**
 * 节点布局骨架 —— 尺寸下限、比例吸附、密度容器、溢出兜底四件事的落点。
 *
 * 弹性次序由 globals.css 的槽位类给出（见 docs/node-sizing.md §0.1）：
 *   .node-shell-header / .node-shell-actions  flex:0 0 auto —— 功能区，永不压缩
 *   .node-shell-media                          flex:1 1 auto —— 媒体区，吃掉剩余
 *   .node-shell-content                        flex:0 1 auto —— 内容区，先被挤走并自己滚动
 *   .node-shell-drawer                         设置面板，流内一行：打开撑高节点，关上还原
 *   [data-node-expand]                         内容里可折叠的块，规则同上
 *   [data-node-media]                          画面块：有媒体时打开设置就隐藏并暂停，节点 = 功能区 + 设置 + 内容
 *
 * 面板撑高由谁负责只有一个答案：有媒体时它是功能区一行（或内容区的一部分），由尺寸
 * 方程加进节点高度；没有媒体时由这里临时加高（见 panelExtra），不写节点的保存尺寸。
 *
 * 槽位用类名就地标记，不做成 props：节点里那几百行 JSX 不需要搬家。
 *
 * shell 根节点**绝不设 minWidth**。原先 `nodeWrapper(280)` 设了，而节点框可以被算到
 * 200px 宽，于是内容比节点框宽 80px，标题栏按钮被整排切掉。宽度下限只能由
 * NodeResizer.minWidth 在节点层面保证。
 */

export interface NodeShellProps {
  nodeId: string;
  spec: NodeSizeSpec;
  selected?: boolean;
  /** 必须是 useCallback 的结果，否则拖拽会在第一帧断掉。见 docs/node-sizing.md §5.1 */
  onResizeEnd?: OnResizeEnd;
  resizerVisible?: boolean;
  /** 来自 useChromeMetrics，测量时用它找到各功能区行 */
  shellRef?: (el: HTMLDivElement | null) => void;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/**
 * 可滚动内容区的标记。
 *
 * 两种写法是有意分开的：`.node-shell-content` 同时带上"先被挤走"的弹性
 * （flex:0 1 auto），适合和媒体区抢空间的槽；`data-shell-content` 只做标记，
 * 不碰布局 —— 给那些本来就该 flex-1 生长的编辑区用，贴上类名会把它们的 flex 改坏。
 */
const CONTENT_SELECTOR = '.node-shell-content, [data-shell-content]';

/**
 * True inside a NodeShell. Handles rendered there leave their vertical position
 * to the shell, which spreads each side's handles evenly down the card body.
 */
export const InNodeShell = createContext(false);

/** Spread one side's handles evenly below the header; true if any moved. */
function spreadHandles(root: HTMLElement): boolean {
  let moved = false;
  for (const side of ['left', 'right']) {
    const handles = Array.from(root.querySelectorAll<HTMLElement>(`.react-flow__handle-${side}`))
      .filter((h) => h.closest('.node-shell') === root);
    handles.forEach((h, i) => {
      const share = ((i + 1) / (handles.length + 1)).toFixed(4);
      const top = `calc(var(--shell-top-inset, 0px) + (100% - var(--shell-top-inset, 0px)) * ${share})`;
      if (h.style.top !== top) {
        h.style.top = top;
        moved = true;
      }
    });
  }
  return moved;
}
/** How far an edit panel may grow past the node's saved height. */
const EDIT_EXTRA_MAX = 1200;

/**
 * How much taller the content wants to be than it is now (negative: how much
 * it could give back). Each content slot is measured at its natural height --
 * flex and height lifted for one synchronous read, so the number does not
 * depend on the box it currently gets -- and free space left at the bottom of
 * the shell (when nothing stretches to fill it) counts as give-back too.
 */
function contentShortfall(root: HTMLElement): number {
  let delta = 0;
  root.querySelectorAll<HTMLElement>(CONTENT_SELECTOR).forEach((c) => {
    if (c.closest('.node-shell') !== root || !c.offsetParent) return;
    const before = c.offsetHeight;
    const { flex, height, minHeight } = c.style;
    c.style.flex = '0 0 auto';
    c.style.height = 'auto';
    c.style.minHeight = '0';
    const natural = c.offsetHeight;
    c.style.flex = flex;
    c.style.height = height;
    c.style.minHeight = minHeight;
    delta += natural - before;
  });
  let bottom = 0;
  for (const child of Array.from(root.children) as HTMLElement[]) {
    const pos = getComputedStyle(child).position;
    if (pos === 'absolute' || pos === 'fixed' || !child.offsetParent) continue;
    bottom = Math.max(bottom, child.offsetTop + child.offsetHeight + (parseFloat(getComputedStyle(child).marginBottom) || 0));
  }
  const free = root.clientHeight - (parseFloat(getComputedStyle(root).paddingBottom) || 0) - bottom;
  return delta - Math.max(0, free);
}

/** 参与实测降级的按钮排：标题栏自动算一排，覆盖层等额外的排显式标记 */
const BTNROW_SELECTOR = '.node-shell-btnrow, [data-chrome-row]';

const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;
const H_LINES = ['left', 'right'] as const;
const V_LINES = ['top', 'bottom'] as const;

const HANDLE_STYLE: CSSProperties = {
  width: 8,
  height: 8,
  background: '#fff',
  border: '1.5px solid #000',
  borderRadius: 2,
  zIndex: 100,
};

const LINE_STYLE: CSSProperties = {
  border: '1px solid rgba(255, 255, 255, 0.6)',
  zIndex: 99,
};

const shellStyle: CSSProperties = {
  width: '100%',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  boxSizing: 'border-box',
  position: 'relative',
};

function NodeShell({
  nodeId,
  spec,
  selected,
  onResizeEnd,
  resizerVisible,
  shellRef,
  children,
  className,
  style,
}: NodeShellProps) {
  const { setNodes } = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();
  const lastShellHeight = useRef(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const showResizer = resizerVisible ?? selected;
  const [overflowing, setOverflowing] = useState(false);
  /**
   * Extra height while editing. A node showing its edit panel (no media on
   * screen) whose content does not fit grows downward by what is missing,
   * without touching its saved size, and gives it back as the content gets
   * shorter: it always equals what the content needs past the saved size.
   * (It used to be grow-only and kept whatever a view switch had briefly asked
   * for -- 400 px of blank card under a video edit node.)
   */
  const [editExtra, setEditExtra] = useState(0);
  const editExtraRef = useRef(0);
  editExtraRef.current = editExtra;
  /**
   * Height of the open panels while the node shows no media: opening a panel
   * grows the node by exactly its height, closing it takes that back. With media
   * the sizing equation does this (the drawer is a chrome row), so this stays 0.
   * Kept out of the saved size, so a save with a panel open does not leave the
   * node taller.
   */
  const [panelExtra, setPanelExtra] = useState(0);
  const panelExtraRef = useRef(0);
  panelExtraRef.current = panelExtra;
  const checkRef = useRef<(() => void) | null>(null);
  const specRef = useRef(spec);
  specRef.current = spec;

  const commonResizerProps = {
    nodeId,
    color: '#fff',
    minWidth: spec.minW,
    minHeight: spec.minH,
    maxWidth: spec.maxW,
    keepAspectRatio: false as const,
    onResizeEnd,
  };

  const setRoot = useCallback(
    (el: HTMLDivElement | null) => {
      rootRef.current = el;
      shellRef?.(el);
    },
    [shellRef],
  );

  /**
   * 适配内容：把内容区被裁掉的部分补回节点高度。
   *
   * 通用实现放在 shell 里而不是每个节点各写一份 —— 它要的信息全在 DOM 上：
   * `.node-shell-content` 的 scrollHeight 超出 clientHeight 多少，就补多少。
   * 没有溢出时退回尺寸方程的自然高。
   */
  const fitToContent = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    let overflow = 0;
    el.querySelectorAll<HTMLElement>(CONTENT_SELECTOR).forEach((c) => {
      overflow += Math.max(0, c.scrollHeight - c.clientHeight);
    });
    setNodes((nds) =>
      nds.map((n) => {
        if (n.id !== nodeId) return n;
        const s = specRef.current;
        const solved = solveNodeSize(s, n.width);
        const height = overflow > 0 ? Math.max(s.minH, (n.height ?? 0) + overflow) : solved.height;
        if (n.width === solved.width && n.height === height) return n;
        return { ...n, width: solved.width, height };
      }),
    );
  }, [nodeId, setNodes]);

  // 双击任意一个 resize 手柄 = 适配内容。对齐窗口管理器的直觉，不额外占用界面
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (!(e.target as HTMLElement).closest?.('.react-flow__resize-control')) return;
      e.stopPropagation();
      fitToContent();
    },
    [fitToContent],
  );

  // 溢出角标 + 按钮排降级
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;

    /**
     * 按钮排放不下就整排收成图标态。
     *
     * 先摘掉 compact 量一次自然宽度，再决定要不要加回去 —— 只有这样节点被拖宽时
     * 文案才能重新展开。断点不写死：按钮个数与文案随时会改，任何像素常量都注定失真。
     */
    const fitRows = () => {
      el.querySelectorAll<HTMLElement>(BTNROW_SELECTOR).forEach((row) => {
        row.removeAttribute('data-fit');
        if (row.scrollWidth > row.clientWidth + 1) row.setAttribute('data-fit', 'compact');
      });
    };

    const check = () => {
      fitRows();
      /*
       * 选中框只框住卡片主体：标题栏是画布上的裸文字，不该被 resizer 边线圈进去。
       * 头部高度随字号/换行变化，所以量一次写进 CSS 变量，由 globals.css 把
       * 上边线与上排手柄整体下移。
       */
      const headerEl = el.querySelector<HTMLElement>('.node-shell-header');
      const inset = headerEl ? headerEl.offsetHeight + (parseFloat(getComputedStyle(headerEl).marginBottom) || 0) : 0;
      el.style.setProperty('--shell-top-inset', `${inset}px`);
      // Panels first: a panel that just opened makes the content overflow until
      // its height is added, and the sticky edit growth must not take that.
      const editing = !specRef.current.hasMedia;
      const panels = editing ? openPanelsHeight(el) : 0;
      if (Math.abs(panels - panelExtraRef.current) >= 1) {
        panelExtraRef.current = panels;
        setPanelExtra(panels);
        return; // the shell resizes, the observer runs this again
      }
      if (editing) {
        const next = Math.round(Math.min(EDIT_EXTRA_MAX, Math.max(0, editExtraRef.current + contentShortfall(el))));
        if (Math.abs(next - editExtraRef.current) >= 2) {
          editExtraRef.current = next;
          setEditExtra(next);
          return; // the shell resizes, the observer runs this again
        }
      }
      let over = false;
      el.querySelectorAll<HTMLElement>(CONTENT_SELECTOR).forEach((c) => {
        if (c.scrollHeight - c.clientHeight > 4) over = true;
      });
      setOverflowing(over);
      // Handles are placed in % of the shell; when they move, or the shell's
      // height changes under them, React Flow re-reads where edges attach.
      const moved = spreadHandles(el);
      if (moved || el.offsetHeight !== lastShellHeight.current) {
        lastShellHeight.current = el.offsetHeight;
        updateNodeInternals(nodeId);
      }
    };
    checkRef.current = check;
    check();
    // 只观察根节点，内容元素每次现查 —— 内容槽可能随视图切换出现或消失，
    // 提前订阅具体元素反而会漏。子树增删用 MutationObserver 兜住。
    const ro = new ResizeObserver(check);
    ro.observe(el);
    const mo = new MutationObserver(check);
    mo.observe(el, { childList: true, subtree: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, []);

  // Showing media again ends the temporary growth.
  useEffect(() => {
    if (spec.hasMedia && editExtraRef.current) {
      editExtraRef.current = 0;
      setEditExtra(0);
    }
    // Media appearing or going away moves the panels between the equation and here.
    checkRef.current?.();
  }, [spec.hasMedia]);

  // Settings open on a node with media: the picture is hidden (CSS on
  // data-media-hidden) and whatever plays in it stops.
  useEffect(() => {
    if (!spec.mediaHidden) return;
    rootRef.current?.querySelectorAll<HTMLMediaElement>('[data-node-media] video, [data-node-media] audio').forEach((m) => m.pause());
  }, [spec.mediaHidden]);

  const extra = spec.hasMedia ? 0 : editExtra + panelExtra;
  const extended = extra > 0;
  // The picture the outline mode (zoomed out) paints on this card's plate, as a
  // CSS variable: only the URL is subscribed, so the card re-renders when its
  // media changes, not on every store update.
  const lodThumb = useFlowStore(useCallback((st) => {
    const n = st.nodeLookup.get(nodeId);
    const image = n ? nodePreview(n.data as Record<string, unknown>, n.type).image : null;
    // Always the small cached JPEG (<= 640 px), for pictures too: 80 full-size PNGs
    // decoded as plate backgrounds overran the image budget and cards went undrawn.
    return image && !image.includes('/media/poster?') ? posterUrl(image) ?? image : image;
  }, [nodeId]));

  return (
    <div
      ref={setRoot}
      className={`node-shell group${className ? ` ${className}` : ''}`}
      data-edit-extended={extended ? '' : undefined}
      data-media-hidden={spec.mediaHidden ? '' : undefined}
      style={{ ...shellStyle, ...(extended ? { height: `calc(100% + ${extra}px)` } : null), ...(lodThumb ? { ['--lod-thumb' as string]: `url(${JSON.stringify(lodThumb)})` } : null), ...style }}
      onDoubleClick={handleDoubleClick}
    >
      {showResizer &&
        (spec.hasMedia ? (
          /*
           * 有媒体：边线要按轴向拆开。NodeResizer 不暴露 resizeDirection，
           * 而 constrainResizeChanges 需要 `setAttributes` 来判断这次拖拽以宽还是高为准 ——
           * 靠猜会抖（见 lib/nodeSizing.ts）。所以这里自己摆一套控件。
           */
          <>
            {H_LINES.map((position) => (
              <NodeResizeControl
                key={position}
                {...commonResizerProps}
                position={position}
                variant={ResizeControlVariant.Line}
                resizeDirection="horizontal"
                style={LINE_STYLE}
              />
            ))}
            {V_LINES.map((position) => (
              <NodeResizeControl
                key={position}
                {...commonResizerProps}
                position={position}
                variant={ResizeControlVariant.Line}
                resizeDirection="vertical"
                style={LINE_STYLE}
              />
            ))}
            {CORNERS.map((position) => (
              <NodeResizeControl
                key={position}
                {...commonResizerProps}
                position={position}
                style={HANDLE_STYLE}
              />
            ))}
          </>
        ) : (
          <NodeResizer
            color="#fff"
            minWidth={spec.minW}
            minHeight={spec.minH}
            maxWidth={spec.maxW}
            // 一律关闭：它锁的是节点框比例，而节点 = 功能区固定像素带 + 媒体区，
            // 锁出来的是一个随尺寸漂移的错误比例。没有媒体的节点本就不需要锁比例。
            keepAspectRatio={false}
            onResizeEnd={onResizeEnd}
            handleStyle={HANDLE_STYLE}
            lineStyle={LINE_STYLE}
          />
        ))}

      <NodeAliasTag nodeId={nodeId} selected={Boolean(selected)} />
      <InNodeShell.Provider value={true}>{children}</InNodeShell.Provider>

      {overflowing && (
        <button
          type="button"
          className="node-shell-overflow nodrag"
          title={t('内容没显示全 — 点击把节点调到装得下')}
          onClick={(e) => {
            e.stopPropagation();
            fitToContent();
          }}
        >
          ⌄
        </button>
      )}
    </div>
  );
}

export default memo(NodeShell);

/**
 * A node's alias, as a tag above its top-left corner.
 *
 * Every node can carry one (`data.alias`, unique across the canvas, the name
 * prompts and references use). The tag scales by the inverse of the zoom, so
 * the canvas can be zoomed out to an overview and the names stay readable.
 * Selecting a node shows "+ 别名" (or the alias itself) as a button to set it;
 * unselected, the tag never takes the pointer.
 */
function NodeAliasTag({ nodeId, selected }: { nodeId: string; selected: boolean }) {
  const { updateNodeData, getNodes } = useReactFlow();
  const alias = useFlowStore(useCallback((s) => {
    const a = s.nodeLookup.get(nodeId)?.data?.alias;
    return typeof a === 'string' ? a.trim() : '';
  }, [nodeId]));

  if (!alias && !selected) return null;

  const edit = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const input = await showPrompt(t('节点别名（全画布唯一，提示词和引用里用它指代这个节点）'), {
      title: t('设置别名'),
      defaultValue: alias,
      placeholder: t('留空可清除别名'),
    });
    if (input === null) return;
    const next = input.trim();
    if (next) {
      const taken = getNodes().find(
        (n) => n.id !== nodeId && String((n.data as Record<string, unknown>)?.alias ?? '').trim().toLowerCase() === next.toLowerCase(),
      );
      if (taken) {
        void showAlert(t('别名「{v1}」已被其他节点占用，别名必须全画布唯一。', { v1: next }), { title: t('别名冲突'), danger: true });
        return;
      }
    }
    updateNodeData(nodeId, { alias: next || undefined });
    window.dispatchEvent(new Event('takeSnapshot'));
  };

  return (
    <button
      type="button"
      className={`node-alias-tag nodrag ${alias ? '' : 'node-alias-tag--empty'} ${selected ? '' : 'pointer-events-none'}`}
      onClick={edit}
      title={selected ? t('点击修改别名') : alias}
    >
      {alias || t('+ 别名')}
    </button>
  );
}
