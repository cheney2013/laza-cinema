'use client';

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { t, useT } from '@/lib/i18n';
import { useStore } from '@/lib/store';
import { useReactFlow } from '@xyflow/react';
import { DEFAULT_NODE_DIMENSIONS, DEFAULT_H3_STEPS } from '@/lib/types';
import { useBackdropDismiss } from '@/lib/useBackdropDismiss';
import { byUsage } from '@/lib/nodeRegistry';
import { useDisabledNodeTypes } from '@/lib/useDisabledNodeTypes';

interface PaletteItem {
  type: string;
  label: string;
  desc: string;
  category: 'image' | 'video' | '3d' | 'utility';
  icon: string;
  color: string;
  hotkey?: string;
  defaultData: Record<string, any>;
}

const PALETTE_ITEMS: PaletteItem[] = [
  {
    type: 'video',
    label: 'MiniMax H3 视频生成',
    desc: '基于关键帧生成带原生环境音效与对白的工业级视频',
    category: 'video',
    icon: '🎥',
    color: '#06b6d4',
    hotkey: 'V',
    defaultData: {
      prompt: '',
      generatedUrl: null,
      status: 'idle',
      width: 1376,
      height: 768,
      steps: DEFAULT_H3_STEPS,
      seed: -1,
      length: 124,
    },
  },
  {
    type: 'prompt',
    label: '提示词编排节点',
    desc: '结构化影视分镜提示词、角色别名与视觉描述',
    category: 'image',
    icon: '✍️',
    color: '#a855f7',
    hotkey: 'P',
    defaultData: { text: '' },
  },
  {
    type: 'audioGen',
    label: '配音 / 换音色',
    desc: 'H3 按台词和音色出音频；Seed-VC 保留台词节奏只换音色',
    category: 'video',
    icon: '🎙',
    color: '#f59e0b',
    hotkey: 'A',
    defaultData: { mode: 'speak', text: '', voiceDescription: '', delivery: '', generatedUrl: null, status: 'idle', length: 0, seed: 81000, seedMode: 'fixed', trimSilence: true, diffusionSteps: 30, semitoneShift: 0 },
  },
  {
    type: 'videoUpscale',
    label: '视频增强',
    desc: '提升视频分辨率与细节纹理，消除噪点与抖动',
    category: 'video',
    icon: '⚡',
    color: '#eab308',
    hotkey: 'U',
    defaultData: {
      generatedUrl: null,
      status: 'idle',
      width: 1376,
      height: 768,
      steps: 6,
      denoiseStrength: 0.25,
      seed: -1,
      targetFps: 0,
    },
  },
  {
    type: 'videoReshot',
    label: '重拍一段 · 前后不动',
    desc: '选中一段从头重拍，动作会变，前后不动',
    category: 'video',
    icon: '✂️',
    color: '#a78bfa',
    defaultData: {
      prompt: '',
      generatedUrl: null,
      status: 'idle',
      steps: 20,
      width: 1376,
      height: 768,
      seed: -1,
    },
  },
  {
    type: 'videoBridge',
    label: '重拍中间 · 两端冻住',
    desc: '前后冻住，只重做中间，衔接最稳',
    category: 'video',
    icon: '🧩',
    color: '#e879f9',
    defaultData: {
      prompt: '',
      generatedUrl: null,
      status: 'idle',
      steps: 20,
      width: 1376,
      height: 768,
      seed: -1,
    },
  },
  {
    type: 'videoEdit',
    label: '改原片 · 动作不变',
    desc: '原片当底，动作运镜声音不变，只改外观；可只改一段',
    category: 'video',
    icon: '🎭',
    color: '#c084fc',
    hotkey: 'E',
    defaultData: {
      prompt: '',
      generatedUrl: null,
      status: 'idle',
      audioStrategy: 'copy_source',
      steps: 4,
      width: 1376,
      height: 768,
      seed: -1,
    },
  },
  {
    type: 'videoContinue',
    label: '往后续拍',
    desc: '从原片结尾接着往下拍',
    category: 'video',
    icon: '⏭️',
    color: '#34d399',
    defaultData: {
      prompt: '',
      generatedUrl: null,
      status: 'idle',
      audioStrategy: 'copy_source',
      steps: 4,
      length: 124,
      width: 1376,
      height: 768,
      seed: -1,
    },
  },
  {
    type: 'videoFrames',
    label: '首尾帧补中间',
    desc: '给定首帧和尾帧，生成中间的镜头',
    category: 'video',
    icon: '🎞️',
    color: '#60a5fa',
    defaultData: {
      prompt: '',
      generatedUrl: null,
      status: 'idle',
      audioStrategy: 'copy_source',
      steps: 4,
      length: 124,
      width: 1376,
      height: 768,
      seed: -1,
    },
  },
  {
    type: 'inpaint',
    label: '局部重绘与微调',
    desc: '通过蒙版画笔对画面局部进行精准二次创作',
    category: 'image',
    icon: '🖌️',
    color: '#ec4899',
    hotkey: 'I',
    defaultData: {
      prompt: '',
      generatedUrl: null,
      status: 'idle',
      steps: 20,
      cfg: 4.0,
      seed: -1,
    },
  },
  {
    type: 'qwenImage',
    label: '生成图片',
    desc: '不接参考图就是文生图；接上参考图就是照着它改，最多十张，连线顺序就是 <image N>',
    category: 'image',
    icon: '🖼️',
    color: '#8b5cf6',
    hotkey: 'Q',
    defaultData: {
      prompt: '',
      negativePrompt: '',
      width: 1376,
      height: 768,
      steps: 25,
      cfg: 1.0,
      seed: 81000,
      seedMode: 'fixed',
      generatedUrl: null,
      status: 'idle',
    },
  },
  {
    type: 'depthVideo',
    label: '深度视频',
    desc: '把一段视频逐帧转成深度图视频（无声）：当运镜参考，或当 ControlNet 的控制视频',
    category: 'video',
    icon: '🌊',
    color: '#06b6d4',
    defaultData: {
      generatedUrl: null,
      status: 'idle',
      resolution: 518,
    },
  },
  {
    type: 'imageUpscale',
    label: '图片超清',
    desc: '接一张图，用 RealESRGAN 放大并补细节，画面内容不变',
    category: 'image',
    icon: '🔍',
    color: '#0ea5e9',
    defaultData: {
      modelName: 'RealESRGAN_x2.pth',
      targetLongEdge: 0,
      generatedUrl: null,
      status: 'idle',
    },
  },
  {
    type: 'titleBlock',
    label: '标题块',
    desc: '接字标素材，写一行小字，生成固定边距的透明标题块，可贴在封面左右两侧',
    category: 'image',
    icon: '🅃',
    color: '#f97316',
    defaultData: {
      line: 'FILM 1【中字】',
      blockHeight: 1536,
      margin: 104,
      contentWidth: 600,
      lineWidth: 800,
      lineHeightScale: 1.5,
      side: 'left',
      generatedUrl: null,
      status: 'idle',
    },
  },
  {
    type: 'characterSheet',
    label: '定妆照',
    desc: '写身份和服装，一次生成正面、侧面、背面和脸部特写',
    category: 'image',
    icon: '🧍',
    color: '#fbbf24',
    hotkey: 'C',
    defaultData: {
      generatedUrl: null,
      status: 'idle',
      identity: '',
      costume: '',
      subjectNoun: 'person',
      width: 768,
      height: 1376,
      steps: 4,
      seed: 81000,
      seedMode: 'fixed',
    },
  },
  {
    type: 'wardrobeSwap',
    label: '一键换装',
    desc: '人物原图与服装参考各接一张，不写提示词直接换衣',
    category: 'image',
    icon: '👗',
    color: '#f472b6',
    hotkey: 'W',
    defaultData: {
      generatedUrl: null,
      status: 'idle',
      width: 1024,
      height: 1024,
      steps: 8,
      guidance: 2.5,
      seed: 81000,
      seedMode: 'fixed',
      detail: '',
    },
  },
  {
    type: 'image',
    label: '素材上传资产',
    desc: '上传本地图片或参考视频并标记角色别名',
    category: 'utility',
    icon: '📁',
    color: '#ededed',
    hotkey: 'O',
    defaultData: { url: null },
  },
  {
    type: 'pose',
    label: '3D 姿态骨骼调整',
    desc: '3D 交互式调节人物姿态、骨骼与深度图',
    category: '3d',
    icon: '🧍',
    color: '#6366f1',
    hotkey: '3D',
    defaultData: {
      glbUrl: null,
      generatedUrl: null,
      status: 'idle',
      skeletonMode: 'openpose',
    },
  },
  {
    type: 'gaussian',
    label: '3D 高斯泼溅场景',
    desc: '加载 3DGS 点云场景并实时截图作为镜头构图输入',
    category: '3d',
    icon: '🧊',
    color: '#14b8a6',
    hotkey: 'GS',
    defaultData: {
      plyUrl: null,
      plyFilename: null,
      generatedUrl: null,
      status: 'idle',
    },
  },
  {
    type: 'gaussianViewer',
    label: '高斯查看',
    desc: '打开现成的 .ply（3DGS 或普通点云，如 GAE 输出），转着看、截图输出',
    category: '3d',
    icon: '👁',
    color: '#14b8a6',
    hotkey: 'GV',
    defaultData: {
      plyUrl: null,
      plyFilename: null,
      plyOriginalName: null,
      generatedUrl: null,
      status: 'idle',
    },
  },
];

