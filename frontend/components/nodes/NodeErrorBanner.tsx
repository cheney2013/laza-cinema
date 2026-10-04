'use client';

import React, { useState, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { t } from '@/lib/i18n';

interface NodeErrorBannerProps {
  error?: string | null;
  onClear?: () => void;
  title?: string;
}

export default function NodeErrorBanner({
  error,
  onClear,
  title = t('生成错误'),
}: NodeErrorBannerProps) {
  const [showDetail, setShowDetail] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const errorText = error || t('发生未知错误，请检查后台日志或网络连接。');

  const handleCopy = useCallback(async (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    // navigator.clipboard 仅在安全上下文（https / localhost）可用，
    // 局域网 IP + http 访问时为 undefined，需回退到 execCommand。
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(errorText);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = errorText;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch {
        ok = false;
      }
    }
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [errorText]);

  if (!error) return null;

  return (
    <>
      {/* ── Compact Error Pill on Node ────────────────────────────────────── */}
      <div 
        className="nodrag absolute top-2 left-2 right-2 z-40 px-2.5 py-1.5 text-[11px] text-zinc-200 bg-[#121218]/95 border border-white/20 rounded-xl shadow-2xl flex items-center justify-between gap-1.5 backdrop-blur-xl animate-in fade-in zoom-in-95 duration-150 select-none group cursor-pointer hover:bg-[#181822] hover:border-white/30 transition-all"
        onClick={() => setShowDetail(true)}
        title={t('点击查看完整错误详情')}
      >
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <span className="text-zinc-300 font-bold flex-shrink-0 text-xs">✕</span>
          <span className="truncate flex-1 font-mono text-[10.5px] leading-tight text-zinc-200">
            {errorText}
          </span>
        </div>

        <div className="flex items-center gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          {/* Quick Copy Button */}
          <button
            type="button"
            onClick={handleCopy}
            className="p-1 rounded-md bg-white/10 hover:bg-white/20 text-zinc-300 hover:text-white transition-colors cursor-pointer flex items-center gap-1 text-[10px]"
            title={t('复制错误信息')}
          >
            {copied ? (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
          </button>

          {/* Dismiss Button */}
          {onClear && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onClear();
              }}
              className="p-1 rounded-md hover:bg-white/10 text-zinc-400 hover:text-white transition-colors cursor-pointer text-xs"
              title={t('清除错误')}
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* ── Full Error Detail Dialog Modal (Portaled to document.body) ───── */}
      {showDetail && mounted && typeof document !== 'undefined' && createPortal(
        <div 
          className="fixed inset-0 z-[99999] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200"
          onClick={() => setShowDetail(false)}
        >
          <div 
            className="relative w-full max-w-xl max-h-[85vh] bg-[#101016]/98 border border-white/15 rounded-2xl shadow-2xl overflow-hidden flex flex-col animate-in zoom-in-95 duration-200"
            onClick={(e) => e.stopPropagation()}
            style={{
              boxShadow: '0 25px 60px rgba(0, 0, 0, 0.9), inset 0 1px 0 rgba(255, 255, 255, 0.15)',
            }}
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/10 bg-white/[0.02]">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-xl bg-white/10 border border-white/15 flex items-center justify-center text-zinc-300 flex-shrink-0">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-bold text-white tracking-wide">{title}</h3>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/10 text-zinc-300 border border-white/15 font-semibold">ERROR</span>
                  </div>
                  <p className="text-[11px] text-zinc-400 mt-0.5">{t('可在下方查看完整堆栈信息并一键复制排查')}</p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setShowDetail(false)}
                className="w-8 h-8 flex items-center justify-center rounded-xl bg-white/5 hover:bg-white/10 text-zinc-400 hover:text-white transition-colors cursor-pointer text-base"
                title={t('关闭')}
              >
                ✕
              </button>
            </div>

            {/* Modal Body - Scrollable Error Content */}
            <div className="p-5 overflow-y-auto flex-1 font-mono text-xs text-zinc-300 leading-relaxed select-text space-y-3 max-h-[55vh]">
              <div className="p-4 rounded-xl bg-black/70 border border-white/10 text-zinc-200 select-text overflow-x-auto whitespace-pre-wrap break-words leading-5 font-mono text-[11.5px]">
                {errorText}
              </div>
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-between px-5 py-3.5 border-t border-white/10 bg-black/40">
              <span className="text-[11px] text-zinc-500">
                {copied ? t('✓ 已成功复制到剪贴板') : t('点击右侧按钮复制完整错误日志')}
              </span>

              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={handleCopy}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold text-white bg-white/15 hover:bg-white/25 border border-white/20 transition-all shadow-md cursor-pointer active:scale-95 whitespace-nowrap"
                >
                  {copied ? (
                    <>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                      <span>{t('已复制')}</span>
                    </>
                  ) : (
                    <>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                      <span>{t('复制错误信息')}</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => setShowDetail(false)}
                  className="px-4 py-2 rounded-xl text-xs font-medium text-zinc-300 hover:text-white bg-white/5 hover:bg-white/10 transition-colors cursor-pointer whitespace-nowrap"
                >
                  
                  {t('关闭')}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
