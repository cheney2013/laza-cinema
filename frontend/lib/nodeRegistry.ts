import type { Node, Edge } from '@xyflow/react';
import { DEFAULT_NODE_DIMENSIONS, DEFAULT_H3_STEPS } from './types';
import { t } from './i18n';

export type PortType =
  | 'prompt'
  | 'image'
  | 'video'
  | 'character'
  | 'pose'
  | 'gaussian'
  | 'audio';

export interface PortDefinition {
  id?: string;
  portType: PortType;
  label?: string;
  acceptedTypes?: PortType[]; // Types this input port accepts
  providesTypes?: PortType[]; // Types this output port can provide
}

export interface NodeCreationContext {
  model?: string;
  sourceData?: any;
}

export interface NodeDefinition {
  type: string;
  label: string;
  cat: string;
  color: string;
  inputs: PortDefinition[];
  outputs: PortDefinition[];
  createData: (context?: NodeCreationContext) => Record<string, any>;
  calculateStyle?: (sourceNode?: Node) => { width: number; height: number } | undefined;
  /**
   * Set when a node type may no longer be created. Its definition stays so the
   * nodes already on saved canvases keep rendering and keep their wiring; every
   * creation surface reads CREATABLE_NODE_DEFINITIONS instead.
   */
  retired?: string;
}

/**
 * Universal type compatibility matrix.
 * Defines which output port types can satisfy an input port requirement.
 */
export const INPUT_COMPATIBILITY_RULES: Record<PortType, PortType[]> = {
  prompt: ['prompt'],
  image: ['image', 'character', 'pose', 'gaussian'],
  character: ['character', 'image'],
  video: ['video'],
  audio: ['audio', 'video'],
  pose: ['pose', 'image'],
  gaussian: ['gaussian', 'image'],
};

const DEFAULT_NEGATIVE_PROMPT =
  '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走';

/**
 * What a node's rendered output actually provides, by PORT TYPE.
 *
 * Every consumer used to carry its own list of upstream node type names, so each new
 * producer had to be added to every list that should accept it - and was not: a new
 * producer's clip was invisible to the upscale and interpolate nodes at once,
 * because both named `video`/`videoEdit`/`videoUpscale` and nothing else. Ask the
 * registry what a node emits instead; a new video producer is then accepted everywhere
 * the moment it declares `portType: 'video'`.
 *
 * The asset node is the one node whose output is not static: it declares image, video and
 * audio ports but renders only the one its current media calls for, so the media decides.
 */
export function providedPortTypes(
  node: { type?: string; mediaType?: string },
): PortType[] {
  const def = NODE_DEFINITIONS.find((d) => d.type === node.type);
  if (!def) return [];
  const ports = node.type === 'image'
    ? def.outputs.filter((o) => o.id === `out-${node.mediaType || 'image'}`)
    : def.outputs;
  const provided = new Set<PortType>();
  for (const port of ports) {
    for (const t of port.providesTypes || [port.portType]) provided.add(t);
  }
  return [...provided];
}

/** Whether a node emits `portType` on the handle it actually renders. */
export function provides(
  node: { type?: string; mediaType?: string },
  portType: PortType,
): boolean {
  return providedPortTypes(node).includes(portType);
}

function extractDimensions(sourceNode?: Node) {
  let width = 1024;
  let height = 1024;
  let videoWidth = 1376;
  let videoHeight = 768;
  let inherited = false;

  if (sourceNode?.data) {
    const srcData = sourceNode.data as any;
    if (srcData.width && srcData.height) {
      width = Math.round(srcData.width / 16) * 16;
      height = Math.round(srcData.height / 16) * 16;
      videoWidth = width;
      videoHeight = height;
      inherited = true;
    }
  }

  const upscaleDim = (d: number) => Math.ceil((d * 2) / 64) * 64;
  const upscaleWidth = inherited ? upscaleDim(videoWidth) : 1664;
  const upscaleHeight = inherited ? upscaleDim(videoHeight) : 960;

  return { width, height, videoWidth, videoHeight, upscaleWidth, upscaleHeight, inherited };
}

function calculateAdaptiveStyle(sourceNode: Node | undefined, isForVideo: boolean) {
  if (!sourceNode) return undefined;
  const { width, height, videoWidth, videoHeight, inherited } = extractDimensions(sourceNode);
  if (!inherited) return undefined;

  const sourceVisualWidth =
    (sourceNode as any)?.measured?.width || (sourceNode?.style?.width as number) || 340;
  const targetW = Math.max(280, sourceVisualWidth);
  const targetWidth = isForVideo ? videoWidth : width;
  const targetHeight = isForVideo ? videoHeight : height;
  const aspectRatio = targetWidth / targetHeight;
  const targetVisualHeight = targetW / aspectRatio + 80;
  return { width: targetW, height: targetVisualHeight };
}

/**
 * Single source of truth: Node definitions and port schemas.
 */
