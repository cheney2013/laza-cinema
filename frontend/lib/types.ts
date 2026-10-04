import type { Node } from '@xyflow/react';

import type { H3DirectorSpec } from './h3/spec';
import type { H3Take } from './h3/takes';
import nodeFloors from './nodeFloors.json';

export const MODELS = [
  { label: 'FLUX.2-dev (text→image)', value: 'flux2_dev_fp8mixed.safetensors' },
];

export const DEFAULT_NODE_DIMENSIONS: Record<string, { width: number; height: number }> = nodeFloors.defaultDims;

/** 
 * Default sampling steps for fused MiniMax H3 video inference. 4 is preview tier; 8 is final/production tier.
 * Cross-reference: Backend counterpart is defined in backend/workflow_builders.py (DEFAULT_H3_STEPS). Keep in sync.
 */
export const DEFAULT_H3_STEPS = 8;

export interface SubmittedResource {
  url: string;
  comfy_filename?: string | null;
}

export interface SubmittedResources {
  first_frame?: SubmittedResource | null;
  last_frame?: SubmittedResource | null;
  reference_images?: SubmittedResource[];
  reference_videos?: SubmittedResource[];
  reference_audios?: SubmittedResource[];
}

// Data payloads stored inside each node
/**
 * 所有节点共有的尺寸字段。
 *
 * 节点尺寸是一自由度模型 —— 宽度是自变量，高度 = 功能区高度 + 宽度/媒体比例，
 * 所以只需要记宽度。见 docs/node-sizing.md。
 */
export interface SizedNodeData extends Record<string, unknown> {
  /** 用户手动拖出来的节点宽度。没有它时尺寸跟着内容与比例走 */
  userWidth?: number;
}

export interface PromptNodeData extends SizedNodeData {
  text: string;
}

export interface UploadNodeData extends SizedNodeData {
  label?: string;
  url: string | null;
  width?: number;
  height?: number;
  mediaType?: 'image' | 'video' | 'audio';
  duration?: number;
  fps?: number;
  alias?: string;               // globally unique alias for this asset (e.g. "林夕", "咖啡馆")
}

export interface VideoNodeData extends SizedNodeData {
  prompt: string;
  generatedUrl: string | null;  // local path to .mp4 with native synchronized audio
  status: 'idle' | 'generating' | 'done' | 'error';
  error?: string;
  jobId?: string;               // backend job id — persisted so polling can resume after reload
  width: number;                // default 1376
  height: number;               // default 768
  steps: number;                // 4 (turbo preview) / 8 (final) / 20 (base)
  seed: number;
  seedMode?: 'fixed' | 'random';
  length?: number;              // 17k+5 frame grid: 124 (5.1s), 175 (7.3s), 226 (9.4s), 311 (13.0s), 430 (17.9s)
  duration?: number;
  fps?: number;                 // default 24
  loraName?: string;
  scheduler?: string;
  refImageOrder?: string[];     // ordered list of connected reference image node IDs
  refAliases?: Record<string, string>; // nodeId -> custom alias name (e.g. "女主", "林夕")
  useFirstFrame?: boolean;      // whether to use designated/first image as starting frame (I2VA vs Ref2VA)
  firstFrameNodeId?: string | null; // specific node ID selected as first frame
  latentFilename?: string;      // cached H3 .latent filename from ComfyUI SaveLatent
  compiledPrompt?: string;      // exact backend prompt used for this generated resource
  compiledPromptMode?: string;
  promptWasModified?: boolean;
  submittedResources?: SubmittedResources;
  /**
   * Structured shot design owned by the director console. While `promptSource` is
   * 'director', `prompt` is compiled from this and nothing else writes it.
   */
  directorSpec?: H3DirectorSpec;
  promptSource?: 'director' | 'manual';
  /** Generation history with the spec that produced each one. */
  takes?: H3Take[];
  /** Steps the on-screen result was rendered at, recorded at submit. The
   *  `steps` setting above can be changed afterwards. */
  generatedSteps?: number;
}

