import { clipEnd, type Clip, type ClipText, type Timeline } from './types';

/** What a film's subtitles are in until someone says otherwise: the first language they were made in. */
export const DEFAULT_SUBTITLE_LANG = 'en';

/** Offered when adding a language; any other code can be typed in. `name` is the language in itself. */
export const SUBTITLE_LANGUAGES: { code: string; name: string }[] = [
  { code: 'en', name: 'English' },
  { code: 'zh', name: '中文' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
  { code: 'es', name: 'Español' },
  { code: 'ru', name: 'Русский' },
];

export const subtitleLangOf = (timeline: Timeline): string => timeline.subtitleLang ?? DEFAULT_SUBTITLE_LANG;

/** Current language first, then the rest in the order they were added. */
export function subtitleLangsOf(timeline: Timeline): string[] {
  const current = subtitleLangOf(timeline);
  return [current, ...(timeline.subtitleLangs ?? []).filter((l) => l !== current)];
}

export const languageName = (code: string): string => SUBTITLE_LANGUAGES.find((l) => l.code === code)?.name ?? code;

const addLang = (timeline: Timeline, lang: string): string[] =>
  timeline.subtitleLangs?.includes(lang) ? timeline.subtitleLangs : [...(timeline.subtitleLangs ?? [subtitleLangOf(timeline)]), lang];

/** A title that carries words in some language and is in the cut. */
const isCue = (c: Clip): boolean =>
  Boolean(c.text && !c.bypassed && (c.text.content.trim() || Object.values(c.text.i18n ?? {}).some((v) => v.trim())));

/** The film's titles in time order: what the translation table walks and what an imported SRT is matched to. */
export function subtitleClips(timeline: Timeline): Clip[] {
  return timeline.clips.filter(isCue).sort((a, b) => a.start - b.start || clipEnd(a) - clipEnd(b));
}

const CJK_EDGE = /[\u3000-\u9fff\uff00-\uffef]/;

/** Two pieces of one sentence as one line: a space between words, nothing between Chinese or Japanese characters. */
export function joinWords(a: string, b: string): string {
  const left = a.trim();
  const right = b.trim();
  if (!left || !right) return left || right;
  return CJK_EDGE.test(left.slice(-1)) || CJK_EDGE.test(right[0]) ? left + right : `${left} ${right}`;
}

/**
 * Two subtitles as one: the words of every language joined in time order, the look of the first. A pair
 * with identical words is a title that was split in two, so merging it gives the original back.
 */
export function mergeTitleText(a: ClipText, b: ClipText): ClipText {
  if (JSON.stringify(a) === JSON.stringify(b)) return a;
  const langs = new Set([...Object.keys(a.i18n ?? {}), ...Object.keys(b.i18n ?? {})]);
  const i18n = Object.fromEntries([...langs].map((l) => [l, joinWords(a.i18n?.[l] ?? '', b.i18n?.[l] ?? '')]));
  return { ...a, content: joinWords(a.content, b.content), i18n: langs.size ? i18n : undefined };
}

/** The words of one title in one language; '' when it has none yet. */
export function titleIn(clip: Clip, lang: string, current: string): string {
  if (!clip.text) return '';
  return lang === current ? clip.text.content : clip.text.i18n?.[lang] ?? '';
}

/**
 * Make `lang` the language every title shows. The words on screen go into `i18n` under the old
 * language and the new language's words come out of it, so nothing is lost either way and every
 * reader of `text.content` (monitor, burn-in, SRT) needs no change. A title with nothing in the new
 * language shows nothing, which is what a half-translated film should do.
 */
export function switchSubtitleLang(timeline: Timeline, lang: string): Timeline {
  const current = subtitleLangOf(timeline);
  if (lang === current) return timeline.subtitleLangs?.includes(lang) ? timeline : { ...timeline, subtitleLangs: addLang(timeline, lang) };
  return {
    ...timeline,
    subtitleLang: lang,
    subtitleLangs: addLang(timeline, lang),
    clips: timeline.clips.map((c) => {
      if (!c.text) return c;
      const { [lang]: incoming, ...rest } = c.text.i18n ?? {};
      return { ...c, text: { ...c.text, content: incoming ?? '', i18n: { ...rest, [current]: c.text.content } } };
    }),
  };
}

/** Write one title's words in one language. */
export function setTitleIn(timeline: Timeline, clipId: string, lang: string, words: string): Timeline {
  const current = subtitleLangOf(timeline);
  return {
    ...timeline,
    subtitleLangs: addLang(timeline, lang),
    clips: timeline.clips.map((c) => {
      if (c.id !== clipId || !c.text) return c;
      return lang === current
        ? { ...c, text: { ...c.text, content: words } }
        : { ...c, text: { ...c.text, i18n: { ...c.text.i18n, [lang]: words } } };
    }),
  };
}

export interface SrtCue {
  start: number; // seconds
  end: number;
  text: string;
}

const srtSeconds = (h: string, m: string, s: string, ms: string) =>
  Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000;

/** Reads an SRT (any line ending, with or without a BOM). Cues with no text are dropped. */
export function parseSrt(source: string): SrtCue[] {
  const cues: SrtCue[] = [];
  const blocks = source.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const time = /(\d+):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d+):(\d{2}):(\d{2})[,.](\d{1,3})/;
  for (const block of blocks) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => time.test(l));
    if (at < 0) continue;
    const m = lines[at].match(time)!;
    const text = lines.slice(at + 1).map((l) => l.trim()).filter(Boolean).join('\n');
    if (!text) continue;
    cues.push({ start: srtSeconds(m[1], m[2], m[3], m[4]), end: srtSeconds(m[5], m[6], m[7], m[8]), text });
  }
  return cues.sort((a, b) => a.start - b.start);
}