export const NODE_DEFINITIONS: NodeDefinition[] = [
  {
    type: 'prompt',
    label: '提示词节点',
    cat: '文本 & 剧本',
    color: '#a855f7',
    inputs: [{ id: 'in-prompt', portType: 'prompt', label: '提示词' }],
    outputs: [{ id: 'out-prompt', portType: 'prompt', label: '提示词' }],
    createData: () => ({ text: '' }),
  },
  {
    type: 'video',
    label: 'H3 电影镜头 (MiniMax H3)',
    cat: '生成引擎',
    color: '#a78bfa',
    inputs: [
      { id: 'in-prompt', portType: 'prompt', label: '提示词' },
      { id: 'in-image', portType: 'image', label: '首帧启动图 (单张)', acceptedTypes: ['image', 'character', 'pose', 'gaussian'] },
      { id: 'in-last-frame', portType: 'image', label: '引导帧 (AddGuide · 默认最后一帧)', acceptedTypes: ['image', 'character', 'pose', 'gaussian'] },
      { id: 'in-ref-image', portType: 'character', label: '角色/道具参考 (<图N> · 可多张)', acceptedTypes: ['character', 'image'] },
      { id: 'in-ref-audio', portType: 'audio', label: '声音参考 (<Audio N>)', acceptedTypes: ['audio', 'video'] },
      { id: 'in-ref-video', portType: 'video', label: '运镜参考 (<Video N>)', acceptedTypes: ['video'] },
      // The handle was on the node but not in this list, so validateConnectionSchema fell back to the
      // first input (the prompt) and refused every wire to it: a chain could only be wired from the
      // canvas server, never by dragging (2026-10-02).
      { id: 'in-motion-context', portType: 'video', label: '接续上一段 (motion context · 单进)', acceptedTypes: ['video'] },
    ],
    outputs: [{ id: 'out-video', portType: 'video', label: '音视频' }],
    calculateStyle: (src) => calculateAdaptiveStyle(src, true),
    createData: (ctx) => {
      const { videoWidth, videoHeight } = extractDimensions(ctx?.sourceData ? ({ data: ctx.sourceData } as any) : undefined);
      return {
        prompt: '',
        generatedUrl: null,
        status: 'idle',
        width: videoWidth,
        height: videoHeight,
        steps: DEFAULT_H3_STEPS,
        length: 124,
        seed: 81000,
        seedMode: 'fixed',
        // New shots render with block-sparse attention (~21% faster); nodes made
        // before this default have no field and stay dense, so accepted takes re-render unchanged.
        blockSparse: true,
      };
    },
  },
  {
    type: 'videoReshot',
    label: '重拍一段 · 前后不动',
    cat: '编辑 & 修复',
    color: '#a78bfa',
    inputs: [
      { id: 'in-video', portType: 'video', label: '源视频' },
      { id: 'in-character', portType: 'character', label: '参考图（角色/道具/环境）', acceptedTypes: ['character', 'image'] },
      { id: 'in-prompt', portType: 'prompt', label: '提示词' },
    ],
    outputs: [{ id: 'out-video', portType: 'video', label: '音视频' }],
    calculateStyle: (src) => calculateAdaptiveStyle(src, true),
    createData: (ctx) => {
      const { videoWidth, videoHeight } = extractDimensions(ctx?.sourceData ? ({ data: ctx.sourceData } as any) : undefined);
      return {
        prompt: '',
        userIntent: '',
        generatedUrl: null,
        status: 'idle',
        width: videoWidth,
        height: videoHeight,
        steps: 20,
        length: 124,
        seed: 81000,
        seedMode: 'fixed',
      };
    },
  },
  {
    type: 'videoBridge',
    label: '重拍中间 · 两端冻住',
    cat: '编辑 & 修复',
    color: '#e879f9',
    inputs: [
      { id: 'in-video', portType: 'video', label: '源视频' },
      { id: 'in-prompt', portType: 'prompt', label: '提示词' },
    ],
    outputs: [{ id: 'out-video', portType: 'video', label: '音视频' }],
    calculateStyle: (src) => calculateAdaptiveStyle(src, true),
    createData: (ctx) => {
      const { videoWidth, videoHeight } = extractDimensions(ctx?.sourceData ? ({ data: ctx.sourceData } as any) : undefined);
      return {
        prompt: '',
        userIntent: '',
        generatedUrl: null,
        status: 'idle',
        width: videoWidth,
        height: videoHeight,
        steps: 20,
        length: 124,
        seed: 81000,
        seedMode: 'fixed',
      };
    },
  },
  {
    type: 'videoEdit',
    label: '改原片 · 动作不变',
    cat: '编辑 & 修复',
    color: '#c084fc',
    inputs: [
      { id: 'in-video', portType: 'video', label: '源视频' },
      { id: 'in-character', portType: 'character', label: '参考图（角色/道具/环境）', acceptedTypes: ['character', 'image'] },
      { id: 'in-audio', portType: 'audio', label: '声音参考', acceptedTypes: ['audio', 'video'] },
      { id: 'in-prompt', portType: 'prompt', label: '提示词' },
      { id: 'in-guide-frame', portType: 'image', label: '引导帧 (AddGuide · 编辑窗口内，帧号按原片)', acceptedTypes: ['image', 'character', 'pose', 'gaussian'] },
    ],
    outputs: [{ id: 'out-video', portType: 'video', label: '音视频' }],
    calculateStyle: (src) => calculateAdaptiveStyle(src, true),
    createData: (ctx) => {
      const { videoWidth, videoHeight } = extractDimensions(ctx?.sourceData ? ({ data: ctx.sourceData } as any) : undefined);
      return {
        prompt: '',
        userIntent: '',
        generatedUrl: null,
        status: 'idle',
        audioStrategy: 'copy_source',
        width: videoWidth,
        height: videoHeight,
        steps: DEFAULT_H3_STEPS,
        length: 124,
        seed: 81000,
        seedMode: 'fixed',
      };
    },
  },
  {
    type: 'videoContinue',
    label: '往后续拍',
    cat: '编辑 & 修复',
    color: '#34d399',
    inputs: [
      { id: 'in-video', portType: 'video', label: '源视频' },
      { id: 'in-character', portType: 'character', label: '参考图（角色/道具/环境）', acceptedTypes: ['character', 'image'] },
      { id: 'in-audio', portType: 'audio', label: '声音参考', acceptedTypes: ['audio', 'video'] },
      { id: 'in-prompt', portType: 'prompt', label: '提示词' },
    ],
    outputs: [{ id: 'out-video', portType: 'video', label: '音视频' }],
    calculateStyle: (src) => calculateAdaptiveStyle(src, true),
    createData: (ctx) => {
      const { videoWidth, videoHeight } = extractDimensions(ctx?.sourceData ? ({ data: ctx.sourceData } as any) : undefined);
      return {
        prompt: '',
        userIntent: '',
        generatedUrl: null,
        status: 'idle',
        audioStrategy: 'copy_source',
        width: videoWidth,
        height: videoHeight,
        steps: DEFAULT_H3_STEPS,
        length: 124,
        seed: 81000,
        seedMode: 'fixed',
      };
    },
  },
  {
    type: 'videoFrames',
    label: '首尾帧补中间',
    cat: '编辑 & 修复',
    color: '#60a5fa',
    inputs: [
      { id: 'in-first-frame', portType: 'image', label: '首帧', acceptedTypes: ['image', 'character', 'pose', 'gaussian'] },
      { id: 'in-last-frame', portType: 'image', label: '尾帧', acceptedTypes: ['image', 'character', 'pose', 'gaussian'] },
      { id: 'in-character', portType: 'character', label: '参考图（角色/道具/环境）', acceptedTypes: ['character', 'image'] },
      { id: 'in-audio', portType: 'audio', label: '声音参考', acceptedTypes: ['audio', 'video'] },
      { id: 'in-prompt', portType: 'prompt', label: '提示词' },
    ],
    outputs: [{ id: 'out-video', portType: 'video', label: '音视频' }],
    calculateStyle: (src) => calculateAdaptiveStyle(src, true),
    createData: (ctx) => {
      const { videoWidth, videoHeight } = extractDimensions(ctx?.sourceData ? ({ data: ctx.sourceData } as any) : undefined);
      return {
        prompt: '',
        userIntent: '',
        generatedUrl: null,
        status: 'idle',
        audioStrategy: 'copy_source',
        width: videoWidth,
        height: videoHeight,
        steps: DEFAULT_H3_STEPS,
        length: 124,
        seed: 81000,
        seedMode: 'fixed',
      };
    },
  },
  {
    type: 'audioRefine',
    label: '声音精修',
    cat: '编辑 & 修复',
    color: '#38bdf8',
    inputs: [
      { id: 'in-video', portType: 'video', label: '要修复声音的片段 (必需 · 画面保留)' },
      { id: 'in-ref-image', portType: 'character', label: '参考图 (可选 · 接在继承的参考后面)', acceptedTypes: ['character', 'image'] },
      { id: 'in-ref-audio', portType: 'audio', label: '声音参考 (可选 · <Audio N>)', acceptedTypes: ['audio', 'video'] },
    ],
    outputs: [{ id: 'out-video', portType: 'video', label: '原画面 + 新声音' }],
    calculateStyle: (src) => calculateAdaptiveStyle(src, true),
    createData: () => ({
      generatedUrl: null,
      status: 'idle',
      mode: 'polish',
      steps: 0,
      denoise: 0,
      seed: 81000,
      seedMode: 'fixed',
      prompt: '',
    }),
  },
  {
    type: 'videoReangle',
    label: '换机位 · CrossView',
    cat: '编辑 & 修复',
    color: '#a78bfa',
    inputs: [
      { id: 'in-video', portType: 'video', label: '已验收的片段 (必需)' },
      { id: 'in-ref-image', portType: 'character', label: '环境/角色参考 (可选 · 补新露出的区域)', acceptedTypes: ['character', 'image'] },
    ],
    outputs: [{ id: 'out-video', portType: 'video', label: '新机位视频' }],
    calculateStyle: (src) => calculateAdaptiveStyle(src, true),
    createData: () => ({
      generatedUrl: null,
      status: 'idle',
      // The render size the backend picks for 16:9 at 0.5 MP (the LoRA's first pass).
      width: 960,
      height: 544,
      azimuth: 30,
      elevation: 0,
      distance: 1,
      keyframes: [],
      startFrame: 0,
      length: 0,
      prompt: 'crossview',
      loraStrength: 0.8,
      megapixels: 0.5,
      steps: 8,
      seed: 81000,
      seedMode: 'fixed',
      keepSourceAudio: true,
    }),
  },
  {
    type: 'charswap',
    label: '换人 · Viggle',
    cat: '编辑 & 修复',
    color: '#2dd4bf',
    inputs: [
      { id: 'in-video', portType: 'video', label: '驱动视频 (必需)' },
      { id: 'in-character', portType: 'character', label: '角色参考图 (必需)', acceptedTypes: ['character', 'image'] },
    ],
    outputs: [{ id: 'out-video', portType: 'video', label: '换人后视频' }],
    calculateStyle: (src) => calculateAdaptiveStyle(src, true),
    createData: (ctx) => {
      const { videoWidth, videoHeight } = extractDimensions(ctx?.sourceData ? ({ data: ctx.sourceData } as any) : undefined);
      return {
        generatedUrl: null,
        status: 'idle',
        width: videoWidth,
        height: videoHeight,
        // 0 = the driving clip's own length. The conditioning node snaps to H3's 17k+5
        // grid itself; a cap above what the clip supplies mosaics the output.
        length: 0,
        megapixels: 0.8,
        seed: 95051,
        seedMode: 'fixed',
      };
    },
  },
  {
    type: 'inpaint',
    label: '局部重绘 (Inpaint)',
    cat: '编辑 & 修复',
    color: '#ec4899',
    inputs: [
      { id: 'in-image', portType: 'image', label: '基础参考图', acceptedTypes: ['image', 'character', 'pose', 'gaussian'] },
    ],
    outputs: [{ id: 'out-image', portType: 'image', label: '重绘图像', providesTypes: ['image', 'character'] }],
    calculateStyle: (src) => calculateAdaptiveStyle(src, false),
    createData: () => ({
      prompt: '',
      generatedUrl: null,
      status: 'idle',
      steps: 20,
      cfg: 4.0,
      seed: 81000,
      seedMode: 'fixed',
    }),
  },
  {
    type: 'videoCompare',
    label: '视频对比',
    cat: '超分 & 插帧',
    color: '#38bdf8',
    inputs: [
      { id: 'in-video-a', portType: 'video', label: 'A 基准' },
      { id: 'in-video-b', portType: 'video', label: 'B 对比' },
    ],
    outputs: [],
    createData: () => ({ mode: 'wipe' }),
  },
  {
    type: 'videoUpscale',
    label: '视频增强',
    cat: '超分 & 插帧',
    color: '#eab308',
    inputs: [{ id: 'in-video', portType: 'video', label: '输入视频' }],
    outputs: [{ id: 'out-video', portType: 'video', label: '增强视频' }],
    createData: (ctx) => {
      const { upscaleWidth, upscaleHeight } = extractDimensions(ctx?.sourceData ? ({ data: ctx.sourceData } as any) : undefined);
      return {
        generatedUrl: null,
        status: 'idle',
        width: upscaleWidth,
        height: upscaleHeight,
        steps: 6,
        denoiseStrength: 0.25,
        seed: 81000,
        seedMode: 'fixed',
        targetFps: 0,
        length: 0,
      };
    },
  },
  {
    type: 'videoInterpolate',
    label: '视频插帧 (RIFE 60FPS)',
    cat: '超分 & 插帧',
    color: '#06b6d4',
    inputs: [{ id: 'in-video', portType: 'video', label: '输入视频' }],
    outputs: [{ id: 'out-video', portType: 'video', label: '插帧视频' }],
    createData: () => ({
      generatedUrl: null,
      status: 'idle',
      targetFps: 30,
    }),
  },
  {
    type: 'depthVideo',
    label: '深度视频',
    cat: '超分 & 插帧',
    color: '#06b6d4',
    inputs: [{ id: 'in-video', portType: 'video', label: '输入视频' }],
    outputs: [{ id: 'out-video', portType: 'video', label: '深度视频' }],
    createData: () => ({
      generatedUrl: null,
      status: 'idle',
      resolution: 518,
    }),
  },
  {
    type: 'videoTrim',
    label: '视频剪切',
    cat: '超分 & 插帧',
    color: '#06b6d4',
    inputs: [{ id: 'in-video', portType: 'video', label: '输入视频' }],
    outputs: [{ id: 'out-video', portType: 'video', label: '剪切后的视频' }],
    createData: () => ({
      generatedUrl: null,
      status: 'idle',
      trimStartSeconds: 0,
      trimEndSeconds: null,
    }),
  },
  {
    type: 'audioGen',
    label: '配音 / 换音色',
    cat: '生成引擎',
    color: '#f59e0b',
    inputs: [
      { id: 'in-ref-audio', portType: 'audio', label: '参考音色', acceptedTypes: ['audio', 'video'] },
      { id: 'in-source-audio', portType: 'audio', label: '要换音色的音频', acceptedTypes: ['audio', 'video'] },
    ],
    outputs: [{ id: 'out-audio', portType: 'audio', label: '音频', providesTypes: ['audio'] }],
    createData: () => ({
      mode: 'speak',
      text: '',
      voiceDescription: '',
      delivery: '',
      generatedUrl: null,
      status: 'idle',
      length: 0,
      seed: 81000,
      seedMode: 'fixed',
      trimSilence: true,
      diffusionSteps: 30,
      semitoneShift: 0,
    }),
  },
  {
    type: 'pose',
    label: '3D骨骼姿态 (Pose)',
    cat: '3D & 空间',
    color: '#6366f1',
    inputs: [
      { id: 'in-image', portType: 'image', label: '输入图像/视频', acceptedTypes: ['image', 'character', 'video'] },
    ],
    outputs: [
      { id: 'out-pose', portType: 'pose', label: '骨骼姿态', providesTypes: ['pose', 'image'] },
    ],
    createData: () => ({
      glbUrl: null,
      generatedUrl: null,
      status: 'idle',
      skeletonMode: 'openpose',
    }),
  },
  {
    type: 'gaussian',
    label: '高斯模型 (3DGS PLY)',
    cat: '3D & 空间',
    color: '#14b8a6',
    inputs: [
      { id: 'in-image', portType: 'image', label: '渲染参考图', acceptedTypes: ['image', 'character'] },
    ],
    outputs: [
      { id: 'out-image', portType: 'image', label: '当前视图截图', providesTypes: ['image'] },
      { id: 'out-gaussian', portType: 'gaussian', label: '高斯点云', providesTypes: ['gaussian'] },
    ],
    createData: () => ({
      plyUrl: null,
      plyFilename: null,
      plyOriginalName: null,
      generatedUrl: null,
      status: 'idle',
    }),
  },
  {
    type: 'gaussianViewer',
    label: '高斯查看',
    cat: '3D & 空间',
    color: '#14b8a6',
    inputs: [
      { id: 'in-gaussian', portType: 'gaussian', label: '高斯模型（可选，也可直接拖入 .ply）', acceptedTypes: ['gaussian'] },
    ],
    outputs: [
      { id: 'out-image', portType: 'image', label: '当前视角截图', providesTypes: ['image'] },
    ],
    createData: () => ({
      plyUrl: null,
      plyFilename: null,
      plyOriginalName: null,
      generatedUrl: null,
      status: 'idle',
    }),
  },
  {
    type: 'qwenImage',
    label: '生成图片',
    cat: '素材 & 风格',
    color: '#8b5cf6',
    inputs: [
      { id: 'in-ref', portType: 'image', label: '参考图（可多个，连线顺序就是 <image N>）', acceptedTypes: ['image', 'character', 'pose', 'gaussian'] },
    ],
    outputs: [{ id: 'out-image', portType: 'image', label: '生成的图片', providesTypes: ['image', 'character'] }],
    calculateStyle: (src) => calculateAdaptiveStyle(src, false),
    createData: () => ({
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
    }),
  },
  {
    type: 'imageUpscale',
    label: '图片超清',
    cat: '素材 & 风格',
    color: '#0ea5e9',
    inputs: [
      { id: 'in-image', portType: 'image', label: '要放大的图片', acceptedTypes: ['image', 'character', 'pose', 'gaussian'] },
    ],
    outputs: [{ id: 'out-image', portType: 'image', label: '放大后的图片', providesTypes: ['image', 'character'] }],
    calculateStyle: (src) => calculateAdaptiveStyle(src, false),
    createData: () => ({
      modelName: 'RealESRGAN_x2.pth',
      targetLongEdge: 0,
      generatedUrl: null,
      status: 'idle',
    }),
  },
  {
    type: 'titleBlock',
    label: '标题块',
    cat: '素材 & 风格',
    color: '#f97316',
    inputs: [
      { id: 'in-image', portType: 'image', label: '字标素材（透明底 logo）', acceptedTypes: ['image', 'character'] },
      { id: 'in-plate', portType: 'image', label: '底图（干净封面，可选；接上就直接贴好）', acceptedTypes: ['image', 'character'] },
    ],
    outputs: [{ id: 'out-image', portType: 'image', label: '标题块，或贴好的封面', providesTypes: ['image'] }],
    calculateStyle: (src) => calculateAdaptiveStyle(src, false),
    createData: () => ({
      line: 'FILM 1【中字】',
      blockHeight: 1536,
      margin: 104,
      contentWidth: 600,
      lineWidth: 800,
      lineHeightScale: 1.5,
      side: 'left',
      generatedUrl: null,
      status: 'idle',
    }),
  },
  {
    type: 'image',
    label: '上传素材 (图片/视频)',
    cat: '素材 & 风格',
    color: '#a1a1aa',
    inputs: [],
    outputs: [
      { id: 'out-image', portType: 'image', label: '图片/角色素材', providesTypes: ['image', 'character'] },
      { id: 'out-video', portType: 'video', label: '视频素材', providesTypes: ['video', 'audio'] },
      { id: 'out-audio', portType: 'audio', label: '音频素材', providesTypes: ['audio'] },
    ],
    calculateStyle: (src) => calculateAdaptiveStyle(src, false),
    createData: () => ({ url: null }),
  },
  {
    type: 'preview',
    label: '大图预览 (Preview)',
    cat: '辅助工具',
    color: '#71717a',
    inputs: [
      { id: 'in-image', portType: 'image', label: '预览输入', acceptedTypes: ['image', 'character', 'gaussian', 'pose'] },
    ],
    outputs: [
      { id: 'out-image', portType: 'image', label: '预览输出', providesTypes: ['image'] },
    ],
    createData: () => ({}),
  },
  {
    type: 'characterSheet',
    label: '定妆照',
    cat: '素材 & 风格',
    color: '#fbbf24',
    inputs: [
      { id: 'in-base', portType: 'image', label: '原定妆照（派生版）', acceptedTypes: ['image', 'character'] },
      { id: 'in-face', portType: 'image', label: '脸部参考（头部裁切）', acceptedTypes: ['image', 'character'] },
      { id: 'in-prop', portType: 'image', label: '关键道具（可多个）', acceptedTypes: ['image', 'character'] },
    ],
    outputs: [{ id: 'out-image', portType: 'image', label: '定妆照', providesTypes: ['image', 'character'] }],
    createData: () => ({
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
    }),
  },
  {
    type: 'wardrobeSwap',
    label: '一键换装',
    cat: '编辑 & 修复',
    color: '#f472b6',
    inputs: [
      { id: 'in-person', portType: 'image', label: '人物原图 (必需)', acceptedTypes: ['image', 'character'] },
      { id: 'in-outfit', portType: 'image', label: '服装参考 (必需)', acceptedTypes: ['image', 'character'] },
    ],
    outputs: [{ id: 'out-image', portType: 'image', label: '换装结果', providesTypes: ['image', 'character'] }],
    calculateStyle: (src) => calculateAdaptiveStyle(src, false),
    createData: (ctx) => {
      const { width, height } = extractDimensions(ctx?.sourceData ? ({ data: ctx.sourceData } as any) : undefined);
      return {
        generatedUrl: null,
        status: 'idle',
        width,
        height,
        steps: 8,
        guidance: 2.5,
        seed: 81000,
        seedMode: 'fixed',
        detail: '',
      };
    },
  },
  {
    type: 'chainPreview',
    label: '智能视频预览',
    cat: '辅助工具',
    color: '#71717a',
    inputs: [
      { id: 'in-video', portType: 'video', label: '视频（普通或链尾，可多接）', acceptedTypes: ['video'] },
    ],
    outputs: [],
    createData: () => ({}),
  },
];