export interface VideoUpscaleNodeData extends SizedNodeData {
  generatedUrl: string | null;
  status: 'idle' | 'generating' | 'done' | 'error';
  error?: string;
  jobId?: string;
  width: number;
  height: number;
  steps: number;
  denoiseStrength: number;
  seed: number;
  seedMode?: 'fixed' | 'random';
  targetFps: number;  // 0 = keep source FPS (no interpolation)
  repair?: boolean;   // deprecated, always false
  length?: number;    // 0 = all frames
  method?: 'lms' | 'h3_latent' | 'esrgan' | 'repair';
  scaleBy?: number;   // 1.5, 2.0
  prompt?: string;
  latentFilename?: string;
  compareUrl?: string | null;
}

/** Inspection only: two clips in, nothing out. The comparison is the product. */
export interface VideoCompareNodeData extends SizedNodeData {
  /** 'wipe' | 'sideBySide' | 'flip' */
  mode?: string;
}

export interface VideoInterpolateNodeData extends SizedNodeData {
  generatedUrl: string | null;
  status: 'idle' | 'generating' | 'done' | 'error';
  error?: string;
  jobId?: string;
  targetFps: number;
  compareUrl?: string | null;
}



export interface VideoTrimNodeData extends SizedNodeData {
  generatedUrl: string | null;
  status: 'idle' | 'generating' | 'done' | 'error';
  error?: string;
  jobId?: string;
  trimStartSeconds: number;
  /** null = to the end of the clip */
  trimEndSeconds: number | null;
  /** Drop the audio track, so the clip mounts as a video reference with no <Audio N> */
  trimMuteAudio?: boolean;
  /** Output per-frame depth instead of the picture (silent): a camera reference H3 cannot copy looks from */
  trimDepth?: boolean;
  sourceUrl?: string | null;
  trimPlan?: { start_frame: number; end_frame: number; frames: number; fps: number; source_frames: number };
  /** The cut latent, when the cut landed on the 17n+5 grid: a shot that carries on from this chains on it. */
  latentFilename?: string;
  width?: number;
  height?: number;
}

export interface InpaintNodeData extends SizedNodeData {
  prompt: string;
  generatedUrl: string | null;
  status: 'idle' | 'generating' | 'done' | 'error';
  error?: string;
  jobId?: string;
  steps: number;
  cfg: number;
  seed: number;
  seedMode?: 'fixed' | 'random';
  imageUrl?: string | null;
  comfyFilename?: string | null;
}

// Full React Flow node types (data + metadata)
export type PromptNode = Node<PromptNodeData, 'prompt'>;

export type VideoNode = Node<VideoNodeData, 'video'>;

export type UploadNode = Node<UploadNodeData, 'image'>;

export type VideoUpscaleNode = Node<VideoUpscaleNodeData, 'videoUpscale'>;
export type VideoInterpolateNode = Node<VideoInterpolateNodeData, 'videoInterpolate'>;
export type VideoTrimNode = Node<VideoTrimNodeData, 'videoTrim'>;

export interface DepthVideoNodeData extends SizedNodeData {
  generatedUrl: string | null;
  status: 'idle' | 'generating' | 'done' | 'error';
  error?: string;
  jobId?: string;
  /** Depth Anything V2 working size, a multiple of 14. */
  resolution?: number;
  sourceUrl?: string | null;
}

export type DepthVideoNode = Node<DepthVideoNodeData, 'depthVideo'>;

export interface AudioGenNodeData extends SizedNodeData {
  /** 'speak' = H3 says `text`; 'convert' = Seed-VC re-voices in-source-audio */
  mode: 'speak' | 'convert';
  text: string;
  voiceDescription: string;
  delivery?: string;
  generatedUrl: string | null;
  status: 'idle' | 'generating' | 'done' | 'error';
  error?: string;
  jobId?: string;
  length?: number;
  seed?: number;
  seedMode?: 'fixed' | 'random';
  trimSilence?: boolean;
  diffusionSteps?: number;
  semitoneShift?: number;
  compiledPrompt?: string | null;
  sampleUrl?: string | null;
}
export type AudioGenNode = Node<AudioGenNodeData, 'audioGen'>;
export type VideoCompareNode = Node<VideoCompareNodeData, 'videoCompare'>;
export type InpaintNode = Node<InpaintNodeData, 'inpaint'>;

