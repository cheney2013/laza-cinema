'use client';

import React, { useEffect, useState } from 'react';
import { t, useT } from '@/lib/i18n';
import LocaleSwitch from './LocaleSwitch';
import { createPortal } from 'react-dom';
import { useStore, StudioSettings } from '@/lib/store';
import { useBackdropDismiss } from '@/lib/useBackdropDismiss';

interface StudioSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function StudioSettingsModal({ isOpen, onClose }: StudioSettingsModalProps) {
  const t = useT();
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const backendOnline = useStore((s) => s.backendOnline);
  const comfyuiOnline = useStore((s) => s.comfyuiOnline);
  const currentProjectName = useStore((s) => s.currentProjectName);
  const currentProjectId = useStore((s) => s.currentProjectId);

  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const dismiss = useBackdropDismiss(onClose);

  if (!isOpen || !mounted) return null;

  const handleToggle = (key: keyof StudioSettings) => {
    updateSettings({ [key]: !settings[key] });
  };

  const modalContent = (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 pointer-events-auto select-auto">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/80 backdrop-blur-md transition-opacity animate-in fade-in duration-200 pointer-events-auto cursor-pointer"
        {...dismiss}
      />

      {/* Modal Container */}
      <div
        className="relative w-full max-w-xl bg-[#101016]/95 border border-white/10 rounded-2xl shadow-2xl overflow-hidden z-10 animate-in fade-in zoom-in-95 duration-200"
        style={{
          boxShadow: '0 20px 60px rgba(0, 0, 0, 0.8), inset 0 1px 0 rgba(255, 255, 255, 0.1)',
        }}
      >
        {/* Header */}
        <div className="px-6 py-4.5 border-b border-white/[0.08] flex items-center justify-between bg-white/[0.02]">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-white/10 border border-white/15 shadow-inner flex items-center justify-center text-white">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                <path
                  d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <div>
              <h2 className="text-sm font-semibold text-white tracking-wide flex items-center gap-2">
                <span>{t('工作室系统设置')}</span>
                <span className="text-[10px] font-mono font-normal text-zinc-300 bg-white/10 px-2 py-0.5 rounded-full border border-white/15">
                  Studio Settings
                </span>
              </h2>
              <p className="text-[11px] text-zinc-400">{t('配置视频播放偏好、自动化行为与工作室全局属性')}</p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg text-zinc-400 hover:text-white hover:bg-white/10 flex items-center justify-center transition-colors cursor-pointer"
            title={t('关闭设置 (Esc)')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Body Content */}
        <div className="p-6 space-y-5 max-h-[70vh] overflow-y-auto no-scrollbar">
          {/* Section: Interface language */}
          <div className="space-y-3.5">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-200">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="text-zinc-400">
                <circle cx="12" cy="12" r="10" />
                <path d="M2 12h20M12 2a15.3 15.3 0 0 1 0 20a15.3 15.3 0 0 1 0-20z" />
              </svg>
              <span>{t('界面语言')}</span>
            </div>
            <div className="flex items-center justify-between gap-4 p-3.5 rounded-xl bg-white/[0.03] border border-white/[0.07]">
              <p className="text-[11px] text-zinc-400 leading-relaxed">
                
                {t('切换界面语言，选择会记在这台设备上。')}
              </p>
              <LocaleSwitch className="flex-shrink-0" />
            </div>
          </div>

          {/* Section: Video Playback & Audio Preferences */}
          <div className="space-y-3.5">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-200">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="text-zinc-400">
                <rect x="2" y="4" width="14" height="16" rx="2" />
                <path d="M16 8l6-3v14l-6-3V8z" />
              </svg>
              <span>{t('视频播放与视听体验偏好')}</span>
            </div>

            <div className="space-y-2.5">
              {/* Autoplay on complete */}
              <div
                onClick={() => handleToggle('autoplayOnComplete')}
                className="flex items-start justify-between p-3.5 rounded-xl bg-white/[0.03] hover:bg-white/[0.05] border border-white/[0.07] transition-all cursor-pointer select-none group"
              >
                <div className="space-y-1 pr-4">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-white group-hover:text-zinc-100 transition-colors">
                      
                      {t('视频生成完成后自动播放')}
                    </span>
                    <span className="text-[9px] font-mono text-zinc-500 bg-black/40 px-1.5 py-0.5 rounded border border-white/5">
                      autoplayOnComplete
                    </span>
                  </div>
                  <p className="text-[11px] text-zinc-400 leading-relaxed">
                    {settings.autoplayOnComplete
                      ? t('开启状态：当 AI 视频生成、编辑或插帧完成后，自动切换为播放预览模式并开始播放。')
                      : t('关闭状态：视频生成完成后保持静止暂停状态，等待手动点击播放。')}
                  </p>
                </div>

                {/* Switch Toggle */}
                <div
                  className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border border-white/10 transition-colors duration-200 ease-in-out focus:outline-none ${
                    settings.autoplayOnComplete ? 'bg-white' : 'bg-white/10'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`pointer-events-none inline-block h-3.5 w-3.5 m-[2px] transform rounded-full shadow transition duration-200 ease-in-out ${
                      settings.autoplayOnComplete ? 'translate-x-4 bg-black' : 'translate-x-0 bg-zinc-400'
                    }`}
                  />
                </div>
              </div>

              {/* Setting 3: Unmute on complete */}
              <div
                onClick={() => handleToggle('unmuteOnComplete')}
                className="flex items-start justify-between p-3.5 rounded-xl bg-white/[0.03] hover:bg-white/[0.05] border border-white/[0.07] transition-all cursor-pointer select-none group"
              >
                <div className="space-y-1 pr-4">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-white group-hover:text-zinc-100 transition-colors">
                      
                      {t('生成完成后非静音播放（自动开启原声音效）')}
                    </span>
                    <span className="text-[9px] font-mono text-zinc-500 bg-black/40 px-1.5 py-0.5 rounded border border-white/5">
                      unmuteOnComplete
                    </span>
                  </div>
                  <p className="text-[11px] text-zinc-400 leading-relaxed">
                    {settings.unmuteOnComplete
                      ? t('开启状态：视频生成完成自动播放时，自动独占开启声音通道，立即听到配音与原生音效。')
                      : t('关闭状态：视频生成完成自动播放时保持静音，需要手动点击喇叭图标开启声音。')}
                  </p>
                </div>

                {/* Switch Toggle */}
                <div
                  className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border border-white/10 transition-colors duration-200 ease-in-out focus:outline-none ${
                    settings.unmuteOnComplete ? 'bg-white' : 'bg-white/10'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`pointer-events-none inline-block h-3.5 w-3.5 m-[2px] transform rounded-full shadow transition duration-200 ease-in-out ${
                      settings.unmuteOnComplete ? 'translate-x-4 bg-black' : 'translate-x-0 bg-zinc-400'
                    }`}
                  />
                </div>
              </div>
              {/* Setting 4: Sound notification for renders */}
              <div
                onClick={() => handleToggle('soundNotifyJobs')}
                className="flex items-start justify-between p-3.5 rounded-xl bg-white/[0.03] hover:bg-white/[0.05] border border-white/[0.07] transition-all cursor-pointer select-none group"
              >
                <div className="space-y-1 pr-4">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-white group-hover:text-zinc-100 transition-colors">
                      
                      {t('生成任务声音提醒')}
                    </span>
                    <span className="text-[9px] font-mono text-zinc-500 bg-black/40 px-1.5 py-0.5 rounded border border-white/5">
                      soundNotifyJobs
                    </span>
                  </div>
                  <p className="text-[11px] text-zinc-400 leading-relaxed">
                    {settings.soundNotifyJobs
                      ? t('开启状态：本项目的任务开始时语音播报预计耗时，结束时播放提示音（成功上扬、失败下降）。')
                      : t('关闭状态：任务开始和结束都不发声。')}
                  </p>
                </div>

                {/* Switch Toggle */}
                <div
                  className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border border-white/10 transition-colors duration-200 ease-in-out focus:outline-none ${
                    settings.soundNotifyJobs ? 'bg-white' : 'bg-white/10'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`pointer-events-none inline-block h-3.5 w-3.5 m-[2px] transform rounded-full shadow transition duration-200 ease-in-out ${
                      settings.soundNotifyJobs ? 'translate-x-4 bg-black' : 'translate-x-0 bg-zinc-400'
                    }`}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Section: Project & Engine Info */}
          <div className="pt-2 border-t border-white/[0.08] space-y-3">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-200">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="text-cyan-400">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              <span>{t('工作室运行状态与当前工程')}</span>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.05] space-y-1">
                <span className="text-[10px] text-zinc-500 font-mono">{t('当前电影工程')}</span>
                <p className="text-white font-medium truncate">{currentProjectName || t('未命名项目')}</p>
                <span className="text-[9px] font-mono text-zinc-600 truncate block">
                  ID: {currentProjectId || 'default'}
                </span>
              </div>

              <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.05] space-y-1.5">
                <span className="text-[10px] text-zinc-500 font-mono">{t('后台推理引擎')}</span>
                <div className="flex items-center gap-3">
                  <span className="flex items-center gap-1.5 text-[11px]">
                    <span className={`w-2 h-2 rounded-full ${backendOnline ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5)]' : 'bg-red-400'}`} />
                    <span className="text-zinc-300">API</span>
                  </span>
                  <span className="flex items-center gap-1.5 text-[11px]">
                    <span className={`w-2 h-2 rounded-full ${comfyuiOnline ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5)]' : 'bg-red-400'}`} />
                    <span className="text-zinc-300">ComfyUI</span>
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-white/[0.08] flex items-center justify-between bg-white/[0.02]">
          <span className="text-[10px] text-zinc-500 font-mono flex items-center gap-1">
            <span>💾</span>
            <span>{t('设置自动保存至本地浏览器存储')}</span>
          </span>

          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-semibold border border-white/15 transition-all cursor-pointer active:scale-95 shadow-sm"
          >
            
            {t('完成')}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
}
