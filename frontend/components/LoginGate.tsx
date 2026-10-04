'use client';

import React, { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { getSession, login, register, revalidate, subscribeAuth } from '@/lib/auth';
import { t, useLocale, useT } from '@/lib/i18n';
import LocaleSwitch from './LocaleSwitch';
import { LazaMark } from './Logo';
import { useAppVersion, versionLabel } from '@/lib/useAppVersion';

/**
 * Wraps the studio. With a cached session it renders the canvas immediately and
 * checks the token in the background; without one it asks for an account.
 *
 * `useSyncExternalStore` rather than a `useState` copy so that logging out from
 * the header -- or in another tab -- puts this screen back up without any
 * component having to notify it. The server snapshot is `null` because
 * localStorage does not exist during SSR; the `mounted` flag keeps the first
 * client render matching that, otherwise React throws away the tree it just
 * hydrated.
 */
export default function LoginGate({ children }: { children: React.ReactNode }) {
  const session = useSyncExternalStore(subscribeAuth, getSession, () => null);
  const locale = useLocale();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // layout.tsx ships lang="zh-CN"; a saved Japanese choice has to correct it
  // once on load, since setLocale only fires when the language is switched.
  useEffect(() => {
    document.documentElement.lang = locale === 'ja' ? 'ja' : 'zh-CN';
  }, [locale]);

  useEffect(() => {
    if (session) void revalidate();
    // Re-check whenever the account changes, not on every render.
  }, [session?.token]);

  if (!mounted) return null;
  // `key` remounts the studio when the language changes. Most of the UI reads
  // its copy through the plain `t()` -- which is a module-level read, not a
  // subscription -- because threading a hook into ~90 components (several with
  // early returns) is how the header crashed with a hook-order error the first
  // time. Remounting makes one rare action, switching language, do the work
  // that would otherwise cost a hook in every component. Canvas state survives:
  // nodes and edges live in the zustand store outside React, and the viewport
  // is restored from localStorage.
  if (session) return <React.Fragment key={locale}>{children}</React.Fragment>;
  return <AuthScreen />;
}

function AuthScreen() {
  const t = useT();
  const version = versionLabel(useAppVersion());
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (!username.trim() || !password) {
      setError(t('请填写用户名和密码'));
      return;
    }
    if (mode === 'register' && password !== confirm) {
      setError(t('两次输入的密码不一致'));
      return;
    }
    setBusy(true);
    try {
      if (mode === 'register') await register(username.trim(), password);
      else await login(username.trim(), password);
      // On success the store fires and LoginGate swaps in the canvas.
    } catch (err) {
      setError(err instanceof Error ? err.message : t('登录失败'));
      setBusy(false);
    }
  }, [busy, mode, username, password, confirm]);

  const switchMode = (next: 'login' | 'register') => {
    setMode(next);
    setError(null);
    setConfirm('');
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-[#08080a] px-4">
      {/* Backdrop glow, same palette as the canvas chrome */}
      <div
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          background:
            'radial-gradient(600px circle at 50% 30%, rgba(120,80,255,0.16), transparent 70%)',
        }}
      />

      <form
        onSubmit={submit}
        className="relative w-full max-w-[360px] rounded-2xl p-7"
        style={{
          background: 'rgba(16, 16, 22, 0.9)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          boxShadow: '0 20px 60px rgba(0, 0, 0, 0.7), inset 0 1px 0 rgba(255, 255, 255, 0.08)',
        }}
      >
        <div className="mb-6 flex items-center gap-2.5">
          <LazaMark size={34} className="flex-shrink-0" />
          <div>
            <div className="flex items-baseline gap-2">
              <span className="text-[14px] font-bold tracking-tight text-white">LAZA CINEMA STUDIO</span>
              {version && <span title={version.title} className="font-mono text-[10px] text-zinc-500">{version.text}</span>}
            </div>
            <div className="text-[11px] text-zinc-500">
              {mode === 'login' ? t('登录后进入无限画布') : t('创建一个新账号')}
            </div>
          </div>
        </div>

        <label className="mb-1.5 block text-[11px] font-medium text-zinc-400">{t('用户名')}</label>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
          autoComplete="username"
          spellCheck={false}
          placeholder={t('2-32 个字符')}
          className="mb-4 w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-[13px] text-white placeholder:text-zinc-600 outline-none transition-colors focus:border-white/25 focus:bg-white/[0.07]"
        />

        <label className="mb-1.5 block text-[11px] font-medium text-zinc-400">{t('密码')}</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          placeholder={t('至少 4 位')}
          className="mb-4 w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-[13px] text-white placeholder:text-zinc-600 outline-none transition-colors focus:border-white/25 focus:bg-white/[0.07]"
        />

        {mode === 'register' && (
          <>
            <label className="mb-1.5 block text-[11px] font-medium text-zinc-400">{t('确认密码')}</label>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              placeholder={t('再输入一次')}
              className="mb-4 w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-[13px] text-white placeholder:text-zinc-600 outline-none transition-colors focus:border-white/25 focus:bg-white/[0.07]"
            />
          </>
        )}

        {error && (
          <div className="mb-3 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[12px] text-red-300">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg border border-white/15 bg-white/[0.10] px-3 py-2.5 text-[13px] font-semibold text-white transition-all hover:bg-white/[0.16] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? t('请稍候…') : mode === 'login' ? t('登录') : t('创建账号并进入')}
        </button>

        <div className="mt-4 text-center text-[12px] text-zinc-500">
          {mode === 'login' ? (
            <>
              
              {t('还没有账号？')}
              <button
                type="button"
                onClick={() => switchMode('register')}
                className="ml-1 text-zinc-300 underline-offset-2 hover:text-white hover:underline"
              >
                
                {t('直接注册一个')}
              </button>
            </>
          ) : (
            <>
              
              {t('已经有账号？')}
              <button
                type="button"
                onClick={() => switchMode('login')}
                className="ml-1 text-zinc-300 underline-offset-2 hover:text-white hover:underline"
              >
                
                {t('去登录')}
              </button>
            </>
          )}
        </div>

        <p className="mt-4 text-center text-[11px] leading-relaxed text-zinc-600">
          
          {t('登录状态会保存在这台设备上，下次打开免登录。')}
        </p>

        <div className="mt-4 flex justify-center">
          <LocaleSwitch />
        </div>
      </form>
    </div>
  );
}