export interface WardrobeSwapNodeData extends SizedNodeData {
  generatedUrl: string | null;
  status: 'idle' | 'generating' | 'done' | 'error';
  error?: string;
  jobId?: string;
  width: number;
  height: number;
  steps: number;
  guidance: number;
  seed: number;
  seedMode?: 'fixed' | 'random';
  /** Optional short adjustment; the identity/pose preservation contract stays hidden. */
  detail?: string;
  outfitSource?: string;
  outfitDescription?: string;
  personSource?: string;
  personDescription?: string;
}

export type WardrobeSwapNode = Node<WardrobeSwapNodeData, 'wardrobeSwap'>;

export interface CharacterSheetNodeData extends SizedNodeData {
  generatedUrl: string | null;
  /** The four-view H3 clip the sheet was composed from. */
  turnaroundUrl?: string;
  compiledPrompt?: string;
  status: 'idle' | 'generating' | 'done' | 'error';
  error?: string;
  jobId?: string;
  /** What the character is, whatever they wear (face, hair, build, make-up). */
  identity?: string;
  /** What they wear in this production. */
  costume?: string;
  subjectNoun?: string;
  /** Description per connected prop node, keyed by that node's id. */
  propDescriptions?: Record<string, string>;
  width: number;
  height: number;
  steps: number;
  seed: number;
  seedMode?: 'fixed' | 'random';
}

export type CharacterSheetNode = Node<CharacterSheetNodeData, 'characterSheet'>;

export interface QwenImageNodeData extends SizedNodeData {
  /** What to draw, or what to change. Edited through useSyncedText so MCP writes win. */
  prompt: string;
  /** Qwen takes negation, unlike H3. */
  negativePrompt?: string;
  /** Only used when no reference is wired: with one, the canvas follows reference 1. */
  width: number;
  height: number;
  steps: number;
  cfg: number;
  seed: number;
  seedMode?: 'fixed' | 'random';
  /** Re-shoot <image 1> at the camera of the coarse view in <image 2> (QI2.1_AnyAngle LoRA). */
  anyAngle?: boolean;
  generatedUrl: string | null;
  status: 'idle' | 'generating' | 'done' | 'error';
  error?: string;
  jobId?: string;
}

export type QwenImageNode = Node<QwenImageNodeData, 'qwenImage'>;

export interface ImageUpscaleNodeData extends SizedNodeData {
  /** upscale: RealESRGAN only; detail: Qwen-Image 2.1 restores fine detail at the same size; both: RealESRGAN, then Qwen. */
  mode?: 'upscale' | 'detail' | 'both';
  /** Overrides the built-in detail prompt. */
  prompt?: string;
  /** RealESRGAN weights under ComfyUI's upscale_models/. */
  modelName: string;
  /** Long edge the result is resampled to; 0 keeps the model's native factor. */
  targetLongEdge: number;
  generatedUrl: string | null;
  status: 'idle' | 'generating' | 'done' | 'error';
  error?: string;
  jobId?: string;
}

export type ImageUpscaleNode = Node<ImageUpscaleNodeData, 'imageUpscale'>;

export interface GaussianNodeData extends SizedNodeData {
  plyUrl: string | null;          // /uploads/gaussian_xxx.ply
  plyFilename: string | null;     // gaussian_xxx.ply (as stored on server)
  plyOriginalName: string | null; // original filename from user
  generatedUrl: string | null;    // captured screenshot /uploads/gaussian_capture_xxx.png
  comfyFilename?: string | null;  // for downstream image nodes
  status: 'idle' | 'loading' | 'ready' | 'capturing' | 'error' | 'generating' | 'done';
  error?: string;
  jobId?: string;
  /** sharp: one picture's own geometry, in a second. flashworld: the whole scene, the
   *  unseen sides generated along a trajectory (~5 min, backend/world_gen.py). */
  engine?: 'sharp' | 'flashworld';
  worldTrajectory?: 'ring' | 'orbit' | 'pan';
  worldPrompt?: string;
  worldJobId?: string;
  worldVideoUrl?: string;
}

