'use client';

import React, { useEffect, useState, useTransition, useCallback } from 'react';
import { useStore } from '@/lib/store';
import { useShallow } from 'zustand/react/shallow';
import { api } from '@/lib/api';
import { useReactFlow } from '@xyflow/react';
import ProjectSwitcher from './ProjectSwitcher';
import TaskQueuePanel, { ActiveJobBar } from './TaskQueuePanel';
import JobSoundNotifier from './JobSoundNotifier';
import StudioSettingsModal from './StudioSettingsModal';
import H3HelpModal from './H3HelpModal';
import AccountMenu from './AccountMenu';
import { LazaMark } from './Logo';
import { useAppVersion, versionLabel } from '@/lib/useAppVersion';
import { t, useT } from '@/lib/i18n';
import { LibraryIcon, ScissorsIcon } from '@/components/ui/icons';
import { animateLayoutTransition } from '@/lib/layoutEngine';
import { calculateStageLayout } from '@/lib/stageLayout';

function HeaderBar() {
  const version = versionLabel(useAppVersion());
  const t = useT();
  const {
    backendOnline,
    comfyuiOnline,
    undo,
    redo,
    past,
    future,
    selectedModel,
    setSelectedModel,
    setNodes,
    takeSnapshot
  } = useStore(useShallow((s) => ({
    backendOnline: s.backendOnline,
    comfyuiOnline: s.comfyuiOnline,
    undo: s.undo,
    redo: s.redo,
    past: s.past,
    future: s.future,
    selectedModel: s.selectedModel,
    setSelectedModel: s.setSelectedModel,
    setNodes: s.setNodes,
    takeSnapshot: s.takeSnapshot,
  })));

  const { fitView, zoomIn, zoomOut, getZoom } = useReactFlow();

  const [isPending, startTransition] = useTransition();
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showHelpModal, setShowHelpModal] = useState(false);

  // Handle cinema auto layout (Shot lanes & DAG topological layout with smooth transition)
  const handleAutoLayout = useCallback(() => {
    takeSnapshot();
    const { nodes, edges } = useStore.getState();
    if (nodes.length === 0) return;

    // Whole-canvas tidy uses the production-stage rule (columns by role, rows by
    // segment); the DAG-lane engine stays behind the selection tidy button.
    const targetNodes = calculateStageLayout(nodes, edges);
    animateLayoutTransition(nodes, targetNodes, setNodes, 320, () => {
      fitView({ duration: 400, padding: 0.2 });
    });
  }, [takeSnapshot, setNodes, fitView]);

  useEffect(() => {
    const onTriggerAutoLayout = () => handleAutoLayout();
    window.addEventListener('triggerAutoLayout', onTriggerAutoLayout);
    return () => window.removeEventListener('triggerAutoLayout', onTriggerAutoLayout);
  }, [handleAutoLayout]);

  return (
    <>
    <ActiveJobBar />
    <JobSoundNotifier />
    <header className="fixed top-2.5 left-2 sm:left-4 right-2 sm:right-4 z-40 flex flex-wrap sm:flex-nowrap items-center justify-between pointer-events-none select-none gap-x-2 gap-y-1.5">
      {/* ── Left: Studio Brand & Project Info ──────────────── */}
      <div className="flex items-center gap-2 pointer-events-auto flex-shrink-0 max-w-full">
        <div
          className="flex items-center gap-2 sm:gap-2.5 px-2.5 sm:px-3.5 py-1.5 sm:py-2 rounded-xl max-w-full"
          style={{
            background: 'rgba(16, 16, 22, 0.85)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            boxShadow: '0 8px 28px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.1)',
          }}
        >
          {/* Logo & Brand Button (Settings Entry) */}
          <button
            type="button"
            onClick={() => setShowSettingsModal(true)}
            title={t('工作室系统设置 (点击打开)')}
            className="flex items-center gap-2 sm:gap-2.5 group/logo cursor-pointer focus:outline-none transition-transform active:scale-95"
          >
            {/* LAZA mark */}
            <LazaMark size={24} className="flex-shrink-0 group-hover/logo:scale-105 transition-transform" />

            <div className="hidden sm:flex flex-col text-left">
              <div className="flex items-center gap-1.5">
                <span className="text-[12px] sm:text-[13px] font-bold tracking-tight text-white group-hover/logo:text-zinc-200 transition-colors">
                  LAZA CINEMA STUDIO
                </span>
                {version && (
                  <span title={version.title} className="hidden md:inline font-mono text-[10px] text-zinc-500">{version.text}</span>
                )}
                <span className="text-[10px] text-zinc-500 group-hover/logo:text-zinc-300 transition-colors">
                  ⚙️
                </span>
              </div>
            </div>
          </button>

          <div className="w-px h-4 bg-white/10 mx-0.5" />

          {/* Project Switcher */}
          <ProjectSwitcher />

          {/* Quick New Project Button */}
          <button
            type="button"
            onClick={() => window.dispatchEvent(new Event('openProjectWizard'))}
            title={t('新建电影工程向导 (Ctrl+P)')}
            className="flex items-center gap-1 px-2 sm:px-2.5 h-7 rounded-lg text-xs font-medium text-zinc-300 hover:text-white bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] hover:border-white/15 transition-all cursor-pointer select-none active:scale-95"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span className="hidden xl:inline">{t('新建工程')}</span>
          </button>

        </div>
      </div>

      {/* ── Center: Engine Status HUD & Monitor ────────────── */}
      <div className="hidden md:flex items-center gap-2 pointer-events-auto flex-shrink-0">
        <div
          className="flex items-center gap-2 sm:gap-3 px-2.5 sm:px-3.5 py-1.5 sm:py-2 rounded-xl"
          style={{
            background: 'rgba(16, 16, 22, 0.85)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            boxShadow: '0 8px 28px rgba(0, 0, 0, 0.6)',
          }}
        >
          {/* Service Online Indicators: dropped first on narrow screens, the GPU stays */}
          <div className="hidden xl:flex items-center gap-2 sm:gap-3">
            <StatusBadge
              online={backendOnline}
              label="API"
              hint={backendOnline ? t('后端服务在线') : t('后端离线 — 请在终端启动 .\\start.ps1')}
            />
            <StatusBadge
              online={comfyuiOnline}
              label="ComfyUI"
              hint={comfyuiOnline ? t('ComfyUI 引擎在线') : t('ComfyUI 离线')}
            />
          </div>

          {/* VRAM & Hardware HUD (hidden on mobile, visible on tablet+) */}
          <div className="hidden md:flex items-center gap-2">
            <div className="hidden xl:block w-px h-3.5 bg-white/10" />
            <ResourceMonitor />
          </div>

        </div>
      </div>

      {/* ── Right: Studio Controls & AI Copilot ─────────────── */}
      <div className="flex items-center gap-1.5 sm:gap-2 pointer-events-auto flex-shrink-0 ml-auto sm:ml-0 max-w-full">
        <div
          className="flex items-center gap-0.5 sm:gap-1.5 px-1.5 sm:px-2.5 py-1 sm:py-1.5 rounded-xl max-w-full"
          style={{
            background: 'rgba(16, 16, 22, 0.85)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            boxShadow: '0 8px 28px rgba(0, 0, 0, 0.6)',
          }}
        >
          {/* Undo / Redo */}
          <HeaderButton
            onClick={undo}
            disabled={past.length === 0}
            icon={<UndoIcon />}
            label={t('撤销')}
            shortcut="Ctrl+Z"
            badge={past.length > 0 ? String(past.length) : undefined}
          />
          <HeaderButton
            onClick={redo}
            disabled={future.length === 0}
            icon={<RedoIcon />}
            label={t('重做')}
            shortcut="Ctrl+Y"
          />

          <div className="hidden sm:block w-px h-3.5 bg-white/10 mx-0.5" />

          {/* Auto Layout DAG */}
          <button
            onClick={handleAutoLayout}
            title={t('一键整理画布 (Shift+L / 按生产阶段分列：灰模→场景板→净帧→参考图→段落→对照)')}
            className="flex items-center gap-1 px-2 sm:px-2.5 h-7 rounded-lg text-xs font-medium text-zinc-300 hover:text-white bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] hover:border-white/15 transition-all cursor-pointer select-none active:scale-95"
          >
            <LayoutGridIcon />
            <span className="hidden xl:inline">{t('整理')}</span>
          </button>

          {/* Task list: running and queued nodes */}
          <TaskQueuePanel />

          {/* Fit View */}
          <button
            onClick={() => fitView({ duration: 400, padding: 0.2 })}
            title={t('聚焦全景 (Fit View [F])')}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-zinc-300 hover:text-white bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] hover:border-white/15 transition-all cursor-pointer active:scale-95"
          >
            <MaximizeIcon />
          </button>

          <div className="hidden sm:block w-px h-3.5 bg-white/10 mx-0.5" />

          {/* Storyboard Reel Toggle */}
          <button
            onClick={() => window.dispatchEvent(new Event('toggleAssetLibrary'))}
            title={t('打开素材库 (查看所有生成资源、引用情况与清理)')}
            className="flex items-center gap-1 px-2 sm:px-2.5 h-7 rounded-lg text-xs font-medium text-zinc-300 hover:text-white bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] hover:border-white/15 transition-all cursor-pointer select-none active:scale-95"
          >
            <LibraryIcon size={13} />
            <span className="hidden xl:inline">{t('素材库')}</span>
          </button>

          {/* Cut Room Toggle */}
          <button
            onClick={() => window.dispatchEvent(new Event('toggleCutRoom'))}
            title={t('打开剪辑台 (多轨时间线剪辑与成片导出)')}
            className="flex items-center gap-1 px-2 sm:px-2.5 h-7 rounded-lg text-xs font-medium text-zinc-300 hover:text-white bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] hover:border-white/15 transition-all cursor-pointer select-none active:scale-95"
          >
            <ScissorsIcon size={13} />
            <span className="hidden xl:inline">{t('剪辑台')}</span>
          </button>

          {/* H3 prompt handbook */}
          <button
            onClick={() => setShowHelpModal(true)}
            title={t('打开 H3 提示词手册 (运镜词表、台词标签、链式规则)')}
            className="flex items-center gap-1 px-2 sm:px-2.5 h-7 rounded-lg text-xs font-medium text-zinc-300 hover:text-white bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] transition-colors cursor-pointer"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
            <span className="hidden xl:inline">{t('手册')}</span>
          </button>

          <div className="hidden sm:block w-px h-3.5 bg-white/10 mx-0.5" />

          {/* Signed-in account: name, password change, 退出登录 */}
          <AccountMenu />
        </div>
      </div>

      {/* Studio Settings Modal */}
      <StudioSettingsModal
        isOpen={showSettingsModal}
        onClose={() => setShowSettingsModal(false)}
      />
      <H3HelpModal isOpen={showHelpModal} onClose={() => setShowHelpModal(false)} />
    </header>
    </>
  );
}

