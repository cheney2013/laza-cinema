'use client';

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { BACKEND_URL } from '@/lib/config';
import { t } from '@/lib/i18n';
import { fileTag } from '@/lib/pinnedFrame';

/**
 * Shows the frame a 钉末帧 pin holds: the last frame of the pinned clip, as a card above
 * everything. Opens on click, closes on click outside or Esc.
 */
export default function PinnedFramePreview({ src }: { src: string }) {
  const button = useRef<HTMLButtonElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!at) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e instanceof PointerEvent && (e.target as Element)?.closest?.('.pinned-frame-card')) return;
      setAt(null);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', close);
    };
  }, [at]);

  const open = () => {
    const rect = button.current?.getBoundingClientRect();
    if (!rect) return;
    setAt({ x: Math.max(8, Math.min(rect.left, window.innerWidth - 528)), y: rect.bottom + 6 });
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        onClick={() => (at ? setAt(null) : open())}
        className="nodrag text-[9px] font-mono px-1.5 py-0.5 rounded-full border border-amber-500/40 text-amber-200 hover:bg-amber-400/15"
        title={t('查看钉住的那一帧（{v1} 的最后一帧）', { v1: fileTag(src) })}
      >
        <span data-chrome="label">{t('看钉的帧')}</span>
      </button>
      {at &&
        createPortal(
          <div
            className="pinned-frame-card fixed w-[512px] overflow-hidden rounded-xl border border-amber-300/60 bg-[#14141c] shadow-2xl"
            style={{ left: at.x, top: at.y, zIndex: 100000 }}
          >
            <video
              ref={video}
              src={src.startsWith('blob:') || src.startsWith('http') ? src : `${BACKEND_URL}${src}`}
              muted
              preload="auto"
              crossOrigin="anonymous"
              className="block aspect-video w-full bg-black object-contain"
              // The last frame: seek to just before the end once the length is known.
              onLoadedMetadata={(e) => {
                const v = e.currentTarget;
                if (Number.isFinite(v.duration)) v.currentTime = Math.max(0, v.duration - 0.05);
              }}
            />
            <div className="px-2.5 py-1.5 text-[11px] text-amber-200">
              {t('钉住的末帧 · {v1} 的最后一帧', { v1: fileTag(src) })}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