export interface SrtImport {
  timeline: Timeline;
  /** Titles that received words. */
  matched: number;
  /** Titles no cue was found for: they stay empty in this language. */
  unmatched: number;
  /** Cues no title took. */
  spare: number;
}

/**
 * Put an SRT in as `lang`'s words. The film's titles keep their timing; only words come in. When the
 * file has as many cues as the film has titles they pair by order (a translated SRT keeps the source's
 * cues, so this is exact even if the times were nudged); otherwise each title takes the cue it overlaps most.
 */
export function importSrtAsLang(timeline: Timeline, lang: string, cues: SrtCue[]): SrtImport {
  const clips = subtitleClips(timeline);
  const fps = timeline.fps;
  const pick = new Map<string, string>();
  const used = new Set<number>();
  if (cues.length === clips.length) {
    clips.forEach((c, i) => { pick.set(c.id, cues[i].text); used.add(i); });
  } else {
    clips.forEach((c) => {
      const a0 = c.start / fps;
      const a1 = clipEnd(c) / fps;
      let best = -1;
      let bestOverlap = 0;
      cues.forEach((cue, i) => {
        const overlap = Math.min(a1, cue.end) - Math.max(a0, cue.start);
        if (overlap > bestOverlap && !used.has(i)) { best = i; bestOverlap = overlap; }
      });
      if (best >= 0) { pick.set(c.id, cues[best].text); used.add(best); }
    });
  }
  let next = { ...timeline, subtitleLangs: addLang(timeline, lang) };
  const current = subtitleLangOf(timeline);
  next = {
    ...next,
    clips: next.clips.map((c) => {
      if (!c.text || !isCue(c)) return c;
      const words = pick.get(c.id) ?? '';
      return lang === current
        ? { ...c, text: { ...c.text, content: words } }
        : { ...c, text: { ...c.text, i18n: { ...c.text.i18n, [lang]: words } } };
    }),
  };
  return { timeline: next, matched: pick.size, unmatched: clips.length - pick.size, spare: cues.length - used.size };
}

/** Drop a language: its words leave every title. The current language cannot be removed. */
export function removeSubtitleLang(timeline: Timeline, lang: string): Timeline {
  if (lang === subtitleLangOf(timeline)) return timeline;
  return {
    ...timeline,
    subtitleLangs: (timeline.subtitleLangs ?? []).filter((l) => l !== lang),
    clips: timeline.clips.map((c) => {
      if (!c.text?.i18n || !(lang in c.text.i18n)) return c;
      const { [lang]: _gone, ...rest } = c.text.i18n;
      return { ...c, text: { ...c.text, i18n: Object.keys(rest).length ? rest : undefined } };
    }),
  };
}

/** How many titles have words in `lang`, out of how many there are. */
export function languageProgress(timeline: Timeline, lang: string): { done: number; total: number } {
  const current = subtitleLangOf(timeline);
  const clips = subtitleClips(timeline);
  return { done: clips.filter((c) => titleIn(c, lang, current).trim()).length, total: clips.length };
}

/**
 * What a title with no words in the current language shows on the monitor and as a hint while
 * translating: its words in the film's first language. Never exported or burned in.
 */
export function referenceTitle(timeline: Timeline, clip: Clip): string {
  if (!clip.text || clip.text.content.trim()) return '';
  const base = (timeline.subtitleLangs ?? [])[0];
  return (base && base !== subtitleLangOf(timeline) && clip.text.i18n?.[base]) || '';
}

/** The title's words in the film's first language while another language is current, translated or not: the fixed line to translate against. */
export function sourceTitle(timeline: Timeline, clip: Clip): { lang: string; words: string } | null {
  const base = (timeline.subtitleLangs ?? [])[0];
  if (!clip.text || !base || base === subtitleLangOf(timeline)) return null;
  return { lang: base, words: clip.text.i18n?.[base] ?? '' };
}