/**
 * Filter and generate compatible menu items for a port release menu.
 */
/**
 * How often each node is reached for, most first. Every node menu lists in this
 * order. Measured on the saved canvases (2026-09-17: uploads 267, H3 video 149,
 * upscale 56, prompt 26, then single digits) and, for types too new to have a
 * count, placed by how the production uses them: the character sheet and the
 * two repair nodes come before the rarer edit and 3D tools.
 */
export const NODE_USAGE_ORDER = [
  'image', 'video', 'prompt', 'videoUpscale', 'characterSheet', 'audioGen',
  'videoBridge', 'videoReshot', 'videoContinue', 'videoEdit', 'wardrobeSwap',
  'charswap', 'videoReangle', 'audioRefine', 'videoFrames',
  'chainPreview', 'videoCompare', 'videoTrim', 'depthVideo', 'videoInterpolate', 'inpaint',
  'preview', 'pose', 'gaussian', 'gaussianViewer',
];

export function usageRank(type: string): number {
  const i = NODE_USAGE_ORDER.indexOf(type);
  return i < 0 ? NODE_USAGE_ORDER.length : i;
}

export function byUsage<T extends { type: string }>(items: T[]): T[] {
  // Array.prototype.sort is stable, so a type's own entries keep their order.
  return [...items].sort((a, b) => usageRank(a.type) - usageRank(b.type));
}

