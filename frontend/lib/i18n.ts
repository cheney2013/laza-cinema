'use client';

/**
 * Interface language.
 *
 * The key of every entry is the Chinese source text, not a symbolic name. That
 * is deliberate: the UI copy was written directly into 140 components over
 * months, so symbolic keys would mean naming several thousand strings before a
 * single one could be translated, and any string that got missed would render
 * as `header.newProject` in front of the user. Keyed on the source text, a
 * missing entry falls back to the Chinese it was written as -- the worst case
 * is an untranslated label, never a broken one.
 *
 * `t()` is also usable outside React (lib/, hooks/): it reads the module-level
 * locale. Components should use `useT()` so that switching language re-renders
 * them; `t()` alone is read once and would leave stale text on screen.
 */

import { useCallback, useSyncExternalStore } from 'react';

import { ja } from './locales/ja';

export const LOCALES = ['zh', 'ja'] as const;
export type Locale = (typeof LOCALES)[number];

/** The language the UI copy is written in, and the fallback for anything else. */
export const DEFAULT_LOCALE: Locale = 'zh';

export const LOCALE_NAMES: Record<Locale, string> = {
  zh: '简体中文',
  ja: '日本語',
};

const STORAGE_KEY = 'ai_cinema_locale';
const CHANGE_EVENT = 'ai-cinema-locale-change';

const DICTIONARIES: Record<Locale, Record<string, string>> = {
  zh: {},   // the source language: every lookup falls through to the key itself
  ja,
};

/**
 * The locale a BCP 47 tag asks for, or null when the studio has no such
 * language. Matching is on the primary subtag, so ja-JP, zh-TW and zh-Hans-CN
 * all land somewhere sensible instead of counting as unknown -- a Taiwan or
 * Hong Kong browser gets the Chinese UI rather than reaching it by accident
 * through the fallback. Region and script are deliberately ignored: there is
 * one Chinese dictionary, not one per region.
 */
export function matchLocale(tag: string): Locale | null {
  const primary = (tag || '').toLowerCase().split('-')[0];
  return (LOCALES as readonly string[]).includes(primary) ? (primary as Locale) : null;
}

/**
 * Which language to open in.
 *
 * A language the user picked by hand always wins -- otherwise the browser would
 * undo the switch on the next reload and the control would look broken. Failing
 * that, the browser's own preference list is read in order, so someone whose
 * first choice is a language the studio does not have (say en, then ja) still
 * gets their second rather than dropping straight to the default. Nothing
 * matching means Chinese, which is what the UI copy is written in.
 *
 * Adding a language is then just a dictionary plus its code in LOCALES; there
 * is nothing per-language in here to update.
 */
function detect(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && (LOCALES as readonly string[]).includes(saved)) return saved as Locale;
  } catch {
    /* private mode */
  }
  if (typeof navigator === 'undefined') return DEFAULT_LOCALE;
  // navigator.languages is the ordered preference list; older browsers and some
  // embedded webviews only have navigator.language.
  const preferred: readonly string[] = navigator.languages?.length
    ? navigator.languages
    : [navigator.language].filter(Boolean);
  return pickLocale(preferred);
}

/** The first tag in an ordered preference list the studio has, else the default. */
export function pickLocale(preferred: readonly string[]): Locale {
  for (const tag of preferred) {
    const hit = matchLocale(tag);
    if (hit) return hit;
  }
  return DEFAULT_LOCALE;
}

let current: Locale | null = null;

export function getLocale(): Locale {
  if (current === null) current = detect();
  return current;
}

export function setLocale(locale: Locale) {
  if (!(LOCALES as readonly string[]).includes(locale)) return;
  current = locale;
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    /* private mode: the choice still holds for this tab */
  }
  // Screen readers and the browser's own translate prompt both key off this.
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale === 'ja' ? 'ja' : 'zh-CN';
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function subscribeLocale(cb: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) {
      current = null;
      cb();
    }
  };
  window.addEventListener(CHANGE_EVENT, cb);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, cb);
    window.removeEventListener('storage', onStorage);
  };
}

/**
 * `vars` fills `{name}` placeholders, so a sentence whose word order differs
 * between the two languages can still be translated as one string instead of
 * being concatenated from fragments in Chinese order.
 */
export function translate(locale: Locale, text: string, vars?: Record<string, string | number>): string {
  let out = DICTIONARIES[locale]?.[text] ?? text;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      out = out.split(`{${k}}`).join(String(v));
    }
  }
  return out;
}

/** Translate with the current locale. For modules that are not components. */
export function t(text: string, vars?: Record<string, string | number>): string {
  return translate(getLocale(), text, vars);
}

/**
 * The hook components should use. Returns a `t` bound to the current locale and
 * re-renders the component when the language changes.
 */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, () => DEFAULT_LOCALE);
}

export function useT(): (text: string, vars?: Record<string, string | number>) => string {
  const locale = useLocale();
  return useCallback(
    (text: string, vars?: Record<string, string | number>) => translate(locale, text, vars),
    [locale],
  );
}

/**
 * A progress phase sent by the backend.
 *
 * Most phases are fixed sentences and translate like any other string. Two of
 * them carry numbers -- "分段生成 2/5" and "扩散去噪采样中 (7/8)" -- so a literal
 * lookup can never match. Rather than change what the API sends (the field is
 * consumed by tools outside this app as well), the numbers are lifted out here
 * and put back through the keyed sentence.
 */
const PHASE_PATTERNS: Array<[RegExp, string, string[]]> = [
  [/^分段生成\s+(\d+)\/(\d+)$/, '分段生成 {n}/{total}', ['n', 'total']],
  [/^扩散去噪采样中\s*\((\d+)\/(\d+)\)$/, '扩散去噪采样中 ({step}/{max})', ['step', 'max']],
];

/**
 * The dictionary key a phase should be looked up under, and the numbers lifted
 * out of it. Separate from the lookup so it can be asserted without a browser:
 * the interesting part is recognising the shape, not the lookup.
 */
export function phaseKey(phase: string): { key: string; vars: Record<string, string> } {
  for (const [re, key, names] of PHASE_PATTERNS) {
    const m = phase.match(re);
    if (m) {
      const vars: Record<string, string> = {};
      names.forEach((name, i) => { vars[name] = m[i + 1]; });
      return { key, vars };
    }
  }
  return { key: phase, vars: {} };
}

export function translatePhase(phase: string | null | undefined): string {
  if (!phase) return '';
  const { key, vars } = phaseKey(phase);
  return t(key, vars);
}