export type GaussianNode = Node<GaussianNodeData, 'gaussian'>;

export interface GaussianViewerNodeData extends SizedNodeData {
  plyUrl: string | null;          // a PLY opened or dropped here; a connected gaussian node wins
  plyFilename: string | null;
  plyOriginalName: string | null;
  generatedUrl: string | null;    // screenshot of the current view, the image output
  status: 'idle' | 'loading' | 'ready' | 'capturing' | 'error';
  error?: string;
}

export type GaussianViewerNode = Node<GaussianViewerNodeData, 'gaussianViewer'>;

export interface PreviewImageNodeData extends SizedNodeData {}
export type PreviewImageNode = Node<PreviewImageNodeData, 'preview'>;

export interface ChainPreviewNodeData extends SizedNodeData {
  /** Play order of the wired sources, as in-video edge ids; unlisted ones follow in wiring order. */
  sourceOrder?: string[];
}
export type ChainPreviewNode = Node<ChainPreviewNodeData, 'chainPreview'>;

export interface PoseNodeData extends SizedNodeData {
  glbUrl: string | null;
  generatedUrl: string | null;
  poseImageUrl?: string | null;
  depthImageUrl?: string | null;
  dwposeImageUrl?: string | null;
  wholebodyJsonUrl?: string | null;  // MediaPipe wholebody JSON — loaded into pose viewer for 3D editing
  poseJsonUrl?: string | null;       // Saved edited openpose JSON — restored on reload (takes precedence over glbUrl)
  skeletonMode: 'openpose' | 'wholebody';
  status: 'idle' | 'loading' | 'ready' | 'saving' | 'done' | 'error';
  error?: string;
  jobId?: string;
  sourceImageUrl?: string | null;
}

export interface VideoEditNodeData extends SizedNodeData {
  prompt: string;
  userIntent?: string;
  generatedUrl: string | null;
  status: 'idle' | 'generating' | 'done' | 'error';
  error?: string;
  jobId?: string;
  editMode: 'edit' | 'continuation' | 'fl2va' | 'revoice' | 'temporal_reshot' | 'av_bridge';
  audioStrategy: 'copy_source' | 'revoice' | 'reference' | 'new';
  width: number;
  height: number;
  steps: number;
  /** Steps the on-screen result was rendered at, recorded at submit. The
   *  `steps` setting above can be changed afterwards. */
  generatedSteps?: number;
  seed: number;
  length?: number;
  duration?: number;
  fps?: number;
  latentFilename?: string;
  compiledPrompt?: string;
  compiledPromptMode?: string;
  promptWasModified?: boolean;
  submittedResources?: SubmittedResources;
  reshotStartSeconds?: number;
  reshotDurationSeconds?: number;
  reshotContextBefore?: number;
  reshotContextAfter?: number;
  reshotEdgeBlendFrames?: number;
  /** Edit mode only: edit just the reshot* range from its own frames and splice it back. */
  editWindowEnabled?: boolean;
  /** Edit mode only: 去水印 / 去字幕 on the whole clip; the prompt is generated and data.prompt ignored. */
  cleanupRemoveWatermark?: boolean;
  cleanupRemoveSubtitles?: boolean;
  cleanupWatermarkHint?: string;
  cleanupSceneHint?: string;
  /** Set by an edit window: mean luma jump at each seam next to the clip's typical step. */
  editSeams?: { head: number | null; tail: number | null; typical: number | null };
  /** Continuation: send the whole source as <Video 1> instead of only its tail. */
  continueFullSource?: boolean;
  /** Continuation tail length in seconds; 0/unset = from the source's last cut (2-15 s). */
  continueTailSeconds?: number;
  /** Set by a tail continuation: which frames of the source it saw. */
  continueTail?: { start: number; frames: number; source_frames: number; auto: boolean };
  /** AV bridge: frames frozen at EACH end. Only 39/90/141/192 are valid. */
  bridgeContextFrames?: number;
}

