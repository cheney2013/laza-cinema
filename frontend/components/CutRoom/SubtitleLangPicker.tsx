'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';

import { useCutRoom } from '@/lib/editor/store';
import {
  SUBTITLE_LANGUAGES, languageName, languageProgress, subtitleClips, subtitleLangOf, subtitleLangsOf, titleIn,
} from '@/lib/editor/subtitleLang';
import { type Timeline, formatTimecode } from '@/lib/editor/types';
import { t } from '@/lib/i18n';

/** The language an AI translation into `target` reads from: the film's first language, or the next one if that is the target. */
function aiSource(timeline: Timeline, target: string): string {
  const langs = subtitleLangsOf(timeline);
  const first = (timeline.subtitleLangs ?? [])[0];
  return first && first !== target ? first : langs.find((l) => l !== target) ?? target;
}

/** Runs the AI translation of one language and tells how far it is; the words land in the film batch by batch. */
function useAiTranslate() {
  const [state, setState] = useState<{ target: string; done: number; total: number } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const run = async (source: string, target: string) => {
    const controller = new AbortController();
    abort.current = controller;
    setMessage(null);
    setState({ target, done: 0, total: 0 });
    try {
      const filled = await useCutRoom.getState().translateSubtitles({
        source, target, signal: controller.signal,
        onProgress: (done, total) => setState({ target, done, total }),
      });
      setMessage(filled > 0 ? t('已翻译 {v1} 条，请逐条看一遍。', { v1: filled }) : t('没有需要翻译的字幕'));
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      abort.current = null;
      setState(null);
    }
  };
  return { state, message, run, cancel: () => abort.current?.abort() };
}

/**
 * The film's subtitle languages: which one the monitor, the burn-in and the SRT show, adding a
 * language, bringing a translated SRT in, and the side-by-side table for translating by hand.
 * Timing belongs to the titles and is shared; only the words differ per language.
 */
