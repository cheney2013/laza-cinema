'use client';

import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { changePassword, getSession, logout, subscribeAuth } from '@/lib/auth';
import { showConfirm } from '@/components/ui/Dialog';
import { t, useT } from '@/lib/i18n';

/** The signed-in name in the header, with 退出登录 and a password change behind it. */
export default function AccountMenu() {
  const t = useT();
  const session = useSyncExternalStore(subscribeAuth, getSession, () => null);
  const [open, setOpen] = useState(false);
  const [changing, setChanging] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setChanging(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const handleLogout = useCallback(async () => {
    const ok = await showConfirm(t('退出后需要重新输入账号密码，确定吗？'), { title: t('退出登录') });
    if (!ok) return;
    setOpen(false);
    await logout();
  }, [t]);

  if (!session) return null;
  const initial = session.user.username.slice(0, 1).toUpperCase();

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={t('已登录：{name}', { name: session.user.username })}
        className="flex h-7 items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.04] px-1.5 sm:px-2 text-xs font-medium text-zinc-300 transition-all hover:border-white/15 hover:bg-white/[0.08] hover:text-white active:scale-95"
      >
        <span className="flex h-[18px] w-[18px] items-center justify-center rounded-md bg-white/15 text-[10px] font-bold text-white">
          {initial}
        </span>
        <span className="hidden max-w-[90px] truncate md:inline">{session.user.username}</span>
      </button>

      {open && (
        <div
          className="absolute right-0 top-9 w-[220px] rounded-xl p-1.5"
          style={{
            background: 'rgba(16, 16, 22, 0.95)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            boxShadow: '0 12px 36px rgba(0, 0, 0, 0.7)',
          }}
        >
          <div className="px-2.5 py-2">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[13px] font-semibold text-white">{session.user.username}</span>
              {session.user.is_admin && (
                <span
                  className="flex-shrink-0 rounded-md border border-amber-400/40 bg-amber-400/10 px-1.5 py-0.5 text-[9px] font-medium text-amber-300"
                  title={t('管理员：素材库里那些无归属的旧文件只有你看得到，清理由你来做')}
                >
                  {t('管理员')}
                </span>
              )}
            </div>
            <div className="truncate font-mono text-[10px] text-zinc-500">{session.user.id}</div>
          </div>
          <div className="my-1 h-px bg-white/[0.08]" />

          {changing ? (
            <PasswordForm onDone={() => { setChanging(false); setOpen(false); }} />
          ) : (
            <>
              <MenuItem onClick={() => setChanging(true)}>{t('修改密码')}</MenuItem>
              <MenuItem onClick={handleLogout} danger>{t('退出登录')}</MenuItem>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  children, onClick, danger,
}: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full rounded-lg px-2.5 py-1.5 text-left text-[12px] transition-colors ${
        danger
          ? 'text-red-300 hover:bg-red-500/10 hover:text-red-200'
          : 'text-zinc-300 hover:bg-white/[0.07] hover:text-white'
      }`}
    >
      {children}
    </button>
  );
}

function PasswordForm({ onDone }: { onDone: () => void }) {
  const t = useT();
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await changePassword(oldPassword, newPassword);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('修改失败'));
      setBusy(false);
    }
  };

  const inputCls =
    'mb-1.5 w-full rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[12px] text-white placeholder:text-zinc-600 outline-none focus:border-white/25';

  return (
    <form onSubmit={submit} className="px-1.5 pb-1">
      <input
        type="password" autoFocus placeholder={t('原密码')} autoComplete="current-password"
        value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} className={inputCls}
      />
      <input
        type="password" placeholder={t('新密码（至少 4 位）')} autoComplete="new-password"
        value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className={inputCls}
      />
      {error && <div className="mb-1.5 px-0.5 text-[11px] text-red-300">{error}</div>}
      <div className="flex gap-1.5">
        <button
          type="submit" disabled={busy}
          className="flex-1 rounded-lg border border-white/15 bg-white/[0.10] py-1.5 text-[12px] text-white hover:bg-white/[0.16] disabled:opacity-50"
        >
          {busy ? '…' : t('确认')}
        </button>
        <button
          type="button" onClick={onDone}
          className="rounded-lg border border-white/[0.08] px-2.5 py-1.5 text-[12px] text-zinc-400 hover:text-white"
        >
          
          {t('取消')}
        </button>
      </div>
    </form>
  );
}