const ORDERED_ITEMS = byUsage(PALETTE_ITEMS);

function QuickNodePalette({
  isOpen,
  onClose,
  spawnCoords,
}: {
  isOpen: boolean;
  onClose: () => void;
  spawnCoords?: { x: number; y: number } | null;
}) {
  const t = useT();
  const [search, setSearch] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const setNodes = useStore((s) => s.setNodes);
  const takeSnapshot = useStore((s) => s.takeSnapshot);
  const { getViewport } = useReactFlow();

  useEffect(() => {
    if (isOpen) {
      setSearch('');
      setSelectedIdx(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  const disabledTypes = useDisabledNodeTypes();
  const filteredItems = useMemo(() => {
    const available = ORDERED_ITEMS.filter((item) => !disabledTypes.has(item.type));
    if (!search.trim()) return available;
    const q = search.toLowerCase();
    return available.filter(
      (item) =>
        // both the source text and what is on screen, so a Japanese UI is searchable
        [item.label, item.desc, t(item.label), t(item.desc), item.type]
          .some((field) => field.toLowerCase().includes(q)) ||
        item.hotkey?.toLowerCase() === q
    );
  }, [search, t, disabledTypes]);

  // Handle spawn
  const spawnNode = (item: PaletteItem) => {
    takeSnapshot();
    let posX = 0;
    let posY = 0;

    if (spawnCoords) {
      posX = spawnCoords.x;
      posY = spawnCoords.y;
    } else {
      const { x, y, zoom } = getViewport();
      posX = (-x + window.innerWidth / 2) / zoom - 140;
      posY = (-y + window.innerHeight / 2) / zoom - 100;
    }

    const dims = DEFAULT_NODE_DIMENSIONS[item.type] || { width: 280, height: 280 };

    const newNode = {
      id: `${item.type}-${Date.now()}`,
      type: item.type,
      position: { x: posX, y: posY },
      width: dims.width,
      height: dims.height,
      data: { ...item.defaultData },
      selected: true,
    };

    const deselected = useStore.getState().nodes.map((n) => ({ ...n, selected: false }));
    setNodes([...deselected, newNode]);
    onClose();
  };

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx((prev) => (prev + 1 < filteredItems.length ? prev + 1 : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx((prev) => (prev - 1 >= 0 ? prev - 1 : filteredItems.length - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filteredItems[selectedIdx]) {
        spawnNode(filteredItems[selectedIdx]);
      }
    }
  };

  const dismiss = useBackdropDismiss(onClose);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-24 p-3 bg-black/60 backdrop-blur-sm animate-in fade-in duration-100"
      {...dismiss}
    >
      <div
        className="w-full max-w-xl rounded-2xl overflow-hidden flex flex-col pointer-events-auto border border-white/15 shadow-2xl"
        style={{
          background: 'rgba(16, 16, 24, 0.96)',
          backdropFilter: 'blur(32px)',
          WebkitBackdropFilter: 'blur(32px)',
          boxShadow: '0 24px 60px rgba(0, 0, 0, 0.9), inset 0 1px 0 rgba(255, 255, 255, 0.2)',
        }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Search Input Bar */}
        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-white/10 bg-white/[0.02]">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="text-zinc-400">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            className="flex-1 bg-transparent border-none outline-none text-sm text-white placeholder-zinc-500 font-medium"
            placeholder={t('搜索节点名称、类型或按快捷键回车创建...')}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setSelectedIdx(0);
            }}
          />
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-black/50 text-zinc-400 font-mono border border-white/10">
            
            {t('ESC 关闭')}
          </span>
        </div>

        {/* Node Results List */}
        <div className="p-2 max-h-[360px] overflow-y-auto space-y-1 no-scrollbar">
          {filteredItems.length === 0 ? (
            <div className="py-8 text-center text-xs text-zinc-500">
              
              {t('未找到匹配的影视节点')}
            </div>
          ) : (
            filteredItems.map((item, idx) => {
              const isSelected = idx === selectedIdx;

              return (
                <div
                  key={item.type}
                  onClick={() => spawnNode(item)}
                  onMouseEnter={() => setSelectedIdx(idx)}
                  className={`
                    px-3.5 py-2.5 rounded-xl transition-all cursor-pointer flex items-center justify-between group
                    ${
                      isSelected
                        ? 'bg-white/[0.08] border border-white/25 shadow-md shadow-black/50 text-white'
                        : 'bg-transparent hover:bg-white/[0.04] border border-transparent'
                    }
                  `}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className="w-8 h-8 rounded-xl flex items-center justify-center text-base shadow-inner border border-white/10 bg-white/[0.06]"
                    >
                      {item.icon}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-white tracking-wide">
                          {t(item.label)}
                        </span>
                        <span className="text-[10px] text-zinc-500 font-mono">
                          {item.type}
                        </span>
                      </div>
                      <p className="text-[11px] text-zinc-400 mt-0.5">
                        {t(item.desc)}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {item.hotkey && (
                    <span className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-zinc-400 group-hover:text-white">
                      {item.hotkey}
                    </span>
                    )}
                    {isSelected && (
                      <span className="text-xs text-white/80 font-bold">↵</span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

// Re-rendered on every canvas change before 2026-09-05; props are stable now.
export default React.memo(QuickNodePalette);