function StatusBadge({ online, label, hint }: { online: boolean; label: string; hint: string }) {
  return (
    <div className="flex items-center gap-1.5 cursor-help group" title={hint}>
      <span className="relative flex h-2 w-2">
        {online && (
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
        )}
        <span className={`relative inline-flex rounded-full h-2 w-2 ${online ? 'bg-emerald-400' : 'bg-rose-500'}`} />
      </span>
      <span className={`text-[11px] font-medium tracking-tight ${online ? 'text-zinc-300' : 'text-rose-400'}`}>
        {label}
      </span>
    </div>
  );
}

function ResourceMonitor() {
  const t = useT();
  const comfyuiOnline = useStore((s) => s.comfyuiOnline);
  const [stats, setStats] = useState<any>(null);
  const [history, setHistory] = useState<Awaited<ReturnType<typeof api.getVramHistory>> | null>(null);
  const [procs, setProcs] = useState<Awaited<ReturnType<typeof api.getVramProcesses>> | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  useEffect(() => {
    if (!historyOpen) return;
    let active = true;
    const load = () => {
      api.getVramHistory().then((h) => { if (active) setHistory(h); }).catch(() => {});
      api.getVramProcesses().then((p) => { if (active) setProcs(p); }).catch(() => { if (active) setProcs(null); });
    };
    load();
    const timer = setInterval(load, 10000);
    const close = () => setHistoryOpen(false);
    window.addEventListener('pointerdown', close);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener('pointerdown', close);
    };
  }, [historyOpen]);

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

  if (!comfyuiOnline || !stats || !stats.vram || stats.vram.length === 0) {
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-zinc-500 font-mono">
        <span>GPU: -</span>
      </div>
    );
  }

  const vram = stats.vram[0];
  const vramPct = Math.round(vram.vram_pct);
  const formatGB = (bytes: number) => (bytes / (1024 ** 3)).toFixed(1);

  const util = vram.gpu_util == null ? null : Math.round(vram.gpu_util);
  const temp = vram.gpu_temp == null ? null : Math.round(vram.gpu_temp);
  const utilColor = util != null && util > 90 ? 'text-amber-300' : 'text-zinc-300';
  const tempColor = temp == null ? 'text-zinc-300' : temp >= 83 ? 'text-rose-400' : temp >= 75 ? 'text-amber-300' : 'text-zinc-300';

  const barColor = vramPct > 85 ? 'bg-rose-500' : vramPct > 65 ? 'bg-amber-400' : 'bg-white/80';
  const textColor = vramPct > 85 ? 'text-rose-400' : vramPct > 65 ? 'text-amber-300' : 'text-zinc-300';

  return (
    <div
      className="relative flex items-center gap-2 cursor-pointer"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => setHistoryOpen((v) => !v)}
      title={`${vram.name}\n${t('显存')} (VRAM): ${formatGB(vram.vram_used)} GB / ${formatGB(vram.vram_total)} GB (${vramPct}%)` +
        (util != null ? `\n${t('GPU 使用率')}: ${util}%` : '') +
        (temp != null ? `\n${t('GPU 温度')}: ${temp}°C` : '')}
    >
      {util != null && (
        <span className="flex items-center gap-1">
          <span className="text-[11px] text-zinc-400 font-mono font-medium">GPU</span>
          <span className={`w-8 text-right text-[11px] font-mono font-semibold ${utilColor}`}>{util}%</span>
        </span>
      )}
      {temp != null && (
        <span className={`text-[11px] font-mono font-semibold ${tempColor}`}>{temp}°C</span>
      )}
      {(util != null || temp != null) && <div className="mx-0.5 h-3 w-px bg-white/10" />}
      <span className="text-[11px] text-zinc-400 font-mono font-medium">VRAM</span>
      <div className="w-16 h-2 bg-white/10 rounded-full overflow-hidden flex items-center p-[1px]">
        <div
          className={`h-full rounded-full transition-all duration-500 ${barColor}`}
          style={{ width: `${Math.min(100, Math.max(5, vramPct))}%` }}
        />
      </div>
      <span className={`text-[11px] font-mono font-semibold ${textColor}`}>
        {vramPct}%
      </span>
      {historyOpen && (
        <div className="absolute right-0 top-full mt-2 z-50 w-[380px] rounded-md border border-white/10 bg-zinc-900/95 p-3 text-[11px] font-mono text-zinc-300 shadow-lg">
          <div className="mb-2 text-zinc-400">{t('最近 1 小时显存')}</div>
          {!history || !history.samples || history.peak_used == null ? (
            <div className="text-zinc-500">{t('暂无数据')}</div>
          ) : (
            <>
              <div className="flex justify-between">
                <span>{t('生成时平均')}</span>
                {history.avg_used == null ? (
                  <span className="text-zinc-500">{t('无生成任务')}</span>
                ) : (
                  <span>{formatGB(history.avg_used)} GB ({Math.round(history.avg_used / (history.vram_total || 1) * 100)}%)</span>
                )}
              </div>
              {!!history.generating_s && (
                <div className="flex justify-between text-zinc-500">
                  <span>{t('生成时长')}</span>
                  <span>{Math.round(history.generating_s / 60)} min</span>
                </div>
              )}
              <div className="flex justify-between">
                <span>{t('峰值')}</span>
                <span>{formatGB(history.peak_used!)} GB ({Math.round(history.peak_used! / (history.vram_total || 1) * 100)}%)</span>
              </div>
              {history.peak_at && (
                <div className="flex justify-between text-zinc-500">
                  <span>{t('峰值时刻')}</span>
                  <span>{new Date(history.peak_at).toLocaleTimeString()}</span>
                </div>
              )}
              {(history.covered_s ?? 0) < history.window_s - 60 && (
                <div className="mt-1 text-zinc-500">
                  {t('仅覆盖 {m} 分钟（后端启动后开始记录）', { m: Math.round((history.covered_s ?? 0) / 60) })}
                </div>
              )}
              <div className="mt-1 text-zinc-500">{t('每 {s} 秒采样一次', { s: history.sample_s })}</div>
            </>
          )}
          {procs?.supported && (
            <div className="mt-3 border-t border-white/10 pt-2">
              <div className="mb-1 text-zinc-400">{t('谁在占显存（现在）')}</div>
              <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 gap-y-0.5">
                <span className="text-zinc-500">{t('进程')}</span>
                <span className="text-right text-zinc-500">{t('显存')}</span>
                <span className="text-right text-zinc-500">{t('溢出到共享')}</span>
                {procs.processes.map((p) => (
                  <React.Fragment key={p.pid}>
                    <span className="truncate" title={`PID ${p.pid}\n${p.cmd}${p.started ? `\n${t('启动于')} ${new Date(p.started).toLocaleString()}` : ''}`}>
                      {p.label} <span className="text-zinc-600">{p.pid}</span>
                    </span>
                    <span className="text-right">{formatGB(p.dedicated)} GB</span>
                    <span className={`text-right ${p.shared > 2 * 1024 ** 3 ? 'text-rose-400' : 'text-zinc-500'}`}>
                      {formatGB(p.shared)} GB
                    </span>
                  </React.Fragment>
                ))}
              </div>
              {procs.processes.some((p) => p.label === 'ComfyUI' && p.shared > 2 * 1024 ** 3) &&
                procs.processes.some((p) => p.label !== 'ComfyUI' && p.dedicated > 2 * 1024 ** 3) && (
                <div className="mt-1.5 leading-relaxed text-amber-300">
                  {t('ComfyUI 溢出到共享内存，同时有其他程序占着显存：渲染会明显变慢')}
                </div>
              )}
              <div className="mt-1 text-zinc-500">{t('鼠标停在进程名上看完整命令行')}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function HeaderButton({
  onClick,
  disabled,
  icon,
  label,
  shortcut,
  badge
}: {
  onClick: () => void;
  disabled: boolean;
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  badge?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={`${label} ${shortcut ? `(${shortcut})` : ''}`}
      className={`
        relative w-7 h-7 flex items-center justify-center rounded-lg transition-all
        ${disabled
          ? 'text-zinc-600 cursor-not-allowed opacity-40 border border-white/[0.04]'
          : 'text-zinc-300 hover:text-white bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] hover:border-white/15 active:scale-95 cursor-pointer'}
      `}
    >
      {icon}
      {badge && (
        <span className="absolute -top-1 -right-1 text-[8px] bg-white/20 border border-white/30 text-white px-1 rounded-full font-mono">
          {badge}
        </span>
      )}
    </button>
  );
}

function UndoIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7v6h6" />
      <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
    </svg>
  );
}

function RedoIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 7v6h-6" />
      <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 2.7" />
    </svg>
  );
}

function LayoutGridIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

function MaximizeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
    </svg>
  );
}


// Re-rendered on every canvas change before 2026-09-05; props are stable now.
export default React.memo(HeaderBar);