export function getCompatibleNodesForPort(query: {
  portType: PortType | string;
  handleType: 'source' | 'target';
  handleId?: string | null;
  model?: string;
  sourceNode?: Node;
}) {
  const { portType, handleType, model, sourceNode } = query;
  const results: Array<{
    type: string;
    label: string;
    cat: string;
    color: string;
    data: any;
    style?: any;
    targetHandle?: string;
    sourceHandle?: string;
  }> = [];

  const effectiveModel = model || 'flux1-dev.safetensors';

  if (handleType === 'source') {
    // Seeking downstream nodes whose INPUTS accept portType
    for (const nodeDef of NODE_DEFINITIONS.filter((d) => !d.retired)) {
      const matchingInputs = nodeDef.inputs.filter((input) => {
        const accepted = input.acceptedTypes || INPUT_COMPATIBILITY_RULES[input.portType] || [input.portType];
        return accepted.includes(portType as PortType) || input.portType === portType;
      });

      for (const input of matchingInputs) {
        let displayLabel = nodeDef.label;
        if (matchingInputs.length > 1 && input.label) {
          displayLabel = `${nodeDef.label} · ${input.label}`;
        }

        results.push({
          type: nodeDef.type,
          label: displayLabel,
          cat: nodeDef.cat,
          color: nodeDef.color,
          targetHandle: input.id,
          data: nodeDef.createData({ model: effectiveModel, sourceData: sourceNode?.data }),
          style: nodeDef.calculateStyle ? nodeDef.calculateStyle(sourceNode) : undefined,
        });
      }
    }
  } else {
    // Seeking upstream nodes whose OUTPUTS provide portType
    const requiredTypes = INPUT_COMPATIBILITY_RULES[portType as PortType] || [portType as PortType];

    for (const nodeDef of NODE_DEFINITIONS.filter((d) => !d.retired)) {
      const matchingOutputs = nodeDef.outputs.filter((output) => {
        const provides = output.providesTypes || [output.portType];
        return provides.some((p) => requiredTypes.includes(p) || p === portType);
      });

      for (const output of matchingOutputs) {
        let displayLabel = nodeDef.label;
        if (matchingOutputs.length > 1 && output.label) {
          displayLabel = `${nodeDef.label} (${output.label})`;
        }

        results.push({
          type: nodeDef.type,
          label: displayLabel,
          cat: nodeDef.cat,
          color: nodeDef.color,
          sourceHandle: output.id,
          data: nodeDef.createData({ model: effectiveModel, sourceData: sourceNode?.data }),
          style: nodeDef.calculateStyle ? nodeDef.calculateStyle(sourceNode) : undefined,
        });
      }
    }
  }

  return byUsage(results);
}

