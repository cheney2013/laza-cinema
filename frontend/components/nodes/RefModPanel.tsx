'use client';

import { useEffect, useState } from 'react';

import { api, type RefModEntry } from '@/lib/api';
import { BACKEND_URL } from '@/lib/config';
import { t } from '@/lib/i18n';
import AudioPlayer from './AudioPlayer';
import Select from '@/components/ui/Select';

/** One RefMod row as the canvas stores it (data.refMods): a look (visual), a voice (audio), and a weight. */
export interface RefModRow {
  visual?: string;
  audio?: string;
  w?: number;
}

interface Props {
  rows: RefModRow[];
  busy: boolean;
  onChange: (rows: RefModRow[]) => void;
}

const field = 'bg-white/5 border border-white/10 rounded px-1 py-0.5 font-mono text-[9px] text-zinc-300 disabled:opacity-40';

/**
 * The saved RefMods a video node sends in place of wired references: see which picture each look was
 * baked from, and add, swap or remove one. An audio RefMod holds only a voice latent, so it has no picture.
 */
export default function RefModPanel({ rows, busy, onChange }: Props) {
  const [entries, setEntries] = useState<RefModEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [big, setBig] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    api.listRefMods().then((r) => { if (live) setEntries(r.refmods); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);

  const looks = (entries || []).filter((e) => e.kind === 'image');
  const voices = (entries || []).filter((e) => e.kind === 'audio');
  const previewOf = (name?: string) => looks.find((e) => e.name === name)?.preview_url || null;
  const entryOf = (name?: string) => (entries || []).find((e) => e.name === name);
  const patch = (i: number, p: Partial<RefModRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));

  return (
    <div className="nodrag nopan space-y-1.5">
      <div className="text-[10px] text-zinc-400 font-medium flex justify-between">
        <span>{t('RefMod（已保存的人物与声音参考）')}</span>
        <button
          type="button"
          disabled={busy || !looks.length}
          onClick={() => onChange([...rows, { visual: looks[0]?.name, w: 1 }])}
          className="px-1.5 rounded border border-white/10 text-zinc-300 hover:text-white hover:bg-white/10 disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed"
        >
          {t('添加 RefMod')}
        </button>
      </div>
      {failed && <div className="text-[9px] text-red-400">{t('RefMod 列表加载失败')}</div>}
      {!rows.length && !failed && <div className="text-[9px] text-zinc-500">{t('没有挂 RefMod')}</div>}
      {rows.map((row, i) => {
        const src = previewOf(row.visual);
        return (
          <div key={i} className="rounded border border-white/10 bg-white/[0.03]">
          <div className="flex items-center gap-2 p-1.5">
            {src ? (
              <img
                src={`${BACKEND_URL}${src}`}
                alt={row.visual}
                title={t('点开看大图')}
                onClick={() => setBig(`${BACKEND_URL}${src}`)}
                className="h-12 w-16 shrink-0 cursor-zoom-in rounded object-cover"
              />
            ) : (
              <div className="h-12 w-16 shrink-0 rounded bg-white/5 text-[8px] text-zinc-500 flex items-center justify-center text-center">
                {t('没有预览')}
              </div>
            )}
            <div className="min-w-0 flex-1 space-y-1">
              <Select className={`${field} w-full`} value={row.visual || ''} disabled={busy}
                      onChange={(e) => patch(i, { visual: e.target.value || undefined })}>
                <option value="">{t('（无外观）')}</option>
                {row.visual && !looks.some((e) => e.name === row.visual) && <option value={row.visual}>{row.visual}</option>}
                {looks.map((e) => <option key={e.name} value={e.name}>{e.name}</option>)}
              </Select>
              <Select className={`${field} w-full`} value={row.audio || ''} disabled={busy}
                      title={t('声音只有潜空间，没有原音频，所以没有预览')}
                      onChange={(e) => patch(i, { audio: e.target.value || undefined })}>
                <option value="">{t('（无声音）')}</option>
                {row.audio && !voices.some((e) => e.name === row.audio) && <option value={row.audio}>{row.audio}</option>}
                {voices.map((e) => <option key={e.name} value={e.name}>{e.name}{e.latent_frames ? ` · ${e.latent_frames}` : ''}</option>)}
              </Select>
            </div>
            <label className="flex shrink-0 flex-col items-center gap-0.5 text-[8px] text-zinc-500">
              {t('权重')}
              <input type="number" min={0} max={2} step={0.1} className={`${field} w-10`} value={row.w ?? 1} disabled={busy}
                     onChange={(e) => patch(i, { w: parseFloat(e.target.value) || 0 })} />
            </label>
            <button type="button" title={t('这个 RefMod 是用什么资料做的')}
                    onClick={() => setOpen(open === i ? null : i)}
                    className={`shrink-0 px-1 text-[9px] cursor-pointer ${open === i ? 'text-white' : 'text-zinc-500 hover:text-white'}`}>
              {t('资料')}
            </button>
            <button type="button" disabled={busy} title={t('移除这个 RefMod')}
                    onClick={() => onChange(rows.filter((_, j) => j !== i))}
                    className="shrink-0 px-1 text-zinc-500 hover:text-red-400 disabled:opacity-30 cursor-pointer">
              ×
            </button>
          </div>
          {open === i && (
            <div className="space-y-2 border-t border-white/10 p-1.5">
              {[row.visual, row.audio].filter(Boolean).map((nm) => {
                const e = entryOf(nm);
                return (
                  <div key={nm} className="space-y-1">
                    <div className="font-mono text-[9px] text-zinc-300">{nm}</div>
                    {!e?.has_sources && <div className="text-[9px] text-zinc-500">{t('没有记录创建资料')}</div>}
                    {typeof e?.params?.emotion === 'string' && e.params.emotion && (
                      <div className="text-[9px] text-amber-300/80">{t('情绪')}：{e.params.emotion}</div>
                    )}
                    {e?.notes && <div className="text-[9px] text-zinc-400">{e.notes}</div>}
                    {(e?.sources || []).map((src) => (
                      <div key={src.url} className="space-y-0.5">
                        {src.role === 'image' && (
                          <img src={`${BACKEND_URL}${src.url}`} alt="" onClick={() => setBig(`${BACKEND_URL}${src.url}`)}
                               className="max-h-24 cursor-zoom-in rounded" />
                        )}
                        {src.role === 'audio' && <AudioPlayer src={`${BACKEND_URL}${src.url}`} className="w-full" />}
                        {src.role === 'video' && <video controls src={`${BACKEND_URL}${src.url}`} className="max-h-24 rounded" />}
                        {src.note && <div className="text-[9px] text-zinc-500">{src.note}</div>}
                      </div>
                    ))}
                    {e?.created_at ? <div className="text-[8px] text-zinc-600">{new Date(e.created_at * 1000).toLocaleString()}</div> : null}
                  </div>
                );
              })}
            </div>
          )}
          </div>
        );
      })}
      {big && (
        <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/80 cursor-zoom-out" onClick={() => setBig(null)}>
          <img src={big} alt="" className="max-h-[90vh] max-w-[90vw] rounded shadow-2xl" />
        </div>
      )}
    </div>
  );
}