export type VideoEditNode = Node<VideoEditNodeData, 'videoEdit'>;

export type PoseNode = Node<PoseNodeData, 'pose'>;


/**
 * Viggle-Animate character swap. Deliberately has no prompt field: on this route the
 * text encoder is a frozen embedding, so there is nothing a prompt could reach.
 */
export interface CharswapNodeData extends Record<string, unknown> {
  generatedUrl: string | null;
  status: string;
  width: number;
  height: number;
  /** 0 = the driving clip's own frame count, read on the server. */
  length: number;
  steps: number;
  seed: number;
  seedMode: string;
  megapixels?: number;
  /** "person" (换人, default): the whole person, clothes included. "head" (换头): the face, hair colour and bangs. */
  swapMode?: 'person' | 'head' | 'reference';
  /** "viggle" (default): a repainted frame of the clip, then Viggle. "h3": MiniMax-H3's own edit of the whole clip. */
  swapEngine?: 'viggle' | 'h3';
  /** H3 engine: the speed LoRA ("taomate3", default: 3 steps; "turbo8": 8 steps). */
  h3Accel?: 'taomate3' | 'turbo8';
  /** H3 engine: the size ("source", default: the clip's own; "small": 864 on the long edge, about 4x faster). */
  h3Size?: 'source' | 'small';
  swapPose?: 'auto' | 'follow' | 'upright';
  /** Face mode: which second of the driving clip is repainted; unset = the middle. */
  faceFrameSeconds?: number;
  /** Face mode: the Qwen edit prompt for the repainted frame; empty = the default. */
  facePrompt?: string;
  /** Face mode: the repainted frame the last swap used as its reference. */
  faceReferenceUrl?: string;
  /** Face mode: the edit prompt the last swap used (written automatically when facePrompt is empty). */
  facePromptUsed?: string;
  jobId?: string;
  error?: string;
}

export type CharswapNode = Node<CharswapNodeData, 'charswap'>;

/** One camera on a re-angle path: f counts from 1 within the rendered window. */
export interface ReangleKeyframe {
  f: number;
  az: number;
  el: number;
  dist: number;
}

/**
 * CrossView re-angle: an accepted clip seen from another camera, with its own
 * performance, timing and sound.
 */
export interface ReangleNodeData extends Record<string, unknown> {
  generatedUrl: string | null;
  status: string;
  width: number;
  height: number;
  azimuth: number;
  elevation: number;
  distance: number;
  /** Empty = one fixed camera; otherwise cuts or moves between cameras. */
  keyframes: ReangleKeyframe[];
  startFrame: number;
  /** 0 = as much of the clip from startFrame as H3's 17k+5 grid allows. */
  length: number;
  prompt: string;
  loraStrength: number;
  megapixels: number;
  steps: number;
  seed: number;
  seedMode: string;
  keepSourceAudio: boolean;
  jobId?: string;
  error?: string;
}

export type ReangleNode = Node<ReangleNodeData, 'videoReangle'>;

/** 声音精修: the sound of any clip redone against its frozen picture (backend /audio-refine). */
export interface AudioRefineNodeData extends Record<string, unknown> {
  generatedUrl: string | null;
  status: string;
  /** 'polish' (4 steps @ 0.5) | 'reroll' (8 steps @ 1.0) */
  mode: string;
  /** 0 = the mode's own */
  steps: number;
  denoise: number;
  seed: number;
  seedMode: string;
  /** Own prompt: replaces everything inherited from the H3 node upstream. */
  prompt: string;
  /** What the last run was made against, written by the canvas server. */
  refineInfo?: { inheritedFrom?: string | null; overridden?: boolean; images?: number; audios?: number; locks?: number };
  jobId?: string;
  error?: string;
}

export type AudioRefineNode = Node<AudioRefineNodeData, 'audioRefine'>;
