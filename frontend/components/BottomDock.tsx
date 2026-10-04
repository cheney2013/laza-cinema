'use client';

import React, { useState, useRef, useEffect } from 'react';
import { useT } from '@/lib/i18n';
import { useReactFlow } from '@xyflow/react';
import { useStore } from '@/lib/store';
import { byUsage } from '@/lib/nodeRegistry';
import { useDisabledNodeTypes } from '@/lib/useDisabledNodeTypes';
import { DEFAULT_NODE_DIMENSIONS, DEFAULT_H3_STEPS } from '@/lib/types';

interface ToolItem {
  type: string;
  label: string;
  hotkey: string;
  category: 'text' | 'image' | 'video' | 'motion' | '3d' | 'utility';
  icon: React.ReactNode;
  data: Record<string, any>;
  color: string;
}

/**
 * The dock button is 40px wide, so the label under the icon is a two-character
 * abbreviation. Slicing works for Chinese, where two characters are a word, and
 * not for Japanese, where "プロンプト".slice(0, 2) is "プロ". A locale that needs
 * its own abbreviation supplies one under the `<label>#short` key; anything with
 * no entry keeps the slice.
 */
function shortLabel(t: (s: string) => string, label: string): string {
  const key = `${label}#short`;
  const short = t(key);
  return short === key ? t(label).slice(0, 2) : short;
}

