'use client';

import React, { useState, useEffect, memo } from 'react';
import { t } from '@/lib/i18n';

export type SeedMode = 'fixed' | 'random';

export interface SeedControlProps {
  seed: number | undefined;
  seedMode?: SeedMode;
  onChange: (newSeed: number, newMode: SeedMode) => void;
  className?: string;
  compact?: boolean;
  label?: string;
  defaultSeed?: number;
}

export function resolveSeedForGeneration(
  currentSeed: number | undefined,
  seedMode: SeedMode | undefined,
  defaultSeed = 81000
): { effectiveSeed: number; nextSeedToStore: number } {
  const mode = seedMode || 'fixed';
  if (mode === 'random') {
    const rolled = Math.floor(Math.random() * 2147483647);
    return { effectiveSeed: rolled, nextSeedToStore: rolled };
  }
  const fixed = currentSeed !== undefined && currentSeed >= 0 ? currentSeed : defaultSeed;
  return { effectiveSeed: fixed, nextSeedToStore: fixed };
}

export const SeedControl = memo(function SeedControl({
  seed,
  seedMode = 'fixed',
  onChange,
  className = '',
  compact = false,
  label = t('随机种子 (Seed)'),
  defaultSeed = 81000,
}: SeedControlProps) {
  const currentSeedValue = seed !== undefined && seed >= 0 ? seed : defaultSeed;
  const [localSeedInput, setLocalSeedInput] = useState<string>(String(currentSeedValue));

  useEffect(() => {
    setLocalSeedInput(String(seed !== undefined && seed >= 0 ? seed : defaultSeed));
  }, [seed, defaultSeed]);

  const handleModeChange = (newMode: SeedMode) => {
    onChange(currentSeedValue, newMode);
  };

  const handleRollRandom = (e: React.MouseEvent) => {
    e.stopPropagation();
    const newSeed = Math.floor(Math.random() * 2147483647);
    setLocalSeedInput(String(newSeed));
    onChange(newSeed, seedMode);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value.replace(/[^\d]/g, '');
    setLocalSeedInput(val);
    const parsed = parseInt(val, 10);
    if (!isNaN(parsed) && parsed >= 0) {
      onChange(parsed, seedMode);
    }
  };

  const handleBlur = () => {
    const parsed = parseInt(localSeedInput, 10);
    if (isNaN(parsed) || parsed < 0) {
      setLocalSeedInput(String(defaultSeed));
      onChange(defaultSeed, seedMode);
    } else {
      onChange(parsed, seedMode);
    }
  };

  if (compact) {
    return (
      <div className={`flex items-center justify-between gap-1.5 text-xs ${className}`}>
        <div className="flex items-center gap-1 min-w-0">
          <span className="text-[10px] text-zinc-400 font-mono flex items-center gap-1 truncate">
            <span>🎲</span>
            <span>{t('种子')}</span>
          </span>
          <div className="flex bg-white/[0.04] p-0.5 rounded-md border border-white/[0.08] text-[9px] font-mono">
            <button
              type="button"
              onClick={() => handleModeChange('fixed')}
              className={`px-1.5 py-0.5 rounded cursor-pointer transition-colors ${
                seedMode === 'fixed'
                  ? 'bg-white/20 text-white font-semibold shadow-xs'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
              title={t('固定种子：每次生成使用固定种子数值')}
            >
              
              {t('固定')}
            </button>
            <button
              type="button"
              onClick={() => handleModeChange('random')}
              className={`px-1.5 py-0.5 rounded cursor-pointer transition-colors ${
                seedMode === 'random'
                  ? 'bg-white/20 text-white font-semibold shadow-xs'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
              title={t('随机种子：每次点击生成时自动换新种子')}
            >
              
              {t('随机')}
            </button>
          </div>
        </div>

        <div className="flex items-center gap-1 flex-1 max-w-[130px] justify-end">
          <input
            type="text"
            value={seedMode === 'random' ? t('🎲 自动随机') : localSeedInput}
            disabled={seedMode === 'random'}
            onChange={handleInputChange}
            onBlur={handleBlur}
            className={`w-full text-right font-mono text-[10px] px-1.5 py-0.5 rounded-md border outline-none transition-colors ${
              seedMode === 'random'
                ? 'bg-white/[0.02] border-white/5 text-zinc-400 cursor-default'
                : 'bg-white/[0.04] border-white/10 text-zinc-200 focus:border-white/30 focus:bg-white/[0.08]'
            }`}
            placeholder={t('种子数值')}
            title={seedMode === 'random' ? t('每次生成自动掷新随机种子') : t('当前固定种子数值')}
          />
          <button
            type="button"
            onClick={handleRollRandom}
            className="p-1 rounded-md bg-white/[0.04] hover:bg-white/[0.1] border border-white/10 text-zinc-300 hover:text-white transition-colors cursor-pointer text-[10px] flex-shrink-0"
            title={t('手动重摇一个新种子数值')}
          >
            🎲
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`space-y-1.5 ${className}`}>
      <div className="flex items-center justify-between text-[10px] text-zinc-400 font-medium">
        <span className="flex items-center gap-1">
          <span>🎲</span>
          <span>{label}</span>
        </span>
        <div className="flex bg-white/[0.04] p-0.5 rounded-lg border border-white/[0.08] text-[9px] font-mono">
          <button
            type="button"
            onClick={() => handleModeChange('fixed')}
            className={`px-2 py-0.5 rounded-md cursor-pointer transition-colors ${
              seedMode === 'fixed'
                ? 'bg-white/20 text-white font-semibold shadow-xs'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
            title={t('固定模式：每次点击生成使用下方填写的种子')}
          >
            
            {t('🔒 固定')}
          </button>
          <button
            type="button"
            onClick={() => handleModeChange('random')}
            className={`px-2 py-0.5 rounded-md cursor-pointer transition-colors ${
              seedMode === 'random'
                ? 'bg-white/20 text-white font-semibold shadow-xs'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
            title={t('随机模式：每次点击生成时自动换新种子')}
          >
            
            {t('🎲 随机')}
          </button>
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <div className="relative flex-1">
          <input
            type="text"
            value={seedMode === 'random' ? t('每次生成自动随机换新') : localSeedInput}
            disabled={seedMode === 'random'}
            onChange={handleInputChange}
            onBlur={handleBlur}
            className={`w-full font-mono text-xs px-2.5 py-1.5 rounded-lg border outline-none transition-colors ${
              seedMode === 'random'
                ? 'bg-white/[0.02] border-white/5 text-zinc-400 cursor-default'
                : 'bg-white/[0.04] border-white/10 text-zinc-200 focus:border-white/30 focus:bg-white/[0.08]'
            }`}
            placeholder={t('输入种子数值')}
            title={seedMode === 'random' ? t('每次生成自动掷新随机种子') : t('当前固定种子数值')}
          />
        </div>
        <button
          type="button"
          onClick={handleRollRandom}
          className="px-2.5 py-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.1] border border-white/10 text-zinc-300 hover:text-white transition-colors cursor-pointer text-xs flex items-center gap-1"
          title={t('手动重摇一个新种子数值')}
        >
          <span>🎲</span>
          <span>{t('重摇')}</span>
        </button>
      </div>
      <div className="text-[9px] text-zinc-500 font-mono flex justify-between px-0.5">
        <span>{seedMode === 'fixed' ? t('模式：固定种子（可重现）') : t('模式：生成时自动随机（探索）')}</span>
        {seedMode === 'random' && seed !== undefined && seed >= 0 && (
          <span className="text-purple-400/80">{t('上次种子:')} {seed}</span>
        )}
      </div>
    </div>
  );
});
