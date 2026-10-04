'use client';

import React, { useEffect, useRef, useState } from 'react';

import { showAlert } from '@/components/ui/Dialog';
import { api, type Asset } from '@/lib/api';
import { resolveAssetUrl } from '@/lib/config';
import { useCutRoom } from '@/lib/editor/store';
import { t } from '@/lib/i18n';

const SHOWN = 48;

/**
 * The film's cover.
 *
 * Pick a picture and frame 0 of the film is that picture: in the monitor and in the exported file. It
 * replaces that one frame instead of being inserted before it, so nothing after it moves and the sound
 * stays in step. The picture comes from the project's images (newest first, which is where a title
 * card just made on the canvas will be) or from a file on this computer.
 */
export default function CoverPicker() {
  const cover = useCutRoom((s) => s.timeline.cover);
  const projectId = useCutRoom((s) => s.projectId);
  const [open, setOpen] = useState(false);
  const [images, setImages] = useState<Asset[] | null>(null);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    // Capture: the cut room stops a lot of events on their way up.
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  useEffect(() => {
    if (!open || images) return;
    let cancelled = false;
    api.listAssets(projectId)
      .then((result) => {
        if (cancelled) return;
        setImages(result.assets.filter((a) => a.kind === 'image').sort((a, b) => b.modified - a.modified).slice(0, SHOWN));
      })
      .catch(() => { if (!cancelled) setImages([]); });
    return () => { cancelled = true; };
  }, [open, images, projectId]);

  const choose = (url: string, title: string) => {
    useCutRoom.getState().setCover({ url, title });
    setOpen(false);
  };

  // A file from this computer is redrawn as PNG before it goes up: the upload route stores PNG.
  const upload = async (file: File) => {
    setBusy(true);
    try {
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
      bitmap.close();
      const { url } = await api.uploadImageBase64(canvas.toDataURL('image/png'), 'frame');
      setImages(null);
      choose(url, file.name);
    } catch (error) {
      void showAlert(t('封面上传失败：{v1}', { v1: (error as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((on) => !on)}
        className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] transition-colors ${
          open || cover
            ? 'border-emerald-400/50 bg-emerald-400/10 text-emerald-200'
            : 'border-white/10 bg-white/[0.04] text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-200'
        }`}
        title={t('设置封面：第一帧显示这张图（只占第 0 帧，其余帧、声音和时长不变）')}
      >
        {cover && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={resolveAssetUrl(cover.url)} alt="" className="h-3.5 w-6 rounded-[2px] object-cover" />
        )}
        {t('封面')}
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-[340px] rounded-lg border border-white/10 bg-[#15151c] p-3 shadow-2xl">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{t('当前封面')}</p>
          {cover ? (
            <div className="mb-3 flex items-center gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={resolveAssetUrl(cover.url)} alt="" className="h-12 w-20 flex-none rounded object-cover" />
              <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-300" title={cover.title}>{cover.title}</span>
              <button
                onClick={() => { useCutRoom.getState().setCover(null); setOpen(false); }}
                className="flex-none rounded border border-white/10 px-1.5 py-0.5 text-[11px] text-zinc-300 hover:bg-white/[0.08]"
              >
                {t('清除封面')}
              </button>
            </div>
          ) : (
            <p className="mb-3 text-[11px] text-zinc-600">{t('还没有封面')}</p>
          )}

          <div className="mb-1.5 flex items-center justify-between">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{t('这个项目的图片（最近的在前）')}</p>
            <button
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              className="rounded border border-white/10 px-1.5 py-0.5 text-[11px] text-zinc-300 hover:bg-white/[0.08] disabled:opacity-40"
            >
              {busy ? t('上传中…') : t('上传图片…')}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void upload(file);
              }}
            />
          </div>
          {images === null ? (
            <p className="py-4 text-center text-[11px] text-zinc-600">{t('读取中…')}</p>
          ) : images.length === 0 ? (
            <p className="py-4 text-center text-[11px] text-zinc-600">{t('这个项目里还没有图片，可以上传一张')}</p>
          ) : (
            <div className="grid max-h-56 grid-cols-4 gap-1 overflow-y-auto">
              {images.map((image) => (
                <button
                  key={image.url}
                  onClick={() => choose(image.url, image.name)}
                  className={`overflow-hidden rounded border transition-colors ${
                    cover?.url === image.url ? 'border-emerald-400/70' : 'border-white/10 hover:border-white/40'
                  }`}
                  title={image.name}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={resolveAssetUrl(image.url)} alt="" loading="lazy" className="aspect-video w-full object-cover" />
                </button>
              ))}
            </div>
          )}
          <p className="mt-3 text-[10px] leading-relaxed text-zinc-600">
            {t('封面只占第 0 帧：影片的第一帧是这张图，其他帧、声音和总时长都不动。只用于整片导出，单个片段、合并和转写的渲染不带封面。')}
          </p>
        </div>
      )}
    </div>
  );
}