/**
 * The handle a node actually renders, which is not always the registry port that matched.
 *
 * An asset node declares three output ports (image / video / audio) but renders exactly
 * ONE handle, named after the media it currently holds. Wiring a video asset into an
 * image input therefore matched `out-image` while the node showed `out-video`, and React
 * Flow dropped the edge it could not attach ("Couldn't create edge for source handle id").
 * The data still flowed - only the wire was missing from the screen.
 */
function resolveSourceHandle(node: { type?: string; data?: any }, handleId: string): string {
  if (node.type !== 'image') return handleId;
  const media = (node.data?.mediaType as string) || 'image';
  return `out-${media}`;
}

export interface ExistingCompatibleNode {
  nodeId: string;
  type: string;
  label: string;
  alias?: string;
  cat: string;
  color: string;
  sourceHandle?: string;
  targetHandle?: string;
  thumbnailUrl?: string | null;
  previewText?: string | null;
  isConnected: boolean;
  edgeId?: string;
}

/**
 * Find existing compatible nodes already present on the canvas that can connect with the given port.
 */
export function getExistingCompatibleNodesOnCanvas(query: {
  portType: PortType | string;
  handleType: 'source' | 'target';
  handleId?: string | null;
  currentNodes: Node[];
  currentNodeId: string;
  currentEdges: Edge[];
}): ExistingCompatibleNode[] {
  const { portType, handleType, handleId, currentNodes, currentNodeId, currentEdges } = query;
  const results: ExistingCompatibleNode[] = [];

  const currentNode = currentNodes.find((n) => n.id === currentNodeId);
  if (!currentNode) return [];

  if (handleType === 'target') {
    // Current handle is an INPUT (target). We want to find existing nodes that can act as SOURCE (output).
    const requiredTypes = INPUT_COMPATIBILITY_RULES[portType as PortType] || [portType as PortType];

    for (const node of currentNodes) {
      if (node.id === currentNodeId) continue; // Cannot connect to self

      const nodeDef = NODE_DEFINITIONS.find((d) => d.type === node.type);
      if (!nodeDef) continue;

      // Find matching output port on this candidate node
      const matchingOutputs = nodeDef.outputs.filter((output) => {
        const provides = output.providesTypes || [output.portType];
        return provides.some((p) => requiredTypes.includes(p) || p === portType);
      });

      if (matchingOutputs.length === 0) continue;

      const outputPort = matchingOutputs[0];
      const sourceHandle = resolveSourceHandle(node, outputPort.id || `out-${outputPort.portType}`);

      // Check if an edge already connects this node's output to current node's input handle
      const existingEdge = currentEdges.find(
        (e) =>
          e.source === node.id &&
          e.target === currentNodeId &&
          (handleId ? e.targetHandle === handleId : true)
      );

      // Extract title / thumbnail / preview
      const data = (node.data || {}) as any;
      let label = nodeDef.label;
      let previewText: string | null = null;
      let thumbnailUrl: string | null = null;

      if (data.alias) {
        label = `[${data.alias}] ${nodeDef.label}`;
      } else if (node.type === 'prompt' && data.text) {
        label = t('提示词: {v1}{v2}', { v1: data.text.slice(0, 30), v2: data.text.length > 30 ? '…' : '' });
        previewText = data.text;
      } else if (node.type === 'image' && data.prompt) {
        label = t('生图: {v1}{v2}', { v1: data.prompt.slice(0, 24), v2: data.prompt.length > 24 ? '…' : '' });
        previewText = data.prompt;
      } else if (node.type === 'video' && data.prompt) {
        label = t('视频: {v1}{v2}', { v1: data.prompt.slice(0, 24), v2: data.prompt.length > 24 ? '…' : '' });
        previewText = data.prompt;
      } else if (node.type === 'upload') {
        label = data.filename ? t('上传: {v1}', { v1: data.filename }) : (data.mediaType === 'video' ? t('已上传视频') : t('已上传图像'));
      }

      if (data.generatedUrl) {
        thumbnailUrl = data.generatedUrl;
      } else if (data.url) {
        thumbnailUrl = data.url;
      } else if (data.imageUrl) {
        thumbnailUrl = data.imageUrl;
      } else if (data.poseImageUrl) {
        thumbnailUrl = data.poseImageUrl;
      } else if (data.depthImageUrl) {
        thumbnailUrl = data.depthImageUrl;
      } else if (data.sourceImageUrl) {
        thumbnailUrl = data.sourceImageUrl;
      }

      results.push({
        nodeId: node.id,
        type: node.type || 'unknown',
        label,
        alias: data.alias,
        cat: nodeDef.cat,
        color: nodeDef.color,
        sourceHandle,
        targetHandle: handleId || undefined,
        thumbnailUrl,
        previewText,
        isConnected: Boolean(existingEdge),
        edgeId: existingEdge?.id,
      });
    }
  } else {
    // Current handle is an OUTPUT (source). We want to find existing nodes that can act as TARGET (input).
    for (const node of currentNodes) {
      if (node.id === currentNodeId) continue;

      const nodeDef = NODE_DEFINITIONS.find((d) => d.type === node.type);
      if (!nodeDef) continue;

      const matchingInputs = nodeDef.inputs.filter((input) => {
        const accepted = input.acceptedTypes || INPUT_COMPATIBILITY_RULES[input.portType] || [input.portType];
        return accepted.includes(portType as PortType) || input.portType === portType;
      });

      if (matchingInputs.length === 0) continue;

      for (const input of matchingInputs) {
        const targetHandle = input.id || `in-${input.portType}`;
        const existingEdge = currentEdges.find(
          (e) =>
            e.source === currentNodeId &&
            e.target === node.id &&
            (handleId ? e.sourceHandle === handleId : true) &&
            e.targetHandle === targetHandle
        );

        const data = (node.data || {}) as any;
        let label = `${nodeDef.label} · ${input.label || input.portType}`;
        if (data.alias) {
          label = `[${data.alias}] ${label}`;
        }

        let thumbnailUrl = data.generatedUrl || data.url || data.imageUrl || null;

        results.push({
          nodeId: node.id,
          type: node.type || 'unknown',
          label,
          alias: data.alias,
          cat: nodeDef.cat,
          color: nodeDef.color,
          sourceHandle: handleId || undefined,
          targetHandle,
          thumbnailUrl,
          previewText: data.prompt || data.text || null,
          isConnected: Boolean(existingEdge),
          edgeId: existingEdge?.id,
        });
      }
    }
  }

  return results;
}