export default function SubtitleLangPicker() {
  const timeline = useCutRoom((s) => s.timeline);
  const hasTitles = timeline.clips.some((c) => c.text);
  const [open, setOpen] = useState(false);
  const [table, setTable] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [custom, setCustom] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const importInto = useRef('');
  const ai = useAiTranslate();

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  if (!hasTitles) return null;

  const current = subtitleLangOf(timeline);
  const langs = subtitleLangsOf(timeline);
  const store = useCutRoom.getState;
  const addable = SUBTITLE_LANGUAGES.filter((l) => !langs.includes(l.code));

  const pickFile = (lang: string) => {
    importInto.current = lang;
    fileRef.current?.click();
  };
  const onFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const result = store().importSubtitleSrt(importInto.current, await file.text());
    setNote(
      result
        ? t('已导入 {v1} 条；{v2} 条字幕没有对应的 cue，{v3} 条 cue 没有用上。', { v1: result.matched, v2: result.unmatched, v3: result.spare })
        : t('文件里没有字幕')
    );
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((on) => !on)}
        className={`rounded border px-1.5 py-0.5 text-[11px] transition-colors ${
          open
            ? 'border-emerald-400/50 bg-emerald-400/10 text-emerald-200'
            : 'border-white/10 bg-white/[0.04] text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-200'
        }`}
        title={t('本影片字幕的语言：预览、烧录和 SRT 都用当前语言，其他语言的文字都保留')}
      >
        {t('字幕语言')} · {languageName(current)}
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 flex w-[280px] flex-col gap-2 rounded-lg border border-white/10 bg-[#15151c] p-3 shadow-2xl">
          <div className="flex flex-col gap-1">
            {langs.map((lang) => {
              const { done, total } = languageProgress(timeline, lang);
              return (
                <div
                  key={lang}
                  className={`flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] ${
                    lang === current ? 'border-emerald-400/50 bg-emerald-400/10 text-emerald-200' : 'border-white/10 text-zinc-300'
                  }`}
                >
                  <button className="flex-1 text-left" onClick={() => store().setSubtitleLang(lang)}>
                    {languageName(lang)} <span className="text-zinc-500">{lang}</span>
                  </button>
                  <span className={done < total ? 'text-amber-300' : 'text-zinc-500'}>{done}/{total}</span>
                  {done < total && (
                    <button
                      className="text-emerald-300 hover:text-emerald-100 disabled:opacity-40"
                      disabled={ai.state !== null || langs.length < 2}
                      title={t('用 Qwen 把没翻的字幕从 {v1} 翻成{v2}', { v1: languageName(aiSource(timeline, lang)), v2: languageName(lang) })}
                      onClick={() => void ai.run(aiSource(timeline, lang), lang)}
                    >
                      {ai.state?.target === lang ? `${ai.state.done}/${ai.state.total}` : 'AI'}
                    </button>
                  )}
                  <button className="text-zinc-400 hover:text-white" onClick={() => pickFile(lang)} title={t('导入 SRT')}>
                    SRT
                  </button>
                  {lang !== current && (
                    <button
                      className="text-zinc-500 hover:text-red-300"
                      title={t('删除这个语言的全部文字')}
                      onClick={() => { if (window.confirm(t('删除这个语言的全部文字？'))) store().removeSubtitleLang(lang); }}
                    >
                      ×
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex flex-wrap gap-1">
            {addable.map((l) => (
              <button
                key={l.code}
                onClick={() => store().setSubtitleLang(l.code)}
                className="rounded border border-white/10 px-1.5 py-0.5 text-[11px] text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-200"
              >
                + {l.name}
              </button>
            ))}
            <form
              className="flex gap-1"
              onSubmit={(event) => {
                event.preventDefault();
                const code = custom.trim().toLowerCase();
                if (code) store().setSubtitleLang(code);
                setCustom('');
              }}
            >
              <input
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                placeholder={t('其他语言代码')}
                className="w-24 rounded border border-white/10 bg-transparent px-1.5 py-0.5 text-[11px] text-zinc-200 placeholder:text-zinc-600"
              />
            </form>
          </div>

          <div className="flex gap-1">
            <button
              onClick={() => { setTable(true); setOpen(false); }}
              className="flex-1 rounded border border-white/10 px-2 py-1 text-[11px] text-zinc-300 hover:bg-white/[0.08]"
              disabled={langs.length < 2}
              title={langs.length < 2 ? t('先添加一个语言') : undefined}
            >
              {t('翻译对照')}
            </button>
          </div>
          {ai.state && (
            <button onClick={ai.cancel} className="self-start text-[10px] text-zinc-500 underline decoration-dotted hover:text-zinc-300">
              {t('停止翻译')}
            </button>
          )}
          {(ai.message ?? note) && <p className="text-[10px] leading-relaxed text-zinc-400">{ai.message ?? note}</p>}
          <input ref={fileRef} type="file" accept=".srt,text/plain" className="hidden" onChange={onFile} />
        </div>
      )}

      {table && <TranslationTable onClose={() => setTable(false)} />}
    </div>
  );
}

/** Every title in time order: the reference language read-only on the left, the language being written on the right. */
function TranslationTable({ onClose }: { onClose: () => void }) {
  const timeline = useCutRoom((s) => s.timeline);
  const current = subtitleLangOf(timeline);
  const langs = subtitleLangsOf(timeline);
  const [target, setTarget] = useState(current);
  const [reference, setReference] = useState(() => langs.find((l) => l !== current) ?? current);
  const rows = useMemo(() => subtitleClips(timeline), [timeline]);
  const { done, total } = languageProgress(timeline, target);
  const ai = useAiTranslate();
  const select = 'rounded border border-white/10 bg-[#15151c] px-1.5 py-0.5 text-[11px] text-zinc-200';

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60"
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape') onClose(); }}
    >
      <div className="flex max-h-[85vh] w-[860px] max-w-[95vw] flex-col rounded-lg border border-white/10 bg-[#15151c] p-4 shadow-2xl">
        <div className="mb-3 flex items-center gap-3 text-xs text-zinc-300">
          <span className="font-semibold text-zinc-100">{t('翻译对照')}</span>
          <label className="flex items-center gap-1">
            {t('参照语言')}
            <select className={select} value={reference} onChange={(e) => setReference(e.target.value)}>
              {langs.map((l) => <option key={l} value={l}>{languageName(l)}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1">
            {t('翻译成')}
            <select className={select} value={target} onChange={(e) => setTarget(e.target.value)}>
              {langs.map((l) => <option key={l} value={l}>{languageName(l)}</option>)}
            </select>
          </label>
          <span className={done < total ? 'text-amber-300' : 'text-zinc-500'}>{done}/{total}</span>
          <button
            onClick={() => (ai.state ? ai.cancel() : void ai.run(reference, target))}
            disabled={reference === target || (!ai.state && done >= total)}
            className="rounded border border-emerald-400/40 px-2 py-0.5 text-emerald-200 hover:bg-emerald-400/10 disabled:opacity-40"
          >
            {ai.state ? t('停止翻译 {v1}/{v2}', { v1: ai.state.done, v2: ai.state.total }) : t('AI 翻译没翻的')}
          </button>
          {ai.message && <span className="text-[11px] text-zinc-400">{ai.message}</span>}
          <button onClick={onClose} className="ml-auto rounded px-3 py-1 text-zinc-400 hover:text-white">{t('关闭')}</button>
        </div>
        <div data-scrollable className="flex-1 overflow-y-auto">
          {rows.map((clip) => {
            const words = titleIn(clip, target, current);
            return (
              <div key={clip.id} className="grid grid-cols-[70px_1fr_1fr] gap-2 border-t border-white/5 py-1.5 text-xs">
                <span className="pt-1 font-mono text-[10px] text-zinc-600">{formatTimecode(clip.start, timeline.fps)}</span>
                <p className="whitespace-pre-wrap pt-1 text-zinc-400">{titleIn(clip, reference, current)}</p>
                <textarea
                  value={words}
                  rows={Math.max(1, words.split('\n').length)}
                  onFocus={() => useCutRoom.getState().commit()}
                  onChange={(e) => useCutRoom.getState().setTitleTranslation(clip.id, target, e.target.value)}
                  className={`resize-none rounded border bg-transparent px-1.5 py-1 text-zinc-100 ${
                    words.trim() ? 'border-white/10' : 'border-amber-400/40'
                  }`}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
