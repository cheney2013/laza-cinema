'use client';

import React, { useEffect, useRef, useState } from 'react';

import { MAX_OPEN_SESSIONS, isScratchSession, useCutRoom } from '@/lib/editor/store';
import { t } from '@/lib/i18n';

/** Drag payload of a film tab; the timeline accepts it as a reference. */
export const SEQ_DRAG_TYPE = 'application/x-cutroom-sequence';
/** Every tab carries this too, so the bar itself can reorder it. */
const TAB_DRAG_TYPE = 'application/x-cutroom-tab';

/**
 * One tab per open film. The active film lives in the store's flat fields and
 * the rest are parked in `sessions`, so a tab's export progress is read from
 * whichever of the two holds it.
 */
export function SequenceTabs() {
  const sequences = useCutRoom((s) => s.sequences);
  const openOrder = useCutRoom((s) => s.openOrder);
  const activeSeqId = useCutRoom((s) => s.activeSeqId);
  const sessions = useCutRoom((s) => s.sessions);
  const activeScratch = useCutRoom((s) => s.scratch);
  const activeStatus = useCutRoom((s) => s.exportStatus);
  const activeProgress = useCutRoom((s) => s.exportProgress);
  const projectId = useCutRoom((s) => s.projectId);

  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [menu, setMenu] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** While a tab is dragged along the bar: the tab it would land before (null = last). */
  const [dropBefore, setDropBefore] = useState<string | null | undefined>(undefined);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menu]);

  // A tab dropped on the timeline is inserted there by TimelineView; if the
  // insert is refused, the reason is shown here, next to the tab it came from.
  useEffect(() => {
    const show = (e: Event) => setError((e as CustomEvent<string>).detail);
    window.addEventListener('cutRoomRefError', show);
    return () => window.removeEventListener('cutRoomRefError', show);
  }, []);

  const run = (p: Promise<unknown>) => p.catch((e: Error) => setError(e.message));
  const store = () => useCutRoom.getState();

  const labelOf = (id: string) => {
    if (isScratchSession(id)) {
      const scratch = id === activeSeqId ? activeScratch : sessions[id]?.scratch;
      return t('单素材 · {v1}', { v1: scratch?.name ?? '' });
    }
    return sequences.find((q) => q.id === id)?.name ?? id;
  };

  const closed = sequences.filter((q) => !openOrder.includes(q.id));
  const active = sequences.find((q) => q.id === activeSeqId);

  const commitRename = () => {
    const id = renaming;
    setRenaming(null);
    if (id && draft.trim()) void run(store().renameSequence(id, draft));
  };

  return (
    // Only the tabs scroll. The ＋ menu drops below the bar, and inside an
    // overflow-x container overflow-y turns to auto too, which clipped it away.
    <div className="flex flex-none items-center gap-1 border-b border-white/10 bg-black/20 px-3 py-1">
      <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
      {openOrder.map((id) => {
        const isActive = id === activeSeqId;
        const status = isActive ? activeStatus : sessions[id]?.exportStatus ?? null;
        const progress = isActive ? activeProgress : sessions[id]?.exportProgress ?? 0;
        const rendering = status === 'queued' || status === 'running';
        return (
          <div
            key={id}
            onClick={() => void run(store().activate(id))}
            draggable={renaming !== id}
            onDragStart={(e) => {
              e.dataTransfer.setData(TAB_DRAG_TYPE, id);
              // A scratch tab is a lone file, not a film: it reorders but cannot be referenced.
              if (!isScratchSession(id)) e.dataTransfer.setData(SEQ_DRAG_TYPE, id);
              e.dataTransfer.effectAllowed = 'copyMove';
            }}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(TAB_DRAG_TYPE)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              const rect = e.currentTarget.getBoundingClientRect();
              const after = e.clientX > rect.left + rect.width / 2;
              const next = after ? openOrder[openOrder.indexOf(id) + 1] ?? null : id;
              if (next !== dropBefore) setDropBefore(next);
            }}
            onDrop={(e) => {
              const dragged = e.dataTransfer.getData(TAB_DRAG_TYPE);
              const before = dropBefore;
              setDropBefore(undefined);
              if (!dragged || before === undefined) return;
              e.preventDefault();
              store().moveTab(dragged, before);
            }}
            onDragEnd={() => setDropBefore(undefined)}
            onDoubleClick={() => {
              if (isScratchSession(id)) return;
              setRenaming(id);
              setDraft(labelOf(id));
            }}
            className={`group flex max-w-[220px] flex-none cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] ${
              isActive ? 'bg-white/10 text-zinc-100' : 'text-zinc-400 hover:bg-white/[0.05]'
            } ${dropBefore === id ? 'shadow-[inset_2px_0_0_0_rgb(252,211,77)]' : ''} ${
              dropBefore === null && id === openOrder[openOrder.length - 1] ? 'shadow-[inset_-2px_0_0_0_rgb(252,211,77)]' : ''
            }`}
            title={isScratchSession(id) ? labelOf(id) : t('双击改名 · 左右拖动排序 · 拖到时间轴上作为引用插入')}
          >
            {renaming === id ? (
              <input
                autoFocus
                data-clip-rename=""
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') setRenaming(null);
                }}
                onClick={(e) => e.stopPropagation()}
                className="w-32 rounded bg-black/40 px-1 text-[12px] text-zinc-100 outline-none"
              />
            ) : (
              <span className={`truncate ${isScratchSession(id) ? 'text-sky-200' : ''}`}>{labelOf(id)}</span>
            )}
            {rendering && (
              <span className="font-mono text-[10px] text-emerald-300 tabular-nums">
                {Math.round(progress * 100)}%
              </span>
            )}
            {!isActive && status === 'completed' && (
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" title={t('导出完成')} />
            )}
            {!isActive && status === 'failed' && (
              <span className="h-1.5 w-1.5 rounded-full bg-red-400" title={t('导出失败')} />
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                void run(store().closeSession(id));
              }}
              className="ml-0.5 text-zinc-600 opacity-0 hover:text-zinc-200 group-hover:opacity-100"
              title={t('关闭标签（不删除）')}
            >
              ×
            </button>
          </div>
        );
      })}
      </div>

      {projectId && (
        <div className="relative flex-none" ref={menuRef}>
          <button
            onClick={() => setMenu((m) => !m)}
            className="rounded-md px-2 py-1 text-[13px] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100"
            title={t('新建 / 打开影片')}
          >
            ＋
          </button>
          {menu && (
            <div className="absolute left-0 top-full z-50 mt-1 w-56 rounded-lg border border-white/10 bg-[#16161c] py-1 text-[12px] shadow-xl">
              <MenuItem
                onClick={() => {
                  setMenu(false);
                  void run(store().createSequence(t('影片 {v1}', { v1: sequences.length + 1 })));
                }}
              >
                {t('新建空白影片')}
              </MenuItem>
              {active && (
                <MenuItem
                  onClick={() => {
                    setMenu(false);
                    void run(store().createSequence(t('{v1} 副本', { v1: active.name }), active.id));
                  }}
                >
                  {t('复制当前影片')}
                </MenuItem>
              )}
              {closed.length > 0 && <div className="my-1 border-t border-white/10" />}
              {closed.map((q) => (
                <MenuItem
                  key={q.id}
                  onClick={() => {
                    setMenu(false);
                    void run(store().activate(q.id));
                  }}
                >
                  {t('打开：{v1}', { v1: q.name })}
                </MenuItem>
              ))}
              {active && sequences.length > 1 && (
                <>
                  <div className="my-1 border-t border-white/10" />
                  <MenuItem
                    danger
                    onClick={() => {
                      setMenu(false);
                      if (window.confirm(t('删除影片「{v1}」？文件会移到 sequences/.trash，可手动恢复。', { v1: active.name }))) {
                        void run(store().deleteSequence(active.id));
                      }
                    }}
                  >
                    {t('删除当前影片')}
                  </MenuItem>
                </>
              )}
              <div className="px-3 pt-1 text-[10px] text-zinc-600">
                {t('最多同时打开 {v1} 个，超出时自动收起最久未用的', { v1: MAX_OPEN_SESSIONS })}
              </div>
            </div>
          )}
        </div>
      )}

      {error && (
        <button onClick={() => setError(null)} className="ml-2 truncate text-[11px] text-red-300" title={error}>
          {error}
        </button>
      )}
    </div>
  );
}

function MenuItem({
  children,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`block w-full truncate px-3 py-1.5 text-left hover:bg-white/[0.06] ${danger ? 'text-red-300' : 'text-zinc-300'}`}
    >
      {children}
    </button>
  );
}
