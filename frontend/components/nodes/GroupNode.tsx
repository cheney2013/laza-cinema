'use client';

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { NodeResizer, useReactFlow, type NodeProps } from '@xyflow/react';

import {
  GROUP_COLORS,
  GROUP_HEADER_H,
  GROUP_MIN_HEIGHT,
  GROUP_MIN_WIDTH,
  DEFAULT_GROUP_COLOR,
} from '@/lib/canvasGroups';
import { t } from '@/lib/i18n';


/**
 * The frame behind the work.
 *
 * Two rules make it feel like ComfyUI's group rather than a card that happens
 * to be large:
 *   - the body is `pointer-events: none`, so a click inside reaches the node it
 *     landed on, not the frame;
 *   - only the header carries `.canvas-group-handle`, which the node's
 *     `dragHandle` points at, so the frame is dragged by its title bar.
 */
function GroupNode({ id, data, selected }: NodeProps) {
  const { updateNodeData } = useReactFlow();
  const title = typeof data?.title === 'string' ? data.title : t('分组');
  const color = typeof data?.color === 'string' ? data.color : DEFAULT_GROUP_COLOR;
  const collapsed = data?.collapsed === true;
  const memberCount = Array.isArray(data?.collapsedMemberIds) ? data.collapsedMemberIds.length : 0;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(title);
  }, [title, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commitTitle = useCallback(() => {
    setEditing(false);
    const next = draft.trim() || t('分组');
    if (next !== title) updateNodeData(id, { title: next });
  }, [draft, id, title, updateNodeData]);

  // Only the flag is written here. Recording the members, keeping the expanded
  // height and folding the frame are done by reconcileGroups over the whole node
  // array, so that a `collapsed` written by the canvas MCP behaves identically.
  const toggleCollapsed = useCallback(() => {
    updateNodeData(id, { collapsed: !collapsed });
  }, [collapsed, id, updateNodeData]);

  return (
    <>
      <NodeResizer
        isVisible={selected && !collapsed}
        minWidth={GROUP_MIN_WIDTH}
        minHeight={GROUP_MIN_HEIGHT}
        lineStyle={{ borderColor: 'transparent' }}
        handleStyle={{
          width: 10,
          height: 10,
          borderRadius: 3,
          background: color,
          border: '1px solid rgba(255,255,255,0.45)',
        }}
      />
      <div
        className="w-full h-full rounded-2xl overflow-hidden"
        style={{
          // The frame must read as a container, never as content: no fill dark
          // enough to change how the clips inside are judged.
          background: collapsed ? `${color}e6` : `${color}1f`,
          border: `1px solid ${selected ? `${color}` : `${color}99`}`,
          boxShadow: selected ? `0 0 0 1px ${color}55` : undefined,
          pointerEvents: 'none',
        }}
      >
        <div
          className="canvas-group-handle flex items-center gap-2 px-3 select-none cursor-grab active:cursor-grabbing"
          style={{
            height: GROUP_HEADER_H,
            background: `${color}cc`,
            borderBottom: collapsed ? 'none' : `1px solid ${color}`,
            pointerEvents: 'auto',
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
        >
          <button
            title={collapsed ? t('展开') : t('折叠归档')}
            onClick={(e) => { e.stopPropagation(); toggleCollapsed(); }}
            className="shrink-0 w-4 h-4 flex items-center justify-center text-white/70 hover:text-white transition-colors cursor-pointer"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path
                d={collapsed ? 'M3 1.5 L7 5 L3 8.5' : 'M1.5 3 L5 7 L8.5 3'}
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>

          {editing ? (
            <input
              ref={inputRef}
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') commitTitle();
                if (e.key === 'Escape') { setDraft(title); setEditing(false); }
              }}
              className="flex-1 min-w-0 bg-black/30 text-white text-[13px] font-medium px-1.5 py-0.5 rounded outline-none border border-white/20"
            />
          ) : (
            <span className="flex-1 min-w-0 truncate text-[13px] font-medium text-white/95">
              {title}
            </span>
          )}

          {collapsed && memberCount > 0 && (
            <span className="shrink-0 text-[11px] text-white/70 tabular-nums">
              {memberCount}  {t('个节点')}
            </span>
          )}

          <div className="relative shrink-0">
            <button
              title={t('换个颜色')}
              onClick={(e) => { e.stopPropagation(); setPaletteOpen((v) => !v); }}
              className="w-3.5 h-3.5 rounded-full border border-white/40 cursor-pointer"
              style={{ background: color }}
            />
            {paletteOpen && (
              <div
                className="absolute right-0 top-5 z-50 flex gap-1 p-1.5 rounded-lg bg-zinc-900/95 border border-white/10 shadow-xl"
                onMouseLeave={() => setPaletteOpen(false)}
              >
                {GROUP_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={(e) => {
                      e.stopPropagation();
                      updateNodeData(id, { color: c });
                      setPaletteOpen(false);
                    }}
                    className="w-4 h-4 rounded-full border border-white/30 cursor-pointer hover:scale-110 transition-transform"
                    style={{ background: c }}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

export default memo(GroupNode);
