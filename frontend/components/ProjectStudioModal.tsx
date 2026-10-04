'use client';

import { userScopedKey } from '@/lib/auth';
import { withoutRetiredNodes } from '@/lib/nodeRegistry';
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '@/lib/store';
import { api, type Project, getUserId, setShownCanvasRevision } from '@/lib/api';
import { cacheCanvas, safeSetItem } from '@/lib/canvasCache';
import { useReactFlow } from '@xyflow/react';
import { posterUrl, resolveAssetUrl } from '@/lib/config';
import { showAlert, showConfirm } from '@/components/ui/Dialog';
import { DEFAULT_H3_STEPS } from '@/lib/types';
import { t } from '@/lib/i18n';

// ── Aspect Ratio Presets ───────────────────────────────────────────────────────
const ASPECT_RATIOS = [
  { id: '16:9', label: '16:9 影院宽银幕', desc: '1376 × 768 电影与横屏主流', w: 1376, h: 768, iconRatio: 'w-8 h-4.5' },
  { id: '9:16', label: '9:16 竖屏短视频', desc: '768 × 1376 抖音/TikTok/Shorts', w: 768, h: 1376, iconRatio: 'w-4.5 h-8' },
  { id: '21:9', label: '21:9 宽银幕变形镜头', desc: '1536 × 640 院线史诗级大片', w: 1536, h: 640, iconRatio: 'w-9 h-4' },
  { id: '1:1', label: '1:1 正方形画幅', desc: '1024 × 1024 概念图与社交媒体', w: 1024, h: 1024, iconRatio: 'w-6 h-6' },
  { id: '4:3', label: '4:3 经典复古胶片', desc: '1152 × 864 IMAX / 经典电影', w: 1152, h: 864, iconRatio: 'w-7 h-5' },
];

// ── Starter Workflow Templates ────────────────────────────────────────────────
interface WorkflowTemplate {
  id: string;
  name: string;
  badge: string;
  badgeColor: string;
  desc: string;
  tags: string[];
  aspectRatio: string;
  buildGraph: (projName: string, ratio: string) => { nodes: any[]; edges: any[] };
}

const TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'blank',
    name: '空白自由画布',
    badge: '自由创作',
    badgeColor: 'bg-zinc-500/20 text-zinc-300 border-zinc-500/30',
    desc: '纯净空白画布，从零开始自由拖拽、编排任意生图、视频与音频节点。',
    tags: ['自由流', '无限扩展', '全节点支持'],
    aspectRatio: '16:9',
    buildGraph: () => ({ nodes: [], edges: [] }),
  },
  {
    id: 'cinematic-i2v',
    name: '电影级图生视频流水线',
    badge: '最受欢迎',
    badgeColor: 'bg-white/10 text-zinc-200 border-white/20',
    desc: '完整的影视工业流水线：镜头提示词 → MiniMax H3 视频与原生音效生成（需要静帧时从成片抽帧）→ H3 超分辨率高清增强。',
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
            target: vidId,
            targetHandle: 'in-image',
            style: { stroke: 'rgba(255,255,255,0.3)', strokeWidth: 1.5 },
          },
          {
            id: `e-${vidId}-${upId}`,
            source: vidId,
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
    badge: '剧情片推荐',
    badgeColor: 'bg-white/10 text-zinc-200 border-white/20',
    desc: '保持主角面容与服装 100% 锁定，跨多场景重演或角色替换。接入角色参考图 + 故事大纲 + 视频编辑节点。',
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
            target: editId,
            targetHandle: 'in-character',
            style: { stroke: 'rgba(255,255,255,0.3)', strokeWidth: 1.5 },
          },
          {
            id: `e-${imgId}-${editId}`,
            source: imgId,
            target: editId,
            targetHandle: 'in-first-frame',
            style: { stroke: 'rgba(255,255,255,0.3)', strokeWidth: 1.5 },
          },
        ],
      };
    },
  },  {
    id: 'viral-shorts',
    name: '9:16 竖屏短剧爆款流水线',
    badge: '竖屏定制',
    badgeColor: 'bg-white/10 text-zinc-200 border-white/20',
    desc: '专门针对短剧、小红书与 TikTok 竖屏视频设计的极速工作流，预置 9:16 高清分辨率。',
    tags: ['9:16 竖屏', '极速渲染', '短剧生产', '高清超分'],
    aspectRatio: '9:16',
    buildGraph: (name, ratio) => {
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
            target: vidId,
            targetHandle: 'in-prompt',
            style: { stroke: 'rgba(255,255,255,0.3)', strokeWidth: 1.5 },
          },
          {
            id: `e-${vidId}-${upId}`,
            source: vidId,
            target: upId,
            targetHandle: 'in-video',
            style: { stroke: 'rgba(255,255,255,0.3)', strokeWidth: 1.5 },
          },
        ],
      };
    },
  },
];

