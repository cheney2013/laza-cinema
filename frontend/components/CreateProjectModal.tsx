'use client';

import { LazaMark } from './Logo';
import { userScopedKey } from '@/lib/auth';
import { withoutRetiredNodes } from '@/lib/nodeRegistry';
import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '@/lib/store';
import { api } from '@/lib/api';
import { cacheCanvas, safeSetItem } from '@/lib/canvasCache';
import { useReactFlow } from '@xyflow/react';
import { showAlert } from '@/components/ui/Dialog';
import { DEFAULT_H3_STEPS } from '@/lib/types';
import { t } from '@/lib/i18n';

// ── Aspect Ratio Presets ───────────────────────────────────────────────────────
const ASPECT_RATIOS = [
  {
    id: '16:9',
    label: '16:9 影院宽银幕',
    sublabel: '横屏电影 / 影视短片工业标准',
    w: 1376,
    h: 768,
    previewRatio: 'aspect-[16/9]',
    desc: 'MiniMax H3 默认最佳工业画幅，极佳的横向推轨运镜与大景别史诗表现力。',
  },
  {
    id: '9:16',
    label: '9:16 竖屏短视频',
    sublabel: '抖音 / TikTok / 小红书 / 短剧',
    w: 768,
    h: 1376,
    previewRatio: 'aspect-[9/16]',
    desc: '专为移动端竖屏短剧设计，人物肖像与高动态全身动效极具视觉冲击。',
  },
  {
    id: '21:9',
    label: '21:9 宽银幕变形镜头',
    sublabel: '院线史诗大片 / 变形宽画幅',
    w: 1536,
    h: 640,
    previewRatio: 'aspect-[21/9]',
    desc: '最强烈的电影沉浸感与变形镜头光晕质感，适合科幻巨制与大场面战争题材。',
  },
  {
    id: '1:1',
    label: '1:1 正方形画幅',
    sublabel: '概念设计 / 角色设定 / 社交封面',
    w: 1024,
    h: 1024,
    previewRatio: 'aspect-square',
    desc: '居中对称构图，适合人物立绘、三视图原画与单镜头概念艺术。',
  },
  {
    id: '4:3',
    label: '4:3 经典复古胶片',
    sublabel: 'IMAX 经典胶片 / 文艺片',
    w: 1152,
    h: 864,
    previewRatio: 'aspect-[4/3]',
    desc: '浓郁胶片电影氛围，纵深感强，适合剧情对白与写实故事片。',
  },
];

const RANDOM_TITLES = [
  '异星觉醒 · 概念先导片 EP01',
  '赛博雨夜 · 霓虹追踪',
  '古风武侠 · 竹林对决',
  '星际漫游 · 遗落空间站',
  '末日废土 · 钢铁绿洲',
  '深海回响 · 机械巨兽',
  '都市夜幕 · 暗影特工',
  '量子裂变 · 最后的倒计时',
];

// ── Starter Workflow Templates ────────────────────────────────────────────────
interface WorkflowTemplate {
  id: string;
  name: string;
  badge: string;
  badgeColor: string;
  icon: string;
  desc: string;
  nodesSummary: string[];
  tags: string[];
  aspectRatio: string;
  buildGraph: (projName: string, ratio: string) => { nodes: any[]; edges: any[] };
}

const TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'cinematic-i2v',
    name: '电影级图生视频流水线',
    badge: '工业标准 · 最受欢迎',
    badgeColor: 'bg-white/10 text-zinc-200 border-white/20',
    icon: '🎬',
    desc: '完整的影视工业流水线：镜头提示词 → MiniMax H3 原生音视频生成（需要静帧时从成片抽帧）→ H3 超分辨率高清增强。',
    nodesSummary: ['Prompt 提示词节点', 'MiniMax H3 视频生成', 'H3 超分增强'],
    tags: ['MiniMax H3', 'H3 抽帧', 'H3 超分', '原生音效'],
    aspectRatio: '16:9',
    buildGraph: (name, ratio) => {
      const selectedAspect = ASPECT_RATIOS.find((r) => r.id === ratio) || ASPECT_RATIOS[0];
      const pId = `prompt-${Date.now()}`;
      const imgId = `image-${Date.now() + 1}`;
      const vidId = `video-${Date.now() + 2}`;
      const upId = `videoUpscale-${Date.now() + 3}`;

      return {
        nodes: [
          {
            id: pId,
            type: 'prompt',
            position: { x: 80, y: 160 },
            width: 320,
            height: 200,
            data: {
              text: `电影级电影大片，4K高清质感，史诗级光影构图，主角置身于充满未知与未来感的场景中，电影运镜推轨，极致细节`,
            },
          },
          {
            id: imgId,
            type: 'image',
            position: { x: 480, y: 100 },
            width: 300,
            height: 260,
            data: { label: '首帧（上传，或从 H3 成片抽帧）' },
          },
          {
            id: vidId,
            type: 'video',
            position: { x: 920, y: 100 },
            width: 340,
            height: 380,
            data: {
              prompt: '镜头缓慢推进，环境粒子浮动，人物眼神转动，伴随低沉震撼的环境氛围音效',
              width: selectedAspect.w,
              height: selectedAspect.h,
              length: 124,
              steps: DEFAULT_H3_STEPS,
            },
          },
          {
            id: upId,
            type: 'videoUpscale',
            position: { x: 1360, y: 100 },
            width: 340,
            height: 380,
            data: {
              width: selectedAspect.w,
              height: selectedAspect.h,
              steps: 4,
              denoise_strength: 0.25,
            },
          },
        ],
        edges: [
          {
            id: `e-${imgId}-${vidId}`,
            source: imgId,
            sourceHandle: 'out-image',
            target: vidId,
            targetHandle: 'in-image',
            style: { stroke: 'rgba(255,255,255,0.3)', strokeWidth: 1.5 },
          },
          {
            id: `e-${vidId}-${upId}`,
            source: vidId,
            sourceHandle: 'out-video',
            target: upId,
            targetHandle: 'in-video',
            style: { stroke: 'rgba(255,255,255,0.3)', strokeWidth: 1.5 },
          },
        ],
      };
    },
  },
  {
    id: 'character-consistency',
    name: '角色一致性与镜头重构',
    badge: '剧情片锁定',
    badgeColor: 'bg-white/10 text-zinc-200 border-white/20',
    icon: '🎭',
    desc: '保持主角面容与服装 100% 锁定，跨多场景重演或角色替换。接入角色参考图 + 提示词 + 视频编辑节点。',
    nodesSummary: ['角色参考上传', '分镜提示词', 'H3 角色替换重构'],
    tags: ['角色锁定', '视频重演', 'MiniMax H3 Edit', '多图参考'],
    aspectRatio: '16:9',
    buildGraph: (name, ratio) => {
      const selectedAspect = ASPECT_RATIOS.find((r) => r.id === ratio) || ASPECT_RATIOS[0];
      const charUploadId = `image-${Date.now()}`;
      const pId = `prompt-${Date.now() + 1}`;
      const imgId = `image-${Date.now() + 2}`;
      const editId = `videoEdit-${Date.now() + 3}`;

      return {
        nodes: [
          {
            id: charUploadId,
            type: 'image',
            position: { x: 80, y: 80 },
            width: 300,
            height: 260,
            data: { label: '角色设定原画 / 三视图' },
          },
          {
            id: pId,
            type: 'prompt',
            position: { x: 80, y: 380 },
            width: 300,
            height: 200,
            data: { text: '主角在暴雨中的电话亭中接听电话，神色严峻，霓虹光线投射在脸颊上' },
          },
          {
            id: imgId,
            type: 'image',
            position: { x: 480, y: 160 },
            width: 300,
            height: 260,
            data: { label: '首帧（上传，或从 H3 成片抽帧）' },
          },
          {
            id: editId,
            type: 'videoEdit',
            position: { x: 920, y: 160 },
            width: 340,
            height: 400,
            data: {
              width: selectedAspect.w,
              height: selectedAspect.h,
              mode: 'edit',
              length: 124,
            },
          },
        ],
        edges: [
          {
            id: `e-${charUploadId}-${editId}`,
            source: charUploadId,
            sourceHandle: 'out-image',
            target: editId,
            targetHandle: 'in-character',
            style: { stroke: 'rgba(255,255,255,0.3)', strokeWidth: 1.5 },
          },
          {
            id: `e-${imgId}-${editId}`,
            source: imgId,
            sourceHandle: 'out-image',
            target: editId,
            targetHandle: 'in-first-frame',
            style: { stroke: 'rgba(255,255,255,0.3)', strokeWidth: 1.5 },
          },
        ],
      };
    },
  },  {
    id: 'viral-shorts',
    name: '9:16 竖屏短剧爆款流',
    badge: '竖屏定制',
    badgeColor: 'bg-white/10 text-zinc-200 border-white/20',
    icon: '⚡',
    desc: '专门针对短剧、小红书与 TikTok 竖屏视频设计的极速工作流，预置 9:16 分辨率。',
    nodesSummary: ['竖屏提示词', 'MiniMax H3 竖屏生成', '高清视频超分'],
    tags: ['9:16 竖屏', '极速渲染', '短剧生产', '高清超分'],
    aspectRatio: '9:16',
    buildGraph: () => {
      const pId = `prompt-${Date.now()}`;
      const vidId = `video-${Date.now() + 1}`;
      const upId = `videoUpscale-${Date.now() + 2}`;

      return {
        nodes: [
          {
            id: pId,
            type: 'prompt',
            position: { x: 80, y: 160 },
            width: 300,
            height: 220,
            data: { text: '竖屏超清短剧镜头，人物表情细节丰富，强戏剧张力，背景虚化电影景深' },
          },
          {
            id: vidId,
            type: 'video',
            position: { x: 480, y: 120 },
            width: 320,
            height: 420,
            data: {
              prompt: '',
              width: 768,
              height: 1376,
              length: 124,
              steps: DEFAULT_H3_STEPS,
            },
          },
          {
            id: upId,
            type: 'videoUpscale',
            position: { x: 880, y: 120 },
            width: 320,
            height: 420,
            data: {
              width: 768,
              height: 1376,
              steps: 4,
            },
          },
        ],
        edges: [
          {
            id: `e-${pId}-${vidId}`,
            source: pId,
            sourceHandle: 'out-prompt',
            target: vidId,
            targetHandle: 'in-prompt',
            style: { stroke: 'rgba(255,255,255,0.3)', strokeWidth: 1.5 },
          },
          {
            id: `e-${vidId}-${upId}`,
            source: vidId,
            sourceHandle: 'out-video',
            target: upId,
            targetHandle: 'in-video',
            style: { stroke: 'rgba(255,255,255,0.3)', strokeWidth: 1.5 },
          },
        ],
      };
    },
  },
  {
    id: 'blank',
    name: '空白自由无限画布',
    badge: '自由编排',
    badgeColor: 'bg-zinc-500/20 text-zinc-300 border-zinc-500/30',
    icon: '✨',
    desc: '从空白画布开始，自由拖拽、编排任意生图、视频与音频生成节点。',
    nodesSummary: ['纯净空白画布', '全节点自由接入'],
    tags: ['自由流', '无限扩展', '全节点支持'],
    aspectRatio: '16:9',
    buildGraph: () => ({ nodes: [], edges: [] }),
  },
];

