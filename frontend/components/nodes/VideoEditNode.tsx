'use client';
import { useSyncedText } from '@/hooks/useSyncedText';
import { GearIcon } from '@/components/ui/icons';

import { useState, useCallback, useEffect, useRef, memo } from 'react';
import { areNodePropsEqual, copyTextToClipboard, downloadFile } from '@/lib/utils';
import { NodeProps, useReactFlow } from '@xyflow/react';
import IconHandle from './IconHandle';
import { VideoEditNode as VideoEditNodeType, VideoEditNodeData } from '@/lib/types';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { cardBody, header, label, selectedShadow, defaultShadow } from './PromptNode';
import NodeShell from './NodeShell';
import { NodeHeaderIconButton } from './nodeChrome';
import { useAutoHeightNode } from '@/hooks/useAutoHeightNode';
import GeneratingLine from './GeneratingLine';
import VideoPreviewModal from './VideoPreviewModal';
import { useConnectedInputs } from '@/hooks/useConnectedInputs';
import { useJobResult } from '@/hooks/useJobPoller';
import { BACKEND_URL as API_BASE, posterUrl } from '@/lib/config';
import { calculateH3Resolution } from './VideoGenNode';
import RichPromptEditor from './RichPromptEditor';
import NodeErrorBanner from './NodeErrorBanner';
import { SeedControl, resolveSeedForGeneration } from './SeedControl';
import SubmittedResourcesPanel from './SubmittedResourcesPanel';
import { showAlert } from '@/components/ui/Dialog';
import NodeVideoPlayer from './NodeVideoPlayer';
import { NATIVE_VIDEO_CHROME_OFF } from './mediaChrome';
import { t } from '@/lib/i18n';
import SegmentRangePicker, { type RangeZone } from './SegmentRangePicker';

const H3_LENGTH_OPTIONS = [
  { label: '5.1s (124帧)', frames: 124, duration: 5.1 },
  { label: '7.3s (175帧)', frames: 175, duration: 7.3 },
  { label: '9.4s (226帧)', frames: 226, duration: 9.4 },
  { label: '15.0s (362帧)', frames: 362, duration: 15.0 },
];

const H3_RESOLUTION_OPTIONS = [
  { label: '1376×768 (16:9 电影宽幅)', width: 1376, height: 768 },
  { label: '768×1376 (9:16 竖屏短剧)', width: 768, height: 1376 },
  { label: '1280×720 (720p HD)', width: 1280, height: 720 },
  { label: '1024×1024 (1:1 方形)', width: 1024, height: 1024 },
];

/**
 * The H3 edit operations. Each is its own node type with its own inputs and its
 * own body; they share this component because they share a job lifecycle, a
 * prompt pipeline and a result view.
 */
export type H3EditMode = 'edit' | 'temporal_reshot' | 'av_bridge' | 'continuation' | 'fl2va';

interface ModeSpec {
  title: string;
  desc: string;
  handles: Array<'in-video' | 'in-first-frame' | 'in-last-frame' | 'in-character' | 'in-guide-frame' | 'in-audio' | 'in-prompt'>;
  audio: boolean;
  length: boolean;
  resolution: boolean;
  defaultSteps: number;
  placeholder: string;
}

export const EDIT_MODE_SPECS: Record<H3EditMode, ModeSpec> = {
  temporal_reshot: {
    title: '重拍一段 · 前后不动',
    desc: '选中的时间段从头重新生成（动作会变），可接参考图；区间外画面和原音轨不动',
    handles: ['in-video', 'in-character', 'in-prompt'],
    audio: false, length: false, resolution: false, defaultSteps: 20,
    placeholder: '这一段要改成什么，例如：她在这里停顿一下再抬头看向门口…',
  },
  // The H3 AV bridge: both ends of the window are frozen in latent space and
  // only the middle is generated. It carries no reference images or audio —
  // the two frozen ends are the only anchor — so what the repair should look
  // like has to be written in the prompt.
  av_bridge: {
    title: '重拍中间 · 两端冻住',
    desc: '冻住选区前后，只重新生成中间；接不了参考图，音色跟着原声',
    handles: ['in-video', 'in-prompt'],
    audio: false, length: false, resolution: false, defaultSteps: 20,
    placeholder: '中间这段要演什么，全部写清楚（这条路看不到参考图）…',
  },
  edit: {
    title: '改原片 · 动作不变',
    desc: '原片当底：动作、运镜、声音全保留，只改外观（加道具、换光、换装）；可只改其中一段',
    handles: ['in-video', 'in-character', 'in-audio', 'in-prompt', 'in-guide-frame'],
    audio: true, length: true, resolution: true, defaultSteps: 4,
    placeholder: '输入修改意图，例如：把男主替换为图1的角色，保持原视频的运镜节奏和对白，背景调整为黄昏雨夜…',
  },
  continuation: {
    title: '往后续拍',
    desc: '沿用原视频结尾与音轨，向后延伸新剧情',
    handles: ['in-video', 'in-character', 'in-audio', 'in-prompt'],
    audio: true, length: true, resolution: true, defaultSteps: 4,
    placeholder: '接下来发生什么，例如：他放下杯子，起身走向窗边…',
  },
  fl2va: {
    title: '首尾帧补中间',
    desc: '给定起始画面与结束画面，生成中间的连贯镜头',
    handles: ['in-first-frame', 'in-last-frame', 'in-character', 'in-audio', 'in-prompt'],
    audio: true, length: true, resolution: true, defaultSteps: 4,
    placeholder: '从首帧到尾帧之间发生了什么…',
  },
};

const AUDIO_STRATEGIES = [
  { id: 'copy_source', label: '✦ 原音复用', desc: '1:1 继承原视频环境音与对白' },
  { id: 'revoice', label: '◈ 智能换声', desc: '绑定新声音音色重塑台词' },
  { id: 'new', label: '✧ 重生音效', desc: '根据修改内容全新生成音轨' },
];