// ── Project Studio Modal Component ────────────────────────────────────────────
export default function ProjectStudioModal({
  isOpen,
  initialTab = 'projects',
  onClose,
  onOpenCreate,
}: {
  isOpen: boolean;
  initialTab?: 'projects' | 'wizard';
  onClose: () => void;
  onOpenCreate?: () => void;
}) {
  const currentProjectId = useStore((s) => s.currentProjectId);
  const currentProjectName = useStore((s) => s.currentProjectName);
  const setCurrentProject = useStore((s) => s.setCurrentProject);
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  const setNodes = useStore((s) => s.setNodes);
  const setEdges = useStore((s) => s.setEdges);

  const { getViewport, setViewport, fitView } = useReactFlow();

  const [activeTab, setActiveTab] = useState<'projects' | 'wizard'>('projects');
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterMode, setFilterMode] = useState<'all' | 'mine' | 'recent'>('all');

  // Wizard state
  const [projectName, setProjectName] = useState('');
  const [projectDesc, setProjectDesc] = useState('');
  const [selectedRatio, setSelectedRatio] = useState('16:9');
  const [selectedTemplateId, setSelectedTemplateId] = useState('cinematic-i2v');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Quick rename in gallery
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');

  const currentUserId = typeof window !== 'undefined' ? getUserId() : '';

  // Switch initial tab on open
  useEffect(() => {
    if (isOpen) {
      setActiveTab(initialTab);
      refreshProjects();
    }
  }, [isOpen, initialTab]);

  const refreshProjects = async () => {
    try {
      setLoading(true);
      const res = await api.listProjects();
      setProjects(res.projects || []);
    } catch (e) {
      console.warn('Failed to load projects list:', e);
    } finally {
      setLoading(false);
    }
  };

  // Filtered projects
  const filteredProjects = useMemo(() => {
    return projects.filter((p) => {
      // Search
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchName = p.name.toLowerCase().includes(q);
        const matchDesc = p.description?.toLowerCase().includes(q);
        if (!matchName && !matchDesc) return false;
      }
      // Filter
      if (filterMode === 'mine') {
        return p.owner_user_id === currentUserId;
      }
      return true;
    });
  }, [projects, searchQuery, filterMode, currentUserId]);

  // Handle Switch / Open Project
  const handleOpenProject = async (target: Project) => {
    if (target.id === currentProjectId) {
      onClose();
      return;
    }

    try {
      // 1. Auto save active canvas
      if (currentProjectId) {
        try {
          await api.saveCanvas(currentProjectId, {
            nodes,
            edges,
            viewport: getViewport(),
          });
        } catch (e) {
          console.warn('Failed to auto-save before switching', e);
        }
      }

      // 2. Load target canvas
      const canvasData = await api.loadCanvas(target.id);
      setShownCanvasRevision(target.id, 'main', canvasData.revision ?? 0);
      const targetNodes = (canvasData.nodes || []).map((n: any) => {
        if (n.data?.status === 'generating' && !n.data?.jobId) {
          return { ...n, data: { ...n.data, status: 'idle' } };
        }
        return n;
      });

      setNodes(targetNodes);
      setEdges((canvasData.edges as any[]) || []);

      if (canvasData.viewport && typeof canvasData.viewport.zoom === 'number') {
        setViewport(canvasData.viewport);
      } else {
        setTimeout(() => fitView({ duration: 400, padding: 0.2 }), 50);
      }

      setCurrentProject(target.id, target.name);
      safeSetItem(localStorage, userScopedKey('ai_cinema_last_project_id'), target.id);
      cacheCanvas(localStorage, userScopedKey('cinima-nodes'), userScopedKey('cinima-edges'), targetNodes, canvasData.edges || []);

      onClose();
    } catch (err: any) {
      void showAlert(t('无法打开项目: {error}', { error: err.message || err }));
    }
  };

  // Handle Create Project with Template
  const handleCreateProject = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const finalName = projectName.trim()
      || t('新电影项目 {month}/{day}', { month: new Date().getMonth() + 1, day: new Date().getDate() });

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
        } catch (e) {
          console.warn('Failed to save current project', e);
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

      // Reset form
      setProjectName('');
      setProjectDesc('');
      onClose();
    } catch (err: any) {
      void showAlert(t('创建工程失败: {error}', { error: err.message || err }), { title: '操作失败', danger: true });
    } finally {
      setIsSubmitting(false);
    }
  };

  // Duplicate Project
  const handleDuplicate = async (projectId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const dup = await api.duplicateProject(projectId);
      await refreshProjects();
    } catch (err: any) {
      void showAlert(t('复制项目失败: {error}', { error: err.message || err }), { title: '操作失败', danger: true });
    }
  };

  // Delete Project
  const handleDelete = async (projectId: string, projName: string, e: React.MouseEvent) => {
    e.stopPropagation();
    // The project's own renders, uploads and latents go with it; say how much,
    // and that anything another project uses is kept.
    let assets = '';
    try {
      const plan = await api.projectDeletePlan(projectId);
      const gib = plan.bytes / 2 ** 30;
      const size = gib >= 1 ? `${gib.toFixed(2)} GB` : `${Math.max(1, Math.round(plan.bytes / 2 ** 20))} MB`;
      assets = plan.file_count
        ? t('\n\n会同时删除只属于这个项目的 {n} 个素材文件（含潜空间，约 {size}）。', { n: plan.file_count, size })
        : t('\n\n这个项目没有独占的素材文件。');
      if (plan.shared_count) assets += t('\n{n} 个素材也被其他项目使用，会保留。', { n: plan.shared_count });
    } catch (err: any) {
      assets = t('\n\n（无法统计素材：{error}）', { error: err.message || err });
    }
    if (!(await showConfirm(
      t('确定要彻底删除项目 "{name}" 吗？此操作无法撤销。', { name: projName }) + assets,
      { title: t('删除工程'), confirmText: t('彻底删除'), danger: true },
    ))) return;

    try {
      await api.deleteProject(projectId);
      if (currentProjectId === projectId) {
        const remaining = projects.filter((p) => p.id !== projectId);
        if (remaining.length > 0) {
          await handleOpenProject(remaining[0]);
        } else {
          // Fresh fallback
          const def = await api.createProject(t('默认项目'));
          setNodes([]);
          setEdges([]);
          setCurrentProject(def.id, def.name);
        }
      }
      refreshProjects();
    } catch (err: any) {
      void showAlert(t('删除项目失败: {error}', { error: err.message || err }), { title: t('操作失败'), danger: true });
    }
  };

  // Rename Project
  const handleSaveRename = async (projectId: string, e: React.FormEvent) => {
    e.preventDefault();
    const name = editingName.trim();
    if (!name) {
      setEditingId(null);
      return;
    }
    try {
      await api.renameProject(projectId, name);
      if (currentProjectId === projectId) {
        setCurrentProject(projectId, name);
      }
      setEditingId(null);
      refreshProjects();
    } catch (err: any) {
      void showAlert(t('重命名失败：{error}', { error: err.message || err }), { title: '操作失败', danger: true });
    }
  };

  // Format relative time
  const formatTime = (isoString?: string) => {
    if (!isoString) return t('刚刚');
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMin / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMin < 1) return t('刚刚');
    if (diffMin < 60) return t('{n} 分钟前', { n: diffMin });
    if (diffHours < 24) return t('{n} 小时前', { n: diffHours });
    if (diffDays < 30) return t('{n} 天前', { n: diffDays });
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
  };

  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!isOpen || !mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] w-screen h-screen bg-[#08080c] text-white flex flex-col overflow-hidden select-none pointer-events-auto animate-in fade-in duration-200">
      {/* ── Ambient Background Glow ───────────────────────────── */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-40 left-1/3 w-[600px] h-[600px] bg-white/[0.02] rounded-full blur-[140px]" />
        <div className="absolute -bottom-40 right-1/3 w-[600px] h-[600px] bg-white/[0.02] rounded-full blur-[140px]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-white/[0.03] via-transparent to-black/80" />
      </div>

      {/* ── Fullscreen Header & Studio Brand ─────────────────── */}
      <div className="relative z-10 flex items-center justify-between px-6 sm:px-10 py-4 border-b border-white/10 bg-black/40 backdrop-blur-2xl flex-shrink-0">
        <div className="flex items-center gap-3.5">
          <div className="w-9 h-9 flex items-center justify-center rounded-xl bg-white/10 border border-white/15 text-white shadow-inner flex-shrink-0">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>

          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-bold text-white tracking-tight">{t('AI 影院项目工作区中心')}</h2>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/10 text-zinc-300 border border-white/15 font-mono font-medium">
                Studio Hub
              </span>
            </div>
            <p className="text-xs text-zinc-400">{t('管理、检索与切换你的电影镜头生产项目')}</p>
          </div>
        </div>

          {/* Actions & Close */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => {
                if (onOpenCreate) {
                  onOpenCreate();
                } else {
                  setActiveTab('wizard');
                }
              }}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-semibold bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white shadow-lg shadow-violet-600/30 hover:scale-[1.02] active:scale-98 transition-all cursor-pointer select-none"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              <span>{t('新建电影工程')}</span>
            </button>

            <button
              type="button"
              onClick={onClose}
              className="flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs text-zinc-400 hover:text-white bg-white/[0.04] hover:bg-white/10 border border-white/10 transition-colors cursor-pointer"
            >
              <span>{t('关闭')}</span>
              <span className="text-[10px] px-1 py-0.2 rounded bg-white/10 font-mono text-zinc-400">ESC</span>
            </button>
          </div>
        </div>

        {/* ── Modal Content ───────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto min-h-0 custom-scrollbar p-6 sm:p-10 max-w-7xl mx-auto w-full">
          {activeTab === 'projects' ? (
            /* ═════════════════ Tab 1: Project Gallery ═════════════════ */
            <div className="space-y-6">
              {/* Search & Filter Bar */}
              <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
                {/* Search Input */}
                <div className="relative w-full sm:w-80">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-500"
                  >
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder={t('搜索电影项目名称或风格描述...')}
                    className="w-full bg-white/[0.04] border border-white/10 hover:border-white/20 focus:border-violet-500/60 rounded-xl pl-10 pr-3 py-2.5 text-xs text-white placeholder-zinc-500 outline-none transition-all"
                  />
                  {searchQuery && (
                    <button
                      onClick={() => setSearchQuery('')}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-zinc-500 hover:text-white"
                    >
                      ✕
                    </button>
                  )}
                </div>

                {/* Filter Pills & Create Action */}
                <div className="flex items-center gap-3 w-full sm:w-auto justify-between sm:justify-end">
                  <div className="flex items-center p-0.5 bg-white/[0.04] rounded-xl border border-white/10 text-xs">
                    <button
                      type="button"
                      onClick={() => setFilterMode('all')}
                      className={`px-3 py-1.5 rounded-lg transition-all cursor-pointer ${
                        filterMode === 'all' ? 'bg-white/15 text-white font-semibold' : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      
                      {t('全部工程 ({n})', { n: projects.length })}
                    </button>
                    <button
                      type="button"
                      onClick={() => setFilterMode('mine')}
                      className={`px-3 py-1.5 rounded-lg transition-all cursor-pointer ${
                        filterMode === 'mine' ? 'bg-white/15 text-white font-semibold' : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      
                      {t('我的创作')}
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      if (onOpenCreate) {
                        onOpenCreate();
                      } else {
                        setActiveTab('wizard');
                      }
                    }}
                    className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-semibold bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white shadow-lg shadow-violet-600/25 transition-all cursor-pointer"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    <span>{t('创建新工程')}</span>
                  </button>
                </div>
              </div>

              {/* Projects Grid */}
              {loading ? (
                <div className="h-64 flex flex-col items-center justify-center text-zinc-500 text-xs gap-2">
                  <div className="w-6 h-6 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
                  <span>{t('正在载入项目库...')}</span>
                </div>
              ) : filteredProjects.length === 0 ? (
                <div className="h-72 rounded-2xl border border-dashed border-white/15 bg-white/[0.02] flex flex-col items-center justify-center text-center p-6 space-y-3">
                  <div className="w-12 h-12 rounded-2xl bg-white/[0.04] border border-white/10 flex items-center justify-center text-zinc-400">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-white">{t('暂未找到符合条件的项目')}</h3>
                    <p className="text-xs text-zinc-500 mt-0.5">{t('你可以使用预置的电影工作流模板快速开启新创作')}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveTab('wizard')}
                    className="px-4 py-2 rounded-xl text-xs font-semibold bg-violet-600 hover:bg-violet-500 text-white cursor-pointer transition-colors shadow-md shadow-violet-600/30"
                  >
                    
                    {t('✦ 开启第一个电影项目')}
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {filteredProjects.map((proj) => {
                    const isActive = proj.id === currentProjectId;
                    const isMyProject = proj.owner_user_id === currentUserId;
                    const isEditing = editingId === proj.id;

                    return (
                      <div
                        key={proj.id}
                        onClick={() => handleOpenProject(proj)}
                        className={`group relative rounded-2xl p-3.5 flex flex-col justify-between transition-all duration-300 cursor-pointer overflow-hidden border ${
                          isActive
                            ? 'bg-gradient-to-b from-violet-950/40 to-[#12121c] border-violet-500/60 shadow-xl shadow-violet-900/20'
                            : 'bg-white/[0.03] hover:bg-white/[0.07] border-white/10 hover:border-white/20 hover:shadow-2xl hover:shadow-black/50'
                        }`}
                      >
                        {/* Cover / Thumbnail Preview Area */}
                        <div className="relative w-full aspect-video rounded-xl overflow-hidden bg-[#0c0c12] border border-white/10 mb-3 flex items-center justify-center group-hover:border-violet-500/40 transition-colors">
                          {proj.thumbnail_url ? (
                            <img
                              // A clip as cover is shown by its poster frame, as in the scene bar.
                              src={/\.(mp4|mov|webm|m4v)(\?|$)/i.test(proj.thumbnail_url)
                                ? posterUrl(resolveAssetUrl(proj.thumbnail_url)) ?? resolveAssetUrl(proj.thumbnail_url)
                                : resolveAssetUrl(proj.thumbnail_url)}
                              alt={proj.name}
                              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                            />
                          ) : (
                            <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-br from-violet-900/20 via-zinc-900/40 to-black p-4 text-center">
                              <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center text-zinc-400 mb-1">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                                  <polygon points="5 3 19 12 5 21 5 3" />
                                </svg>
                              </div>
                              <span className="text-[10px] text-zinc-500 font-mono">
                                {proj.node_count ? t('{n} 个画布节点', { n: proj.node_count }) : t('无限画布工程')}
                              </span>
                            </div>
                          )}

                          {/* Top Badges */}
                          <div className="absolute top-2 left-2 flex items-center gap-1.5 z-10">
                            {isActive && (
                              <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-emerald-500 text-black shadow-md shadow-emerald-500/40 flex items-center gap-1">
                                <span className="w-1.5 h-1.5 rounded-full bg-black animate-pulse" />
                                
                                {t('正在编辑')}
                              </span>
                            )}
                            <span className="px-1.5 py-0.5 rounded-md text-[10px] font-mono font-medium bg-black/60 backdrop-blur-md text-zinc-300 border border-white/10">
                              {proj.aspect_ratio || '16:9'}
                            </span>
                          </div>

                          {isMyProject && (
                            <div className="absolute top-2 right-2 z-10">
                              <span className="px-1.5 py-0.5 rounded-md text-[10px] font-sans font-medium bg-indigo-500/80 backdrop-blur-md text-white border border-indigo-400/40 shadow-sm">
                                
                                {t('我的创作')}
                              </span>
                            </div>
                          )}
                        </div>

                        {/* Project Info */}
                        <div className="space-y-1.5 flex-1">
                          {isEditing ? (
                            <form
                              onSubmit={(e) => handleSaveRename(proj.id, e)}
                              onClick={(e) => e.stopPropagation()}
                              className="flex items-center gap-1 my-0.5"
                            >
                              <input
                                type="text"
                                value={editingName}
                                onChange={(e) => setEditingName(e.target.value)}
                                autoFocus
                                className="flex-1 bg-black/80 border border-violet-500 rounded-lg px-2 py-0.5 text-xs text-white outline-none"
                              />
                              <button
                                type="submit"
                                className="px-2 py-0.5 rounded text-xs bg-violet-600 text-white cursor-pointer"
                              >
                                
                                {t('存')}
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingId(null)}
                                className="px-1.5 py-0.5 rounded text-xs text-zinc-400 hover:text-white cursor-pointer"
                              >
                                ✕
                              </button>
                            </form>
                          ) : (
                            <div className="flex items-center justify-between">
                              <h4 className="text-xs font-bold text-white truncate max-w-[180px] group-hover:text-violet-300 transition-colors">
                                {proj.name}
                              </h4>
                            </div>
                          )}

                          {proj.description ? (
                            <p className="text-[11px] text-zinc-400 line-clamp-1 leading-relaxed">
                              {proj.description}
                            </p>
                          ) : (
                            <p className="text-[11px] text-zinc-500 italic">{t('暂无工程描述')}</p>
                          )}
                        </div>

                        {/* Bottom Meta & Action Strip */}
                        <div className="flex items-center justify-between pt-3 mt-2 border-t border-white/5 text-[10px] text-zinc-500 font-mono">
                          <span>{formatTime(proj.updated_at || proj.created_at)}</span>

                          {/* Action Buttons on Card */}
                          <div
                            className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {/* Duplicate */}
                            <button
                              type="button"
                              onClick={(e) => handleDuplicate(proj.id, e)}
                              title={t('复制项目副本')}
                              className="p-1 rounded-md text-zinc-400 hover:text-white hover:bg-white/10 cursor-pointer transition-colors"
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                              </svg>
                            </button>

                            {/* Rename */}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditingId(proj.id);
                                setEditingName(proj.name);
                              }}
                              title={t('重命名项目')}
                              className="p-1 rounded-md text-zinc-400 hover:text-white hover:bg-white/10 cursor-pointer transition-colors"
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                              </svg>
                            </button>

                            {/* Delete */}
                            <button
                              type="button"
                              onClick={(e) => handleDelete(proj.id, proj.name, e)}
                              title={t('删除项目')}
                              className="p-1 rounded-md text-zinc-400 hover:text-rose-400 hover:bg-rose-500/10 cursor-pointer transition-colors"
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <polyline points="3 6 5 6 21 6" />
                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                              </svg>
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            /* ═════════════════ Tab 2: New Project Wizard ═════════════════ */
            <form onSubmit={handleCreateProject} className="p-6 space-y-6 max-w-4xl mx-auto">
              {/* Section 1: Basic Project Details */}
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-violet-600 text-white text-[11px] font-bold flex items-center justify-center">
                    1
                  </span>
                  <h3 className="text-sm font-bold text-white">{t('工程基本信息')}</h3>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Name Input */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-zinc-300">
                      
                      {t('项目名称')} <span className="text-violet-400">*</span>
                    </label>
                    <input
                      type="text"
                      value={projectName}
                      onChange={(e) => setProjectName(e.target.value)}
                      placeholder={t('例如: 异星纪元 · 概念先导片 EP01')}
                      className="w-full bg-black/60 border border-white/15 focus:border-violet-500 rounded-xl px-3.5 py-2.5 text-xs text-white placeholder-zinc-500 outline-none transition-all shadow-inner"
                      autoFocus
                    />
                  </div>

                  {/* Description Input */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-zinc-300">{t('工程描述 / 标签 (可选)')}</label>
                    <input
                      type="text"
                      value={projectDesc}
                      onChange={(e) => setProjectDesc(e.target.value)}
                      placeholder={t('例如: 科幻短片 / 角色设定锁定 / 胶片运镜风格')}
                      className="w-full bg-black/60 border border-white/15 focus:border-violet-500 rounded-xl px-3.5 py-2.5 text-xs text-white placeholder-zinc-500 outline-none transition-all shadow-inner"
                    />
                  </div>
                </div>
              </div>

              {/* Section 2: Aspect Ratio Preset */}
              <div className="space-y-3 pt-2">
                <div className="flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-violet-600 text-white text-[11px] font-bold flex items-center justify-center">
                    2
                  </span>
                  <h3 className="text-sm font-bold text-white">{t('默认画幅分辨率')}</h3>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                  {ASPECT_RATIOS.map((ratio) => {
                    const isSelected = selectedRatio === ratio.id;
                    return (
                      <div
                        key={ratio.id}
                        onClick={() => setSelectedRatio(ratio.id)}
                        className={`p-3 rounded-2xl border transition-all cursor-pointer flex flex-col items-center text-center justify-between ${
                          isSelected
                            ? 'bg-violet-600/20 border-violet-500 text-white shadow-lg shadow-violet-600/20'
                            : 'bg-white/[0.03] hover:bg-white/[0.06] border-white/10 text-zinc-400 hover:text-zinc-200'
                        }`}
                      >
                        {/* Aspect Ratio Box Preview */}
                        <div className="w-12 h-10 flex items-center justify-center mb-2">
                          <div
                            className={`rounded-sm border ${isSelected ? 'border-violet-400 bg-violet-500/30' : 'border-zinc-500 bg-white/5'} ${ratio.iconRatio}`}
                          />
                        </div>

                        <div>
                          <div className={`text-xs font-bold ${isSelected ? 'text-white' : ''}`}>
                            {ratio.id}
                          </div>
                          <div className="text-[10px] text-zinc-500 font-mono mt-0.5 truncate max-w-[120px]">
                            {ratio.w}×{ratio.h}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Section 3: Cinematic Workflow Starter Templates */}
              <div className="space-y-3 pt-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-5 h-5 rounded-full bg-violet-600 text-white text-[11px] font-bold flex items-center justify-center">
                      3
                    </span>
                    <h3 className="text-sm font-bold text-white">{t('选择电影生产工作流模板')}</h3>
                  </div>
                  <span className="text-[11px] text-zinc-400">{t('已预配节点连线与画质参数')}</span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                  {TEMPLATES.map((tpl) => {
                    const isSelected = selectedTemplateId === tpl.id;
                    return (
                      <div
                        key={tpl.id}
                        onClick={() => {
                          setSelectedTemplateId(tpl.id);
                          if (tpl.aspectRatio) setSelectedRatio(tpl.aspectRatio);
                        }}
                        className={`p-4 rounded-2xl border transition-all cursor-pointer flex flex-col justify-between space-y-2.5 ${
                          isSelected
                            ? 'bg-gradient-to-br from-violet-950/50 to-indigo-950/40 border-violet-500 text-white shadow-xl shadow-violet-900/30'
                            : 'bg-white/[0.03] hover:bg-white/[0.06] border-white/10 text-zinc-300 hover:text-white'
                        }`}
                      >
                        <div>
                          <div className="flex items-center justify-between mb-1.5">
                            <div className="flex items-center gap-2">
                              <span className={`w-2.5 h-2.5 rounded-full ${isSelected ? 'bg-violet-400 shadow-sm shadow-violet-400' : 'bg-zinc-600'}`} />
                              <h4 className="text-xs font-bold text-white">{t(tpl.name)}</h4>
                            </div>
                            <span className={`text-[10px] px-2 py-0.5 rounded-full border font-sans font-medium ${tpl.badgeColor}`}>
                              {t(tpl.badge)}
                            </span>
                          </div>

                          <p className="text-[11px] text-zinc-400 leading-relaxed">{t(tpl.desc)}</p>
                        </div>

                        {/* Tag pills */}
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {tpl.tags.map((tag) => (
                            <span
                              key={tag}
                              className="text-[9px] font-mono px-2 py-0.5 rounded-md bg-white/[0.05] border border-white/5 text-zinc-400"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Bottom Submit Actions */}
              <div className="flex items-center justify-end gap-3 pt-6 border-t border-white/10">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2.5 rounded-xl text-xs font-semibold text-zinc-400 hover:text-white hover:bg-white/10 cursor-pointer transition-colors"
                >
                  
                  {t('取消')}
                </button>

                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="flex items-center gap-2 px-6 py-2.5 rounded-xl text-xs font-bold bg-gradient-to-r from-violet-600 via-indigo-600 to-cyan-500 hover:from-violet-500 hover:to-cyan-400 text-white shadow-xl shadow-violet-600/30 hover:scale-[1.02] active:scale-98 cursor-pointer transition-all duration-200"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polygon points="5 3 19 12 5 21 5 3" />
                  </svg>
                  <span>{isSubmitting ? t('正在构建工程画布...') : t('✦ 立即创建并进入画布')}</span>
                </button>
              </div>
            </form>
          )}
        </div>
      </div>,
      document.body
    );
}
