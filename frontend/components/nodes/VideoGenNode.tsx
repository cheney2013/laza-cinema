'use client';
import { useSyncedText } from '@/hooks/useSyncedText';

import { useState, useCallback, useEffect, useRef, useMemo, memo } from 'react';

import { useH3Assets } from '@/hooks/useH3Assets';
import { snapToFrameGrid, isOnFrameGrid, H3_FRAME_GRID, type H3DirectorSpec } from '@/lib/h3/spec';
import { pushTake, type H3Take } from '@/lib/h3/takes';
import { snapshotInputs, snapshotOutputs, snapshotParams, takeForDisplayed } from '@/lib/h3/takeSwitch';
import TakeNavigator from './TakeNavigator';
import { areNodePropsEqual, copyTextToClipboard, downloadFile } from '@/lib/utils';
import { NodeProps, useReactFlow } from '@xyflow/react';
import IconHandle from './IconHandle';
import { VideoNode as VideoNodeType } from '@/lib/types';
import { api, loadMachineProfile, type MachineProfile } from '@/lib/api';
import { useStore } from '@/lib/store';
import { cardBody, header, label } from './PromptNode';
import { promptDialogue } from '@/lib/promptDialogue';
import NodeShell from './NodeShell';
import { NodeHeaderIconButton } from './nodeChrome';
import { BoltIcon, GearIcon } from '@/components/ui/icons';
import { useAutoHeightNode } from '@/hooks/useAutoHeightNode';
import GeneratingLine from './GeneratingLine';
import VideoPreviewModal from './VideoPreviewModal';
import { useConnectedInputs, ConnectedInput } from '@/hooks/useConnectedInputs';
import { useJobResult, useJobStatusText } from '@/hooks/useJobPoller';
import { usePromptBinding } from '@/hooks/usePromptBinding';

import { BACKEND_URL as API_BASE, posterUrl, resolveAssetUrl } from '@/lib/config';
import { createPortal } from 'react-dom';

import { ExpandedPromptModal, insertIntoActiveRichPrompt, RenderedPromptFlow, type RichPromptEditorHandle } from './RichPromptEditor';
import NodeErrorBanner from './NodeErrorBanner';
import { SeedControl, resolveSeedForGeneration } from './SeedControl';
import SubmittedResourcesPanel from './SubmittedResourcesPanel';
import { showAlert } from '@/components/ui/Dialog';
import NodeVideoPlayer from './NodeVideoPlayer';
import PinnedFramePreview from './PinnedFramePreview';
import { resolveAudioLocks } from '@/lib/audioLocks';
import AudioLocksPanel, { type LockRow } from './AudioLocksPanel';
import { resolveChain } from '@/lib/chainContext';
import { t } from '@/lib/i18n';
import { fileTag, pinIsElsewhere, pinnedSource, repin, togglePin } from '@/lib/pinnedFrame';

// 17k+5 frame length options
const H3_LENGTH_OPTIONS = [
  { label: '5.1s (124帧 · 推荐)', frames: 124, duration: 5.1 },
  { label: '7.3s (175帧)', frames: 175, duration: 7.3 },
  { label: '9.4s (226帧)', frames: 226, duration: 9.4 },
  { label: '15.0s (362帧)', frames: 362, duration: 15.0 },
];

const H3_ASPECT_RATIOS = [
  { label: '16:9', desc: '院线横屏', w: 1376, h: 768, iconRatio: 'w-4 h-2.5' },
  { label: '9:16', desc: '竖屏短剧', w: 768, h: 1376, iconRatio: 'w-2.5 h-4' },
  { label: '2.39:1', desc: '变形宽屏', w: 1536, h: 640, iconRatio: 'w-5 h-2' },
  { label: '1:1', desc: '正方形', w: 1024, h: 1024, iconRatio: 'w-3 h-3' },
  { label: '4:3', desc: '经典复古', w: 1152, h: 864, iconRatio: 'w-3.5 h-2.5' },
];

// Pixel size at the node's current aspect ratio, by the short side. 768 is the
// size every aspect preset above is built on; H3 wants multiples of 32.
const H3_PIXEL_SIZES = [
  { short: 480, desc: '预览：快，省显存' },
  { short: 576, desc: '偏快' },
  { short: 768, desc: '默认' },
  { short: 1088, desc: '更清楚：更慢、更吃显存' },
];

function sizeForShortSide(w: number, h: number, short: number): { w: number; h: number } {
  const snap = (v: number) => Math.max(256, Math.round(v / 32) * 32);
  return w >= h ? { w: snap((short * w) / h), h: short } : { w: short, h: snap((short * h) / w) };
}

// Style LoRAs that can be stacked on the base (multi-select, stacked in click order). The turbo LoRA is not one of
// these -- it belongs to the motion preset. Default is none: until
// 2026-09-09 the backend stacked AfterMidnight on every render without the
// node knowing, so the accepted takes before that date carry it.
// defaultStrength: what a LoRA starts at when switched on; each can differ.
// recommendedRange: the author's published range, inclusive; omitted when the
// author gives none, so nothing is flagged on a guess.
const STYLE_LORA_OPTIONS: { label: string; value: string; title: string; defaultStrength: number; recommendedRange?: [number, number]; sampling?: string }[] = [
  // No model card on huggingface.co/kirk86413/cinema-h3: no published range.
  { label: 'Cinema', value: 'h3/cinema_h3_realfilm_v0.1.safetensors', defaultStrength: 1.0, title: 'kirk86413/cinema-h3 "电影镜头" v0.1，rank 16，19000 步；对比测试中（2026-09-09）' },
  // 1.0 is the author's only recommendation (civitai.com/models/2867841).
  { label: 'Mystic', value: 'h3/MysticXXX_MMH3-V4.safetensors', defaultStrength: 1.0, recommendedRange: [0.2, 1.0], title: 'MysticXXX MMH3 V4（2026-09-16 加入）' },
  // NSFW_ANIME_V7_H3 step 19500 (kohya, rank 32, trained on the fl2va pruned base at 640x360); no published range.
  { label: 'Anime', value: 'h3/NSFW_ANIME_V7_H3-step00019500.safetensors', defaultStrength: 1.0, title: 'NSFW_ANIME_V7_H3 step 19500（2026-09-19 替换 Bobby Anime）' },
];

const styleLoraDefaultStrength = (name: string) =>
  STYLE_LORA_OPTIONS.find((o) => o.value === name)?.defaultStrength ?? 1.0;

type MotionPreset = MachineProfile['motion_preset'];

// The backend's H3_MACHINE_PROFILE: what a node that never set size or base
// model renders at on this box (1376x768 Singularity on the 5090, 864x480
// pruned w4a8 on a 16 GB card).
function useMachineProfile(): MachineProfile | null {
  const [profile, setProfile] = useState<MachineProfile | null>(null);
  useEffect(() => {
    let live = true;
    loadMachineProfile().then((p) => { if (live) setProfile(p); });
    return () => { live = false; };
  }, []);
  return profile;
}


// Remaps reference tokens (<Picture 1>, <Image 1>, <图1>, etc.) according to old-index -> new-index map
// Calculate optimal MiniMax H3 video dimensions constrained by official 768p / 16-multiple rules
export function calculateH3Resolution(srcW: number, srcH: number): { width: number; height: number } {
  if (!srcW || !srcH) return { width: 1376, height: 768 };
  const ratio = srcW / srcH;
  // H3 standard training anchor is ~1.05 Megapixels (1376x768 = 1056768)
  const TARGET_PIXELS = 1376 * 768; // ~1.05M

  let w: number;
  let h: number;

  if (ratio >= 1) {
    // Landscape or square: baseline short edge ~ 768
    h = Math.sqrt(TARGET_PIXELS / ratio);
    w = h * ratio;
  } else {
    // Portrait: baseline short edge ~ 768
    w = Math.sqrt(TARGET_PIXELS * ratio);
    h = w / ratio;
  }

  // Bound maximum dimension: max width/height = 1536, min dimension = 512
  const maxDim = 1536;
  const minDim = 512;
  if (w > maxDim) {
    w = maxDim;
    h = w / ratio;
  }
  if (h > maxDim) {
    h = maxDim;
    w = h * ratio;
  }
  if (w < minDim) {
    w = minDim;
    h = w / ratio;
  }
  if (h < minDim) {
    h = minDim;
    w = h * ratio;
  }

  // Snap both width and height to multiples of 32 (strictly required by H3 VAE & DiT 2x2 patchify)
  const finalW = Math.max(512, Math.min(1536, Math.round(w / 32) * 32));
  const finalH = Math.max(512, Math.min(1536, Math.round(h / 32) * 32));

  return { width: finalW, height: finalH };
}

function remapVideoPromptTokens(text: string, oldToNewMap: Map<number, number>): string {
  if (!text) return text;
  return text.replace(/(<(?:Picture|Pic|Image|图)\s*)(\d+)((?:\s*[:：][^>]*)?>)/gi, (match, prefix, numStr, suffix) => {
    const oldNum = parseInt(numStr, 10);
    const newNum = oldToNewMap.get(oldNum);
    return newNum !== undefined ? `${prefix}${newNum}${suffix}` : match;
  });
}