function H3EditNode({ id, data, selected, mode }: NodeProps<VideoEditNodeType> & { mode: H3EditMode }) {
  const spec = EDIT_MODE_SPECS[mode];
  const { updateNodeData, getNodes, setNodes } = useReactFlow();
  const connected = useConnectedInputs(id);
  const comfyuiOnline = useStore((s) => s.comfyuiOnline);
  const activeAudioNodeId = useStore((s) => s.activeAudioNodeId);
  const setActiveAudioNodeId = useStore((s) => s.setActiveAudioNodeId);
  const settings = useStore((s) => s.settings);
  const isAudioActive = activeAudioNodeId === id;

  const [showSettings, setShowSettings] = useState(false);
  const [showAdvancedPrompt, setShowAdvancedPrompt] = useState(false);
  const [showCompiledPrompt, setShowCompiledPrompt] = useState(false);
  // The backend sent the prompt through untouched: showing it again says nothing.
  const editCompiledSame = typeof data.compiledPrompt === 'string' && !data.promptWasModified && (
    data.compiledPrompt.trim().startsWith('(same as')
    || data.compiledPrompt.trim() === String(data.prompt || '').trim());
  const [compiledCopied, setCompiledCopied] = useState(false);
  const [localIntent, setLocalIntent] = useSyncedText((data.userIntent as string) || '');
  const [localPrompt, setLocalPrompt] = useSyncedText((data.prompt as string) || '');
  const [isCompilingPrompt, setIsCompilingPrompt] = useState(false);
  const [compileStage, setCompileStage] = useState('');
  const [compileWarning, setCompileWarning] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playToken, setPlayToken] = useState(0);
  const [videoTime, setVideoTime] = useState(0);
  const [videoDur, setVideoDur] = useState(0);
  // Length of the clip being repaired (not of the result): bounds the window.
  const [sourceDur, setSourceDur] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'preview' | 'editor'>('editor');
  const cancelledRef = useRef(false);
  const fittedUrlRef = useRef<string | null>(null);
  const lastAdoptedPrimaryId = useRef<string | null>(null);
  const prevGeneratedUrlRef = useRef<string | null>(data.generatedUrl as string | null);
  const prevStatusRef = useRef<string>((data.status as string) || 'idle');
  const isInitialMountRef = useRef(true);

  useEffect(() => {
    if (isInitialMountRef.current) {
      isInitialMountRef.current = false;
      if (data.generatedUrl) {
        setViewMode('preview');
        if (videoRef.current) {
          videoRef.current.pause();
          setIsPlaying(false);
        }
      }
      return;
    }

    const prevUrl = prevGeneratedUrlRef.current;
    const curUrl = data.generatedUrl as string | null;
    const prevStatus = prevStatusRef.current;
    const curStatus = (data.status as string) || 'idle';

    prevGeneratedUrlRef.current = curUrl;
    prevStatusRef.current = curStatus;

    const justFinished = (prevStatus === 'generating' && curStatus !== 'generating' && curUrl) || (curUrl && curUrl !== prevUrl);

    if (justFinished) {
      setViewMode('preview');
      if (settings.autoplayOnComplete) {
        if (settings.unmuteOnComplete) setActiveAudioNodeId(id);
        // The <video> is usually not mounted yet (poster is up), so ask the player.
        setPlayToken((n) => n + 1);
      } else {
        videoRef.current?.pause();
        setIsPlaying(false);
      }
    }
  }, [data.generatedUrl, data.status, settings.autoplayOnComplete, settings.unmuteOnComplete, setActiveAudioNodeId, id]);

  useEffect(() => {
    if (showModal && videoRef.current) {
      videoRef.current.pause();
      setIsPlaying(false);
    }
  }, [showModal]);


  useEffect(() => {
    setNodes(nds => nds.map(n => {
      if (n.id !== id) return n;
      if (n.width && n.height) return n;
      return { ...n, width: n.width || 340, height: n.height || 360 };
    }));
  }, [id, setNodes]);

  useEffect(() => {
    if (!data.generatedUrl) fittedUrlRef.current = null;
  }, [data.generatedUrl]);

  const jobResult = useJobResult(data.jobId as string | undefined);
  useEffect(() => {
    if (!jobResult || cancelledRef.current) return;
    if (jobResult.status === 'done' && jobResult.url) {
      updateNodeData(id, {
        status: 'done',
        generatedUrl: jobResult.url as string,
        latentFilename: (jobResult as any).latent_filename as string | undefined,
        // A bridge's latent covers only its own span; where that span sits in the
        // assembled clip is what lets its HD version be put together later.
        latentSpan: (jobResult as any).latent_span as Record<string, unknown> | undefined,
        compiledPrompt: (jobResult as any).compiled_prompt as string | undefined,
        compiledPromptMode: (jobResult as any).mode as string | undefined,
        promptWasModified: Boolean((jobResult as any).prompt_was_modified),
        submittedResources: (jobResult as any).submitted_resources,
        editSeams: (jobResult as any).seams,
        continueTail: (jobResult as any).continue_tail,
        jobId: undefined,
      });
    } else if (jobResult.status === 'error') {
      updateNodeData(id, { status: 'error', error: (jobResult.error as string) || 'Video edit failed', jobId: undefined });
    } else if (jobResult.status === 'cancelled') {
      // Cancelled elsewhere (another tab, the API, a script): stop waiting on it.
      updateNodeData(id, { status: 'idle', jobId: undefined, error: undefined });
    }
  }, [jobResult]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!data.generatedUrl) {
      setVideoSrc(null);
      return;
    }
    setVideoSrc(`${API_BASE}${data.generatedUrl}`);
  }, [data.generatedUrl]);

  useEffect(() => {
    if (data.status === 'generating') {
      if (videoRef.current) {
        videoRef.current.pause();
      }
      setIsPlaying(false);
    }
  }, [data.status]);

  useEffect(() => {
    if (data.generatedUrl && data.status !== 'generating' && videoRef.current) {
      videoRef.current.currentTime = 0;
      videoRef.current.play().catch(() => {});
      setIsPlaying(true);
    }
  }, [data.generatedUrl, data.status]);

  // Sync DOM muted property with global audio exclusivity state
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.muted = !isAudioActive;
    }
  }, [isAudioActive]);

  useEffect(() => {
    setLocalPrompt(data.prompt || '');
  }, [data.prompt]);

  useEffect(() => {
    setLocalIntent(data.userIntent || '');
  }, [data.userIntent]);

  // Connected inputs classification
  const connectedPrompts = connected.filter((n) => n.type === 'prompt' || n.targetHandle === 'in-prompt');
  const connectedPromptText = connectedPrompts.map((n) => n.text).filter(Boolean).join(' ');

  // Source Videos (<Video 1>, ...)
  const sourceVideoInputs = connected.filter(
    (n) => n.targetHandle === 'in-video' || (n.mediaType === 'video' && n.targetHandle !== 'in-first-frame' && n.targetHandle !== 'in-last-frame')
  );
  const sourceVideoUrls = sourceVideoInputs.map((n) => (n.generatedUrl || n.url) as string).filter(Boolean);

  // First & Last Frames (FL2VA / I2VA / L2VA)
  const firstFrameInput = connected.find((n) => n.targetHandle === 'in-first-frame' || n.targetHandle === 'in-image');
  const firstFrameUrl = firstFrameInput ? ((firstFrameInput.generatedUrl || firstFrameInput.url) as string) : null;

  const lastFrameInput = connected.find((n) => n.targetHandle === 'in-last-frame');
  const lastFrameUrl = lastFrameInput ? ((lastFrameInput.generatedUrl || lastFrameInput.url) as string) : null;

  // Reference Images (<Picture 1>, <Picture 2>, ...)
  const refImageInputs = connected.filter(
    (n) => n.targetHandle === 'in-character' || n.targetHandle === 'in-ref-image' || n.targetHandle === 'in-style'
  );
  const refImageUrls = refImageInputs.map((n) => (n.generatedUrl || n.url) as string).filter(Boolean);
  const refImageAliases = refImageInputs.map((n) => n.alias || '');
  const isNotImageMedia = (url: string | null | undefined) => {
    if (!url) return false;
    const clean = url.split('?')[0].toLowerCase();
    return !clean.endsWith('.png') && !clean.endsWith('.jpg') && !clean.endsWith('.jpeg') && !clean.endsWith('.webp') && !clean.endsWith('.bmp') && !clean.endsWith('.gif');
  };

  // Audio References (<Audio 1>, ...)
  const refAudioInputs = connected.filter((n) => (n.targetHandle === 'in-audio' || n.targetHandle === 'in-ref-audio') && isNotImageMedia(n.url || n.generatedUrl));
  const refAudioUrls = refAudioInputs.map((n) => (n.url || n.generatedUrl) as string).filter(Boolean);

  // Primary media reference (source video > first frame > picture 1)
  const primaryMediaNode = sourceVideoInputs[0] || firstFrameInput || refImageInputs[0];

  useEffect(() => {
    if (primaryMediaNode && !data.generatedUrl) {
      if (lastAdoptedPrimaryId.current !== primaryMediaNode.id) {
        lastAdoptedPrimaryId.current = primaryMediaNode.id;

        const updates: Partial<VideoEditNodeData> = {};

        // 1. Adopt resolution (画幅分辨率)
        if (primaryMediaNode.width && primaryMediaNode.height) {
          const targetRes = calculateH3Resolution(primaryMediaNode.width, primaryMediaNode.height);
          if (data.width !== targetRes.width || data.height !== targetRes.height) {
            updates.width = targetRes.width;
            updates.height = targetRes.height;
          }
        }

        // 2. Adopt inference steps (推理档位)
        if (primaryMediaNode.steps && data.steps !== primaryMediaNode.steps) {
          updates.steps = primaryMediaNode.steps;
        }

        // 3. Adopt length / duration (镜头时长)
        if (primaryMediaNode.length && data.length !== primaryMediaNode.length) {
          updates.length = primaryMediaNode.length;
          updates.duration = primaryMediaNode.duration || primaryMediaNode.length / 24;
        }

        if (Object.keys(updates).length > 0) {
          updateNodeData(id, updates);
        }
      }
    }
  }, [
    primaryMediaNode?.width,
    primaryMediaNode?.height,
    primaryMediaNode?.steps,
    primaryMediaNode?.length,
    primaryMediaNode?.duration,
    primaryMediaNode?.id,
    data.generatedUrl,
    id,
    updateNodeData,
    data.width,
    data.height,
    data.steps,
    data.length,
  ]);

  const currentMode: H3EditMode = mode;
  const currentAudioStrategy = spec.audio ? (data.audioStrategy || 'copy_source') : 'copy_source';
  const currentLength = data.length || 124;
  const currentSteps = data.steps || spec.defaultSteps;

  // What the frame grids actually allow for the window in the fields above.
  // Resolved by the backend rather than duplicated here: the rules (preserved
  // runs of 39/90/141/192, targets of 5+17k, and a target that must clear twice
  // the preserve) are the render's rules, and a second copy of them would drift.
  const [bridgePlan, setBridgePlan] = useState<Awaited<ReturnType<typeof api.planAvBridge>> | null>(null);
  const bridgeStart = Math.max(0, Math.round((data.reshotStartSeconds ?? 0) * 24));
  const bridgeCount = Math.max(1, Math.round((data.reshotDurationSeconds ?? 3) * 24));
  const bridgeContext = data.bridgeContextFrames ?? 39;
  const bridgeSource = sourceVideoUrls[0];
  useEffect(() => {
    if (currentMode !== 'av_bridge' || !bridgeSource) { setBridgePlan(null); return; }
    let live = true;
    const timer = setTimeout(() => {
      void api.planAvBridge({
        video_url: bridgeSource.startsWith('http') ? bridgeSource : `${API_BASE}${bridgeSource}`,
        prompt: '', start_frame: bridgeStart, frame_count: bridgeCount,
        context_frames: bridgeContext,
      }).then((plan) => { if (live) setBridgePlan(plan); })
        .catch(() => { if (live) setBridgePlan(null); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [currentMode, bridgeSource, bridgeStart, bridgeCount, bridgeContext]);
  // Edit mode with a window: the range is edited from its own frames and spliced back.
  const editWindow = currentMode === 'edit' && Boolean(data.editWindowEnabled);
  const continueTail = currentMode === 'continuation' && !data.continueFullSource;
  // 去水印 / 去字幕: whole clip, prompt written by the backend.
  const cleanup = currentMode === 'edit' && Boolean(data.cleanupRemoveWatermark || data.cleanupRemoveSubtitles);
  const rangeStartFrame = Math.round((data.reshotStartSeconds ?? 0) * 24);
  const rangeFrames = Math.max(1, Math.round((data.reshotDurationSeconds ?? Math.min(3, sourceDur || 3)) * 24));
  const rangeZones: RangeZone[] = currentMode === 'av_bridge'
    ? (bridgePlan?.ok && bridgePlan.preserve != null && bridgePlan.head_end != null && bridgePlan.tail_start != null
      ? [
          { start: bridgePlan.head_end - bridgePlan.preserve, end: bridgePlan.head_end, kind: 'context', label: t('冻住（原样保留，作为衔接）') },
          { start: bridgePlan.head_end, end: bridgePlan.tail_start, kind: 'regen', label: t('重新生成') },
          { start: bridgePlan.tail_start, end: bridgePlan.tail_start + bridgePlan.preserve, kind: 'context', label: t('冻住（原样保留，作为衔接）') },
        ]
      : [])
    : editWindow
    ? [{ start: rangeStartFrame, end: rangeStartFrame + rangeFrames, kind: 'regen', label: t('按原帧编辑（只替换这段）') }]
    : currentMode === 'temporal_reshot'
    ? [
        { start: Math.max(0, rangeStartFrame - (data.reshotContextBefore ?? 39)), end: rangeStartFrame, kind: 'context', label: t('上下文（参考，不改）') },
        { start: rangeStartFrame, end: rangeStartFrame + rangeFrames, kind: 'regen', label: t('重新生成') },
        { start: rangeStartFrame + rangeFrames, end: rangeStartFrame + rangeFrames + (data.reshotContextAfter ?? 39), kind: 'context', label: t('上下文（参考，不改）') },
      ]
    : [];
  const rangeStatus: { text: string; tone: 'info' | 'error' | 'pending' } | undefined = currentMode === 'av_bridge'
    ? bridgePlan === null
      ? { text: t('正在按帧栅格核算…'), tone: 'pending' }
      : bridgePlan.ok
      ? {
          text: t('实际重新生成 {v1} 帧（{v2}s），前后各冻住 {v3} 帧；其余原样保留', {
            v1: String(bridgePlan.middle ?? 0),
            v2: (bridgePlan.middle_seconds ?? 0).toFixed(2),
            v3: String(bridgePlan.preserve ?? 0),
          }) + (bridgePlan.middle !== rangeFrames ? t('（按模型帧栅格从 {v1} 帧对齐）', { v1: String(rangeFrames) }) : ''),
          tone: 'info',
        }
      : { text: bridgePlan.error || t('这个区间放不下'), tone: 'error' }
    : currentMode === 'temporal_reshot'
    ? { text: t('重新生成 {v1} 帧；区间外画面与原音轨保持不变', { v1: String(rangeFrames) }), tone: 'info' }
    : undefined;
  // Every image on in-guide-frame is pinned through its own MiniMaxH3AddGuide at
  // data.guideFrameIndexes[i] (edge order). Numbers are SOURCE frames; the backend maps
  // them into the edit window and drops any that fall outside it.
  const guideFrameNodes = connected.filter((n) => n.targetHandle === 'in-guide-frame');
  const guideFrameIndexes = (data.guideFrameIndexes || []) as (number | null)[];
  const guideFrameDefault = editWindow ? Math.max(0, rangeStartFrame) : 0;
  const guideFrames = guideFrameNodes.map((n, i) => ({
    url: (n.generatedUrl || n.url) as string,
    frame_index: Number(guideFrameIndexes[i] ?? guideFrameDefault),
  })).filter((g) => !!g.url);
  const setGuideFrameIndex = (i: number, v: number) => {
    const next = guideFrameNodes.map((_, j) => Number(guideFrameIndexes[j] ?? guideFrameDefault));
    next[i] = v;
    updateNodeData(id, { guideFrameIndexes: next });
  };
  const currentWidth = data.width || 1376;
  const currentHeight = data.height || 768;

  const effectivePrompt = localPrompt || connectedPromptText || '';
  const isGenerating = data.status === 'generating';
  const hasPromptInput = Boolean(effectivePrompt.trim() || localIntent.trim());
  const isValidToGenerate = Boolean(
    currentMode === 'temporal_reshot'
      ? hasPromptInput && sourceVideoUrls.length > 0
      : currentMode === 'av_bridge'
      ? hasPromptInput && sourceVideoUrls.length > 0 && bridgePlan?.ok !== false
      : currentMode === 'continuation'
      ? hasPromptInput && sourceVideoUrls.length > 0
      : currentMode === 'fl2va'
      ? Boolean(firstFrameUrl && lastFrameUrl)
      : hasPromptInput || sourceVideoUrls.length > 0 || refImageUrls.length > 0
  );

  // AI Prompt Compiler Trigger
  const handleCompilePrompt = async () => {
    setIsCompilingPrompt(true);
    setCompileWarning('');
    setCompileStage('');
    try {
      // Calculate exact count of actually connected inputs (strictly no fake padding)
      let imageCount = refImageUrls.length;
      if (firstFrameUrl) imageCount += 1;
      if (lastFrameUrl) imageCount += 1;

      const videoCount = sourceVideoUrls.length;
      const audioCount = refAudioUrls.length;
      const intentToUse = localIntent || effectivePrompt || localPrompt || (data.prompt as string) || (data.userIntent as string) || '';

      setCompileStage(t('正在编译提示词…'));
      const { prompt } = await api.compileH3Prompt({
        userIntent: intentToUse,
        mode: currentMode,
        refImagesCount: imageCount,
        refVideosCount: videoCount,
        refAudiosCount: audioCount,
        audioStrategy: currentAudioStrategy,
        duration: currentLength / 24,
      });

      if (prompt) {
        const promptNode = connected.find((n) => n.type === 'prompt' || n.targetHandle === 'in-prompt');
        if (promptNode) {
          updateNodeData(promptNode.id, { text: prompt });
        }
        setLocalPrompt(prompt);
        updateNodeData(id, { prompt, userIntent: intentToUse });
        setShowAdvancedPrompt(true);
        window.dispatchEvent(new Event('takeSnapshot'));
      }
    } catch (e: any) {
      void showAlert(t('提示词编译失败: {v1}', { v1: e.message }), { title: t('操作失败'), danger: true });
    } finally {
      setIsCompilingPrompt(false);
      setCompileStage('');
    }
  };

  const handleCancel = useCallback(async () => {
    cancelledRef.current = true;
    if (data.jobId) {
      try {
        await api.cancelJob(data.jobId as string);
      } catch {}
    }
    updateNodeData(id, { status: 'idle', jobId: undefined, error: undefined });
  }, [id, updateNodeData, data.jobId]);

  const handleGenerate = useCallback(async () => {
    if (!isValidToGenerate) return;
    cancelledRef.current = false;
    if (videoRef.current) {
      videoRef.current.pause();
    }
    setIsPlaying(false);
    updateNodeData(id, {
      status: 'generating',
      jobId: undefined,
      error: undefined,
      compiledPrompt: undefined,
      compiledPromptMode: undefined,
      promptWasModified: undefined,
      submittedResources: undefined,
    });
    setShowCompiledPrompt(false);

    try {
      const { effectiveSeed, nextSeedToStore } = resolveSeedForGeneration(
        data.seed as number | undefined,
        data.seedMode as any,
        81000
      );

      if (data.seedMode === 'random') {
        updateNodeData(id, { seed: nextSeedToStore });
      }

      const absoluteUrl = (u: string) => u.startsWith('http') || u.startsWith('data:') ? u : `${API_BASE}${u}`;
      const reshotStartFrame = Math.max(0, Math.round((data.reshotStartSeconds ?? 0) * 24));
      const requestedReshotFrames = Math.max(1, Math.round((data.reshotDurationSeconds ?? Math.min(3, sourceDur || 3)) * 24));
      const sourceFrames = sourceDur > 0 ? Math.max(1, Math.round(sourceDur * 24)) : 0;
      const reshotFrameCount = sourceFrames > 0
        ? Math.max(1, Math.min(requestedReshotFrames, sourceFrames - reshotStartFrame))
        : requestedReshotFrames;
      const request = cleanup
        ? api.cleanupVideo({
            source_url: absoluteUrl(sourceVideoUrls[0]),
            remove_watermark: Boolean(data.cleanupRemoveWatermark),
            remove_subtitles: Boolean(data.cleanupRemoveSubtitles),
            watermark_hint: String(data.cleanupWatermarkHint || ''),
            scene_hint: String(data.cleanupSceneHint || ''),
            seed: effectiveSeed,
            steps: currentSteps,
          })
        : currentMode === 'av_bridge'
        ? api.avBridge({
            video_url: absoluteUrl(sourceVideoUrls[0]),
            prompt: effectivePrompt || localIntent || '',
            start_frame: reshotStartFrame,
            frame_count: reshotFrameCount,
            context_frames: data.bridgeContextFrames ?? 39,
            // 20 steps, no acceleration LoRA: what the pack's own example runs.
            steps: currentSteps,
            seed: effectiveSeed,
          })
        : currentMode === 'temporal_reshot'
        ? api.temporalReshot({
            video_url: absoluteUrl(sourceVideoUrls[0]),
            prompt: effectivePrompt || localIntent || '',
            start_frame: reshotStartFrame,
            frame_count: reshotFrameCount,
            context_before: data.reshotContextBefore ?? 39,
            context_after: data.reshotContextAfter ?? 39,
            edge_blend_frames: data.reshotEdgeBlendFrames ?? 0,
            ref_image_urls: refImageUrls.map(absoluteUrl),
            steps: currentSteps,
            seed: effectiveSeed,
            // Turbo is useful for previews, but controlled tests showed that it
            // can preserve the source instead of obeying conspicuous edits.
            lora_name: currentSteps <= 8
              ? 'h3/minimax_h3_turbo_v4_step600_ema_pruned_comfyui.safetensors'
              : '',
            lora_strength: currentSteps <= 8 ? 1 : 0,
            condition_source_audio: false,
          })
        : (editWindow
          ? (body: Parameters<typeof api.editVideo>[0]) => api.editVideoWindow({ ...body, start_frame: reshotStartFrame, frame_count: reshotFrameCount })
          : continueTail
          ? (body: Parameters<typeof api.editVideo>[0]) => api.continueVideoTail({ ...body, tail_frames: Math.max(0, Math.round((data.continueTailSeconds ?? 0) * 24)) })
          : api.editVideo)({
        prompt: effectivePrompt || localIntent || '',
        mode: currentMode,
        image_url: firstFrameUrl ? (firstFrameUrl.startsWith('blob:') ? firstFrameUrl : `${API_BASE}${firstFrameUrl}`) : null,
        last_frame_url: lastFrameUrl ? (lastFrameUrl.startsWith('blob:') ? lastFrameUrl : `${API_BASE}${lastFrameUrl}`) : null,
        ref_image_urls: refImageUrls.map((u) => (u.startsWith('http') ? u : `${API_BASE}${u}`)),
        ref_video_urls: sourceVideoUrls.map((u) => (u.startsWith('http') ? u : `${API_BASE}${u}`)),
        ref_audio_urls: refAudioUrls.map((u) => (u.startsWith('http') ? u : `${API_BASE}${u}`)),
        audio_strategy: currentAudioStrategy,
        width: currentWidth,
        height: currentHeight,
        steps: currentSteps,
        length: currentLength,
        seed: effectiveSeed,
        fps: 24,
        guide_frames: currentMode === 'edit' && guideFrames.length
          ? guideFrames.map((g) => ({ url: absoluteUrl(g.url), frame_index: g.frame_index }))
          : undefined,
      });
      const { job_id } = await request;

      if (cancelledRef.current) return;
      // Recorded at submit, not read back off the settings: the step selector can
      // be changed afterwards, and the overlay describes the clip on screen.
      updateNodeData(id, { jobId: job_id, generatedSteps: currentSteps });
    } catch (e: any) {
      if (!cancelledRef.current) {
        updateNodeData(id, { status: 'error', error: e.message, jobId: undefined });
      }
    }
  }, [
    isValidToGenerate,
    effectivePrompt,
    localIntent,
    currentMode,
    firstFrameUrl,
    lastFrameUrl,
    refImageUrls,
    sourceVideoUrls,
    refAudioUrls,
    guideFrames,
    currentAudioStrategy,
    currentWidth,
    currentHeight,
    currentSteps,
    currentLength,
    data.seed,
    data.reshotStartSeconds,
    data.reshotDurationSeconds,
    data.reshotContextBefore,
    data.reshotContextAfter,
    data.reshotEdgeBlendFrames,
    data.cleanupRemoveWatermark,
    data.cleanupRemoveSubtitles,
    sourceDur,
    bridgePlan,
    id,
    updateNodeData,
  ]);

  // Frame capture
  const handleScreenshot = useCallback(async (videoEl?: HTMLVideoElement) => {
    const nodes = getNodes();
    const video = videoEl || videoRef.current;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0 || video.readyState < 2) {
      void showAlert(t('视频正在加载中，请稍候…'));
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    try {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) return;
      const file = new File([blob], `shot-${Date.now()}.png`, { type: 'image/png' });
      const { url, comfy_filename } = await api.uploadStyleReference(file);

      const currentNode = nodes.find((n) => n.id === id);
      const selfX = currentNode?.position?.x ?? 0;
      const selfY = currentNode?.position?.y ?? 0;
      const selfWidth = currentNode?.measured?.width ?? currentNode?.width ?? 320;

      const newNode = {
        id: `img-shot-${Date.now()}`,
        type: 'image',
        position: { x: selfX + selfWidth + 40, y: selfY },
        data: {
          url,
          comfyFilename: comfy_filename,
          width: video.videoWidth,
          height: video.videoHeight,
        },
        selected: true,
        zIndex: 1000,
        width: 240,
        height: 32 + Math.min(Math.round((240 * video.videoHeight) / video.videoWidth), 480),
      };

      setNodes((nds) => [...nds.map((n) => ({ ...n, selected: false })), newNode]);
    } catch (e) {
      console.error('Snapshot capture failed:', e);
    }
  }, [getNodes, id, setNodes]);

  const fmt = (t: number) => {
    const s = Math.floor(t);
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  };

  // 与 H3 生成节点同理：只有预览态在放画面，编辑态整块是控件与文本
  const showsMedia = Boolean(data.generatedUrl) && viewMode === 'preview';
  // 首次生成时还没有成片，但目标分辨率已定、整块被生成遮罩盖住：按成片比例占位，
  // 不让长提示词把表单撑成竖条（2026-09-19）
  const firstRender = data.status === 'generating' && !data.generatedUrl;

  // Only the width is kept. The picture sits in an aspect-ratio box, the editor view is as tall as its content (capped,
  // then it scrolls), and the settings drawer is a row in the flow: the card's own layout is its height.
  const sizing = useAutoHeightNode({
    id,
    ratioSources: [
      { width: data.width as number | undefined, height: data.height as number | undefined },
    ],
    hasMedia: showsMedia || firstRender,
    mediaHidden: showsMedia && showSettings,
    userWidth: data.userWidth as number | undefined,
    defaultW: 360,
  });

  return (
    <NodeShell
      nodeId={id}
      spec={sizing.spec}
      selected={selected}
      onResizeEnd={sizing.onResizeEnd}
      autoHeight
    >
      {/* 功能区与设置抽屉。抽屉是流内一行：打开撑高节点，关上还原 */}
      <div className="node-shell-headwrap" style={{ position: 'relative', flex: '0 0 auto' }}>
        {/* Header */}
        <div style={header} data-chrome-row="header" className="node-shell-header flex items-center justify-between">
          <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-white/[0.05] border border-white/[0.08] text-zinc-300">
            <WandIcon />
            <span style={label} className="text-zinc-200" data-chrome="label">
              
              {t(spec.title)}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <NodeHeaderIconButton
              active={showSettings}
              onClick={() => setShowSettings(!showSettings)}
              title={t('编辑规格与参数')}
            >
              <GearIcon />
            </NodeHeaderIconButton>
          </div>
        </div>

        {/* 设置抽屉：绝对定位浮层，不占节点高度 */}
        {showSettings && (
          <div data-chrome-row="settings" className="node-shell-drawer nodrag nowheel p-3 text-xs space-y-3 animate-in fade-in duration-150">
            {currentMode === 'temporal_reshot' && (
              <div className="space-y-1.5">
                <div className="text-[10px] font-medium text-zinc-400">{t('上下文与融合')}</div>
                <div className="grid grid-cols-3 gap-1.5">
                  {[
                    [t('前文帧'), 'reshotContextBefore', 39],
                    [t('后文帧'), 'reshotContextAfter', 39],
                    [t('融合帧'), 'reshotEdgeBlendFrames', 0],
                  ].map(([title, key, fallback]) => (
                    <label key={String(key)} className="text-[9px] text-zinc-500">{title}
                      <input type="number" min={0} step={1}
                        value={(data[key as keyof VideoEditNodeData] as number | undefined) ?? Number(fallback)}
                        onChange={(e) => updateNodeData(id, { [key]: Math.max(0, Math.round(Number(e.target.value))) })}
                        className="mt-1 w-full rounded bg-black/30 border border-white/10 px-1.5 py-1 text-zinc-200" />
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* Audio Strategy */}
            {spec.audio && (
            <div>
              <div className="text-[10px] text-zinc-400 font-medium mb-1.5 flex justify-between">
                <span>{t('音轨调度策略')}</span>
                <span className="font-mono text-zinc-200">{currentAudioStrategy}</span>
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                {AUDIO_STRATEGIES.map((opt) => (
                  <button
                    key={opt.id}
                    onClick={() => updateNodeData(id, { audioStrategy: opt.id })}
                    className={`py-1 px-1.5 text-[10px] rounded-lg border text-center transition-colors cursor-pointer ${
                      currentAudioStrategy === opt.id
                        ? 'bg-white/20 border-white/40 text-white font-semibold shadow-xs'
                        : 'bg-white/[0.03] border-white/10 text-zinc-400 hover:text-white hover:bg-white/[0.08]'
                    }`}
                    title={opt.desc}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            )}

            {/* Steps & Duration */}
            <div className="grid grid-cols-2 gap-2 pt-1 border-t border-white/5">
              <div>
                <span className="text-[10px] text-zinc-400 block mb-1">{t('推理档位')}</span>
                <select
                  value={currentSteps}
                  onChange={(e) => updateNodeData(id, { steps: Number(e.target.value) })}
                  className="w-full bg-white/[0.04] border border-white/10 rounded-lg px-2 py-1 text-xs text-zinc-200 outline-none"
                >
                  <option value={4} className="bg-[#121218]">{t('4步 Turbo 预览')}</option>
                  <option value={8} className="bg-[#121218]">{t('8步 Turbo 预览')}</option>
                  <option value={20} className="bg-[#121218]">{t('20步 基础模型（高服从）')}</option>
                </select>
              </div>
              {spec.length && (
              <div>
                <span className="text-[10px] text-zinc-400 block mb-1">{currentMode === 'continuation' ? t('续写时长') : t('镜头时长')}</span>
                <select
                  value={currentLength}
                  onChange={(e) => {
                    const frames = Number(e.target.value);
                    const opt = H3_LENGTH_OPTIONS.find(o => o.frames === frames);
                    updateNodeData(id, { length: frames, duration: opt?.duration });
                  }}
                  className="w-full bg-white/[0.04] border border-white/10 rounded-lg px-2 py-1 text-xs text-zinc-200 outline-none"
                >
                  {H3_LENGTH_OPTIONS.map(o => (
                    <option key={o.frames} value={o.frames} className="bg-[#121218]">{o.label}</option>
                  ))}
                </select>
              </div>
              )}
            </div>

            {/* Resolution */}
            {spec.resolution && (
            <div>
              <span className="text-[10px] text-zinc-400 block mb-1">{t('画幅分辨率')}</span>
              <select
                value={`${currentWidth}x${currentHeight}`}
                onChange={(e) => {
                  const [w, h] = e.target.value.split('x').map(Number);
                  updateNodeData(id, { width: w, height: h });
                }}
                className="w-full bg-white/[0.04] border border-white/10 rounded-lg px-2 py-1 text-xs text-zinc-200 outline-none"
              >
                {H3_RESOLUTION_OPTIONS.map((res) => (
                  <option key={`${res.width}x${res.height}`} value={`${res.width}x${res.height}`} className="bg-[#121218]">
                    {res.label}
                  </option>
                ))}
              </select>
            </div>
            )}

            {/* Seed Control */}
            <div className="pt-2 border-t border-white/10">
              <SeedControl
                seed={data.seed as number | undefined}
                seedMode={data.seedMode as any}
                onChange={(newSeed, newMode) => {
                  updateNodeData(id, { seed: newSeed, seedMode: newMode });
                  window.dispatchEvent(new Event('takeSnapshot'));
                }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Main Body */}
      {data.generatedUrl && viewMode === 'preview' ? (
        <div data-node-media style={{ position: 'relative', flex: '0 0 auto', aspectRatio: String(sizing.ratio) }}>
          <div
            style={{ ...cardBody, width: '100%', height: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
          >
            <NodeVideoPlayer
              nodeId={id}
              playToken={playToken}
              src={videoSrc}
              videoRef={videoRef}
              selected={selected}
              holdPlayback={data.status === 'generating'}
              paused={showModal || showSettings}
              onMediaSize={(w, h) => {
                const url = data.generatedUrl as string | null;
                if (url && fittedUrlRef.current !== url) {
                  fittedUrlRef.current = url;
                  sizing.onMediaSize(w, h);
                }
              }}
              info={<>{t(spec.title)} · {currentWidth}×{currentHeight} · {(data.generatedSteps as number | undefined) ?? currentSteps}{t('步')}</>}
              infoRight={
                <span className="text-zinc-300 font-mono flex items-center gap-1 bg-black/60 px-1.5 py-0.5 rounded border border-white/10">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-300">
                    <path d="M12 2v20M17 5v14M7 9v6M22 10v4M2 10v4" />
                  </svg>
                  <span>{currentAudioStrategy === 'copy_source' ? t('原声复用') : currentAudioStrategy === 'revoice' ? t('重塑配音') : t('原生音效')}</span>
                </span>
              }
              actions={<>
                    <div className="node-shell-btnrow flex items-center gap-1">
                      <button
                        onClick={() => setViewMode('editor')}
                        className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white/10 hover:bg-white/20 border border-white/15 text-zinc-200 hover:text-white text-[10px] transition-colors cursor-pointer"
                        title={t('切换到提示词与参数编辑面板')}
                      >
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                        </svg>
                        <span>{t('编辑提示词')}</span>
                      </button>
                      <button
                        onClick={() => handleScreenshot()}
                        className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white/10 hover:bg-white/20 border border-white/15 text-zinc-200 hover:text-white text-[10px] transition-colors cursor-pointer"
                        title={t('抽取当前帧至画布')}
                      >
                        <CameraIcon />
                        <span>{t('抽帧')}</span>
                      </button>
                      <button
                        onClick={() => {
                          if (videoRef.current) {
                            videoRef.current.pause();
                            setIsPlaying(false);
                          }
                          setShowModal(true);
                        }}
                        className="p-1 rounded-lg text-zinc-300 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                        title={t('放大查看')}
                      >
                        <MaximizeIcon />
                      </button>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void downloadFile(`${API_BASE}${data.generatedUrl}`, 'edited-video.mp4', (data as any).alias);
                        }}
                        className="p-1 rounded-lg text-zinc-300 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                        title={t('下载视频')}
                      >
                        <DownloadIcon />
                      </button>
                      <button
                        onClick={handleGenerate}
                        disabled={isGenerating || !comfyuiOnline || !isValidToGenerate}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/15 hover:bg-white/25 border border-white/20 text-white text-[11px] font-medium transition-colors cursor-pointer disabled:opacity-50"
                      >
                        <RegenIcon />
                        <span>{t('重新编辑')}</span>
                      </button>
                    </div>
              </>}
            >
              <GeneratingLine active={isGenerating} jobId={data.jobId as string | undefined} steps={currentSteps} onCancel={handleCancel} />
            </NodeVideoPlayer>
          </div>

          <NodeErrorBanner
            error={data.status === 'error' ? (data.error || t('视频编辑失败')) : null}
            onClear={() => updateNodeData(id, { status: 'idle', error: undefined })}
            title={t('MiniMax H3 视频编辑错误')}
          />
        </div>
      ) : (
        <div data-node-media={firstRender ? '' : undefined} style={{ position: 'relative', flex: '0 0 auto', ...(firstRender ? { aspectRatio: String(sizing.ratio) } : null) }}>
          <div
            style={{ ...cardBody, width: '100%', height: firstRender ? '100%' : 'auto', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
          >
            <div data-shell-content className="relative z-10 w-full flex-1 min-h-[220px] max-h-[640px] p-3.5 flex flex-col justify-between overflow-y-auto space-y-2.5">
              <div>
                {/* Mode & Config Badges + Preview Toggle */}
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-zinc-300 font-medium bg-white/[0.05] border border-white/[0.08] px-2 py-0.5 rounded-md">
                      {t(spec.title)}
                    </span>
                    {data.generatedUrl && (
                      <button
                        type="button"
                        onClick={() => setViewMode('preview')}
                        className="flex items-center gap-1 text-[9px] font-mono text-zinc-200 bg-white/10 hover:bg-white/20 px-1.5 py-0.5 rounded-md border border-white/20 transition-colors cursor-pointer"
                        title={t('返回视频播放预览')}
                      >
                        <PlayIcon />
                        <span>{t('返回视频预览')}</span>
                      </button>
                    )}
                  </div>
                  <span className="text-[9px] font-mono text-zinc-400">
                    {currentWidth}×{currentHeight} · {currentSteps}{t('步 ·')} {currentLength}f ({((currentLength)/24).toFixed(1)}s)
                  </span>
                </div>

                {/* References Status Badges */}
                <div className="flex flex-wrap gap-1.5 mb-2.5 text-[10px] font-mono">
                  {sourceVideoUrls.length > 0 ? (
                    <span className="bg-white/5 border border-white/10 text-zinc-300 px-1.5 py-0.5 rounded flex items-center gap-1">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400">
                        <rect x="2" y="4" width="14" height="16" rx="2" />
                        <path d="M16 8l6-3v14l-6-3V8z" />
                      </svg>
                      <span>{t('已挂载源视频')}</span>
                    </span>
                  ) : (
                    <span className="bg-zinc-800/40 border border-white/5 text-zinc-500 px-1.5 py-0.5 rounded">
                      
                      {t('等待连接源视频')}
                    </span>
                  )}
                  {firstFrameUrl && (
                    <span className="bg-white/5 border border-white/10 text-zinc-300 px-1.5 py-0.5 rounded flex items-center gap-1">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400">
                        <rect x="3" y="3" width="18" height="18" rx="2" />
                      </svg>
                      <span>{t('首帧')}</span>
                    </span>
                  )}
                  {lastFrameUrl && (
                    <span className="bg-white/5 border border-white/10 text-zinc-300 px-1.5 py-0.5 rounded flex items-center gap-1">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400">
                        <rect x="3" y="3" width="18" height="18" rx="2" />
                      </svg>
                      <span>{t('尾帧')}</span>
                    </span>
                  )}
                  {refImageUrls.length > 0 && (
                    <span className="bg-white/5 border border-white/10 text-zinc-300 px-1.5 py-0.5 rounded">
                      {refImageUrls.length}{t('张外观参考')}
                    </span>
                  )}
                  {refAudioUrls.length > 0 && (
                    <span className="bg-white/5 border border-white/10 text-zinc-300 px-1.5 py-0.5 rounded">
                      {refAudioUrls.length}{t('条声音参考')}
                    </span>
                  )}
                </div>

                <p className="mb-2 text-[10px] leading-snug text-zinc-500">{t(spec.desc)}</p>

                {currentMode === 'edit' && sourceVideoUrls[0] && (
                  <label className="mb-2 flex items-center gap-2 text-[10px] text-zinc-400">
                    <input type="checkbox" checked={editWindow}
                      onChange={(e) => updateNodeData(id, { editWindowEnabled: e.target.checked })} />
                    {t('只改选中的时间段（按原帧编辑，区间外画面和原音轨不动）')}
                  </label>
                )}
                {currentMode === 'edit' && sourceVideoUrls[0] && (
                  <div className="mb-2 flex flex-col gap-1 text-[10px] text-zinc-400">
                    <div className="flex items-center gap-3">
                      <span>{t('去水印 / 去字幕')}</span>
                      <label className="flex items-center gap-1">
                        <input type="checkbox" checked={Boolean(data.cleanupRemoveWatermark)}
                          onChange={(e) => updateNodeData(id, { cleanupRemoveWatermark: e.target.checked })} />
                        {t('去水印')}
                      </label>
                      <label className="flex items-center gap-1">
                        <input type="checkbox" checked={Boolean(data.cleanupRemoveSubtitles)}
                          onChange={(e) => updateNodeData(id, { cleanupRemoveSubtitles: e.target.checked })} />
                        {t('去字幕')}
                      </label>
                    </div>
                    {Boolean(data.cleanupRemoveWatermark) && (
                      <>
                        <input className="nodrag w-full rounded bg-zinc-900 border border-zinc-700 px-1.5 py-1 text-[10px] text-zinc-200"
                          placeholder={t('水印是什么样、在哪（如：左上角"AI生成"灰框、抖音logo和下面那行抖音号）')}
                          value={String(data.cleanupWatermarkHint || '')}
                          onChange={(e) => updateNodeData(id, { cleanupWatermarkHint: e.target.value })} />
                        <input className="nodrag w-full rounded bg-zinc-900 border border-zinc-700 px-1.5 py-1 text-[10px] text-zinc-200"
                          placeholder={t('画面是什么（一句话，可不填）')}
                          value={String(data.cleanupSceneHint || '')}
                          onChange={(e) => updateNodeData(id, { cleanupSceneHint: e.target.value })} />
                      </>
                    )}
                    {cleanup && (
                      <span className="text-zinc-500">{t('整段处理：提示词自动生成（下方提示词不使用），尺寸、帧数和原音轨跟随源视频')}</span>
                    )}
                  </div>
                )}
                {currentMode === 'continuation' && sourceVideoUrls[0] && (
                  <div className="mb-2 flex flex-col gap-1 text-[10px] text-zinc-400">
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={continueTail}
                        onChange={(e) => updateNodeData(id, { continueFullSource: !e.target.checked })} />
                      {t('只用源片尾段续写（更快；默认从最后一个切点起，2–15 秒）')}
                    </label>
                    {continueTail && (
                      <label className="flex items-center gap-2 pl-5">
                        {t('尾段秒数')}
                        <input type="number" min={0} max={15} step={0.5}
                          className="nodrag w-14 rounded bg-black/40 px-1 py-0.5 text-zinc-200"
                          value={data.continueTailSeconds ?? 0}
                          onChange={(e) => updateNodeData(id, { continueTailSeconds: Number(e.target.value) || 0 })} />
                        <span className="text-zinc-500">{t('0 = 自动取最后一个镜头')}</span>
                      </label>
                    )}
                    {data.continueTail && (
                      <span className="pl-5 text-zinc-500">
                        {t('上次用了第 {a}–{b} 帧（共 {n} 帧）', { a: data.continueTail.start, b: data.continueTail.source_frames, n: data.continueTail.frames })}
                      </span>
                    )}
                  </div>
                )}
                {currentMode === 'edit' && data.editSeams && (data.editSeams.head != null || data.editSeams.tail != null) && (
                  <p className="mb-2 text-[10px] text-zinc-500">
                    {t('接缝帧差')}: {data.editSeams.head ?? '—'} / {data.editSeams.tail ?? '—'}（{t('平时')} {data.editSeams.typical ?? '—'}）
                  </p>
                )}
                {currentMode === 'edit' && guideFrames.length > 0 && (
                  <div className="mb-3">
                    <div className="text-[10px] text-zinc-400 font-medium">{t('引导帧钉在第几帧（按连线顺序）')}</div>
                    {guideFrames.map((g, i) => (
                      <div key={i} className="mt-1.5 flex items-center gap-1.5 nodrag">
                        <img src={absoluteMediaUrl(g.url)} alt="" className="w-10 h-6 object-cover rounded border border-white/10" />
                        <input
                          type="number"
                          value={g.frame_index}
                          min={0}
                          step={1}
                          onChange={(e) => {
                            const v = Math.round(Number(e.target.value));
                            if (Number.isFinite(v)) setGuideFrameIndex(i, Math.max(0, v));
                          }}
                          className="flex-1 min-w-0 h-6 px-1.5 rounded-lg border border-white/10 bg-black/30 text-[10px] font-mono text-zinc-200 text-center focus:outline-hidden focus:border-white/30"
                        />
                        <span className="w-12 text-right text-[9px] font-mono text-zinc-400">{`${(g.frame_index / 24).toFixed(2)}s`}</span>
                      </div>
                    ))}
                    <div className="mt-1 text-[9px] text-zinc-500">{t('帧号按原片计；只在编辑窗口内生效，窗口外的会被丢弃')}</div>
                  </div>
                )}
                {(currentMode === 'temporal_reshot' || currentMode === 'av_bridge' || editWindow) && (
                  <div className="mb-3">
                    {sourceVideoUrls[0] ? (
                      <SegmentRangePicker
                        sourceUrl={absoluteMediaUrl(sourceVideoUrls[0])}
                        startSeconds={data.reshotStartSeconds ?? 0}
                        durationSeconds={data.reshotDurationSeconds ?? Math.min(3, sourceDur || 3)}
                        onChange={(start, duration) => updateNodeData(id, { reshotStartSeconds: start, reshotDurationSeconds: duration })}
                        onSourceDuration={setSourceDur}
                        zones={rangeZones}
                        status={rangeStatus}
                      />
                    ) : (
                      <EmptyInput text={t('把要修改的视频连到左侧「源视频」接口，在这里选出要重做的片段')} />
                    )}
                    {currentMode === 'av_bridge' && (
                      <label className="mt-2 flex items-center justify-between gap-2 text-[10px] text-zinc-400">
                        <span>{t('选区前后各冻住')}</span>
                        <select
                          value={data.bridgeContextFrames ?? 39}
                          onChange={(e) => updateNodeData(id, { bridgeContextFrames: Number(e.target.value) })}
                          className="rounded bg-black/30 border border-white/10 px-2 py-1 text-zinc-200"
                        >
                          {/* Only these four land on both the 24 fps picture grid and
                              the 40 Hz audio grid; anything else is refused. */}
                          {[39, 90, 141, 192].map((n) => (
                            <option key={n} value={n}>{n} {t('帧')} · {(n / 24).toFixed(2)}s</option>
                          ))}
                        </select>
                      </label>
                    )}
                  </div>
                )}

                {currentMode === 'continuation' && (
                  <div className="mb-3">
                    {sourceVideoUrls[0] ? (
                      <ContinuationPreview
                        sourceUrl={absoluteMediaUrl(sourceVideoUrls[0])}
                        extendSeconds={currentLength / 24}
                        onSourceDuration={setSourceDur}
                      />
                    ) : (
                      <EmptyInput text={t('把要接着拍的视频连到左侧「源视频」接口')} />
                    )}
                  </div>
                )}

                {currentMode === 'fl2va' && (
                  <div className="mb-3 grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                    <FrameSlot url={firstFrameUrl} label={t('首帧')} />
                    <div className="text-center font-mono text-[10px] text-zinc-400">
                      →<div>{(currentLength / 24).toFixed(1)}s</div>
                    </div>
                    <FrameSlot url={lastFrameUrl} label={t('尾帧')} />
                  </div>
                )}

                {/* Natural Language Intent Input + Compiler Trigger */}
                <div className="space-y-1.5 min-h-0">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-zinc-400 font-medium">{t('✦ 编辑意图描述')}</span>
                    <button
                      onClick={handleCompilePrompt}
                      disabled={isCompilingPrompt}
                      className="text-[10px] text-zinc-300 hover:text-white bg-white/10 hover:bg-white/20 border border-white/15 px-2 py-0.5 rounded transition-colors flex items-center gap-1 cursor-pointer disabled:opacity-50"
                    >
                      <span>{isCompilingPrompt ? (compileStage || t('编译中…')) : t('转译为 H3 规范 Prompt')}</span>
                    </button>
                  </div>
                  {compileWarning && (
                    <div className="text-[10px] text-amber-300/90 bg-amber-500/10 border border-amber-500/20 rounded px-2 py-1 leading-snug whitespace-pre-line">
                      {compileWarning}
                    </div>
                  )}
                  <div className="h-[64px]">
                    <RichPromptEditor
                      title={t('视频智能重构意图工作台')}
                      value={localIntent}
                      onChange={(val) => {
                        setLocalIntent(val);
                        updateNodeData(id, { userIntent: val });
                      }}
                      onBlur={() => {
                        if (localIntent !== data.userIntent) updateNodeData(id, { userIntent: localIntent });
                      }}
                      placeholder={t(spec.placeholder)}
                      imageUrls={refImageUrls}
                      aliases={refImageAliases}
                      audioUrls={refAudioUrls}
                      videoUrls={sourceVideoUrls}
                      minHeight={64}
                      maxHeight={64}
                    />
                  </div>
                </div>

                {/* Toggle H3 6-Section Prompt View */}
                <div className="mt-2 min-h-0">
                  <button
                    onClick={() => setShowAdvancedPrompt(!showAdvancedPrompt)}
                    className="text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors flex items-center gap-1 cursor-pointer"
                  >
                    <span>{showAdvancedPrompt ? t('▼ 收起 H3 规范 Prompt') : t('▶ 查看/手动编辑 H3 规范 6 段式 Prompt')}</span>
                  </button>
                  {showAdvancedPrompt && (
                    <div data-node-expand className="shrink-0 mt-1 h-[100px]">
                      <RichPromptEditor
                        title={t('MiniMax H3 六段式电影规范 Prompt')}
                        value={localPrompt}
                        onChange={(val) => {
                          setLocalPrompt(val);
                          updateNodeData(id, { prompt: val });
                        }}
                        onBlur={() => {
                          if (localPrompt !== data.prompt) updateNodeData(id, { prompt: localPrompt });
                        }}
                        placeholder={t('标准 MiniMax H3 6段式 Prompt (subject_definitions, summary, retention_analysis, detailed_description...)')}
                        imageUrls={refImageUrls}
                        aliases={refImageAliases}
                        audioUrls={refAudioUrls}
                        videoUrls={sourceVideoUrls}
                        minHeight={100}
                        maxHeight={100}
                      />
                    </div>
                  )}
                </div>

                {/* Exact prompt attached to the completed generated resource */}
                <div className="mt-2 min-h-0 border-t border-white/10 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowCompiledPrompt((visible) => !visible)}
                    className="w-full flex items-center justify-between text-[10px] text-emerald-300 hover:text-emerald-200 transition-colors cursor-pointer"
                  >
                    <span>{t('✦ 生成资源的编译后提示词')}</span>
                    <span>{showCompiledPrompt ? '▲' : '▼'}</span>
                  </button>
                  {showCompiledPrompt && (
                    <div data-node-expand className="shrink-0 mt-1.5 rounded-lg bg-black/40 border border-emerald-500/25 overflow-hidden">
                      <div className="flex items-center justify-between px-2 py-1 border-b border-white/10">
                        <span className="text-[9px] font-mono text-zinc-400">
                          {data.compiledPrompt
                            ? (editCompiledSame
                              ? t('与提示词一致，未改写')
                              : t('后端实际 Prompt · {v1}', { v1: String(data.compiledPromptMode || currentMode).toUpperCase() }))
                            : t('当前资源暂无已保存的编译结果')}
                        </span>
                        {data.compiledPrompt && (
                          <button
                            type="button"
                            onClick={() => void copyTextToClipboard(data.compiledPrompt as string)
                              .then(() => { setCompiledCopied(true); setTimeout(() => setCompiledCopied(false), 1500); })
                              .catch((error) => void showAlert(error.message))}
                            className="text-[9px] px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20 text-zinc-300 cursor-pointer"
                          >
                            {compiledCopied ? t('✓ 已复制') : t('复制')}
                          </button>
                        )}
                      </div>
                      {!editCompiledSame && (
                      <pre className="p-2 text-[9px] font-mono text-zinc-300 leading-relaxed max-h-48 overflow-y-auto whitespace-pre-wrap break-words">
                        {(data.compiledPrompt as string) || t('请先执行一次视频编辑。新生成的资源会在这里保存并显示后端实际使用的编译后提示词。')}
                      </pre>
                      )}
                      {data.compiledPrompt && (
                        <div className="border-t border-white/10 p-2">
                          <div className="mb-1.5 text-[9px] font-mono text-emerald-300">{t('提交给 ComfyUI 的资源')}</div>
                          <SubmittedResourcesPanel resources={data.submittedResources} />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div data-chrome-row="actions" className="node-shell-actions mt-2 space-y-1.5">
                <div className="px-0.5">
                  <SeedControl
                    compact
                    seed={data.seed as number | undefined}
                    seedMode={data.seedMode as any}
                    onChange={(newSeed, newMode) => {
                      updateNodeData(id, { seed: newSeed, seedMode: newMode });
                      window.dispatchEvent(new Event('takeSnapshot'));
                    }}
                  />
                </div>
                <button
                  onClick={handleGenerate}
                  disabled={isGenerating || !comfyuiOnline || !isValidToGenerate}
                  className="w-full py-2.5 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-semibold transition-all duration-150 active:scale-[0.98] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-1.5 border border-white/15 shadow-sm"
                >
                  <WandIcon />
                  <span>{data.generatedUrl ? t('更新并重新编辑视频') : t('执行 MiniMax H3 视频编辑 / 重构')}</span>
                </button>
              </div>
            </div>

            <GeneratingLine active={isGenerating} jobId={data.jobId as string | undefined} steps={currentSteps} onCancel={handleCancel} />

            <NodeErrorBanner
              error={data.status === 'error' ? (data.error || t('视频编辑失败')) : null}
              onClear={() => updateNodeData(id, { status: 'idle', error: undefined })}
              title={t('MiniMax H3 视频编辑错误')}
            />
          </div>
        </div>
      )}

      {/* Connection Handles (Permanently mounted to avoid unmount edge breaks) */}
      {spec.handles.map((handle, i) => {
        const top = `${Math.round(((i + 1) / (spec.handles.length + 1)) * 100)}%`;
        const meta = HANDLE_META[handle];
        return (
          <IconHandle key={handle} type="target" id={handle} portType={meta.port} nodeId={id} style={{ top }}
            title={handle === 'in-video' && currentMode === 'av_bridge' ? t('源视频（要重做中间的那条）') : t(meta.title)} />
        );
      })}
      <IconHandle type="source" id="out-video" portType="video" nodeId={id} title={t('输出编辑音视频')} />

      {showModal && data.generatedUrl && (
        <VideoPreviewModal
          beforeUrl={sourceVideoUrls[0] ? (sourceVideoUrls[0].startsWith('http') ? sourceVideoUrls[0] : `${API_BASE}${sourceVideoUrls[0]}`) : null}
          afterUrl={`${API_BASE}${data.generatedUrl}`}
          onClose={() => setShowModal(false)}
          onCaptureFrame={(v) => handleScreenshot(v)}
          downloadName="edited-video.mp4"
          alias={(data as any).alias}
        />
      )}
    </NodeShell>
  );
}

const HANDLE_META = {
  'in-video': { port: 'video', title: '源视频 (<Video 1>)' },
  'in-first-frame': { port: 'image', title: '首帧图' },
  'in-last-frame': { port: 'image', title: '尾帧图' },
  'in-character': { port: 'character', title: '参考图 · 角色/道具/环境 (<Picture N>)' },
  'in-audio': { port: 'audio', title: '声音参考 (<Audio N>)' },
  'in-prompt': { port: 'prompt', title: '提示词' },
  'in-guide-frame': { port: 'image', title: '引导帧 (AddGuide · 编辑窗口内，帧号按原片)' },
} as const;

function absoluteMediaUrl(u: string) {
  return u.startsWith('http') || u.startsWith('blob:') || u.startsWith('data:') ? u : `${API_BASE}${u}`;
}

function EmptyInput({ text }: { text: string }) {
  return (
    <div className="flex min-h-[90px] items-center justify-center rounded-lg border border-dashed border-white/15 bg-black/20 px-4 text-center text-[11px] leading-relaxed text-zinc-500">
      {text}
    </div>
  );
}

function FrameSlot({ url, label: text }: { url: string | null; label: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-white/10 bg-black/30">
      {url ? (
        <img src={absoluteMediaUrl(url)} alt="" className="block aspect-video w-full object-contain" />
      ) : (
        <div className="flex aspect-video items-center justify-center px-2 text-center text-[10px] text-zinc-600">{t('连接{v1}', { v1: text })}</div>
      )}
      <div className="px-1.5 py-0.5 text-[10px] text-zinc-400">{text}</div>
    </div>
  );
}

/** The end of the source, where the new shot picks up, and how far it runs. */
function ContinuationPreview({ sourceUrl, extendSeconds, onSourceDuration }: {
  sourceUrl: string; extendSeconds: number; onSourceDuration: (s: number) => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [dur, setDur] = useState(0);
  const total = dur + extendSeconds;
  return (
    <div className="nodrag space-y-1.5">
      <div className="relative overflow-hidden rounded-lg bg-black">
        <video
          ref={ref}
          src={sourceUrl}
          preload="metadata"
          crossOrigin="anonymous"
          muted
          playsInline
          {...NATIVE_VIDEO_CHROME_OFF}
          className="block max-h-[180px] w-full object-contain"
          onLoadedMetadata={() => {
            const v = ref.current;
            if (!v) return;
            setDur(v.duration);
            onSourceDuration(v.duration);
            v.currentTime = Math.max(0, v.duration - 1 / 24);
          }}
          onClick={() => {
            const v = ref.current;
            if (!v) return;
            if (v.paused) {
              v.currentTime = Math.max(0, v.duration - 2);
              v.play().catch(() => {});
            } else v.pause();
          }}
          onTimeUpdate={() => {
            const v = ref.current;
            if (v && !v.paused && v.currentTime >= v.duration - 0.05) v.pause();
          }}
        />
        <span className="pointer-events-none absolute left-2 top-2 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-zinc-200">
          {t('原片最后一帧 · 点击回放结尾 2 秒')}
        </span>
      </div>
      <div className="flex h-5 overflow-hidden rounded-md text-[9px] font-mono">
        <div className="flex items-center justify-center bg-white/10 text-zinc-400" style={{ width: total ? `${(dur / total) * 100}%` : '50%' }}>
          {t('原片')} {dur.toFixed(1)}s
        </div>
        <div className="flex flex-1 items-center justify-center bg-emerald-500/40 text-emerald-50">
          + {extendSeconds.toFixed(1)}s {t('续写')}
        </div>
      </div>
    </div>
  );
}

const withMode = (mode: H3EditMode) =>
  memo((props: NodeProps<VideoEditNodeType>) => <H3EditNode {...props} mode={mode} />, areNodePropsEqual);

/** 局部编辑. Keeps the `videoEdit` type, so canvases and the MCP server that name it still work. */
const VideoEditNode = withMode('edit');
export const VideoReshotNode = withMode('temporal_reshot');
export const VideoBridgeNode = withMode('av_bridge');
export const VideoContinueNode = withMode('continuation');
export const VideoFramesNode = withMode('fl2va');

export default VideoEditNode;


function PlayIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}

function MaximizeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
    </svg>
  );
}

function RegenIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l6 5.81" />
    </svg>
  );
}

function WandIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M12.2 6.2L11 5M12.2 11.8L11 13M17.8 6.2L19 5M3 21l9-9" />
    </svg>
  );
}
