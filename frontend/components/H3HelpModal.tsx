'use client';

import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '@/lib/i18n';
import { useBackdropDismiss } from '@/lib/useBackdropDismiss';
import { H3_HELP_SECTIONS } from '@/lib/h3/help';

interface H3HelpModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * H3 提示词手册：运镜词表、台词内表演标签、链式生成的实测规则。
 * 内容表在 lib/h3/help.ts，是要原样写进提示词的英文加中文说明，不走 t()。
 */
export default function H3HelpModal({ isOpen, onClose }: H3HelpModalProps) {
  const t = useT();
  const [mounted, setMounted] = useState(false);
  const [active, setActive] = useState(H3_HELP_SECTIONS[0].id);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const dismiss = useBackdropDismiss(onClose);

  if (!isOpen || !mounted) return null;

  const section = H3_HELP_SECTIONS.find((s) => s.id === active) ?? H3_HELP_SECTIONS[0];

  const modalContent = (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 pointer-events-auto select-auto">
      <div
        className="fixed inset-0 bg-black/80 backdrop-blur-md transition-opacity animate-in fade-in duration-200 pointer-events-auto cursor-pointer"
        {...dismiss}
      />
      <div
        className="relative w-full max-w-5xl bg-[#101016]/95 border border-white/10 rounded-2xl shadow-2xl overflow-hidden z-10 animate-in fade-in zoom-in-95 duration-200"
        style={{ boxShadow: '0 20px 60px rgba(0, 0, 0, 0.8), inset 0 1px 0 rgba(255, 255, 255, 0.1)' }}
      >
        <div className="px-6 py-4 border-b border-white/[0.08] flex items-center justify-between bg-white/[0.02]">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-white/10 border border-white/15 shadow-inner flex items-center justify-center text-white">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              </svg>
            </div>
            <div>
              <h2 className="text-sm font-semibold text-white tracking-wide flex items-center gap-2">
                <span>{t('H3 提示词手册')}</span>
                <span className="text-[10px] font-mono font-normal text-zinc-300 bg-white/10 px-2 py-0.5 rounded-full border border-white/15">
                  Prompt Handbook
                </span>
              </h2>
              <p className="text-[11px] text-zinc-400">{t('运镜词表、台词内表演标签、链式生成的实测规则')}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg text-zinc-400 hover:text-white hover:bg-white/10 flex items-center justify-center transition-colors cursor-pointer"
            title={t('关闭手册 (Esc)')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="flex max-h-[75vh]">
          <nav className="w-48 flex-shrink-0 border-r border-white/[0.08] p-3 space-y-1 overflow-y-auto no-scrollbar">
            {H3_HELP_SECTIONS.map((s) => (
              <button
                key={s.id}
                onClick={() => setActive(s.id)}
                className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-colors cursor-pointer ${
                  s.id === active ? 'bg-white/10 text-white' : 'text-zinc-400 hover:text-white hover:bg-white/[0.05]'
                }`}
              >
                {s.title}
              </button>
            ))}
          </nav>

          <div className="flex-1 p-6 overflow-y-auto no-scrollbar space-y-4 text-zinc-200">
            <h3 className="text-sm font-semibold text-white">{section.title}</h3>
            {section.intro && <p className="text-[12px] leading-relaxed text-zinc-300">{section.intro}</p>}

            {section.rows && (
              <div className="overflow-x-auto rounded-xl border border-white/[0.07]">
                <table className="w-full text-[12px]">
                  <thead className="bg-white/[0.04] text-zinc-400">
                    <tr>
                      {(section.columns ?? ['词', '含义', '例句']).map((c, i) => (
                        <th key={i} className="text-left px-3 py-2 font-medium whitespace-nowrap">{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {section.rows.map((r, i) => (
                      <tr key={i} className="border-t border-white/[0.06] align-top">
                        <td className="px-3 py-2 font-mono text-[11px] text-amber-200/90 whitespace-nowrap">{r.term}</td>
                        <td className="px-3 py-2 text-zinc-300 leading-relaxed">{r.meaning}</td>
                        {(section.columns?.length ?? 3) >= 3 && (
                          <td className="px-3 py-2 font-mono text-[11px] text-zinc-400 leading-relaxed">{r.example ?? ''}</td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {section.bullets && (
              <ul className="space-y-2">
                {section.bullets.map((b, i) => (
                  <li key={i} className="flex gap-2 text-[12px] leading-relaxed text-zinc-300">
                    <span className="text-zinc-500 flex-shrink-0">•</span>
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
}
