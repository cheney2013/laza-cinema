'use client';

import React from 'react';
import { useViewport } from '@xyflow/react';
import { useStore } from '@/lib/store';
import { calculateCinemaLayout, getNodeBounds } from '@/lib/layoutEngine';
import { t } from '@/lib/i18n';

export default function SelectionBoundingBox() {
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  const setNodes = useStore((s) => s.setNodes);
  const takeSnapshot = useStore((s) => s.takeSnapshot);
  const { x, y, zoom } = useViewport();

  const selectedNodes = nodes.filter((n) => n.selected);

  // 仅在选中 2 个及以上节点时显示多选对齐包围框
  if (selectedNodes.length < 2) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const node of selectedNodes) {
    const { width: w, height: h } = getNodeBounds(node);
    const nx = node.position.x;
    const ny = node.position.y;

    if (nx < minX) minX = nx;
    if (ny < minY) minY = ny;
    if (nx + w > maxX) maxX = nx + w;
    if (ny + h > maxY) maxY = ny + h;
  }

  if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) return null;

  const boxCenterX = (minX + maxX) / 2;
  const boxCenterY = (minY + maxY) / 2;

  const pad = 12;
  const screenX = (minX - pad) * zoom + x;
  const screenY = (minY - pad) * zoom + y;
  const screenW = (maxX - minX + pad * 2) * zoom;
  const screenH = (maxY - minY + pad * 2) * zoom;

  const handleSize = Math.max(6, Math.min(10, 8 * zoom));

  // ── 水平对齐操作 ──────────────────────────────────────
  const alignLeft = () => {
    takeSnapshot();
    setNodes(
      nodes.map((n) =>
        n.selected ? { ...n, position: { ...n.position, x: minX } } : n
      )
    );
  };

  const alignCenterH = () => {
    takeSnapshot();
    setNodes(
      nodes.map((n) => {
        if (!n.selected) return n;
        const { width: w } = getNodeBounds(n);
        return {
          ...n,
          position: { ...n.position, x: Math.round(boxCenterX - w / 2) },
        };
      })
    );
  };

  const alignRight = () => {
    takeSnapshot();
    setNodes(
      nodes.map((n) => {
        if (!n.selected) return n;
        const { width: w } = getNodeBounds(n);
        return {
          ...n,
          position: { ...n.position, x: Math.round(maxX - w) },
        };
      })
    );
  };

  // ── 垂直对齐操作 ──────────────────────────────────────
  const alignTop = () => {
    takeSnapshot();
    setNodes(
      nodes.map((n) =>
        n.selected ? { ...n, position: { ...n.position, y: minY } } : n
      )
    );
  };

  const alignCenterV = () => {
    takeSnapshot();
    setNodes(
      nodes.map((n) => {
        if (!n.selected) return n;
        const { height: h } = getNodeBounds(n);
        return {
          ...n,
          position: { ...n.position, y: Math.round(boxCenterY - h / 2) },
        };
      })
    );
  };

  const alignBottom = () => {
    takeSnapshot();
    setNodes(
      nodes.map((n) => {
        if (!n.selected) return n;
        const { height: h } = getNodeBounds(n);
        return {
          ...n,
          position: { ...n.position, y: Math.round(maxY - h) },
        };
      })
    );
  };

  // ── 真实几何等间距分布 ──────────────────────────────────
  const distributeHorizontally = () => {
    takeSnapshot();
    const sorted = [...selectedNodes].sort((a, b) => a.position.x - b.position.x);
    if (sorted.length < 3) return;

    const totalWidth = sorted.reduce((sum, n) => sum + getNodeBounds(n).width, 0);
    const spanWidth = maxX - minX;
    const totalGap = spanWidth - totalWidth;
    const gap = Math.max(20, totalGap / (sorted.length - 1));

    const posMap = new Map<string, number>();
    let currentX = minX;
    sorted.forEach((n) => {
      posMap.set(n.id, Math.round(currentX));
      currentX += getNodeBounds(n).width + gap;
    });

    setNodes(
      nodes.map((n) =>
        n.selected && posMap.has(n.id)
          ? { ...n, position: { ...n.position, x: posMap.get(n.id)! } }
          : n
      )
    );
  };

  const distributeVertically = () => {
    takeSnapshot();
    const sorted = [...selectedNodes].sort((a, b) => a.position.y - b.position.y);
    if (sorted.length < 3) return;

    const totalHeight = sorted.reduce((sum, n) => sum + getNodeBounds(n).height, 0);
    const spanHeight = maxY - minY;
    const totalGap = spanHeight - totalHeight;
    const gap = Math.max(20, totalGap / (sorted.length - 1));

    const posMap = new Map<string, number>();
    let currentY = minY;
    sorted.forEach((n) => {
      posMap.set(n.id, Math.round(currentY));
      currentY += getNodeBounds(n).height + gap;
    });

    setNodes(
      nodes.map((n) =>
        n.selected && posMap.has(n.id)
          ? { ...n, position: { ...n.position, y: posMap.get(n.id)! } }
          : n
      )
    );
  };

  // ── 紧凑网格整理 (Pack Grid) ────────────────────────────
  const packGrid = () => {
    takeSnapshot();
    const sorted = [...selectedNodes].sort(
      (a, b) => a.position.y - b.position.y || a.position.x - b.position.x
    );
    const cols = Math.ceil(Math.sqrt(sorted.length));
    const GAP = 32;

    const maxW = Math.max(...sorted.map((n) => getNodeBounds(n).width));
    const maxH = Math.max(...sorted.map((n) => getNodeBounds(n).height));

    const posMap = new Map<string, { x: number; y: number }>();
    sorted.forEach((n, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      posMap.set(n.id, {
        x: Math.round(minX + col * (maxW + GAP)),
        y: Math.round(minY + row * (maxH + GAP)),
      });
    });

    setNodes(
      nodes.map((n) =>
        n.selected && posMap.has(n.id)
          ? { ...n, position: posMap.get(n.id)! }
          : n
      )
    );
  };

  // ── 局部整理所选分支 (Tidy Selection DAG) ───────────────
  const tidySelectionDag = () => {
    takeSnapshot();
    const newNodes = calculateCinemaLayout(nodes, edges, {
      selectedOnly: true,
      selectedNodeIds: new Set(selectedNodes.map((n) => n.id)),
    });
    setNodes(newNodes);
  };

  const deleteSelected = () => {
    takeSnapshot();
    setNodes(nodes.filter((n) => !n.selected));
  };

  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 25,
        overflow: 'hidden',
      }}
    >
      {/* 多选包围框高亮 */}
      <div
        style={{
          position: 'absolute',
          left: screenX,
          top: screenY,
          width: screenW,
          height: screenH,
          border: '1.5px solid rgba(255, 255, 255, 0.75)',
          borderRadius: 10 * zoom,
          background: 'rgba(255, 255, 255, 0.02)',
          boxShadow: '0 0 24px rgba(255, 255, 255, 0.12)',
        }}
      >
        {/* 浮动智能对齐工具栏 */}
        <div
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 10px)',
            left: '50%',
            transform: 'translateX(-50%)',
            pointerEvents: 'auto',
          }}
          className="flex items-center gap-0.5 px-2 py-1 rounded-xl bg-zinc-950/95 backdrop-blur-xl border border-white/15 shadow-2xl"
        >
          {/* 计数指示 */}
          <div className="flex items-center gap-1.5 pr-2 mr-1 border-r border-white/10 text-[10px] font-mono text-zinc-200 font-semibold select-none">
            <span className="w-1.5 h-1.5 rounded-full bg-white/80 animate-pulse" />
            <span>{t('已选')} {selectedNodes.length}</span>
          </div>

          {/* 水平对齐组 */}
          <div className="flex items-center gap-0.5">
            <ToolbarBtn onClick={alignLeft} title={t('左对齐')} icon={<AlignLeftIcon />} />
            <ToolbarBtn onClick={alignCenterH} title={t('水平居中对齐')} icon={<AlignCenterHIcon />} />
            <ToolbarBtn onClick={alignRight} title={t('右对齐')} icon={<AlignRightIcon />} />
            <ToolbarBtn onClick={distributeHorizontally} title={t('水平几何等间距分布')} icon={<DistributeHIcon />} />
          </div>

          <div className="w-px h-3.5 bg-white/10 mx-1" />

          {/* 垂直对齐组 */}
          <div className="flex items-center gap-0.5">
            <ToolbarBtn onClick={alignTop} title={t('顶对齐')} icon={<AlignTopIcon />} />
            <ToolbarBtn onClick={alignCenterV} title={t('垂直居中对齐')} icon={<AlignCenterVIcon />} />
            <ToolbarBtn onClick={alignBottom} title={t('底对齐')} icon={<AlignBottomIcon />} />
            <ToolbarBtn onClick={distributeVertically} title={t('垂直几何等间距分布')} icon={<DistributeVIcon />} />
          </div>

          <div className="w-px h-3.5 bg-white/10 mx-1" />

          {/* 智能排版组 */}
          <div className="flex items-center gap-0.5">
            <ToolbarBtn onClick={packGrid} title={t('网格紧凑排列')} icon={<GridPackIcon />} />
            <ToolbarBtn onClick={tidySelectionDag} title={t('整理所选分支流水线')} icon={<TidyBranchIcon />} highlight />
          </div>

          <div className="w-px h-3.5 bg-white/10 mx-1" />

          {/* 删除 */}
          <button
            onClick={deleteSelected}
            title={t('删除所选节点 (Delete)')}
            className="p-1 rounded hover:bg-rose-500/20 text-zinc-400 hover:text-rose-300 transition-colors cursor-pointer"
          >
            <TrashIcon />
          </button>
        </div>

        {/* 4 Corner Handles */}
        <div style={{ position: 'absolute', left: -handleSize / 2, top: -handleSize / 2, width: handleSize, height: handleSize, background: '#ffffff', border: '1.5px solid #000', borderRadius: '2px' }} />
        <div style={{ position: 'absolute', right: -handleSize / 2, top: -handleSize / 2, width: handleSize, height: handleSize, background: '#ffffff', border: '1.5px solid #000', borderRadius: '2px' }} />
        <div style={{ position: 'absolute', left: -handleSize / 2, bottom: -handleSize / 2, width: handleSize, height: handleSize, background: '#ffffff', border: '1.5px solid #000', borderRadius: '2px' }} />
        <div style={{ position: 'absolute', right: -handleSize / 2, bottom: -handleSize / 2, width: handleSize, height: handleSize, background: '#ffffff', border: '1.5px solid #000', borderRadius: '2px' }} />
      </div>
    </div>
  );
}