/**
 * Validate edge connection based on registered port schemas.
 */
export function validateConnectionSchema(
  connection: { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null },
  getNode: (id: string) => Node | undefined
): boolean {
  const sourceNode = getNode(connection.source);
  const targetNode = getNode(connection.target);
  if (!sourceNode || !targetNode) return false;

  const sourceDef = NODE_DEFINITIONS.find((d) => d.type === sourceNode.type);
  const targetDef = NODE_DEFINITIONS.find((d) => d.type === targetNode.type);
  if (!sourceDef || !targetDef) return true;

  // Find output port
  let outputPort = sourceDef.outputs.find((o) => o.id === connection.sourceHandle);
  if (!outputPort) {
    outputPort = sourceDef.outputs[0];
  }

  // Find input port
  let inputPort = targetDef.inputs.find((i) => i.id === connection.targetHandle);
  if (!inputPort) {
    inputPort = targetDef.inputs[0];
  }

  const isImageSuffix = (url?: string | null) => {
    if (!url) return false;
    const clean = url.split('?')[0].toLowerCase();
    return clean.endsWith('.png') || clean.endsWith('.jpg') || clean.endsWith('.jpeg') || clean.endsWith('.webp') || clean.endsWith('.bmp') || clean.endsWith('.gif');
  };

  const sourceData = (sourceNode.data || {}) as any;
  const sourceUrl = sourceData.url || sourceData.generatedUrl || sourceData.imageUrl;
  const sourceMediaType = sourceData.mediaType as string | undefined;

  // Strict Audio port safety: Audio input ports only accept Audio or Video sources, NEVER images.
  if (inputPort.portType === 'audio') {
    if (
      sourceNode.type === 'inpaint' ||
      sourceNode.type === 'gaussian' ||
      sourceNode.type === 'gaussianViewer' ||
      sourceNode.type === 'prompt' ||
      sourceMediaType === 'image' ||
      isImageSuffix(sourceUrl)
    ) {
      return false;
    }
  }

  // Handle dynamic media upload node and media types
  let provides = outputPort.providesTypes || [outputPort.portType];
  if (sourceNode.type === 'image') {
    if (sourceMediaType === 'image' || isImageSuffix(sourceUrl)) {
      provides = ['image', 'character'];
      if (inputPort.portType === 'video' || inputPort.portType === 'audio') {
        return false;
      }
    } else if (sourceMediaType === 'audio') {
      provides = ['audio'];
      if (inputPort.portType !== 'audio') return false;
    } else if (sourceMediaType === 'video' || (sourceUrl && !isImageSuffix(sourceUrl))) {
      provides = ['video', 'audio'];
      if (inputPort.portType === 'prompt') {
        return false;
      }
    }
  }

  const accepted = inputPort.acceptedTypes || INPUT_COMPATIBILITY_RULES[inputPort.portType] || [inputPort.portType];

  return provides.some((p) => accepted.includes(p) || p === inputPort!.portType);
}


