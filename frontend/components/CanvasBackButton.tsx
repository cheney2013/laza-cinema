'use client';

import { Panel, useReactFlow } from '@xyflow/react';
import React, { useCallback, useEffect } from 'react';

import { useCanvasNav } from '@/lib/canvasNav';
import { t } from '@/lib/i18n';

const typing = (target: EventTarget | null) => {
  const el = target as HTMLElement | null;
  return Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
};

/**
 * Back to where the canvas was before the last jump (to a node on the far side of an
 * edge, from the search box, the chain index or the minimap). Alt+← does the same.
 */
export default function CanvasBackButton() {
  const { setViewport } = useReactFlow();
  const count = useCanvasNav((s) => s.trail.length);

  const goBack = useCallback(() => {
    const viewport = useCanvasNav.getState().back();
    if (viewport) void setViewport(viewport, { duration: 350 });
  }, [setViewport]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || event.key !== 'ArrowLeft' || typing(event.target)) return;
      if (useCanvasNav.getState().trail.length === 0) return;
      event.preventDefault();
      goBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goBack]);

  if (count === 0) return null;
  return (
    <Panel position="top-center" style={{ marginTop: 64 }}>
      <button
        type="button"
        onClick={goBack}
        className="pointer-events-auto flex items-center gap-2 rounded-full border border-amber-300/50 bg-[#14141c]/95 px-4 py-1.5 text-xs text-amber-100 shadow-xl backdrop-blur hover:bg-amber-300/15"
        title={t('回到跳转之前的位置 (Alt+←)')}
      >
        <span>↩</span>
        <span>{t('返回上一处')}</span>
        {count > 1 && <span className="text-amber-200/60">{t('还有 {v1} 处', { v1: count - 1 })}</span>}
      </button>
    </Panel>
  );
}