function ToolbarBtn({
  onClick,
  title,
  icon,
  highlight = false,
}: {
  onClick: () => void;
  title: string;
  icon: React.ReactNode;
  highlight?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`p-1 rounded transition-all cursor-pointer ${
        highlight
          ? 'text-white bg-white/20 hover:bg-white/30 border border-white/25'
          : 'text-zinc-300 hover:text-white hover:bg-white/10'
      }`}
    >
      {icon}
    </button>
  );
}

function AlignLeftIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
      <line x1="4" y1="21" x2="4" y2="3" />
      <rect x="8" y="5" width="12" height="4" rx="1" />
      <rect x="8" y="15" width="8" height="4" rx="1" />
    </svg>
  );
}

function AlignCenterHIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
      <line x1="12" y1="21" x2="12" y2="3" strokeDasharray="2 2" />
      <rect x="5" y="5" width="14" height="4" rx="1" />
      <rect x="7" y="15" width="10" height="4" rx="1" />
    </svg>
  );
}

function AlignRightIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
      <line x1="20" y1="21" x2="20" y2="3" />
      <rect x="4" y="5" width="12" height="4" rx="1" />
      <rect x="8" y="15" width="8" height="4" rx="1" />
    </svg>
  );
}

function AlignTopIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
      <line x1="3" y1="4" x2="21" y2="4" />
      <rect x="5" y="8" width="4" height="12" rx="1" />
      <rect x="15" y="8" width="4" height="8" rx="1" />
    </svg>
  );
}

function AlignCenterVIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
      <line x1="3" y1="12" x2="21" y2="12" strokeDasharray="2 2" />
      <rect x="5" y="5" width="4" height="14" rx="1" />
      <rect x="15" y="7" width="4" height="10" rx="1" />
    </svg>
  );
}

function AlignBottomIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
      <line x1="3" y1="20" x2="21" y2="20" />
      <rect x="5" y="4" width="4" height="12" rx="1" />
      <rect x="15" y="8" width="4" height="8" rx="1" />
    </svg>
  );
}

function DistributeHIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="4" y="5" width="4" height="14" rx="1" />
      <rect x="16" y="5" width="4" height="14" rx="1" />
      <line x1="12" y1="5" x2="12" y2="19" strokeDasharray="2 2" />
    </svg>
  );
}

function DistributeVIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="5" y="4" width="14" height="4" rx="1" />
      <rect x="5" y="16" width="14" height="4" rx="1" />
      <line x1="5" y1="12" x2="19" y2="12" strokeDasharray="2 2" />
    </svg>
  );
}

function GridPackIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function TidyBranchIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
      <path d="M6 3v12" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
      <circle cx="18" cy="6" r="3" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}