/** Every node type a user or the assistant may still create. */
export const CREATABLE_NODE_DEFINITIONS: NodeDefinition[] = byUsage(NODE_DEFINITIONS.filter((d) => !d.retired));

export const RETIRED_NODE_TYPES: ReadonlySet<string> = new Set(
  NODE_DEFINITIONS.filter((d) => d.retired).map((d) => d.type)
);

/**
 * Take retired node types out of a template graph and join what they sat
 * between, so a template written around one still produces a working chain.
 *
 * A retired node's incoming edges are handed to each node it fed: a prompt goes
 * to that node's prompt input, anything else to the input the retired node was
 * plugged into. Templates are fixed code, so this only has to be right for the
 * shapes they use, not for arbitrary canvases.
 */
export function withoutRetiredNodes<
  N extends { id: string; type?: string },
  E extends { id: string; source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null },
>(graph: { nodes: N[]; edges: E[] }): { nodes: N[]; edges: E[] } {
  const retired = new Set(
    graph.nodes.filter((n) => n.type && RETIRED_NODE_TYPES.has(n.type)).map((n) => n.id)
  );
  if (retired.size === 0) return graph;
  const edges = graph.edges.filter((e) => !retired.has(e.source) && !retired.has(e.target));
  for (const id of retired) {
    const into = graph.edges.filter((e) => e.target === id && !retired.has(e.source));
    const outOf = graph.edges.filter((e) => e.source === id && !retired.has(e.target));
    for (const incoming of into) {
      for (const outgoing of outOf) {
        const targetHandle = incoming.sourceHandle === 'out-prompt' ? 'in-prompt' : outgoing.targetHandle;
        const key = `e-${incoming.source}-${outgoing.target}-${targetHandle}`;
        if (edges.some((e) => e.id === key)) continue;
        edges.push({
          ...outgoing,
          id: key,
          source: incoming.source,
          sourceHandle: incoming.sourceHandle,
          targetHandle,
        });
      }
    }
  }
  return { nodes: graph.nodes.filter((n) => !retired.has(n.id)), edges };
}