function BottomDock() {
  const t = useT();
  const setNodes = useStore((s) => s.setNodes);
  const takeSnapshot = useStore((s) => s.takeSnapshot);
  const selectedModel = useStore((s) => s.selectedModel);
  const { screenToFlowPosition, getViewport } = useReactFlow();

  // Spawn node in the center of the current viewport
  const spawnNode = (type: string, data: Record<string, any>) => {
    takeSnapshot();
    const { x, y, zoom } = getViewport();
    // Calculate center of screen in flow coordinates
    const centerX = (-x + window.innerWidth / 2) / zoom - 140;
    const centerY = (-y + window.innerHeight / 2) / zoom - 100;

    // Small jitter to prevent exact overlapping if spawning multiple
    const jitterX = (Math.random() - 0.5) * 40;
    const jitterY = (Math.random() - 0.5) * 40;

    const dims = DEFAULT_NODE_DIMENSIONS[type] || { width: 280, height: 280 };

    const newNode = {
      id: `${type}-${Date.now()}`,
      type,
      position: { x: centerX + jitterX, y: centerY + jitterY },
      width: dims.width,
      height: dims.height,
      data,
      selected: true,
    };

    // Deselect existing
    const updatedNodes = useStore.getState().nodes.map(n => ({ ...n, selected: false }));
    setNodes([...updatedNodes, newNode]);
  };

  const disabledTypes = useDisabledNodeTypes();
  const tools: ToolItem[] = [
      {
      type: 'video',
      label: '视频',
      hotkey: 'V',
      category: 'video',
      color: '#ededed',
      icon: (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400 group-hover:text-white transition-colors">
          <polygon points="23 7 16 12 23 17 23 7" />
          <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
        </svg>
      ),
      data: { prompt: '', generatedUrl: null, status: 'idle', width: 1376, height: 768, steps: DEFAULT_H3_STEPS, seed: -1, length: 124 },
    },
    {
      type: 'prompt',
      label: '提示词',
      hotkey: 'P',
      category: 'text',
      color: '#ededed',
      icon: (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400 group-hover:text-white transition-colors">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
      ),
      data: { text: '' },
    },
    {
      type: 'inpaint',
      label: '重绘',
      hotkey: 'I',
      category: 'image',
      color: '#ededed',
      icon: (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400 group-hover:text-white transition-colors">
          <path d="M18.375 2.625a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.375-9.375z" />
        </svg>
      ),
      data: { prompt: '', generatedUrl: null, status: 'idle', steps: 20, cfg: 4.0, seed: -1 },
    },
    {
      type: 'characterSheet',
      label: '定妆',
      hotkey: 'C',
      category: 'image',
      color: '#fbbf24',
      icon: <span className="text-sm grayscale group-hover:grayscale-0 transition-all">🧍</span>,
      data: { generatedUrl: null, status: 'idle', identity: '', costume: '', subjectNoun: 'person', width: 768, height: 1376, steps: 4, seed: 81000, seedMode: 'fixed' },
    },
    {
      type: 'wardrobeSwap',
      label: '换装',
      hotkey: 'W',
      category: 'image',
      color: '#f472b6',
      icon: <span className="text-sm grayscale group-hover:grayscale-0 transition-all">👗</span>,
      data: { generatedUrl: null, status: 'idle', width: 1024, height: 1024, steps: 8, guidance: 2.5, seed: 81000, seedMode: 'fixed', detail: '' },
    },
    {
      type: 'audioGen',
      label: '配音',
      hotkey: 'A',
      category: 'video',
      color: '#f59e0b',
      icon: <span className="text-sm grayscale group-hover:grayscale-0 transition-all">🎙</span>,
      data: { mode: 'speak', text: '', voiceDescription: '', delivery: '', generatedUrl: null, status: 'idle', length: 0, seed: 81000, seedMode: 'fixed', trimSilence: true, diffusionSteps: 30, semitoneShift: 0 },
    },
    {
      type: 'videoUpscale',
      label: '超分',
      hotkey: 'U',
      category: 'utility',
      color: '#ededed',
      icon: (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400 group-hover:text-white transition-colors">
          <path d="M6 3v12M18 9v12M6 3l4 4M6 3L2 7M18 21l4-4M18 21l-4-4" />
        </svg>
      ),
      data: { generatedUrl: null, status: 'idle', width: 1376, height: 768, steps: 6, denoiseStrength: 0.25, seed: -1, targetFps: 0, length: 0 },
    },
    {
      type: 'pose',
      label: '3D姿态',
      hotkey: '3D',
      category: '3d',
      color: '#ededed',
      icon: (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400 group-hover:text-white transition-colors">
          <circle cx="12" cy="5" r="2" />
          <path d="M12 7v7m-4-4l4-3 4 3m-6 9l2-5 2 5" />
        </svg>
      ),
      data: { glbUrl: null, generatedUrl: null, status: 'idle', skeletonMode: 'openpose' },
    },
    {
      type: 'gaussian',
      label: '3D高斯',
      hotkey: 'GS',
      category: '3d',
      color: '#ededed',
      icon: (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400 group-hover:text-white transition-colors">
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
          <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
          <line x1="12" y1="22.08" x2="12" y2="12" />
        </svg>
      ),
      data: { plyUrl: null, plyFilename: null, plyOriginalName: null, generatedUrl: null, status: 'idle' },
    },
    {
      type: 'gaussianViewer',
      label: '高斯查看',
      hotkey: 'GV',
      category: '3d',
      color: '#ededed',
      icon: (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400 group-hover:text-white transition-colors">
          <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      ),
      data: { plyUrl: null, plyFilename: null, plyOriginalName: null, generatedUrl: null, status: 'idle' },
    },
    {
      type: 'image',
      label: '素材',
      hotkey: '+',
      category: 'utility',
      color: '#ededed',
      icon: (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400 group-hover:text-white transition-colors">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
        </svg>
      ),
      data: { url: null },
    },
  ];

  return (
    <div 
      className="fixed bottom-2.5 sm:bottom-5 left-1/2 -translate-x-1/2 z-30 flex flex-col items-center gap-1.5 sm:gap-2 pointer-events-auto select-none max-w-[calc(100vw-16px)] px-1"
    >
      {/* ── Bottom Creation Toolbar (Higgsfield Dock) ──────── */}
      <div 
        className="flex items-center gap-1 p-1 sm:p-1.5 rounded-2xl glass-dock max-w-full overflow-x-auto overscroll-x-contain shadow-2xl max-sm:[mask-image:linear-gradient(to_right,#000_calc(100%-26px),transparent)]"
        style={{
          background: 'rgba(14, 14, 18, 0.92)',
          backdropFilter: 'blur(24px)',
          WebkitBackdropFilter: 'blur(24px)',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          boxShadow: '0 16px 40px rgba(0, 0, 0, 0.7), inset 0 1px 0 rgba(255, 255, 255, 0.12)',
          scrollbarWidth: 'none',
        }}
        onWheel={(e) => {
          if (e.deltaY !== 0) {
            e.currentTarget.scrollLeft += e.deltaY;
          }
        }}
      >
        {/* Node Creation Tool Buttons */}
        <div className="flex items-center gap-0.5 sm:gap-1 flex-nowrap">
          {byUsage(tools).filter((tool) => !disabledTypes.has(tool.type)).map((tool) => (
            <button
              key={tool.type}
              onClick={() => spawnNode(tool.type, tool.data)}
              title={t('添加 {label} 节点', { label: t(tool.label) })}
              className="group relative flex flex-col items-center justify-center w-8 sm:w-10 h-8 sm:h-10 rounded-xl bg-white/[0.03] hover:bg-white/[0.1] border border-white/[0.04] hover:border-white/[0.15] transition-all duration-200 active:scale-95 cursor-pointer flex-shrink-0"
            >
              <div className="transition-transform group-hover:scale-110">
                {tool.icon}
              </div>
              <span className="hidden sm:inline text-[9px] text-zinc-400 group-hover:text-zinc-200 font-medium tracking-tight mt-0.5 scale-90">
                {shortLabel(t, tool.label)}
              </span>

              {/* Floating Tooltip */}
              <div className="absolute -top-9 opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity duration-150 px-2 py-1 rounded-md bg-zinc-900 border border-white/10 text-[10px] text-zinc-200 whitespace-nowrap shadow-xl z-50">
                {t(tool.label)}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// Re-rendered on every canvas change before 2026-09-05; props are stable now.
export default React.memo(BottomDock);
