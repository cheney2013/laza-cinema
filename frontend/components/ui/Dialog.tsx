'use client';

import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { t } from '@/lib/i18n';

/**
 * 全局对话框 —— 替换 window.alert / confirm / prompt。
 *
 * 做成模块级单例而不是 Context：调用点散落在几十个节点组件的回调里（有的还在
 * .catch() 链上），走 Hook 就得给每个组件加 useDialog 并把函数往下传。这里
 * 只需 `import { showAlert } from '@/components/ui/Dialog'` 就能用，宿主
 * <DialogHost /> 在 layout 里挂一次。
 *
 * 三个函数都返回 Promise：
 *   showAlert   -> Promise<void>
 *   showConfirm -> Promise<boolean>
 *   showPrompt  -> Promise<string | null>   （取消返回 null，与 window.prompt 一致）
 *
 * 同时只显示一个：后来的排队，先进先出。浏览器原生弹框是阻塞的，排队才能保住
 * 「弹两次就看到两次」的旧语义。
 */

type DialogKind = 'alert' | 'confirm' | 'prompt';

export interface DialogOptions {
  title?: string;
  /** 正文，`\n` 按行渲染 */
  message: string;
  confirmText?: string;
  cancelText?: string;
  /** prompt 专用 */
  defaultValue?: string;
  placeholder?: string;
  /** 危险操作：确认键转为红色 */
  danger?: boolean;
}

interface DialogRequest extends DialogOptions {
  kind: DialogKind;
  resolve: (value: unknown) => void;
}

// ── 极简 store ──────────────────────────────────────────────────────────────
const queue: DialogRequest[] = [];
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function getSnapshot(): DialogRequest | null {
  return queue[0] ?? null;
}

function push(kind: DialogKind, options: DialogOptions): Promise<unknown> {
  return new Promise((resolve) => {
    queue.push({ ...options, kind, resolve });
    emit();
  });
}

function settle(value: unknown) {
  const current = queue.shift();
  emit();
  current?.resolve(value);
}

// ── 公开 API ────────────────────────────────────────────────────────────────

export function showAlert(message: string, options: Omit<DialogOptions, 'message'> = {}): Promise<void> {
  return push('alert', { ...options, message }) as Promise<void>;
}

export function showConfirm(message: string, options: Omit<DialogOptions, 'message'> = {}): Promise<boolean> {
  return push('confirm', { ...options, message }) as Promise<boolean>;
}

export function showPrompt(message: string, options: Omit<DialogOptions, 'message'> = {}): Promise<string | null> {
  return push('prompt', { ...options, message }) as Promise<string | null>;
}

// ── 宿主 ────────────────────────────────────────────────────────────────────

const ICONS: Record<DialogKind, React.ReactNode> = {
  alert: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v5" />
      <path d="M12 16h.01" />
    </svg>
  ),
  confirm: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  ),
  prompt: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  ),
};

const TITLES: Record<DialogKind, string> = {
  alert: '提示',
  confirm: '请确认',
  prompt: '请输入',
};

export function DialogHost() {
  const request = useSyncExternalStore(subscribe, getSnapshot, () => null);
  const [value, setValue] = useState('');
  const [mounted, setMounted] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => setMounted(true), []);

  // 每换一个请求重置输入并抢焦点 —— 弹框出来就能直接打字/回车
  useEffect(() => {
    if (!request) return;
    setValue(request.defaultValue ?? '');
    const t = requestAnimationFrame(() => {
      if (request.kind === 'prompt') {
        inputRef.current?.focus();
        inputRef.current?.select();
      } else {
        confirmRef.current?.focus();
      }
    });
    return () => cancelAnimationFrame(t);
  }, [request]);

  const onCancel = useCallback(() => {
    if (!request) return;
    settle(request.kind === 'prompt' ? null : false);
  }, [request]);

  const onConfirm = useCallback(() => {
    if (!request) return;
    if (request.kind === 'prompt') settle(value);
    else if (request.kind === 'confirm') settle(true);
    else settle(undefined);
  }, [request, value]);

  // 键盘走全局捕获：画布和节点上挂了一堆 keydown，弹框开着时不能让它们收到
  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => {
      // 弹框自己的输入框要正常收键 —— 捕获阶段 stopPropagation 会连目标都到不了
      const inDialog = (e.target as HTMLElement | null)?.closest?.('[data-app-dialog]');
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        request.kind === 'alert' ? onConfirm() : onCancel();
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        onConfirm();
      } else if (!inDialog) {
        // 阻断 Delete / 空格等画布快捷键，别让它们穿透到底下
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [request, onCancel, onConfirm]);

  if (!mounted || !request) return null;

  const hasCancel = request.kind !== 'alert';
  const title = request.title ?? t(TITLES[request.kind]);
  const accent = request.danger
    ? 'bg-rose-600/90 hover:bg-rose-500 border-rose-400/40'
    : 'bg-white/15 hover:bg-white/25 border-white/25';

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-6 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150"
      onMouseDown={(e) => {
        // 点遮罩 = 取消；alert 只有一个出口，点哪都算关掉
        if (e.target === e.currentTarget) (hasCancel ? onCancel : onConfirm)();
      }}
    >
      <div
        data-app-dialog
        role="dialog"
        aria-modal="true"
        className="w-full max-w-[420px] rounded-2xl bg-[#0e0e14]/95 border border-white/12 shadow-[0_24px_80px_rgba(0,0,0,0.85)] backdrop-blur-2xl overflow-hidden animate-in zoom-in-95 fade-in duration-150"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 px-5 pt-5 pb-4">
          <div
            className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 border ${
              request.danger
                ? 'bg-rose-500/12 border-rose-400/25 text-rose-300'
                : 'bg-white/[0.06] border-white/10 text-zinc-300'
            }`}
          >
            {ICONS[request.kind]}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold text-white leading-6">{title}</div>
            <div className="mt-1 text-[12px] text-zinc-400 leading-relaxed whitespace-pre-wrap break-words max-h-[40vh] overflow-y-auto custom-scrollbar">
              {request.message}
            </div>
            {request.kind === 'prompt' && (
              <input
                ref={inputRef}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={request.placeholder}
                className="mt-3 w-full bg-black/60 border border-white/12 focus:border-white/35 focus:ring-2 focus:ring-white/10 rounded-xl px-3 py-2 text-[13px] text-white placeholder-zinc-600 outline-none transition-all"
              />
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 bg-black/40 border-t border-white/[0.07]">
          {hasCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-1.5 rounded-lg text-[12px] font-medium text-zinc-400 hover:text-white bg-white/[0.04] hover:bg-white/[0.1] border border-white/10 transition-colors cursor-pointer"
            >
              {request.cancelText ?? t('取消')}
            </button>
          )}
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className={`px-4 py-1.5 rounded-lg text-[12px] font-semibold text-white border transition-colors cursor-pointer ${accent}`}
          >
            {request.confirmText ?? (hasCancel ? '确定' : '知道了')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default DialogHost;
