'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useReactFlow, useStore } from '@xyflow/react';
import { useT } from '@/lib/i18n';
import { useCanvasNav } from '@/lib/canvasNav';

/**
 * Ctrl+F / Cmd+F: search nodes by label, id, type or prompt text and fly to
 * the one picked. Enter jumps to the highlighted hit, ↑/↓ move, Esc closes.
 */
type Hit = { id: string; label: string; type: string; where: string };

function fieldText(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export default function NodeSearch() {
  const t = useT();
  const { setCenter, getViewport, setNodes, getNode } = useReactFlow();
  const nodes = useStore((s) => s.nodes);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setOpen(true);
        requestAnimationFrame(() => inputRef.current?.select());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const hits = useMemo<Hit[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out: { hit: Hit; rank: number }[] = [];
    for (const n of nodes) {
      const d = (n.data ?? {}) as Record<string, unknown>;
      const label = fieldText(d.label) || n.id;
      const type = n.type ?? '';
      const fields: [string, string, number][] = [
        [t('名称'), label, 0],
        ['id', n.id, 1],
        [t('类型'), type, 2],
        [t('提示词'), fieldText(d.prompt), 3],
      ];
      for (const [where, text, rank] of fields) {
        if (text && text.toLowerCase().includes(q)) {
          out.push({ hit: { id: n.id, label, type, where }, rank });
          break;
        }
      }
    }
    out.sort((a, b) => a.rank - b.rank || a.hit.label.localeCompare(b.hit.label));
    return out.slice(0, 50).map((o) => o.hit);
  }, [nodes, query, t]);

  useEffect(() => setActive(0), [query]);

  const jump = (id: string) => {
    const node = getNode(id);
    if (!node) return;
    const w = node.measured?.width ?? node.width ?? 0;
    const h = node.measured?.height ?? node.height ?? 0;
    // Nodes inside a group have positions relative to the parent.
    let x = node.position.x;
    let y = node.position.y;
    let parent = node.parentId ? getNode(node.parentId) : undefined;
    while (parent) {
      x += parent.position.x;
      y += parent.position.y;
      parent = parent.parentId ? getNode(parent.parentId) : undefined;
    }
    useCanvasNav.getState().remember(getViewport());
    setCenter(x + w / 2, y + h / 2, { zoom: Math.max(getViewport().zoom, 0.6), duration: 300 });
    setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })));
  };

  if (!open) return null;

  const close = () => setOpen(false);

  return (
    <div className="absolute left-1/2 top-16 z-50 w-[420px] max-w-[calc(100vw-32px)] -translate-x-1/2 overflow-hidden rounded-xl border border-white/15 bg-black/85 shadow-2xl backdrop-blur">
      <input
        ref={inputRef}
        autoFocus
        value={query}
        placeholder={t('搜索节点：名称 / id / 类型 / 提示词')}
        className="w-full bg-transparent px-3 py-2 text-sm text-white outline-none placeholder:text-white/40"
        onChange={(e) => setQuery(e.target.value)}
        onBlur={() => setTimeout(close, 150)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') close();
          else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, hits.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          else if (e.key === 'Enter' && hits[active]) jump(hits[active].id);
        }}
      />
      {query.trim() && (
        <div className="max-h-[360px] overflow-y-auto border-t border-white/10">
          {hits.length === 0 && <div className="px-3 py-2 text-xs text-white/40">{t('没有匹配的节点')}</div>}
          {hits.map((h, i) => (
            <div
              key={h.id}
              className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs ${i === active ? 'bg-white/15 text-white' : 'text-white/75 hover:bg-white/10'}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => { e.preventDefault(); jump(h.id); }}
            >
              <span className="flex-1 truncate">{h.label}</span>
              <span className="shrink-0 text-white/40">{h.type}</span>
              <span className="shrink-0 text-white/30">{h.where}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
