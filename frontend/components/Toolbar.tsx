'use client';

import { useEffect, useState } from 'react';
import { useStore } from '@/lib/store';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';

export default function Toolbar() {
  const backendOnline = useStore((s) => s.backendOnline);
  const comfyuiOnline = useStore((s) => s.comfyuiOnline);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const past = useStore((s) => s.past);
  const future = useStore((s) => s.future);

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5
      rounded-2xl px-3 py-2"
      style={{
        background: 'rgba(20,20,20,0.92)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        boxShadow: '0 0 0 0.5px rgba(255,255,255,0.07), 0 8px 32px rgba(0,0,0,0.6)',
      }}
    >
      <div className="flex items-center gap-2.5 px-1">
        <StatusDot online={backendOnline} label="API" hint={t('后端离线 — 请运行: .\\start.ps1')} />
        <StatusDot online={comfyuiOnline} label="ComfyUI" hint="ComfyUI 离线" />
        <ResourceStatus />
      </div>

      <div className="w-px h-3.5 bg-white/10 mx-1" />

      <div className="flex items-center gap-1">
        <ToolbarButton 
          onClick={undo} 
          disabled={past.length === 0} 
          icon={<UndoIcon />} 
          label={t('撤销')} 
          shortcut="Ctrl+Z" 
        />
        <ToolbarButton 
          onClick={redo} 
          disabled={future.length === 0} 
          icon={<RedoIcon />} 
          label={t('重做')} 
          shortcut="Ctrl+Y" 
        />
      </div>
    </div>
  );
}


function ToolbarButton({ onClick, disabled, icon, label, shortcut }: { onClick: () => void, disabled: boolean, icon: React.ReactNode, label: string, shortcut?: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={`${label} ${shortcut ? `(${shortcut})` : ''}`}
      className={`
        w-8 h-8 flex items-center justify-center rounded-lg transition-all duration-200
        ${disabled 
          ? 'text-white/20 cursor-not-allowed' 
          : 'text-white/60 hover:text-white hover:bg-white/10 active:scale-95 cursor-pointer'}
      `}
      style={{ border: 'none', outline: 'none', background: 'transparent' }}
    >
      {icon}
    </button>
  );
}

function UndoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7v6h6" />
      <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
    </svg>
  );
}

function RedoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 7v6h-6" />
      <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 2.7" />
    </svg>
  );
}

function StatusDot({ online, label, hint }: { online: boolean; label: string; hint: string }) {
  return (
    <span className="flex items-center gap-1.5 cursor-default" title={online ? t('{v1} 已在线', { v1: label }) : hint}>
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 transition-colors ${online ? 'bg-emerald-400' : 'bg-red-500 animate-pulse'}`} />
      <span className={`text-[10px] font-medium tracking-wide ${online ? 'text-[#666]' : 'text-red-500'}`}>{label}</span>
    </span>
  );
}

function ResourceStatus() {
  const comfyuiOnline = useStore((s) => s.comfyuiOnline);
  const [stats, setStats] = useState<any>(null);

  useEffect(() => {
    if (!comfyuiOnline) {
      setStats(null);
      return;
    }
    let active = true;
    const check = async () => {
      try {
        const res = await api.getSystemStats();
        if (active) setStats(res);
      } catch {
        if (active) setStats(null);
      }
    };
    check();
    const timer = setInterval(check, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [comfyuiOnline]);

  if (!comfyuiOnline || !stats || !stats.vram || stats.vram.length === 0) return null;

  const vram = stats.vram[0];
  const ram = stats.ram && 'ram_pct' in stats.ram ? stats.ram : null;

  const vramPct = Math.round(vram.vram_pct);
  const vramColorClass = vramPct > 85 ? 'text-rose-400 font-semibold animate-pulse' : vramPct > 60 ? 'text-amber-400 font-medium' : 'text-emerald-400 font-medium';
  const vramDotClass = vramPct > 85 ? 'bg-rose-500 animate-pulse' : vramPct > 60 ? 'bg-amber-400' : 'bg-emerald-400';

  const formatGB = (bytes: number) => (bytes / (1024 ** 3)).toFixed(1) + ' GB';

  return (
    <>
      <div className="w-px h-3 bg-white/10 mx-0.5" />
      <span 
        className="flex items-center gap-1.5 cursor-default" 
        title={
          t('{name}\n显存 (VRAM): {used} / {total} ({pct}%)', {
            name: vram.name,
            used: formatGB(vram.vram_used),
            total: formatGB(vram.vram_total),
            pct: vram.vram_pct,
          })
          + (ram
            ? t('\n内存 (RAM): {used} / {total} ({pct}%)', {
                used: formatGB(ram.ram_used),
                total: formatGB(ram.ram_total),
                pct: ram.ram_pct,
              })
            : '')
        }
      >
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 transition-colors ${vramDotClass}`} />
        <span className="text-[10px] tracking-wide text-white/40">
          VRAM: <span className={vramColorClass}>{vramPct}%</span>
        </span>
      </span>
    </>
  );
}