function VideoGenNode({ id, data, selected }: NodeProps<VideoNodeType>) {
  const { updateNodeData, getNodes, setNodes, setEdges } = useReactFlow();
  const connected = useConnectedInputs(id);
  const comfyuiOnline = useStore((s) => s.comfyuiOnline);
  const activeAudioNodeId = useStore((s) => s.activeAudioNodeId);
  const setActiveAudioNodeId = useStore((s) => s.setActiveAudioNodeId);
  const settings = useStore((s) => s.settings);
  const isAudioActive = activeAudioNodeId === id;
  const [showSettings, setShowSettings] = useState(false);
  const [localPrompt, setLocalPrompt] = useSyncedText((data.prompt as string) || '');
  const [showModal, setShowModal] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playToken, setPlayToken] = useState(0);
  const [videoTime, setVideoTime] = useState(0);
  const [videoDur, setVideoDur] = useState(0);
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'preview' | 'editor'>('editor');
  const [isCompilingPrompt, setIsCompilingPrompt] = useState(false);
  const [draggedRefIdx, setDraggedRefIdx] = useState<number | null>(null);
  const [dragOverRefIdx, setDragOverRefIdx] = useState<number | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [debugCopied, setDebugCopied] = useState(false);
  const [compiledCopied, setCompiledCopied] = useState(false);
  const [compiledPromptResult, setCompiledPromptResult] = useState<{ prompt: string; mode: string; modified: boolean } | null>(() =>
    data.compiledPrompt
      ? {
          prompt: data.compiledPrompt as string,
          mode: (data.compiledPromptMode as string) || '',
          modified: Boolean(data.promptWasModified),
        }
      : null
  );
  const [isFetchingCompiled, setIsFetchingCompiled] = useState(false);
  // Nothing to show when the backend sent the prompt through untouched: the
  // block only repeated the prompt (or said "(same as prompt)").
  const compiledSameAsPrompt = Boolean(compiledPromptResult) && !compiledPromptResult!.modified && (
    compiledPromptResult!.prompt.trim().startsWith('(same as')
    || compiledPromptResult!.prompt.trim() === String(data.prompt || '').trim());
  /**
   * The prompt is written in the 独立大窗 and nowhere else. A 68 px box on the
   * card could show three lines of a 400-word H3 prompt, which is not enough to
   * read one and just enough to edit the wrong sentence — and being a
   * contentEditable it was the one surface on the card that could disagree with
   * the node's own data.
   */
  const [showPromptModal, setShowPromptModal] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const richPromptEditorRef = useRef<RichPromptEditorHandle | null>(null);
  const cancelledRef = useRef(false);
  const lastAdoptedPrimaryId = useRef<string | null>(null);
  const prevGeneratedUrlRef = useRef<string | null>(data.generatedUrl as string | null);
  const prevStatusRef = useRef<string>((data.status as string) || 'idle');
  const isInitialMountRef = useRef(true);

  useEffect(() => {
    if (!data.compiledPrompt) return;
    setCompiledPromptResult({
      prompt: data.compiledPrompt as string,
      mode: (data.compiledPromptMode as string) || '',
      modified: Boolean(data.promptWasModified),
    });
  }, [data.compiledPrompt, data.compiledPromptMode, data.promptWasModified]);

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

    // Only a render that actually produced a new clip counts. Cancelling or queueing
    // leaves the old clip on the node and must not start it playing.
    const justFinished = curStatus === 'done' && curUrl && (prevStatus === 'generating' || curUrl !== prevUrl);

    if (justFinished) {
      const takes = data.takes as H3Take[] | undefined;
      if (takes?.length && !takes[0].url && curUrl) {
        updateNodeData(id, { takes: [{ ...takes[0], url: curUrl }, ...takes.slice(1)] });
      }
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

  // ── 节点尺寸 ──────────────────────────────────────────────────
  // 一自由度模型：宽度是自变量，高度 = 功能区高度 + 宽度/媒体比例。
  // 最小尺寸 = 功能区最简化（只留图标）时的尺寸，由 useChromeMetrics 就地实测标定。
  // 详见 docs/node-sizing.md。
  //
  // 只有预览态才真的在放画面。编辑态整块是控件与文本，比例项不成立 —— 硬按比例算
  // 会给 9:16 造出 675 高的空壳，minH 还会高到拖不小。功能区在场的行也随视图变：
  // 预览态只有标题栏（画面满铺、无内边距），编辑态还有底部 seed 与生成按钮加 p-3.5。
  const showsMedia = Boolean(data.generatedUrl) && viewMode === 'preview';
  // The lines this node speaks, under its title, so a reviewer reads the beat
  // without opening the prompt: the prompt that made the clip on display, else
  // the one that will run next.
  const dialogueSource = (data.generatedUrl && typeof data.compiledPrompt === 'string'
    && !String(data.compiledPrompt).startsWith('(same as')
    ? data.compiledPrompt : data.prompt) as string | undefined;
  const dialogue = useMemo(() => promptDialogue(dialogueSource), [dialogueSource]);
  const dialogueKey = dialogue.map((l) => l.speaker + l.text).join('|');
  const [editingLabel, setEditingLabel] = useState(false);
  const hasLabelRow = Boolean(data.label) || dialogue.length > 0 || editingLabel;
  // 例外：首次生成时还没有成片，但目标分辨率已定、整块被生成遮罩盖住，按成片比例占位
  const firstRender = data.status === 'generating' && !data.generatedUrl;

  // Only the width is kept. The picture sits in an aspect-ratio box, the editor view is as tall as its content (capped, then
  // it scrolls), and the label, header, actions and settings drawer are rows in the flow: the card's own layout is its height.
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
  const spec = sizing.spec;

  const jobResult = useJobResult(data.jobId as string | undefined);
  const jobStatusText = useJobStatusText(data.jobId as string | undefined);
  useEffect(() => {
    // No cancelledRef check: handleCancel clears jobId, which drops the result, and
    // the ref stays true until the next local Generate -- so after one cancel every
    // job started elsewhere (MCP, another tab) finished in ComfyUI and never left
    // the spinner.
    if (!jobResult) return;
    if (jobResult.status === 'done' && jobResult.url) {
      const outputs = {
        latentFilename: (jobResult as any).latent_filename as string | undefined,
        untrimmedUrl: (jobResult as any).untrimmed_url as string | undefined,
        contextFrames: (jobResult as any).context_frames as number | undefined,
        compiledPrompt: (jobResult as any).compiled_prompt as string | undefined,
        compiledPromptMode: (jobResult as any).mode as string | undefined,
        promptWasModified: Boolean((jobResult as any).prompt_was_modified),
        submittedResources: (jobResult as any).submitted_resources,
        generatedSteps: data.generatedSteps,
        seamMatchApplied: (jobResult as any).seam_match as string | undefined,
      };
      const doneJobId = data.jobId as string | undefined;
      updateNodeData(id, {
        takes: (() => {
          const prev = (data.takes as H3Take[] | undefined) || [];
          if (prev.some((tk) => tk.id === doneJobId)) {
            return prev.map((tk) => (tk.id === doneJobId
              ? { ...tk, url: jobResult.url as string, outputs: snapshotOutputs(outputs) }
              : tk));
          }
          // Started elsewhere (MCP, another tab): no take was pushed at submit.
          const tk = takeForDisplayed({ ...data, ...outputs, generatedUrl: jobResult.url }, doneJobId || `job-${Date.now().toString(36)}`);
          // The canvas MCP records what it submitted (parameters and wired inputs,
          // in edge order) as pendingTake; without it the take has no inputs and
          // the version badge can only say it cannot check them.
          const pending = data.pendingTake as { params?: Record<string, unknown>; inputs?: H3Take['inputs'] } | undefined;
          if (tk && pending) {
            if (pending.inputs) tk.inputs = pending.inputs;
            if (pending.params) tk.params = { ...(tk.params || {}), ...pending.params };
          }
          return tk && !prev.some((p) => p.url === tk.url) ? pushTake(prev, tk) : prev;
        })(),
        status: 'done',
        generatedUrl: jobResult.url as string,
        latentFilename: (jobResult as any).latent_filename as string | undefined,
        untrimmedUrl: (jobResult as any).untrimmed_url as string | undefined,
        contextFrames: (jobResult as any).context_frames as number | undefined,
        compiledPrompt: (jobResult as any).compiled_prompt as string | undefined,
        compiledPromptMode: (jobResult as any).mode as string | undefined,
        promptWasModified: Boolean((jobResult as any).prompt_was_modified),
        submittedResources: (jobResult as any).submitted_resources,
        seamMatchApplied: (jobResult as any).seam_match as string | undefined,
        jobId: undefined,
        pendingTake: undefined,
      });
    } else if (jobResult.status === 'error') {
      updateNodeData(id, { status: 'error', error: (jobResult.error as string) || 'Video generation failed', jobId: undefined });
    } else if (jobResult.status === 'cancelled') {
      // Cancelled elsewhere (another tab, the API, a script): stop waiting on it.
      updateNodeData(id, { status: 'idle', jobId: undefined, error: undefined });
    }
  }, [jobResult, id, updateNodeData]);

  useEffect(() => {
    if (data.generatedUrl) {
      const url = data.generatedUrl.startsWith('blob:') || data.generatedUrl.startsWith('http')
        ? data.generatedUrl
        : `${API_BASE}${data.generatedUrl}`;
      setVideoSrc(url);
    } else {
      setVideoSrc(null);
    }
  }, [data.generatedUrl]);

  useEffect(() => {
    if (data.status === 'generating') {
      if (videoRef.current) {
        videoRef.current.pause();
      }
      setIsPlaying(false);
    }
  }, [data.status]);

  // Sync DOM muted property with global audio exclusivity state
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.muted = !isAudioActive;
    }
  }, [isAudioActive]);

  // `useH3Assets` is the authority on reference numbering: it mirrors the order the
  // backend actually fills the reference slots in (first frame, last frame, then the
  // rest). The per-strip computations below stay in wiring order for display; when
  // one of them changes, change the hook too or the prompt and the workflow will
  // disagree about which picture is <Picture 1>.
  const h3 = useH3Assets(id, {
    refImageOrder: data.refImageOrder as string[] | undefined,
    useFirstFrame: data.useFirstFrame as boolean | undefined,
    firstFrameNodeId: data.firstFrameNodeId as string | null | undefined,
    length: (data.length as number) || 124,
    fps: (data.fps as number) || 24,
  });

  const rawConnectedImageNodes = useMemo(() => {
    return connected.filter(
      (n) =>
        n.mediaType !== 'audio' &&
        n.mediaType !== 'video' &&
        // The last-frame anchor is neither a reference nor a first frame.
        n.targetHandle !== 'in-last-frame' &&
        // A voice clip on an image node wired to the audio port is audio, whatever its node type.
        n.targetHandle !== 'in-ref-audio' &&
        (n.type === 'image' ||
          n.type === 'gaussian' ||
          n.type === 'inpaint' ||
          n.targetHandle === 'in-image' ||
          n.targetHandle === 'in-ref-image' ||
          n.targetHandle === 'in-character' ||
          n.targetHandle === 'in-style')
    );
  }, [connected]);

  const connectedImageNodes = useMemo(() => {
    const order = (data.refImageOrder || []) as string[];
    if (order.length === 0) return rawConnectedImageNodes;
    const sorted = [...rawConnectedImageNodes].sort((a, b) => {
      const idxA = order.indexOf(a.id);
      const idxB = order.indexOf(b.id);
      if (idxA === -1 && idxB === -1) return 0;
      if (idxA === -1) return 1;
      if (idxB === -1) return -1;
      return idxA - idxB;
    });
    return sorted;
  }, [rawConnectedImageNodes, data.refImageOrder]);

  const connectedImageUrls = useMemo(() => {
    return connectedImageNodes
      .map((n) => (n.generatedUrl || n.url) as string)
      .filter(Boolean);
  }, [connectedImageNodes]);

  // Extract reference aliases from connected source nodes
  const connectedImageAliases = useMemo(() => {
    return connectedImageNodes.map((n) => {
      if (n.alias) return n.alias;
      if (n.label && n.label !== 'Style' && n.label !== t('图像生成') && n.label !== t('上传')) {
        return n.label;
      }
      return '';
    });
  }, [connectedImageNodes]);

  // Only an image wired to the first-frame port (in-image) is a first frame
  // (2026-09-24): inferring one from "some image that is not a reference"
  // turned a character sheet into the first frame when voice clips on image nodes
  // were wired with the image handle, and the frame size followed the sheet.
  const isFirstFrameActive = connectedImageNodes.some((n) => n.targetHandle === 'in-image');

  // The image wired to the first-frame port is the first frame. A stored
  // firstFrameNodeId goes stale when that edge is rewired (the MCP swaps the frame
  // without touching it), and falling through to connectedImageNodes[0] then picked
  // whatever reference came first in edge order: a chain segment was generated from a
  // character sheet instead of its first frame (2026-09-16).
  const firstFrameNode = isFirstFrameActive
    ? (connectedImageNodes.find((n) => n.targetHandle === 'in-image') || null)
    : null;
  const firstFrameUrl = firstFrameNode ? ((firstFrameNode.generatedUrl || firstFrameNode.url) as string) : null;
  // Every image on in-last-frame is a guide frame pinned through its own MiniMaxH3AddGuide:
  // data.guideFrameIndexes[i] for the i-th wired image (edge order), else the older single
  // data.guideFrameIndex, else -1 (the clip's last frame).
  const guideFrameNodes = connected.filter((n) => n.targetHandle === 'in-last-frame');
  const guideFrameIndexes = (data.guideFrameIndexes || []) as (number | null)[];
  const guideFrames = guideFrameNodes.map((n, i) => ({
    url: (n.generatedUrl || n.url) as string,
    frame_index: Number(guideFrameIndexes[i] ?? data.guideFrameIndex ?? -1),
  })).filter((g) => !!g.url);
  const setGuideFrameIndex = (i: number, v: number) => {
    const next = guideFrameNodes.map((_, j) => Number(guideFrameIndexes[j] ?? data.guideFrameIndex ?? -1));
    next[i] = v;
    updateNodeData(id, { guideFrameIndexes: next });
  };
  const firstFrameNodeId = firstFrameNode ? firstFrameNode.id : null;

  // A first frame locks the frame size: the clip's first picture IS that image, so
  // any other aspect would stretch or crop it. The size follows the image (snapped to
  // H3's 1.05 MP grid) whenever it changes, and the aspect buttons are disabled.
  // Sizes arrive as strings from MCP-written canvases, hence Number().
  const firstFrameW = Number(firstFrameNode?.width) || 0;
  const firstFrameH = Number(firstFrameNode?.height) || 0;
  // A rendered clip on in-motion-context locks the size too, and wins over a first
  // frame: its latent cannot be resized, and a size taken from anything else made the
  // chained render fail in ComfyUI (1248x832 against a 1376x768 latent, 2026-09-24).
  const chainSource = connected.find((n) => n.targetHandle === 'in-motion-context' && n.latentFilename);
  const chainW = Number(chainSource?.width) || 0;
  const chainH = Number(chainSource?.height) || 0;
  const lockedByChain = Boolean(chainW && chainH);
  const lockedRes = lockedByChain
    ? { width: chainW, height: chainH }
    : (firstFrameW && firstFrameH ? calculateH3Resolution(firstFrameW, firstFrameH) : null);
  const lockedLabel = lockedByChain ? t('画幅跟随上一段') : t('画幅跟随首帧');
  useEffect(() => {
    if (!lockedRes) return;
    if (Number(data.width) !== lockedRes.width || Number(data.height) !== lockedRes.height) {
      updateNodeData(id, { width: lockedRes.width, height: lockedRes.height });
    }
  }, [
    firstFrameNode?.id,
    firstFrameNode?.width,
    firstFrameNode?.height,
    chainW,
    chainH,
    data.generatedUrl,
    data.width,
    data.height,
    id,
    updateNodeData,
  ]);

  const handleMoveRefImage = useCallback((fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= connectedImageNodes.length || toIndex >= connectedImageNodes.length) {
      return;
    }
    const newOrder = [...connectedImageNodes.map((n) => n.id)];
    const [movedId] = newOrder.splice(fromIndex, 1);
    newOrder.splice(toIndex, 0, movedId);

    const oldToNewMap = new Map<number, number>();
    connectedImageNodes.forEach((node, oldIdx) => {
      const newIdx = newOrder.indexOf(node.id);
      if (newIdx !== -1) {
        oldToNewMap.set(oldIdx + 1, newIdx + 1);
      }
    });

    const currentLocalPrompt = localPrompt || (data.prompt as string) || '';
    if (currentLocalPrompt) {
      const updatedPrompt = remapVideoPromptTokens(currentLocalPrompt, oldToNewMap);
      if (updatedPrompt !== currentLocalPrompt) {
        setLocalPrompt(updatedPrompt);
        updateNodeData(id, { prompt: updatedPrompt, refImageOrder: newOrder });
      } else {
        updateNodeData(id, { refImageOrder: newOrder });
      }
    } else {
      updateNodeData(id, { refImageOrder: newOrder });
    }

    connected.forEach((inputNode) => {
      if (inputNode.type === 'prompt' || inputNode.targetHandle === 'in-prompt') {
        const pn = inputNode as any;
        if (pn.text) {
          const updatedPnText = remapVideoPromptTokens(pn.text, oldToNewMap);
          if (updatedPnText !== pn.text) {
            updateNodeData(pn.id, { text: updatedPnText });
          }
        }
      }
    });

    window.dispatchEvent(new Event('takeSnapshot'));
  }, [connectedImageNodes, connected, localPrompt, data.prompt, id, updateNodeData]);

  const insertImageToken = useCallback((idx: number) => {
    const targetNode = connectedImageNodes[idx - 1];
    const alias = targetNode?.alias || '';
    const token = alias ? `<图${idx}:${alias}>` : `<图${idx}>`;
    const promptNode = connected.find((n) => n.type === 'prompt' || n.targetHandle === 'in-prompt');
    if (promptNode) {
      const curText = promptNode.text || '';
      const next = (curText.trim() ? `${curText.trim()} ` : '') + token;
      updateNodeData(promptNode.id, { text: next });
      window.dispatchEvent(new Event('takeSnapshot'));
      return;
    }

    if (richPromptEditorRef.current?.insertText(token) || insertIntoActiveRichPrompt(token)) return;
    const next = (localPrompt || '') + (localPrompt && !localPrompt.endsWith(' ') ? ' ' : '') + token;
    setLocalPrompt(next);
    updateNodeData(id, { prompt: next });
  }, [connectedImageNodes, connected, localPrompt, id, updateNodeData]);

  const isNotImageMedia = (url: string | null | undefined) => {
    if (!url) return false;
    const clean = url.split('?')[0].toLowerCase();
    return !clean.endsWith('.png') && !clean.endsWith('.jpg') && !clean.endsWith('.jpeg') && !clean.endsWith('.webp') && !clean.endsWith('.bmp') && !clean.endsWith('.gif');
  };

  const machineProfile = useMachineProfile();
  const currentLength = data.length || 124;
  const currentWidth = data.width || machineProfile?.width || 1376;
  const currentHeight = data.height || machineProfile?.height || 768;
  const currentPreset: MotionPreset = (data.motionPreset as MotionPreset | undefined)
    || machineProfile?.motion_preset || 'fused';
  // Speed LoRA: TaoMate is distilled for exactly 3 steps and the backend locks it
  // there. Fused has its turbo merged in, so the choice does not apply to it.
  // Steps follow the speed LoRA (the backend enforces the same table).
  const currentAccel: 'taomate3' | 'turbo8' | 'none' = (data.accelLora as 'taomate3' | 'turbo8' | 'none' | undefined) || 'turbo8';
  // w4a8 is Singularity's quantised build, not a base of its own: the backend
  // runs it in place of Singularity when the GPU is too small, and the node
  // shows one Singularity button either way.
  const shownPreset = currentPreset === 'pruned_w4a8' || currentPreset === 'singularity_w4a8' ? 'singularity' : currentPreset;
  const singularityIsW4a8 = shownPreset === 'singularity'
    && (currentPreset === 'pruned_w4a8' || currentPreset === 'singularity_w4a8'
      || machineProfile?.preset_substitutes?.singularity === 'pruned_w4a8'
      || machineProfile?.preset_substitutes?.singularity === 'singularity_w4a8');
  // Which attention patches this preset may use is the backend's decision (it knows the checkpoint that
  // really loads): the node shows what it is told and never works it out itself.
  const [attention, setAttention] = useState<{ allowed: string[]; blocked: Record<string, string>; default: string } | null>(null);
  useEffect(() => {
    let live = true;
    api.getH3Attention(currentPreset).then((p) => { if (live) setAttention(p); }).catch(() => { if (live) setAttention(null); });
    return () => { live = false; };
  }, [currentPreset]);
  const chosenAttention = (data.accel as string | undefined) || '';
  const attentionBlocked = (name: string) => Boolean(attention && !attention.allowed.includes(name));
  const effectiveAttention = chosenAttention && attentionBlocked(chosenAttention) ? (attention?.default ?? '') : chosenAttention;
  // HyperFlow brings its own fixed 8-step grid in place of any speed LoRA.
  const ownsSteps = currentPreset === 'fused' || currentPreset === 'hyperflow';
  const currentSteps = ownsSteps ? 8
    : currentAccel === 'taomate3' ? 3 : currentAccel === 'turbo8' ? 8 : 20;
  const refAudioUrls = connected
    .filter((n) => n.targetHandle === 'in-ref-audio' || n.targetHandle === 'in-audio')
    .map((n) => (n.url || n.generatedUrl) as string)
    .filter((u) => u && isNotImageMedia(u));
  const refVideoInputs = connected.filter((n) => (n.targetHandle === 'in-ref-video' || n.targetHandle === 'in-video') && isNotImageMedia(n.url || n.generatedUrl));
  // The clip this shot continues from, wired into in-motion-context. Its latent
  // is what carries the motion and the sound over the join; a node connected
  // there that has not been rendered yet simply has no latent, and this shot
  // starts on its own rather than failing.
  const chainParent = connected.find((n) => n.targetHandle === 'in-motion-context');
  // data.motionContextAtFrame = N carries on from frame N of that clip instead of its end
  // (a cutaway in between); a latent only holds the end, so then its pictures are sent.
  const chain = resolveChain(chainParent as any, data.motionContextLatent, data.motionContextAtFrame);
  const chainLatent = chain.motion_context_latent || '';
  const chainVideo = chain.motion_context_video || '';
  const refVideoUrls = refVideoInputs.map((n) => (n.url || n.generatedUrl) as string).filter(Boolean);
  const refVideoResolution = refVideoInputs.find((n) => Number(n.width) > 0 && Number(n.height) > 0);
  const promptBinding = usePromptBinding(id);
  const connectedPromptText = (connected.filter((n) => n.type === 'prompt' || n.targetHandle === 'in-prompt').map((n) => n.text).filter(Boolean).join(' ')) || '';
  // While the console owns the prompt, it is the prompt. A prompt node wired to
  // in-prompt would otherwise silently outrank a compiled spec.
  const directorOwnsPrompt = data.promptSource === 'director' && Boolean(data.directorSpec);
  const effectivePrompt = directorOwnsPrompt
    ? ((data.prompt as string) || '')
    : connectedPromptText || localPrompt || '';
  const isGenerating = data.status === 'generating';
  const isValidToGenerate = Boolean(effectivePrompt || firstFrameUrl || connectedImageUrls.length > 0 || refVideoUrls.length > 0);

  const mode = useMemo(() => {
    const hasAudio = refAudioUrls.length > 0;
    const hasVideoRef = refVideoUrls.length > 0;
    const hasImageRef = connectedImageUrls.length > 0;

    if (hasImageRef || hasAudio || hasVideoRef) {
      if (isFirstFrameActive) {
        return hasAudio || hasVideoRef || connectedImageUrls.length > 1
          ? t('首帧+多模态参考')
          : t('首帧生视频 I2VA');
      }
      return t('全模态参考生视频 Ref2VA');
    }
    return t('文生电影音视频 T2VA');
  }, [connectedImageUrls.length, refAudioUrls.length, refVideoUrls.length, isFirstFrameActive]);

  const handleGenerate = async () => {
    if (isGenerating) return;
    cancelledRef.current = false;
    if (videoRef.current) {
      videoRef.current.pause();
    }
    setIsPlaying(false);
    updateNodeData(id, {
      status: 'generating',
      error: undefined,
      compiledPrompt: undefined,
      compiledPromptMode: undefined,
      promptWasModified: undefined,
      submittedResources: undefined,
    });
    setCompiledPromptResult(null);

    try {
      const finalFirstFrameUrl = isFirstFrameActive ? firstFrameUrl : null;
      const finalRefImageUrls = isFirstFrameActive
        ? connectedImageUrls.filter((u) => u !== firstFrameUrl)
        : connectedImageUrls;

      const { effectiveSeed, nextSeedToStore } = resolveSeedForGeneration(
        data.seed as number | undefined,
        data.seedMode as any,
        81000
      );

      if (data.seedMode === 'random') {
        updateNodeData(id, { seed: nextSeedToStore });
      }

      // Recordings put on a second of the clip (data.audioLocks); left out of the request the
      // run would render the clip without them and nothing would say so.
      const audioLocks = resolveAudioLocks(data.audioLocks, getNodes());

      const { job_id } = await api.generateVideo({
        prompt: effectivePrompt,
        image_url: finalFirstFrameUrl,
        guide_frames: guideFrames,
        guide_frames_delivered: data.guideFramesDelivered ? true : undefined,
        pin_last_frame_of: pinnedSource(data),
        ref_image_urls: finalRefImageUrls,
        ref_audio_urls: refAudioUrls,
        ref_video_urls: refVideoUrls,
        width: currentWidth,
        height: currentHeight,
        steps: currentSteps,
        length: currentLength,
        seed: effectiveSeed,
        motion_preset: currentPreset,
        accel_lora: currentAccel,
        // Only a node that chose one sends it; w4a8 never gets Sol (the backend also enforces it).
        ...(effectiveAttention ? { sage: effectiveAttention } : {}),
        block_sparse: data.blockSparse === true,
        ...(audioLocks.length ? {
          audio_locks: audioLocks,
          audio_lock_feather: Number(data.audioLockFeather) || 0,
        } : {}),
        style_lora_name: '',
        style_loras: ((data.styleLoras as string[] | undefined) || []).map((name) => ({
          name,
          strength: (data.styleLoraStrengths as Record<string, number> | undefined)?.[name] ?? styleLoraDefaultStrength(name),
        })),
        // A clip wired into in-motion-context is the one this shot continues
        // from; its saved latent carries the motion and the sound across.
        ...(chainLatent ? {
          motion_context_latent: chainLatent,
          motion_context_length: (data.motionContextLength as number | undefined) ?? 22,
          motion_context_audio: (data.motionContextAudio as number | undefined) ?? 24,
        } : chainVideo ? {
          motion_context_video: chainVideo,
          ...(chain.motion_context_end_frame ? { motion_context_end_frame: chain.motion_context_end_frame } : {}),
          motion_context_length: (data.motionContextLength as number | undefined) ?? 22,
          motion_context_audio: (data.motionContextAudio as number | undefined) ?? 24,
        } : {}),
        // Seam colour/texture match (comfyui_nodes/aicinema_chain), only when the node
        // sets it -- same rule as the canvas MCP; otherwise the backend default applies.
        // A gain the node leaves unset is left out, so the backend default's value holds.
        ...((chainLatent || chainVideo) && data.seamMatch ? {
          seam_match: data.seamMatch as string,
          ...(data.seamMatchGain != null ? { seam_match_gain: Number(data.seamMatchGain) } : {}),
          ...(data.seamMatchTexture != null ? { seam_match_texture: Number(data.seamMatchTexture) } : {}),
          ...(data.seamMatchPostGain != null ? { seam_match_post_gain: Number(data.seamMatchPostGain) } : {}),
          ...(data.seamMatchAdaptive != null ? { seam_match_adaptive: Boolean(data.seamMatchAdaptive) } : {}),
        } : {}),
      });

      if (cancelledRef.current) return;

      // A take keeps the spec that produced it, so "what did I change between #3
      // and #5" is a field list rather than a diff of two walls of prose.
      const take: H3Take = {
        id: job_id,
        createdAt: Date.now(),
        spec: (data.directorSpec as H3DirectorSpec | undefined) ?? null,
        prompt: effectivePrompt,
        seed: effectiveSeed,
        width: currentWidth,
        height: currentHeight,
        length: currentLength,
        steps: currentSteps,
        motionPreset: currentPreset,
        url: null,
        params: snapshotParams({ ...data, prompt: localPrompt || (data.prompt as string) || '' }),
        inputs: snapshotInputs(connected),
      };
      updateNodeData(id, {
        jobId: job_id,
        // Recorded at submit, not read back off the settings: the step selector
        // can be changed afterwards, and the overlay describes the clip that is
        // actually on screen.
        generatedSteps: currentSteps,
        takes: pushTake(data.takes as H3Take[] | undefined, take),
      });
    } catch (err: any) {
      if (cancelledRef.current) return;
      updateNodeData(id, { status: 'error', error: err.message || 'Generation failed', jobId: undefined });
    }
  };

  const setAspectRatio = (w: number, h: number) => {
    // A connected first frame owns the size (see lockedRes).
    if (lockedRes) return;
    // 只写 data：比例是尺寸方程的输入，节点高度由 useAutoFitNode 自动跟上
    updateNodeData(id, { width: w, height: h });
    window.dispatchEvent(new Event('takeSnapshot'));
  };

  const handleCancel = () => {
    cancelledRef.current = true;
    const jobId = data.jobId as string | undefined;
    if (jobId) {
      // Best effort: without this the backend (and the GPU) kept rendering a
      // clip nobody was waiting for, and the next job queued behind it.
      api.cancelJob(jobId).catch(() => {});
    }
    updateNodeData(id, {
      status: 'idle', jobId: undefined, error: undefined, pendingTake: undefined,
      // the take pushed at submit has no clip: it would dangle at takes[0]
      ...(jobId ? { takes: ((data.takes as H3Take[] | undefined) || []).filter((tk) => !(tk.id === jobId && !tk.url)) } : {}),
    });
  };

  const fmt = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const handleScreenshot = async (targetVideo?: HTMLVideoElement) => {
    const v = targetVideo || videoRef.current;
    if (!v) return;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = v.videoWidth || currentWidth;
      canvas.height = v.videoHeight || currentHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/png');

      // Persist to the backend: a raw data: URL renders fine in <img> but cannot be
      // resolved to a file when this node is later used as a reference image.
      let imageUrl = dataUrl;
      try {
        const res = await fetch(`${API_BASE}/upload-image-base64`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: dataUrl, purpose: 'frame' }),
        });
        if (!res.ok) throw new Error(`upload failed: ${res.status}`);
        const { url } = await res.json();
        // Store the backend-relative path, never an absolute one. API_BASE is
        // derived from whatever host the page was opened on, so baking it in
        // saves "http://localhost:8003/..." into the canvas — which resolves to
        // nothing when the same project is opened from another machine.
        imageUrl = url;
      } catch (upErr) {
        console.error('Screenshot upload failed, keeping inline data URL:', upErr);
      }

      const srcNode = getNodes().find(n => n.id === id);
      const newPos = srcNode ? { x: srcNode.position.x + (srcNode.measured?.width || 340) + 40, y: srcNode.position.y } : { x: 100, y: 100 };
      const newNodeId = `upload-${Date.now()}`;

      setNodes(nds => [
        ...nds,
        {
          id: newNodeId,
          type: 'image',
          position: newPos,
          data: { url: imageUrl, width: canvas.width, height: canvas.height, mediaType: 'image' },
        }
      ]);
    } catch (err) {
      console.error('Screenshot capture failed (CORS/tainted canvas):', err);
    }
  };

  // 高清: a 2x latent-refine node to the right, wired to this clip. The upscale
  // node reads everything else (latent, references, chain anchor) from its input.
  const handleCreateUpscaleNode = () => {
    if (!data.generatedUrl) return;
    const srcNode = getNodes().find(n => n.id === id);
    const newPos = srcNode ? { x: srcNode.position.x + (srcNode.measured?.width || 340) + 40, y: srcNode.position.y } : { x: 100, y: 100 };
    const newNodeId = `videoUpscale-${Date.now()}`;
    setNodes(nds => [
      ...nds,
      {
        id: newNodeId,
        type: 'videoUpscale',
        position: newPos,
        width: 280,
        data: {
          scaleBy: 2,
          width: Math.round((currentWidth * 2) / 16) * 16,
          height: Math.round((currentHeight * 2) / 16) * 16,
          status: 'idle',
        },
      },
    ]);
    setEdges(eds => [
      ...eds,
      { id: `e-${id}-${newNodeId}`, source: id, sourceHandle: 'out-video', target: newNodeId, targetHandle: 'in-video' },
    ]);
  };

  const handleCompilePrompt = async () => {
    setIsCompilingPrompt(true);
    try {
      const imageCount = connectedImageUrls.length;
      const videoCount = refVideoUrls.length;
      const audioCount = refAudioUrls.length;
      const targetMode =
        isFirstFrameActive && imageCount === 1 && videoCount === 0 && audioCount === 0
          ? 'i2va'
          : imageCount > 0 || videoCount > 0 || audioCount > 0
          ? 'edit'
          : 'generate';

      const intentToUse = effectivePrompt || localPrompt || (data.prompt as string) || '';

      const { prompt } = await api.compileH3Prompt({
        userIntent: intentToUse,
        mode: targetMode,
        refImagesCount: imageCount,
        refVideosCount: videoCount,
        refAudiosCount: audioCount,
        audioStrategy: 'copy_source',
        duration: currentLength / 24,
      });

      if (prompt) {
        const promptNode = connected.find((n) => n.type === 'prompt' || n.targetHandle === 'in-prompt');
        if (promptNode) {
          updateNodeData(promptNode.id, { text: prompt });
        } else {
          setLocalPrompt(prompt);
          updateNodeData(id, { prompt });
        }
        window.dispatchEvent(new Event('takeSnapshot'));
      }
    } catch (e: any) {
      void showAlert(t('提示词转译失败: {v1}', { v1: e.message }), { title: t('操作失败'), danger: true });
    } finally {
      setIsCompilingPrompt(false);
    }
  };


  const RefImageStrip = connectedImageNodes.length > 0 ? (
    <div className="mb-2 p-1.5 rounded-xl bg-white/[0.03] border border-white/[0.07]">
      <div className="flex items-center justify-between mb-1.5 px-0.5">
        <div className="flex items-center gap-1.5">
          <span className="text-[9px] font-mono text-zinc-400 font-semibold">
            
            {t('✦ 参考图 ({n})', { n: connectedImageNodes.length })}
          </span>
        </div>
        <span className="text-zinc-500 select-none text-[8px] truncate">
          {connectedImageNodes.length > 1 ? t('拖拽排序 · 标签别名') : t('点击插入引用')}
        </span>
      </div>

      <div className="flex items-center gap-1.5 overflow-x-auto pb-1 no-scrollbar">
        {connectedImageNodes.map((node, idx) => {
          const url = (node.generatedUrl || node.url) as string | undefined;
          if (!url) return null;
          const resolved = url.startsWith('blob:') || url.startsWith('http') ? url : `${API_BASE}${url}`;
          const isCurrentFirstFrame = isFirstFrameActive && (firstFrameNodeId ? node.id === firstFrameNodeId : idx === 0);
          const isPrimary = idx === 0;
          const isDragged = draggedRefIdx === idx;
          const isDragOver = dragOverRefIdx === idx && draggedRefIdx !== idx;
          const effectiveAlias = node.alias || '';

          return (
            <div
              key={node.id || idx}
              draggable={connectedImageNodes.length > 1}
              onDragStart={(e) => {
                e.dataTransfer.setData('text/plain', String(idx));
                setDraggedRefIdx(idx);
              }}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
              onDragEnter={() => { if (draggedRefIdx !== null && draggedRefIdx !== idx) setDragOverRefIdx(idx); }}
              onDragLeave={() => { if (dragOverRefIdx === idx) setDragOverRefIdx(null); }}
              onDrop={(e) => {
                e.preventDefault();
                const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
                if (!isNaN(fromIdx) && fromIdx !== idx) handleMoveRefImage(fromIdx, idx);
                setDraggedRefIdx(null); setDragOverRefIdx(null);
              }}
              className={`nodrag relative group/thumb flex-shrink-0 rounded-xl overflow-hidden border transition-all ${isDragged ? 'opacity-30 scale-90 border-dashed border-amber-400'
                  : isDragOver ? 'scale-110 ring-2 ring-amber-400 border-amber-300 z-30'
                    : isCurrentFirstFrame ? 'border-amber-500/90 shadow-[0_0_10px_rgba(245,158,11,0.3)] ring-1 ring-amber-400/50'
                      : isPrimary ? 'border-white/40 shadow-[0_0_8px_rgba(255,255,255,0.15)] ring-1 ring-white/20'
                        : 'border-white/20 hover:border-white/50 bg-black/40'
                }`}
              style={{ width: isCurrentFirstFrame || isPrimary ? 48 : 44, height: isCurrentFirstFrame || isPrimary ? 48 : 44 }}
            >
              <button
                type="button"
                className="w-full h-full p-0 m-0 border-0 bg-transparent cursor-grab active:cursor-grabbing block relative"
                title={effectiveAlias
                  ? t('按住拖拽调序，或点击插入 {token} 引用', { token: `<图${idx + 1}:${effectiveAlias}>` })
                  : t('按住拖拽调序，或点击插入 {token} 引用', { token: `<图${idx + 1}>` })}
                onClick={(e) => { e.stopPropagation(); insertImageToken(idx + 1); }}
              >
                <img src={resolved} alt="" className="w-full h-full object-cover pointer-events-none" />
                <div className="absolute inset-0 bg-black/70 opacity-0 group-hover/thumb:opacity-100 transition-opacity flex items-center justify-center pointer-events-none">
                  <span className="text-[8px] font-mono text-amber-300 font-bold truncate max-w-[40px] px-0.5">
                    {effectiveAlias ? `+${effectiveAlias}` : `+图${idx + 1}`}
                  </span>
                </div>
              </button>

              <div className="absolute top-0 inset-x-0 h-4 bg-black/85 backdrop-blur-xs flex items-center justify-between px-0.5 opacity-0 group-hover/thumb:opacity-100 transition-opacity z-20">
                {idx > 0 ? (
                  <button type="button" title={t('向前移动')} onClick={(e) => { e.stopPropagation(); handleMoveRefImage(idx, idx - 1); }} className="w-3 h-3 flex items-center justify-center rounded text-[7px] text-zinc-300 hover:text-white hover:bg-white/20 cursor-pointer">◀</button>
                ) : <span className="w-3" />}

                {idx < connectedImageNodes.length - 1 ? (
                  <button type="button" title={t('向后移动')} onClick={(e) => { e.stopPropagation(); handleMoveRefImage(idx, idx + 1); }} className="w-3 h-3 flex items-center justify-center rounded text-[7px] text-zinc-300 hover:text-white hover:bg-white/20 cursor-pointer">▶</button>
                ) : <span className="w-3" />}
              </div>

              {effectiveAlias ? (
                <span
                  className="absolute bottom-0 inset-x-0 bg-black/85 backdrop-blur-xs text-amber-300 text-[8px] font-sans font-medium text-center truncate px-0.5 leading-tight py-0.5 border-t border-amber-500/20 pointer-events-none"
                  title={t('参考别名: {v1}', { v1: effectiveAlias })}
                >
                  {effectiveAlias}
                </span>
              ) : (
                <span
                  className={`absolute bottom-0 right-0 px-1 py-0.2 text-[8px] font-mono rounded-tl pointer-events-none group-hover/thumb:hidden ${isCurrentFirstFrame ? 'bg-amber-600 text-white font-bold' : isPrimary ? 'bg-emerald-600 text-white font-bold' : 'bg-black/80 text-zinc-300'
                    }`}
                >
                  {isCurrentFirstFrame
                    ? t('🎬 首帧 {token}', { token: `图${idx + 1}` })
                    : isPrimary ? '图1 ★' : `图${idx + 1}`}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  ) : null;

  // ── 功能区 ──────────────────────────────────────────────────
  // 抽成变量是为了让标定镜像复用同一份 JSX：镜像量的就是真身，不会漂移。
  const HeaderRow = (
    <div style={header} data-chrome-row="header" className="node-shell-header flex items-center justify-between">
      <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-white/[0.05] border border-white/[0.08] text-zinc-300">
        <VideoIcon />
        <span style={label} className="text-zinc-200" data-chrome="label">
          
          {t('MiniMax H3 电影镜头')}
        </span>
      </div>
      <div className="flex items-center gap-1">
        {data.latentFilename && (
          <span className="text-[9px] font-mono px-1.5 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 flex items-center gap-1" title={t('原始H3 Latent潜空间已就绪，可连接增强节点进行无损潜空间超分精炼')}>
            <BoltIcon />
            <span data-chrome="label">Latent</span>
          </span>
        )}
        {chainParent && (
          <label
            className="nodrag text-[9px] font-mono px-1.5 py-0.5 rounded-full border border-white/10 bg-white/[0.04] text-zinc-400 flex items-center gap-1"
            title={t('从上一段的第几帧往前接。留空是接它的最后一帧；中间插了别的机位时，填切走前的那一帧数（与剪切节点的结束帧同一个数）。')}
          >
            <span data-chrome="label">{t('接第')}</span>
            <span className="node-shell-label-fallback">{t('接')}</span>
            <input
              type="number"
              min={1}
              step={1}
              className="nodrag w-10 bg-transparent text-right text-zinc-200 outline-none"
              value={Number(data.motionContextAtFrame) > 0 ? Number(data.motionContextAtFrame) : ''}
              placeholder={t('末')}
              onChange={(e) => updateNodeData(id, { motionContextAtFrame: e.target.value ? Math.max(1, Math.round(Number(e.target.value))) : undefined })}
            />
            <span data-chrome="label">{t('帧')}</span>
          </label>
        )}
        {typeof data.untrimmedUrl === 'string' && data.untrimmedUrl && (
          <a
            href={resolveAssetUrl(data.untrimmedUrl)}
            target="_blank"
            rel="noreferrer"
            className="nodrag text-[9px] font-mono px-1.5 py-0.5 rounded-full bg-sky-500/10 border border-sky-500/30 text-sky-300 hover:text-sky-100"
            title={t('含接续重叠帧的完整片段（前 {n} 帧与上一段重叠，剪切前的原片）', { n: Number(data.contextFrames) || 0 })}
          >
            <span data-chrome="label">{t('含重叠')}</span>
            <span className="node-shell-label-fallback">{t('叠')}</span>
          </a>
        )}
        {typeof data.generatedUrl === 'string' && data.generatedUrl && (
          <>
            <button
              onClick={() => updateNodeData(id, togglePin(data))}
              className={`nodrag text-[9px] font-mono px-1.5 py-0.5 rounded-full border ${
                data.pinLastFrame
                  ? pinIsElsewhere(data)
                    ? 'bg-amber-500/25 border-amber-400/70 text-amber-100'
                    : 'bg-amber-500/15 border-amber-500/40 text-amber-200'
                  : 'bg-white/[0.04] border-white/10 text-zinc-500 hover:text-zinc-300'
              }`}
              title={
                data.pinLastFrame
                  ? t('重跑时新一版的最后一帧钉在 {v1} 的最后一帧，换显示的版本也不会变。再点一次取消。', { v1: fileTag(pinnedSource(data)) })
                  : t('打开后记住当前显示的这一版，重跑时把它的最后一帧钉在新一版的最后一帧，接在后面的链段就不用跟着重跑')
              }
            >
              <span data-chrome="label">
                {data.pinLastFrame ? t('钉着 {v1}', { v1: fileTag(pinnedSource(data)) }) : t('钉末帧')}
              </span>
              <span className="node-shell-label-fallback">{t('钉')}</span>
            </button>
            {pinnedSource(data) && <PinnedFramePreview src={pinnedSource(data) as string} />}
            {Array.isArray(data.audioLocks) && data.audioLocks.length > 0 && (
              <span
                className="text-[9px] font-mono px-1.5 py-0.5 rounded-full border border-sky-400/40 text-sky-200"
                title={t('这个节点有音频锁定：录音放在成片的指定秒数并保持原样，其余声音由模型围绕它生成。在这里只读，用 MCP 设置。')}
              >
                <span data-chrome="label">{t('音频锁定 {v1} 条', { v1: data.audioLocks.length })}</span>
                <span className="node-shell-label-fallback">{t('锁 {v1}', { v1: data.audioLocks.length })}</span>
              </span>
            )}
            {pinIsElsewhere(data) && (
              <button
                onClick={() => updateNodeData(id, repin(data))}
                className="nodrag text-[9px] font-mono px-1.5 py-0.5 rounded-full border border-amber-400/50 text-amber-200 hover:bg-amber-400/15"
                title={t('钉的不是现在显示的这一版；点这里改钉现在显示的版本')}
              >
                <span data-chrome="label">{t('改钉当前版')}</span>
                <span className="node-shell-label-fallback">{t('改钉')}</span>
              </button>
            )}
          </>
        )}
        <NodeHeaderIconButton
          active={showSettings}
          onClick={() => setShowSettings(!showSettings)}
          title={t('镜头规格与调度参数')}
        >
          <GearIcon />
        </NodeHeaderIconButton>
      </div>
    </div>
  );

  const ActionsRow = (
    <div data-chrome-row="actions" className="node-shell-actions pt-2 space-y-1.5 z-20">
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
        className="w-full py-2 rounded-xl bg-white/20 hover:bg-white/30 border border-white/25 text-white text-xs font-semibold shadow-lg transition-all duration-150 active:scale-[0.98] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
      >
        <VideoIcon />
        <span data-chrome="label">{data.generatedUrl ? t('更新并重新生成音视频') : t('生成 MiniMax H3 电影音视频')}</span>
        <span className="node-shell-label-fallback">{data.generatedUrl ? t('重新生成') : t('生成')}</span>
      </button>
    </div>
  );

  return (
    <NodeShell
      nodeId={id}
      spec={spec}
      selected={selected}
      onResizeEnd={sizing.onResizeEnd}
      autoHeight
    >
      {/* 功能区与设置抽屉。抽屉是流内一行：打开撑高节点，关上还原 */}
      <div className="node-shell-headwrap" style={{ position: 'relative', flex: '0 0 auto' }}>
        {/* The label names the take on display and its acceptance state (written
            over the canvas MCP). Upload nodes already show theirs; a segment node
            that hides it leaves the reviewer looking at a clip with no idea which
            version it is. Placed above the icon row so it acts as the node's title/summary. */}
        {hasLabelRow && (
          <div
            data-chrome-row="label"
            className="px-2 pb-1 text-[10px] leading-snug text-zinc-400 tracking-tight select-none break-words"
            title={data.label ? String(data.label) : undefined}
          >
            {editingLabel ? (
              <textarea
                autoFocus
                defaultValue={String(data.label ?? '')}
                className="nodrag nowheel w-full resize-none rounded bg-black/40 p-1 text-[10px] text-zinc-200 outline-none select-text"
                rows={3}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Escape') setEditingLabel(false);
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); }
                }}
                onBlur={(e) => { updateNodeData(id, { label: e.target.value.trim() }); setEditingLabel(false); }}
              />
            ) : (
              <div
                className="cursor-text"
                title={t('双击编辑标签')}
                onDoubleClick={(e) => { e.stopPropagation(); setEditingLabel(true); }}
              >{data.label ? String(data.label) : <span className="text-zinc-600">{t('双击编辑标签')}</span>}</div>
            )}
            {dialogue.length > 0 && (
              <div className="mt-1 space-y-0.5 border-l border-white/15 pl-1.5 text-zinc-300">
                {dialogue.map((line, i) => (
                  <div key={i}>
                    {line.speaker && <span className="text-amber-200/80">{line.speaker}：</span>}
                    {line.text}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {HeaderRow}

        {showSettings && (
          <div data-chrome-row="settings" className="node-shell-drawer nodrag nowheel p-3 text-xs space-y-3 animate-in fade-in duration-150">
            <AudioLocksPanel
              nodeId={id}
              locks={Array.isArray(data.audioLocks) ? (data.audioLocks as LockRow[]) : []}
              generatedUrl={data.generatedUrl as string | null | undefined}
              latentFilename={data.latentFilename as string | null | undefined}
              seed={data.seed as number | undefined}
              busy={data.status === 'generating'}
              onChange={(locks) => updateNodeData(id, { audioLocks: locks })}
            />
            {/* Motion preset */}
            <div>
              <div className="text-[10px] text-zinc-400 font-medium mb-1.5 flex justify-between">
                <span>{t('底模')}</span>
                <span className="font-mono text-zinc-200">
                  {currentPreset === 'hybrid'
                    ? 'hybrid_b25-49 + turbo_8step'
                    : currentPreset === 'fused'
                      ? 'fused_refdelta_turbo8_mystic07'
                      : currentPreset === 'hyperflow'
                        ? 'ref2va_int8（未剪枝）+ HyperFlow 8步'
                      : currentPreset === 'ref2va'
                        ? 'ref2va_pruned_int8（官方剪枝）'
                        : currentPreset === 'ref2va_full'
                          ? 'ref2va_int8（官方未剪枝）'
                        : singularityIsW4a8
                          ? t('Singularity w4a8 量化版（本机显存小，自动选用）')
                          : 'Singularity_ref2va_v1.3'}
                </span>
              </div>
              <div className="grid grid-cols-5 gap-1.5">
                {[
                  { label: 'Singul.', value: 'singularity' },
                  { label: 'Fused', value: 'fused' },
                  { label: 'Hybrid', value: 'hybrid' },
                  { label: 'HyperFlow', value: 'hyperflow' },
                  { label: '官方', value: 'ref2va' },
                ].map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => updateNodeData(id, { motionPreset: opt.value })}
                    disabled={Boolean(machineProfile?.disabled_presets?.includes(opt.value))}
                    title={machineProfile?.disabled_presets?.includes(opt.value)
                      ? t('这台机器的显存放不下这个底模，已禁用。')
                      : opt.value === 'ref2va'
                      ? t('minimax_h3_ref2va_pruned_int8_convrot（19.5GB）+ ref2v turbo 8步 LoRA。MiniMax 官方权重的剪枝 int8 版，没有任何第三方微调、也没有合并 turbo 或 Mystic，是判断其他底模好坏的中性基准。和 Singularity 同一量级、比官方未剪枝版省一半显存，日常做 A/B 用这个。剪枝版不含 time_embedder，HyperFlow 仍需它自己的预设；深度控制走官方节点，这个底模可用。')
                      : opt.value === 'ref2va_full'
                      ? t('minimax_h3_ref2va_int8_convrot（31.7GB）+ ref2v turbo 8步 LoRA。官方未剪枝权重，本机唯一还带 time_embedder 的底模，也是 HyperFlow 的同底模对照组。显存占用最高，除非要和 HyperFlow 对比，平时用「官方」那个剪枝版即可。')
                      : opt.value === 'hyperflow'
                      ? t('videorebirth/hyperflow 8 步蒸馏 LoRA，挂在未剪枝的 minimax_h3_ref2va_int8_convrot（34GB）上，用它自带的 sigma 网格 + euler，不走加速 LoRA。只有未剪枝底模带 time_embedder，所以不能配其他底模。2026-09-19 对比：和同底模 turbo8 几乎一样、慢约 20 秒；画面比 Singularity 亮一截（来自底模）。')
                      : opt.value === 'hybrid'
                      ? t('minimax_h3_hybrid_b25-49_int8 + minimax_h3_fl2v_turbo_8step_v1.0_768p + beta 调度。运动更克制：同一镜实测车身俯仰 34.7° vs Fused 的 42.4°，两者都消不掉。深度控制现在走官方节点（ControlNet 2.0），各底模都能用，不再需要 Fused。')
                      : opt.value === 'singularity'
                        ? t('Minimax-h3_Singularity_ref2va_Pruned_v1.3_int8 + 加速 LoRA（TaoMate 3步 或 ref2v turbo 8步）。第三方 ref2va 微调（HDR 数据集），作者称中远景人脸、肤色与动作幅度更好。底模不含 turbo，靠外挂 8 步 LoRA。张量表与 ref2va_pruned 一一对应（932 个，仅键名多 model.diffusion_model. 前缀），深度控制走官方节点，同样可用，不需要 Fused。显存不足 24GB 的机器自动换成它的 w4a8 量化版（ref2va_pruned_w4a8，11.8GB）。')
                        : t('minimax_h3_fused_refdelta_r1024_turbo8_mystic07_int8_convrot。turbo 与 Mystic 0.7 已合并进底模，运动与细节最强，4/8 步。加载时 ComfyUI 会报 unet unexpected 警告，属正常。')}
                    className={`py-1 px-1.5 text-[10px] rounded-lg border transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-30 ${shownPreset === opt.value
                        ? 'bg-white/20 border-white/40 text-white font-semibold shadow-xs'
                        : 'bg-white/[0.03] border-white/10 text-zinc-400 hover:text-white hover:bg-white/[0.08]'
                      }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Attention patch: Sol is off the table on a w4a8 base */}
            <div>
              <div className="text-[10px] text-zinc-400 font-medium mb-1.5 flex justify-between">
                <span>{t('注意力补丁')}</span>
                <span className="font-mono text-zinc-200">
                  {effectiveAttention || t('跟随本机默认')}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                {[
                  { label: t('默认'), value: '', tip: t('不指定，用这台机器的默认（工作站 Sol，16 GB 档 kjsage）。') },
                  { label: 'Sol', value: 'sol', tip: attentionBlocked('sol') ? t('w4a8 底模上 Sol 会让人脸变形，已禁用。') : t('最快；int8 底模上没有看到问题。') },
                  { label: 'kjsage', value: 'kjsage', tip: t('省显存的 SageAttention，比 Sol 慢约 20%，画面干净。') },
                ].map((opt) => {
                  const blocked = opt.value !== '' && attentionBlocked(opt.value);
                  return (
                    <button
                      key={opt.label}
                      disabled={blocked}
                      onClick={() => updateNodeData(id, { accel: opt.value || undefined })}
                      title={opt.tip}
                      className={`py-1 px-1.5 text-[10px] rounded-lg border transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-30 ${effectiveAttention === opt.value
                          ? 'bg-white/20 border-white/40 text-white font-semibold shadow-xs'
                          : 'bg-white/[0.03] border-white/10 text-zinc-400 hover:text-white hover:bg-white/[0.08]'
                        }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
              {chosenAttention && attentionBlocked(chosenAttention) && (
                <p className="mt-1 text-[9px] leading-relaxed text-amber-300">
                  {t('这个节点设了 {v1}，但这个底模不允许，实际会用 {v2}。', { v1: chosenAttention, v2: effectiveAttention })}
                </p>
              )}
            </div>

            {/* Speed LoRA */}
            <div>
              <div className="text-[10px] text-zinc-400 font-medium mb-1.5 flex justify-between">
                <span>{t('加速 LoRA')}</span>
                <span className="font-mono text-zinc-200">
                  {currentPreset === 'fused' ? t('已合并进底模') : currentPreset === 'hyperflow' ? t('HyperFlow 自带 8 步') : currentAccel === 'taomate3' ? 'TaoMate 3步' : currentAccel === 'turbo8' ? 'turbo 8步' : t('不加速 20步')}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                {[
                  { label: t('TaoMate 3步'), value: 'taomate3', tip: t('TaoMate-H3-3step，固定 3 步。链7 同 seed 整单 103–108s vs turbo 8步 203–222s；色调偏冷、台灯更亮。') },
                  { label: t('turbo 8步'), value: 'turbo8', tip: t('底模自带的 8 步 turbo LoRA，固定 8 步。已验收镜头要保持原貌时用它。') },
                  { label: t('不加速 20步'), value: 'none', tip: t('不挂加速 LoRA，20 步 res_multistep，同 ComfyUI 官方 r2v 模板。本项目未实测画质与耗时。') },
                ].map((opt) => (
                  <button
                    key={opt.value}
                    disabled={ownsSteps}
                    title={opt.tip}
                    onClick={() => updateNodeData(id, { accelLora: opt.value })}
                    className={`py-1 px-1.5 text-[10px] rounded-lg border transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${currentAccel === opt.value
                        ? 'bg-white/20 border-white/40 text-white font-semibold shadow-xs'
                        : 'bg-white/[0.03] border-white/10 text-zinc-400 hover:text-white hover:bg-white/[0.08]'
                      }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Block-sparse attention: on for new nodes, absent (off) on older ones */}
            <label
              className="flex items-center justify-between text-[10px] text-zinc-400 font-medium cursor-pointer"
              title={t('稀疏注意力：快约 21%，构图动作不变但小细节会重画；已验收镜头重跑要保持原貌就关掉')}
            >
              <span>{t('稀疏注意力（加速）')}</span>
              <input
                type="checkbox"
                checked={data.blockSparse === true}
                onChange={(e) => updateNodeData(id, { blockSparse: e.target.checked })}
              />
            </label>

            {/* Style LoRA (the speed LoRA is chosen above, not here) */}
            <div>
              <div className="text-[10px] text-zinc-400 font-medium mb-1.5 flex justify-between">
                <span>{t('风格 LoRA')}</span>
                <span className="font-mono text-zinc-200">
                  {(((data.styleLoras as string[] | undefined) || []).map((n) => n.split('/').pop()?.replace('.safetensors', '')).join(' + ')) || t('不加载')}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                {STYLE_LORA_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => {
                      const cur = (data.styleLoras as string[] | undefined) || [];
                      if (cur.includes(opt.value)) {
                        updateNodeData(id, { styleLoras: cur.filter((v) => v !== opt.value) });
                      } else {
                        // Write the default onto the node so the canvas MCP, which has no
                        // copy of this table, renders at the same strength.
                        const strengths = (data.styleLoraStrengths as Record<string, number> | undefined) || {};
                        updateNodeData(id, {
                          styleLoras: [...cur, opt.value],
                          styleLoraStrengths: { ...strengths, [opt.value]: strengths[opt.value] ?? opt.defaultStrength },
                        });
                      }
                    }}
                    title={opt.title}
                    className={`py-1 px-1.5 text-[10px] rounded-lg border transition-colors cursor-pointer ${(((data.styleLoras as string[] | undefined) || []).includes(opt.value))
                        ? 'bg-white/20 border-white/40 text-white font-semibold shadow-xs'
                        : 'bg-white/[0.03] border-white/10 text-zinc-400 hover:text-white hover:bg-white/[0.08]'
                      }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              {/* Per-LoRA strength, in stacking order. Kept in a separate map so
                  styleLoras stays a plain list of names; 1.0 when unset. */}
              {((data.styleLoras as string[] | undefined) || []).map((name) => {
                const strengths = (data.styleLoraStrengths as Record<string, number> | undefined) || {};
                const value = strengths[name] ?? styleLoraDefaultStrength(name);
                const opt = STYLE_LORA_OPTIONS.find((o) => o.value === name);
                const range = opt?.recommendedRange;
                // Compare at 0.1 precision so 1.0000001 from the slider is not "out".
                const r10 = (x: number) => Math.round(x * 10);
                const outOfRange = !!range && (r10(value) < r10(range[0]) || r10(value) > r10(range[1]));
                const rangeText = range
                  ? (range[0] === range[1] ? range[0].toFixed(1) : `${range[0].toFixed(1)}–${range[1].toFixed(1)}`)
                  : t('无官方建议');
                return (
                  <div key={name} className="mt-1.5">
                  <div className="flex items-center gap-2 text-[10px] text-zinc-400">
                    <span className="w-14 truncate" title={name}>{opt?.label || name.split('/').pop()}</span>
                    <input
                      type="range" min={0} max={2} step={0.1} value={value}
                      onChange={(e) => updateNodeData(id, { styleLoraStrengths: { ...strengths, [name]: Number(e.target.value) } })}
                      className={`nodrag min-w-0 flex-1 cursor-pointer ${outOfRange ? 'accent-red-500' : 'accent-white'}`}
                      aria-label={t('LoRA 强度')}
                    />
                    <input
                      type="number" min={0} max={2} step={0.1} value={value}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (Number.isFinite(v)) updateNodeData(id, { styleLoraStrengths: { ...strengths, [name]: Math.max(0, Math.min(2, v)) } });
                      }}
                      className={`nodrag w-12 rounded border bg-white/[0.03] px-1 py-0.5 text-right font-mono ${outOfRange ? 'border-red-500/60 text-red-400' : 'border-white/10 text-zinc-200'}`}
                    />
                  </div>
                  <div className={`mt-0.5 pl-16 text-[9px] ${outOfRange ? 'text-red-400' : 'text-zinc-500'}`}>
                    {t('推荐')}: <span className="font-mono">{rangeText}</span>{outOfRange ? ` · ${t('超出推荐范围')}` : ''}
                  </div>
                  </div>
                );
              })}
              {STYLE_LORA_OPTIONS.filter((o) => o.sampling && ((data.styleLoras as string[] | undefined) || []).includes(o.value)).map((o) => (
                <div key={o.value} className="mt-1 text-[9px] text-amber-300/80">
                  {o.label} {t('已锁定采样')}: <span className="font-mono">{o.sampling}</span>
                </div>
              ))}
            </div>

            {/* Steps: fixed by the speed LoRA */}
            <div className="text-[10px] text-zinc-400 font-medium flex justify-between">
              <span>{t('推理步数（由加速 LoRA 决定）')}</span>
              <span className="font-mono text-zinc-200">{currentSteps} Steps</span>
            </div>

            {/* Duration / Length */}
            <div>
              <div className="text-[10px] text-zinc-400 font-medium mb-1.5 flex justify-between">
                <span>{t('镜头时长 (17k+5 网格)')}</span>
                {/* The frame count is the thing that lands, but nobody thinks in
                    frames -- and a length typed in from outside the four presets
                    used to show only a number (2026-09-09). */}
                <span className="font-mono text-zinc-200">{currentLength}  {t('帧 ·')} {(currentLength / 24).toFixed(2)}s</span>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {H3_LENGTH_OPTIONS.map((opt) => (
                  <button
                    key={opt.frames}
                    onClick={() => updateNodeData(id, { length: opt.frames, duration: opt.duration })}
                    className={`py-1 px-1.5 text-[10px] rounded-lg border transition-colors cursor-pointer ${currentLength === opt.frames
                        ? 'bg-white/20 border-white/40 text-white font-semibold shadow-xs'
                        : 'bg-white/[0.03] border-white/10 text-zinc-400 hover:text-white hover:bg-white/[0.08]'
                      }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              {/* Fine adjustment. The four presets are the common lengths, but a
                  shot that needs 12 seconds had nowhere to go except the MCP or
                  a hand-typed number (2026-09-09). The arrows walk the
                  17k+5 grid one step (0.71s) at a time; the box snaps whatever
                  is typed to the nearest legal length. */}
              <div className="mt-1.5 flex items-center gap-1.5 nodrag">
                <button
                  type="button"
                  title={t('上一档 (-17 帧)')}
                  onClick={() => {
                    const i = H3_FRAME_GRID.indexOf(snapToFrameGrid(currentLength));
                    const next = H3_FRAME_GRID[Math.max(0, i - 1)];
                    updateNodeData(id, { length: next, duration: next / 24 });
                  }}
                  disabled={snapToFrameGrid(currentLength) <= H3_FRAME_GRID[0]}
                  className="w-6 h-6 rounded-lg border border-white/10 bg-white/[0.03] text-zinc-300 text-[11px] leading-none hover:bg-white/[0.08] hover:text-white disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                >
                  −
                </button>
                <input
                  type="number"
                  value={currentLength}
                  step={17}
                  min={H3_FRAME_GRID[0]}
                  max={H3_FRAME_GRID[H3_FRAME_GRID.length - 1]}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v)) updateNodeData(id, { length: v, duration: v / 24 });
                  }}
                  onBlur={(e) => {
                    const snapped = snapToFrameGrid(Number(e.target.value) || currentLength);
                    updateNodeData(id, { length: snapped, duration: snapped / 24 });
                  }}
                  className="flex-1 min-w-0 h-6 px-1.5 rounded-lg border border-white/10 bg-black/30 text-[10px] font-mono text-zinc-200 text-center focus:outline-hidden focus:border-white/30"
                />
                <button
                  type="button"
                  title={t('下一档 (+17 帧)')}
                  onClick={() => {
                    const i = H3_FRAME_GRID.indexOf(snapToFrameGrid(currentLength));
                    const next = H3_FRAME_GRID[Math.min(H3_FRAME_GRID.length - 1, i + 1)];
                    updateNodeData(id, { length: next, duration: next / 24 });
                  }}
                  disabled={snapToFrameGrid(currentLength) >= H3_FRAME_GRID[H3_FRAME_GRID.length - 1]}
                  className="w-6 h-6 rounded-lg border border-white/10 bg-white/[0.03] text-zinc-300 text-[11px] leading-none hover:bg-white/[0.08] hover:text-white disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                >
                  +
                </button>
              </div>
              <div className="mt-1 text-[9px] text-zinc-500">
                {isOnFrameGrid(currentLength)
                  ? t('网格第 {v1}/{v2} 档 · 上限 {v3} 帧 ({v4}s)', { v1: H3_FRAME_GRID.indexOf(currentLength) + 1, v2: H3_FRAME_GRID.length, v3: H3_FRAME_GRID[H3_FRAME_GRID.length - 1], v4: (H3_FRAME_GRID[H3_FRAME_GRID.length - 1] / 24).toFixed(2) })
                  : t('不在 17k+5 网格上 · 最近的一档是 {v1} 帧 ({v2}s)', { v1: snapToFrameGrid(currentLength), v2: (snapToFrameGrid(currentLength) / 24).toFixed(2) })}
              </div>
            </div>

            {/* Guide frames: each image on in-last-frame is pinned at its own pixel frame
                (MiniMaxH3AddGuide). -1 is the clip's last frame. Frames inside a chained
                clip's motion-context head (~22) are dropped by the pack. */}
            {guideFrames.length > 0 && (
              <div>
                <div className="text-[10px] text-zinc-400 font-medium">{t('引导帧钉在第几帧（按连线顺序）')}</div>
                {guideFrames.map((g, i) => (
                  <div key={i} className="mt-1.5 flex items-center gap-1.5 nodrag">
                    <img src={resolveAssetUrl(g.url)} alt="" className="w-10 h-6 object-cover rounded border border-white/10" />
                    <input
                      type="number"
                      value={g.frame_index}
                      min={-1}
                      max={currentLength - 1}
                      step={1}
                      onChange={(e) => {
                        const v = Math.round(Number(e.target.value));
                        if (Number.isFinite(v)) setGuideFrameIndex(i, Math.max(-1, Math.min(currentLength - 1, v)));
                      }}
                      className="flex-1 min-w-0 h-6 px-1.5 rounded-lg border border-white/10 bg-black/30 text-[10px] font-mono text-zinc-200 text-center focus:outline-hidden focus:border-white/30"
                    />
                    <span className="w-12 text-right text-[9px] font-mono text-zinc-400">
                      {g.frame_index < 0 ? t('最后一帧') : `${(g.frame_index / 24).toFixed(2)}s`}
                    </span>
                    <button
                      type="button"
                      onClick={() => setGuideFrameIndex(i, -1)}
                      className="h-6 px-2 rounded-lg border border-white/10 bg-white/[0.03] text-zinc-300 text-[10px] hover:bg-white/[0.08] hover:text-white cursor-pointer"
                    >
                      {t('尾')}
                    </button>
                  </div>
                ))}
                <div className="mt-1 text-[9px] text-zinc-500">{t('-1 = 最后一帧；接前段时开头约 22 帧内的引导会被丢弃')}</div>
              </div>
            )}

            {/* Resolution */}
            <div>
              <div className="text-[10px] text-zinc-400 font-medium mb-1.5 flex justify-between">
                <span>{t('画幅比例 (Aspect Ratio)')}{lockedRes ? ` · ${lockedLabel}` : ''}</span>
                <span className="font-mono text-cyan-300 font-semibold">
                  {currentWidth}×{currentHeight}
                </span>
              </div>

              {/* Visual Aspect Ratio Wireframe Chips */}
              <div className={`grid grid-cols-5 gap-1 mb-2 ${lockedRes ? 'opacity-40 pointer-events-none' : ''}`}>
                {H3_ASPECT_RATIOS.map((ar) => {
                  const isSel = Number(currentWidth) === ar.w && Number(currentHeight) === ar.h;
                  return (
                    <button
                      key={ar.label}
                      type="button"
                      disabled={Boolean(lockedRes)}
                      onClick={() => setAspectRatio(ar.w, ar.h)}
                      title={lockedRes ? lockedLabel : `${ar.label} (${t(ar.desc)}) - ${ar.w}×${ar.h}`}
                      className={`flex flex-col items-center justify-center p-1.5 rounded-lg border transition-all cursor-pointer ${
                        isSel
                          ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200 shadow-sm shadow-cyan-500/20 font-bold'
                          : 'bg-white/[0.03] border-white/10 text-zinc-400 hover:text-white hover:bg-white/10'
                      }`}
                    >
                      <div className={`border border-current rounded-xs mb-1 ${ar.iconRatio} ${isSel ? 'bg-cyan-400/30' : 'bg-transparent'}`} />
                      <span className="text-[9px] font-mono leading-none">{ar.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

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

            {/* Debug Panel: compiled H3 prompt preview */}
            <div className="pt-2 border-t border-white/10">
              <button
                type="button"
                onClick={() => setShowDebug(v => !v)}
                className="w-full flex items-center justify-between text-[10px] text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer py-0.5"
              >
                <span className="flex items-center gap-1.5">
                  <span className="text-[9px] font-mono bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-1 rounded">DEBUG</span>
                  <span>{t('实际发送的 Prompt')}</span>
                </span>
                <span className="text-zinc-500">{showDebug ? '▲' : '▼'}</span>
              </button>

              {showDebug && (() => {
                const finalFirstFrameUrl = isFirstFrameActive ? firstFrameUrl : null;
                const finalRefImageUrls = isFirstFrameActive
                  ? connectedImageUrls.filter((u) => u !== firstFrameUrl)
                  : connectedImageUrls;
                const apiPayload = {
                  prompt: effectivePrompt,
                  image_url: finalFirstFrameUrl || undefined,
                  guide_frames: guideFrames.length ? guideFrames : undefined,
                  guide_frames_delivered: data.guideFramesDelivered ? true : undefined,
                  pin_last_frame_of: pinnedSource(data),
                  ref_image_urls: finalRefImageUrls.length ? finalRefImageUrls : undefined,
                  ref_audio_urls: refAudioUrls.length ? refAudioUrls : undefined,
                  ref_video_urls: refVideoUrls.length ? refVideoUrls : undefined,
                  width: currentWidth,
                  height: currentHeight,
                  steps: currentSteps,
                  length: currentLength,
                  seed: data.seed ?? -1,
                };

                const handleFetchCompiled = async () => {
                  setIsFetchingCompiled(true);
                  setCompiledPromptResult(null);
                  try {
                    const res = await fetch(`${API_BASE}/preview-video-workflow`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify(apiPayload),
                    });
                    if (!res.ok) throw new Error(await res.text());
                    const data = await res.json();
                    setCompiledPromptResult({
                      prompt: data.compiled_prompt,
                      mode: data.mode,
                      modified: data.prompt_was_modified,
                    });
                  } catch (e: any) {
                    setCompiledPromptResult({ prompt: t('❌ 错误: {v1}', { v1: e.message }), mode: '', modified: false });
                  } finally {
                    setIsFetchingCompiled(false);
                  }
                };

                return (
                  <div className="mt-1.5 space-y-2">
                    {/* Raw prompt from frontend */}
                    <div className="rounded-lg bg-black/50 border border-white/10 overflow-hidden">
                      <div className="flex items-center justify-between px-2 py-1 bg-white/[0.03] border-b border-white/[0.06]">
                        <span className="text-[9px] font-mono text-zinc-500">{t('前端原始 Prompt ({n} chars)', { n: effectivePrompt.length })}</span>
                        <button
                          type="button"
                          onClick={() => void copyTextToClipboard(effectivePrompt)
                            .then(() => { setDebugCopied(true); setTimeout(() => setDebugCopied(false), 1500); })
                            .catch((error) => void showAlert(error.message))}
                          className="text-[8px] font-mono px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20 text-zinc-300 hover:text-white transition-colors cursor-pointer"
                        >
                          {debugCopied ? t('✓ 已复制') : t('复制')}
                        </button>
                      </div>
                      <pre className="p-2 text-[8.5px] font-mono text-zinc-300 leading-relaxed max-h-32 overflow-y-auto whitespace-pre-wrap break-all">
                        {effectivePrompt || t('(空)')}
                      </pre>
                    </div>

                    {/* Fetch compiled prompt from backend */}
                    <button
                      type="button"
                      onClick={handleFetchCompiled}
                      disabled={isFetchingCompiled}
                      className="w-full py-1 px-2 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 text-[9px] font-mono transition-colors cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1.5"
                    >
                      {isFetchingCompiled ? (
                        <><span className="animate-spin">↻</span><span>{t('后端处理中…')}</span></>
                      ) : (
                        <><span>↓</span><span>{t('获取后端编译 Prompt（含 build_smart_fallback_h3_prompt）')}</span></>
                      )}
                    </button>

                    {compiledPromptResult && !compiledSameAsPrompt && (
                      <div className="rounded-lg bg-black/50 border overflow-hidden"
                        style={{ borderColor: compiledPromptResult.modified ? 'rgba(245,158,11,0.4)' : 'rgba(255,255,255,0.1)' }}
                      >
                        <div className="flex items-center justify-between px-2 py-1 border-b"
                          style={{ background: compiledPromptResult.modified ? 'rgba(245,158,11,0.08)' : 'rgba(255,255,255,0.03)', borderColor: compiledPromptResult.modified ? 'rgba(245,158,11,0.2)' : 'rgba(255,255,255,0.06)' }}
                        >
                          <span className="text-[9px] font-mono" style={{ color: compiledPromptResult.modified ? '#fbbf24' : '#71717a' }}>
                            
                            {t('后端实际 Prompt · {mode}', { mode: compiledPromptResult.mode.toUpperCase() })}
                            {compiledPromptResult.modified && t(' ⚠ 已被后处理修改')}
                          </span>
                          <button
                            type="button"
                            onClick={() => void copyTextToClipboard(compiledPromptResult.prompt)
                              .then(() => { setCompiledCopied(true); setTimeout(() => setCompiledCopied(false), 1500); })
                              .catch((error) => void showAlert(error.message))}
                            className="text-[8px] font-mono px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20 text-zinc-300 hover:text-white transition-colors cursor-pointer"
                          >
                            {compiledCopied ? t('✓ 已复制') : t('复制')}
                          </button>
                        </div>
                        <pre className="p-2 text-[8.5px] font-mono leading-relaxed max-h-64 overflow-y-auto whitespace-pre-wrap break-all"
                          style={{ color: compiledPromptResult.modified ? '#fde68a' : '#d4d4d8' }}
                        >
                          {compiledPromptResult.prompt}
                        </pre>
                        {data.compiledPrompt && (
                          <div className="border-t border-white/10 p-2">
                            <div className="mb-1.5 text-[9px] font-mono text-emerald-300">{t('提交给 ComfyUI 的资源')}</div>
                            <SubmittedResourcesPanel resources={data.submittedResources} />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>
        )}

      </div>

      {/* Main Body */}
      {data.generatedUrl && viewMode === 'preview' ? (
        <div data-node-media style={{ position: 'relative', flex: '0 0 auto', aspectRatio: String(sizing.ratio) }}>
          <TakeNavigator
            nodeId={id}
            data={data as Record<string, unknown>}
            connected={connected}
            onSwitch={(patch) => {
              updateNodeData(id, patch);
              window.dispatchEvent(new Event('takeSnapshot'));
            }}
          />
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
              onMediaSize={sizing.onMediaSize}
              info={<>{currentWidth}×{currentHeight} · 24fps · {(data.generatedSteps as number | undefined) ?? currentSteps}{t('步 ·')} {(currentLength / 24).toFixed(2)}s</>}
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
                        onClick={() => handleCreateUpscaleNode()}
                        className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white/10 hover:bg-white/20 border border-white/15 text-zinc-200 hover:text-white text-[10px] transition-colors cursor-pointer"
                        title={t('基于此视频创建 2 倍高清增强节点（潜空间精炼）')}
                      >
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="2" y="5" width="20" height="14" rx="2" />
                          <path d="M7 9v6M11 9v6M7 12h4M15 9v6h1.5a2.5 2.5 0 0 0 0-5H15" />
                        </svg>
                        <span>{t('高清')}</span>
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
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void downloadFile(`${API_BASE}${data.generatedUrl}`, 'generated-video.mp4', data.alias as string | undefined);
                        }}
                        className="p-1 rounded-lg text-zinc-300 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                        title={t('下载视频')}
                      >
                        <DownloadIcon />
                      </button>
                      <button
                        onClick={handleGenerate}
                        disabled={isGenerating || !comfyuiOnline || !isValidToGenerate}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/15 hover:bg-white/25 border border-white/20 text-white text-[11px] font-medium transition-colors cursor-pointer disabled:opacity-40"
                        title={t('重新生成')}
                      >
                        <RegenIcon />
                        <span>{t('重新生成')}</span>
                      </button>
                    </div>
              </>}
            >
              <GeneratingLine active={isGenerating} jobId={data.jobId as string | undefined} steps={currentSteps} statusText={jobStatusText} onCancel={handleCancel} prompt={String(data.prompt || '')} />
            </NodeVideoPlayer>
          </div>

          <NodeErrorBanner
            error={data.status === 'error' ? (data.error || t('视频生成失败')) : null}
            onClear={() => updateNodeData(id, { status: 'idle', error: undefined })}
            title={t('MiniMax H3 视频生成错误')}
          />
        </div>
      ) : (
        <div data-node-media={firstRender ? '' : undefined} style={{ position: 'relative', flex: '0 0 auto', ...(firstRender ? { aspectRatio: String(sizing.ratio) } : null) }}>
          <div
            style={{ ...cardBody, width: '100%', height: firstRender ? '100%' : 'auto', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
          >
            <div className={`relative z-10 w-full ${firstRender ? 'h-full' : ''} p-3.5 flex flex-col justify-between min-h-0 overflow-hidden`}>
              {/* Scrollable Upper Area (Header + Badges + Strip + Prompt Editor) */}
              <div data-shell-content className="flex-1 min-h-[200px] max-h-[640px] overflow-y-auto no-scrollbar flex flex-col gap-2 pr-0.5">
                <div className="flex items-center justify-between flex-shrink-0">
                  <div className="flex items-center gap-1.5 overflow-hidden">
                    <span className="text-[10px] text-zinc-300 font-mono font-medium truncate">
                      {mode}
                    </span>
                    {data.generatedUrl && (
                      <button
                        type="button"
                        onClick={() => setViewMode('preview')}
                        className="flex items-center gap-1 text-[9px] font-mono text-zinc-200 hover:text-white bg-white/10 hover:bg-white/20 px-1.5 py-0.5 rounded-md border border-white/15 transition-colors cursor-pointer"
                        title={t('返回视频播放预览')}
                      >
                        <PlayIcon />
                        <span>{t('返回预览')}</span>
                      </button>
                    )}
                    <span className="text-[9px] font-mono text-zinc-500">
                      {currentWidth}×{currentHeight} · {currentLength}f
                    </span>
                  </div>
                  {lockedRes ? (
                    <span className="text-[9px] font-mono text-zinc-500 flex-shrink-0" title={lockedLabel}>
                      {lockedLabel}
                    </span>
                  ) : (
                  <div className="flex gap-1 flex-shrink-0 overflow-x-auto no-scrollbar py-0.5">
                    {refVideoResolution && (
                      <button
                        type="button"
                        onClick={() => setAspectRatio(refVideoResolution.width!, refVideoResolution.height!)}
                        className={`px-1.5 py-0.5 rounded text-[9px] font-mono transition-colors ${currentWidth === refVideoResolution.width && currentHeight === refVideoResolution.height ? 'bg-white/20 text-white border border-white/30 font-bold' : 'bg-white/10 text-zinc-300 hover:text-white'}`}
                        title={t('跟随连入视频分辨率 {v1}×{v2}', { v1: refVideoResolution.width ?? 0, v2: refVideoResolution.height ?? 0 })}
                      >
                        
                        {t('视频')} {refVideoResolution.width}×{refVideoResolution.height}
                      </button>
                    )}
                    <span className="w-px bg-white/10 mx-0.5" />
                    {H3_PIXEL_SIZES.map((ps) => {
                      const target = sizeForShortSide(currentWidth, currentHeight, ps.short);
                      const isSel = Math.min(currentWidth, currentHeight) === ps.short;
                      return (
                        <button
                          key={ps.short}
                          type="button"
                          onClick={() => setAspectRatio(target.w, target.h)}
                          title={`${t(ps.desc)} - ${target.w}×${target.h}`}
                          className={`px-1.5 py-0.5 rounded-md border text-[9px] font-mono transition-all cursor-pointer ${
                            isSel
                              ? 'bg-white/20 border-white/40 text-white shadow-sm font-bold'
                              : 'bg-white/[0.04] border-white/10 text-zinc-400 hover:text-white hover:bg-white/10'
                          }`}
                        >
                          {ps.short}p
                        </button>
                      );
                    })}
                    <span className="w-px bg-white/10 mx-0.5" />
                    {H3_ASPECT_RATIOS.map((ar) => {
                      // Same pixel tier, new shape: switching ratio keeps the chosen short side.
                      const sized = sizeForShortSide(ar.w, ar.h, Math.min(currentWidth, currentHeight));
                      const isSel = Math.abs(currentWidth / currentHeight - ar.w / ar.h) < 0.02;
                      return (
                        <button
                          key={ar.label}
                          type="button"
                          onClick={() => setAspectRatio(sized.w, sized.h)}
                          title={`${ar.label} (${t(ar.desc)}) - ${sized.w}×${sized.h}`}
                          className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[9px] font-mono transition-all cursor-pointer ${
                            isSel
                              ? 'bg-white/20 border-white/40 text-white shadow-sm font-bold'
                              : 'bg-white/[0.04] border-white/10 text-zinc-400 hover:text-white hover:bg-white/10'
                          }`}
                        >
                          <span className={`inline-block border border-current rounded-xs ${ar.iconRatio} ${isSel ? 'bg-white/40' : 'bg-transparent'}`} />
                          <span>{ar.label}</span>
                        </button>
                      );
                    })}
                  </div>
                  )}
                </div>

                {/* References Indicator Badge */}
                {(refAudioUrls.length > 0 || refVideoUrls.length > 0) && (
                  <div className="flex items-center gap-1.5 text-[10px] font-mono flex-shrink-0">
                    {refAudioUrls.length > 0 && (
                      <span className="bg-white/5 border border-white/10 text-zinc-300 px-1.5 py-0.5 rounded flex items-center gap-1">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400">
                          <path d="M12 2v20M17 5v14M7 9v6M22 10v4M2 10v4" />
                        </svg>
                        <span>{refAudioUrls.length}{t('条参考音')}</span>
                      </span>
                    )}
                    {refVideoUrls.length > 0 && (
                      <span className="bg-white/5 border border-white/10 text-zinc-300 px-1.5 py-0.5 rounded flex items-center gap-1">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400">
                          <rect x="2" y="4" width="14" height="16" rx="2" />
                          <path d="M16 8l6-3v14l-6-3V8z" />
                        </svg>
                        <span>{refVideoUrls.length}{t('条参考视频')}</span>
                      </span>
                    )}
                  </div>
                )}

                {/* Reference Images Strip with Reordering */}
                {RefImageStrip}

                {/* Prompt Area: a prompt node wired only to this node is edited here and written back. */}
                {connectedPromptText && !promptBinding.exclusive ? (
                  <div className="space-y-1">
                  <div className="text-xs text-zinc-200 line-clamp-3 leading-relaxed font-normal bg-white/[0.04] p-2 rounded-xl border border-white/[0.08] h-[68px] overflow-y-auto">
                      <RenderedPromptFlow
                        text={connectedPromptText}
                        imageUrls={connectedImageUrls}
                        aliases={connectedImageAliases}
                        audioUrls={refAudioUrls}
                        videoUrls={refVideoUrls}
                      />
                    </div>
                    <div className="text-[9px] leading-snug text-zinc-500">
                      {t('提示词节点还连着别的节点（或接了多个提示词），请在提示词节点里编辑')}
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setShowPromptModal(true)}
                      className="flex-1 min-w-0 flex items-center gap-1.5 px-2 py-1.5 rounded-xl text-[11px] font-medium bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.12] hover:border-white/25 text-zinc-200 cursor-pointer transition-colors"
                      title={t('在独立大窗里写运镜、光影、人物动作与对白')}
                    >
                      <span className="text-purple-300">✎</span>
                      <span className="truncate">{promptBinding.exclusive ? t('编辑提示词（写回提示词节点）') : t('编辑提示词')}</span>
                      <span className="ml-auto shrink-0 text-[9px] font-mono text-zinc-500">
                        {(promptBinding.exclusive ? connectedPromptText : localPrompt).trim()
                          ? t('{n} 字', { n: (promptBinding.exclusive ? connectedPromptText : localPrompt).trim().length })
                          : t('未填写')}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={handleCompilePrompt}
                      disabled={isCompilingPrompt}
                      className="shrink-0 flex items-center gap-1 text-[9px] font-mono text-zinc-300 hover:text-white bg-white/10 hover:bg-white/20 px-1.5 py-1.5 rounded-lg border border-white/15 transition-all cursor-pointer disabled:opacity-50"
                      title={t('依据官方 MiniMax H3 电影标准，将当前意图与连入资源转译为六段式/时序规范 Prompt')}
                    >
                      <WandIcon />
                      <span>{isCompilingPrompt ? t('转译中…') : t('✦ 转译')}</span>
                    </button>
                  </div>
                )}
              </div>

              {/* 功能区：底部固定操作。永不压缩，也是 minW 标定的取样对象 */}
              {ActionsRow}
            </div>

            <GeneratingLine active={isGenerating} jobId={data.jobId as string | undefined} steps={currentSteps} statusText={jobStatusText} onCancel={handleCancel} prompt={String(data.prompt || '')} />

            <NodeErrorBanner
              error={data.status === 'error' ? (data.error || t('视频生成失败')) : null}
              onClear={() => updateNodeData(id, { status: 'idle', error: undefined })}
              title={t('MiniMax H3 视频生成错误')}
            />
          </div>
        </div>
      )}

      {/* Connection Handles (Permanently mounted to avoid unmount edge breaks) */}
      <IconHandle type="target" id="in-prompt" portType="prompt" nodeId={id} style={{ top: '15%' }} title={t('提示词')} />
      <IconHandle type="target" id="in-image" portType="image" icon="firstFrame" nodeId={id} style={{ top: '32%' }} title={t('首帧启动图 (单张 · 连入新图自动替换)')} />
      <IconHandle type="target" id="in-last-frame" portType="image" nodeId={id} style={{ top: '41%' }} title={t('引导帧 (AddGuide · 帧号见 guideFrameIndex，默认最后一帧)')} />
      <IconHandle type="target" id="in-ref-image" portType="character" nodeId={id} style={{ top: '50%' }} title={t('角色/道具参考图 (<图N> · 支持连入多张)')} />
      <IconHandle type="target" id="in-ref-audio" portType="audio" nodeId={id} style={{ top: '68%' }} title={t('声音参考 (<Audio N>)')} />
      <IconHandle type="target" id="in-ref-video" portType="video" nodeId={id} style={{ top: '85%' }} title={t('运镜参考 (<Video N>)')} />
      {/* The clip this one continues from. Wiring it here is what makes a long
          take out of several generations: the backend takes that clip's latent
          as motion context. Each generated section remains its own asset. */}
      <IconHandle type="target" id="in-motion-context" portType="video" nodeId={id} style={{ top: '96%' }} title={t('接续上一段 (motion context)')} />
      <IconHandle type="source" id="out-video" portType="video" nodeId={id} title={t('输出音视频')} />

      {showPromptModal && typeof document !== 'undefined' && createPortal(
        <ExpandedPromptModal
          title={t('MiniMax H3 电影镜头提示词工作台')}
          value={promptBinding.exclusive && promptBinding.promptNodeId ? connectedPromptText : localPrompt}
          onChange={(val) => {
            if (promptBinding.exclusive && promptBinding.promptNodeId) {
              updateNodeData(promptBinding.promptNodeId, { text: val });
              return;
            }
            setLocalPrompt(val);
            updateNodeData(id, { prompt: val });
          }}
          onClose={() => setShowPromptModal(false)}
          placeholder={t('输入电影镜头运镜、光影、人物动作与对白（点击参考图可插入 <图1><图2> 引用）…')}
          imageUrls={connectedImageUrls}
          aliases={connectedImageAliases}
          audioUrls={refAudioUrls}
          videoUrls={refVideoUrls}
          tokenPrefix="图"
        />,
        document.body
      )}


      {showModal && data.generatedUrl && (
        <VideoPreviewModal
          beforeUrl={null}
          afterUrl={`${API_BASE}${data.generatedUrl}`}
          onClose={() => setShowModal(false)}
          onCaptureFrame={(v) => handleScreenshot(v)}
          downloadName="generated-video.mp4"
          alias={data.alias as string | undefined}
        />
      )}
    </NodeShell>
  );
}

export default memo(VideoGenNode, areNodePropsEqual);

function VideoIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="14" height="16" rx="2" />
      <path d="M16 8l6-3v14l-6-3V8z" />
    </svg>
  );
}


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
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M12.2 6.2L11 5M12.2 11.8L11 13M17.8 6.2L19 5M3 21l9-9" />
    </svg>
  );
}
