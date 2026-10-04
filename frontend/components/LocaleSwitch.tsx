'use client';

import React from 'react';
import { LOCALES, LOCALE_NAMES, setLocale, useLocale, type Locale } from '@/lib/i18n';

/**
 * Interface language toggle. Each language is labelled in itself (简体中文 /
 * 日本語) rather than translated, so someone who has landed in the wrong
 * language can still find their way out.
 */
export default function LocaleSwitch({ className = '' }: { className?: string }) {
  const locale = useLocale();
  return (
    <div className={`inline-flex items-center gap-0.5 rounded-lg border border-white/[0.08] bg-white/[0.03] p-0.5 ${className}`}>
      {LOCALES.map((code: Locale) => (
        <button
          key={code}
          type="button"
          lang={code === 'ja' ? 'ja' : 'zh-CN'}
          onClick={() => setLocale(code)}
          className={`rounded-md px-2 py-1 text-[11px] transition-colors ${
            locale === code
              ? 'bg-white/[0.14] font-medium text-white'
              : 'text-zinc-400 hover:text-white'
          }`}
        >
          {LOCALE_NAMES[code]}
        </button>
      ))}
    </div>
  );
}