export default function CreateProjectModal({
  isOpen,
  onClose,
  onProjectCreated,
}: {
  isOpen: boolean;
  onClose: () => void;
  onProjectCreated?: (project: any) => void;
}) {
  const currentProjectId = useStore((s) => s.currentProjectId);
  const setCurrentProject = useStore((s) => s.setCurrentProject);
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  const setNodes = useStore((s) => s.setNodes);
  const setEdges = useStore((s) => s.setEdges);

  const { getViewport, fitView } = useReactFlow();

  // Wizard Step (1: Identity, 2: Aspect Ratio, 3: Production Pipeline)
  const [currentStep, setCurrentStep] = useState<1 | 2 | 3>(1);

  const [projectName, setProjectName] = useState('');
  const [projectDesc, setProjectDesc] = useState('');
  const [selectedRatio, setSelectedRatio] = useState('16:9');
  const [selectedTemplateId, setSelectedTemplateId] = useState('cinematic-i2v');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [mounted, setMounted] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (isOpen) {
      setCurrentStep(1);
      const randomTitle = RANDOM_TITLES[Math.floor(Math.random() * RANDOM_TITLES.length)];
      // a suggestion the user may keep as the project name, so it follows the UI language
      setProjectName(t(randomTitle));
      setProjectDesc('');
      setSelectedRatio('16:9');
      setSelectedTemplateId('cinematic-i2v');
      setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          inputRef.current.select();
        }
      }, 50);
    }
  }, [isOpen]);

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const handleRandomizeTitle = () => {
    const randomTitle = RANDOM_TITLES[Math.floor(Math.random() * RANDOM_TITLES.length)];
    setProjectName(t(randomTitle));
  };

  const handleNext = () => {
    if (currentStep === 1) {
      if (!projectName.trim()) {
        void showAlert(t('请输入电影工程名称'));
        return;
      }
      setCurrentStep(2);
    } else if (currentStep === 2) {
      setCurrentStep(3);
    }
  };

  const handlePrev = () => {
    if (currentStep > 1) {
      setCurrentStep((prev) => (prev - 1) as 1 | 2 | 3);
    }
  };

  const handleFinish = async () => {
    const finalName = projectName.trim() || t('未命名电影工程');

    try {
      setIsSubmitting(true);

      // Auto save active project first
      if (currentProjectId) {
        try {
          await api.saveCanvas(currentProjectId, {
            nodes,
            edges,
            viewport: getViewport(),
          });
        } catch (err) {
          console.warn('Failed to save current project', err);
        }
      }

      const tpl = TEMPLATES.find((t) => t.id === selectedTemplateId) || TEMPLATES[0];
      // A template may still be written around a retired node type; it is taken
      // out and its neighbours joined, so the project opens on a working chain.
      const graph = withoutRetiredNodes(tpl.buildGraph(finalName, selectedRatio));

      const created = await api.createProject({
        name: finalName,
        description: projectDesc.trim(),
        aspect_ratio: selectedRatio,
        template: selectedTemplateId,
        initial_nodes: graph.nodes,
        initial_edges: graph.edges,
      });

      // Update Canvas
      setNodes(graph.nodes);
      setEdges(graph.edges);
      setCurrentProject(created.id, created.name);
      safeSetItem(localStorage, userScopedKey('ai_cinema_last_project_id'), created.id);
      cacheCanvas(localStorage, userScopedKey('cinima-nodes'), userScopedKey('cinima-edges'), graph.nodes, graph.edges);

      setTimeout(() => fitView({ duration: 500, padding: 0.25 }), 100);

      onClose();
      if (onProjectCreated) onProjectCreated(created);
    } catch (err: any) {
      void showAlert(t('创建工程失败: {error}', { error: err.message || err }), { title: t('操作失败'), danger: true });
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen || !mounted) return null;

  const selectedAspect = ASPECT_RATIOS.find((r) => r.id === selectedRatio) || ASPECT_RATIOS[0];
  const selectedTemplate = TEMPLATES.find((t) => t.id === selectedTemplateId) || TEMPLATES[0];

  return createPortal(
    <div className="fixed inset-0 z-[120] w-screen h-screen bg-[#08080c] text-white flex flex-col overflow-hidden select-none pointer-events-auto animate-in fade-in duration-200">
      {/* ── Ambient Gradient & Cinema Lighting Background ─────── */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-40 left-1/4 w-[600px] h-[600px] bg-white/[0.02] rounded-full blur-[140px]" />
        <div className="absolute -bottom-40 right-1/4 w-[600px] h-[600px] bg-white/[0.02] rounded-full blur-[140px]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-white/[0.03] via-transparent to-black/80" />
      </div>

      {/* ── Fullscreen Studio Top Header ─────────────────────── */}
      <header className="relative z-10 flex items-center justify-between px-6 sm:px-10 py-4 border-b border-white/10 bg-black/40 backdrop-blur-2xl flex-shrink-0">
        {/* Brand & Title */}
        <div className="flex items-center gap-3.5">
          <LazaMark size={36} className="flex-shrink-0" />

          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold tracking-tight text-white">
                LAZA CINEMA STUDIO
              </span>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/10 text-zinc-300 border border-white/15 font-mono font-medium">
                
                {t('工程向导')}
              </span>
            </div>
            <p className="text-xs text-zinc-400">{t('步骤式影视工程生产流水线构建向导')}</p>
          </div>
        </div>

        {/* Center: Fullscreen Step Indicator Bar */}
        <div className="hidden md:flex items-center gap-3 px-4 py-1.5 bg-white/[0.04] border border-white/10 rounded-2xl">
          {[
            { step: 1, title: '工程基本信息', icon: '📝' },
            { step: 2, title: t('画幅与分辨率'), icon: '📐' },
            { step: 3, title: t('影视流水线预设'), icon: '🎬' },
          ].map((item, idx) => {
            const isPassed = currentStep > item.step;
            const isCurrent = currentStep === item.step;

            return (
              <React.Fragment key={item.step}>
                <button
                  type="button"
                  onClick={() => isPassed && setCurrentStep(item.step as 1 | 2 | 3)}
                  className={`flex items-center gap-2 transition-all ${
                    isPassed ? 'cursor-pointer' : 'cursor-default'
                  }`}
                >
                  <div
                    className={`w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center transition-all ${
                      isCurrent
                        ? 'bg-white text-black shadow-md font-bold ring-2 ring-white/30'
                        : isPassed
                        ? 'bg-zinc-300 text-black font-semibold'
                        : 'bg-white/10 text-zinc-500'
                    }`}
                  >
                    {isPassed ? '✓' : item.step}
                  </div>
                  <span
                    className={`text-xs font-medium tracking-tight ${
                      isCurrent
                        ? 'text-white font-bold'
                        : isPassed
                        ? 'text-zinc-300'
                        : 'text-zinc-500'
                    }`}
                  >
                    {t(item.title)}
                  </span>
                </button>

                {idx < 2 && (
                  <div className="w-12 h-[2px] bg-white/10 overflow-hidden">
                    <div
                      className={`h-full bg-white transition-all duration-300 ${
                        currentStep > item.step ? 'w-full' : 'w-0'
                      }`}
                    />
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>

        {/* Right Close / Exit Fullscreen */}
        <button
          type="button"
          onClick={onClose}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium text-zinc-400 hover:text-white bg-white/[0.04] hover:bg-white/[0.1] border border-white/10 transition-colors cursor-pointer"
        >
          <span className="hidden sm:inline">{t('退出向导')}</span>
          <span className="text-[10px] px-1 py-0.2 rounded bg-white/10 font-mono text-zinc-400">ESC</span>
        </button>
      </header>

      {/* ── Main Stage Area (2-Column Studio Layout) ─────────── */}
      <main className="relative z-10 flex-1 flex overflow-hidden">
        {/* ── Left Sidebar: Live Cinema Inspector & Monitor ──── */}
        <aside className="w-80 lg:w-96 border-r border-white/10 bg-black/30 backdrop-blur-xl p-6 flex flex-col justify-between overflow-y-auto custom-scrollbar flex-shrink-0 hidden md:flex">
          <div className="space-y-5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider font-mono">
                
                {t('监视器实时预览 (Cinema Monitor)')}
              </span>
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shadow-sm shadow-emerald-400" />
            </div>

            {/* Live Camera Viewport Box */}
            <div className="relative w-full aspect-video rounded-2xl overflow-hidden bg-gradient-to-br from-[#0e0e16] to-[#06060a] border border-white/15 p-4 flex flex-col items-center justify-center shadow-2xl">
              {/* Corner Framing Marks */}
              <div className="absolute top-2 left-2 w-3 h-3 border-t-2 border-l-2 border-white/40" />
              <div className="absolute top-2 right-2 w-3 h-3 border-t-2 border-r-2 border-white/40" />
              <div className="absolute bottom-2 left-2 w-3 h-3 border-b-2 border-l-2 border-white/40" />
              <div className="absolute bottom-2 right-2 w-3 h-3 border-b-2 border-r-2 border-white/40" />

              {/* Dynamic Aspect Ratio Silhouette */}
              <div
                className={`rounded-lg border border-violet-500/60 bg-violet-600/10 shadow-lg shadow-violet-600/20 flex items-center justify-center transition-all duration-300 max-w-[85%] max-h-[80%]`}
                style={{
                  width: selectedAspect.id === '16:9' ? '180px' : selectedAspect.id === '9:16' ? '90px' : selectedAspect.id === '21:9' ? '210px' : selectedAspect.id === '1:1' ? '120px' : '150px',
                  height: selectedAspect.id === '16:9' ? '101px' : selectedAspect.id === '9:16' ? '160px' : selectedAspect.id === '21:9' ? '80px' : selectedAspect.id === '1:1' ? '120px' : '112px',
                }}
              >
                <span className="text-xs font-bold text-violet-300 font-mono">
                  {selectedAspect.id}
                </span>
              </div>

              <div className="absolute bottom-2 text-[10px] text-zinc-500 font-mono">
                {selectedAspect.w} × {selectedAspect.h} · 4K Rec.709
              </div>
            </div>

            {/* Project Specs Card */}
            <div className="p-4 rounded-2xl bg-white/[0.03] border border-white/10 space-y-3">
              <span className="text-xs font-bold text-zinc-300">{t('工程规格清单 (Project Specs)')}</span>

              <div className="space-y-2 text-xs">
                <div className="flex items-center justify-between py-1 border-b border-white/5">
                  <span className="text-zinc-500">{t('工程片名')}</span>
                  <span className="font-semibold text-white truncate max-w-[170px]">
                    {projectName || t('未命名工程')}
                  </span>
                </div>

                <div className="flex items-center justify-between py-1 border-b border-white/5">
                  <span className="text-zinc-500">{t('画幅比例')}</span>
                  <span className="font-mono text-violet-300 font-semibold">{t(selectedAspect.label)}</span>
                </div>

                <div className="flex items-center justify-between py-1 border-b border-white/5">
                  <span className="text-zinc-500">{t('预设流水线')}</span>
                  <span className="font-semibold text-cyan-300 truncate max-w-[170px]">
                    {t(selectedTemplate.name)}
                  </span>
                </div>

                <div className="flex items-center justify-between py-1">
                  <span className="text-zinc-500">{t('初始节点编排')}</span>
                  <span className="font-mono text-emerald-400 font-bold">
                    {selectedTemplate.nodesSummary.length}  {t('个节点')}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5 text-[11px] text-zinc-500 leading-relaxed">
            
            {t('LAZA CINEMA STUDIO 会为每个工程设立独立工作区目录与资产库，保障镜头资产完全隔离。')}
          </div>
        </aside>

        {/* ── Center Stage: Interactive Step Wizard ──────────── */}
        <section className="flex-1 overflow-y-auto p-6 sm:p-10 lg:p-12 custom-scrollbar flex flex-col justify-between max-w-5xl mx-auto w-full">
          {/* ═══════════════ STEP 1: Basic Identity ═══════════════ */}
          {currentStep === 1 && (
            <div className="space-y-8 animate-in fade-in slide-in-from-right-6 duration-200">
              <div>
                <div className="flex items-center gap-2 text-violet-400 text-xs font-mono font-semibold uppercase tracking-wider mb-2">
                  <span>STEP 01</span>
                  <span>/</span>
                  <span>PROJECT IDENTITY</span>
                </div>
                <h2 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
                  
                  {t('为你的新电影工程设定片名与概念')}
                </h2>
                <p className="text-sm text-zinc-400 mt-2 leading-relaxed max-w-2xl">
                  
                  {t('输入富有故事感和视觉张力的片名，设置故事大纲或风格标签，我们将为你开辟专属的无限节点画布。')}
                </p>
              </div>

              {/* Title Input Card */}
              <div className="p-6 rounded-3xl bg-white/[0.03] border border-white/10 space-y-4 shadow-xl">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-bold text-white flex items-center gap-1.5">
                    <span>{t('电影工程名称')}</span>
                    <span className="text-violet-400">*</span>
                  </label>

                  <button
                    type="button"
                    onClick={handleRandomizeTitle}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-violet-600/20 hover:bg-violet-600/40 text-violet-300 hover:text-white border border-violet-500/30 transition-all cursor-pointer select-none active:scale-95 shadow-sm"
                  >
                    <span>{t('🎲 换一个随机片名灵感')}</span>
                  </button>
                </div>

                <input
                  ref={inputRef}
                  type="text"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleNext()}
                  placeholder={t('例如: 异星觉醒 · 概念先导片 EP01')}
                  className="w-full bg-black/70 border border-white/15 focus:border-violet-500 focus:ring-2 focus:ring-violet-500/30 rounded-2xl px-5 py-4 text-base sm:text-lg text-white placeholder-zinc-500 outline-none transition-all shadow-inner font-medium"
                  required
                />
              </div>

              {/* Description Input Card */}
              <div className="p-6 rounded-3xl bg-white/[0.03] border border-white/10 space-y-3 shadow-xl">
                <label className="text-sm font-bold text-white">{t('故事大纲 / 风格关键词描述 (可选)')}</label>
                <textarea
                  value={projectDesc}
                  onChange={(e) => setProjectDesc(e.target.value)}
                  placeholder={t('输入故事背景或风格关键词，例如：赛博朋克 / 雨夜街道 / 电影级胶片运镜 / 保持主角一致性 / 4K 院线标准...')}
                  rows={4}
                  className="w-full bg-black/50 border border-white/10 focus:border-violet-500 focus:ring-2 focus:ring-violet-500/30 rounded-2xl p-4 text-sm text-zinc-200 placeholder-zinc-600 outline-none transition-all leading-relaxed"
                />
              </div>
            </div>
          )}

          {/* ═══════════════ STEP 2: Aspect Ratio ═══════════════ */}
          {currentStep === 2 && (
            <div className="space-y-8 animate-in fade-in slide-in-from-right-6 duration-200">
              <div>
                <div className="flex items-center gap-2 text-violet-400 text-xs font-mono font-semibold uppercase tracking-wider mb-2">
                  <span>STEP 02</span>
                  <span>/</span>
                  <span>ASPECT RATIO & RESOLUTION</span>
                </div>
                <h2 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
                  
                  {t('选择默认画幅比例与输出分辨率')}
                </h2>
                <p className="text-sm text-zinc-400 mt-2 leading-relaxed max-w-2xl">
                  
                  {t('系统会自动针对选定画幅对齐 MiniMax H3 模型的工业级最佳分辨率。')}
                </p>
              </div>

              {/* Aspect Ratio Cards Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {ASPECT_RATIOS.map((ratio) => {
                  const isSelected = selectedRatio === ratio.id;
                  return (
                    <div
                      key={ratio.id}
                      onClick={() => setSelectedRatio(ratio.id)}
                      className={`group p-5 rounded-3xl border transition-all duration-300 cursor-pointer flex flex-col justify-between space-y-4 ${
                        isSelected
                          ? 'bg-gradient-to-b from-violet-950/60 to-indigo-950/40 border-violet-500 text-white shadow-2xl shadow-violet-900/30 ring-2 ring-violet-500/40'
                          : 'bg-white/[0.03] hover:bg-white/[0.07] border-white/10 hover:border-white/20 text-zinc-300 hover:text-white'
                      }`}
                    >
                      {/* Viewport Silhouette */}
                      <div className="w-full h-28 rounded-2xl bg-black/60 border border-white/10 flex items-center justify-center p-3 group-hover:border-violet-500/40 transition-colors">
                        <div
                          className={`rounded border flex items-center justify-center text-xs font-mono transition-all ${
                            isSelected
                              ? 'border-violet-400 bg-violet-500/30 text-violet-200 shadow-md shadow-violet-400/40'
                              : 'border-zinc-500 bg-white/5 text-zinc-500'
                          } ${ratio.previewRatio}`}
                          style={{
                            width: ratio.id === '16:9' ? '80px' : ratio.id === '9:16' ? '45px' : ratio.id === '21:9' ? '95px' : ratio.id === '1:1' ? '60px' : '70px',
                            height: ratio.id === '16:9' ? '45px' : ratio.id === '9:16' ? '80px' : ratio.id === '21:9' ? '36px' : ratio.id === '1:1' ? '60px' : '52px',
                          }}
                        >
                          {ratio.id}
                        </div>
                      </div>

                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <h4 className={`text-sm font-bold ${isSelected ? 'text-white' : 'text-zinc-200'}`}>
                            {t(ratio.label)}
                          </h4>
                          <span className="text-xs font-mono text-zinc-400">{ratio.w}×{ratio.h}</span>
                        </div>
                        <p className="text-xs text-zinc-400 leading-relaxed">{t(ratio.desc)}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ═══════════════ STEP 3: Workflow Pipeline ═══════════════ */}
          {currentStep === 3 && (
            <div className="space-y-8 animate-in fade-in slide-in-from-right-6 duration-200">
              <div>
                <div className="flex items-center gap-2 text-zinc-400 text-xs font-mono font-semibold uppercase tracking-wider mb-2">
                  <span>STEP 03</span>
                  <span>/</span>
                  <span>PRODUCTION WORKFLOW</span>
                </div>
                <h2 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
                  
                  {t('选择开箱即用的电影工业生产流水线')}
                </h2>
                <p className="text-sm text-zinc-400 mt-2 leading-relaxed max-w-2xl">
                  
                  {t('系统会自动为你的新工程预布设节点、连线与经过实战调优的生成参数，进入画布即可直接出片。')}
                </p>
              </div>

              {/* Template Pipeline Cards Grid */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {TEMPLATES.map((tpl) => {
                  const isSelected = selectedTemplateId === tpl.id;
                  return (
                    <div
                      key={tpl.id}
                      onClick={() => {
                        setSelectedTemplateId(tpl.id);
                        if (tpl.aspectRatio) setSelectedRatio(tpl.aspectRatio);
                      }}
                      className={`p-5 rounded-3xl border transition-all duration-300 cursor-pointer flex flex-col justify-between space-y-4 ${
                        isSelected
                          ? 'bg-white/[0.08] border-white/40 text-white shadow-2xl ring-1 ring-white/30'
                          : 'bg-white/[0.03] hover:bg-white/[0.07] border-white/10 hover:border-white/20 text-zinc-300 hover:text-white'
                      }`}
                    >
                      <div>
                        <div className="flex items-center justify-between mb-2.5">
                          <div className="flex items-center gap-2.5">
                            <span className="text-2xl">{tpl.icon}</span>
                            <h4 className="text-sm font-bold text-white">{t(tpl.name)}</h4>
                          </div>
                          <span className={`text-[10px] px-2.5 py-0.5 rounded-full border font-sans font-medium ${tpl.badgeColor}`}>
                            {t(tpl.badge)}
                          </span>
                        </div>

                        <p className="text-xs text-zinc-400 leading-relaxed">{t(tpl.desc)}</p>
                      </div>

                      {/* Nodes Pipeline Summary */}
                      <div className="space-y-1.5 pt-2 border-t border-white/5">
                        <div className="text-[10px] text-zinc-500 font-semibold uppercase tracking-wider">{t('流水线初始节点')}</div>
                        <div className="flex flex-wrap gap-1.5">
                          {tpl.nodesSummary.map((nodeName) => (
                            <span
                              key={nodeName}
                              className="text-[10px] font-mono px-2 py-0.5 rounded-lg bg-white/[0.06] border border-white/10 text-zinc-300 flex items-center gap-1.5"
                            >
                              <span className="w-1.5 h-1.5 rounded-full bg-white/80" />
                              {t(nodeName)}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </section>
      </main>

      {/* ── Fullscreen Bottom Navigation Control Dock ─────────── */}
      <footer className="relative z-10 flex items-center justify-between px-6 sm:px-10 py-4 border-t border-white/10 bg-black/50 backdrop-blur-2xl flex-shrink-0">
        {/* Left: Previous Step / Cancel */}
        {currentStep > 1 ? (
          <button
            type="button"
            onClick={handlePrev}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-semibold text-zinc-300 hover:text-white hover:bg-white/10 cursor-pointer transition-colors"
          >
            <span>{t('← 上一步')}</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2.5 rounded-xl text-xs font-semibold text-zinc-500 hover:text-zinc-300 hover:bg-white/10 cursor-pointer transition-colors"
          >
            
            {t('取消退出')}
          </button>
        )}

        {/* Center: Info Hint */}
        <div className="hidden sm:flex items-center gap-2 text-xs text-zinc-500 font-mono">
          <span>{t('按')}</span>
          <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-zinc-300 text-[11px]">Enter ↵</kbd>
          <span>{t('继续下一步')}</span>
        </div>

        {/* Right: Next Step or Launch Project */}
        {currentStep < 3 ? (
          <button
            type="button"
            onClick={handleNext}
            className="flex items-center gap-2 px-7 py-2.5 rounded-xl text-xs font-bold bg-white/15 hover:bg-white/25 border border-white/20 text-white shadow-lg hover:scale-[1.02] active:scale-98 cursor-pointer transition-all"
          >
            <span>{t('下一步：')}{currentStep === 1 ? t('选择画幅比例') : t('选择影视工作流')}</span>
            <span>→</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={handleFinish}
            disabled={isSubmitting}
            className="flex items-center gap-2.5 px-8 py-3 rounded-xl text-sm font-bold bg-white hover:bg-zinc-200 text-black shadow-2xl hover:scale-[1.02] active:scale-98 cursor-pointer transition-all duration-200"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
            <span>{isSubmitting ? t('正在构建工程流水线...') : t('✦ 立即创建并进入画布')}</span>
          </button>
        )}
      </footer>
    </div>,
    document.body
  );
}
