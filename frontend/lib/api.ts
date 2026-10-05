import { BACKEND_URL } from './config';
import { llmRequest } from './llmQueue';
import type { ExportPayload } from './editor/exportPayload';
import { getSession, getAuthToken, expireSession } from './auth';
import { t } from './i18n';

const BASE = BACKEND_URL;

/**
 * The user's own LLM endpoint, when they have configured one in settings.
 * Server routes fall back to NV_API_KEY when these come back empty.
 */
function llmCredentials(): { customApiKey?: string; customBaseUrl?: string } {
  if (typeof window === 'undefined') return {};
  return {
    customApiKey: localStorage.getItem('ai_cinema_assistant_custom_key') || undefined,
    customBaseUrl: localStorage.getItem('ai_cinema_assistant_custom_url') || undefined,
  };
}

// ── User identity ─────────────────────────────────────────────────────────────
// A signed-in account is the identity; its id follows the person between
// browsers. Without one -- the pre-account state, and the tools that talk to the
// backend directly -- each browser falls back to a stable UUID in localStorage.
// Note: In non-HTTPS LAN / Tailscale environments (http://100.x.x.x or http://192.168.x.x),
// crypto.randomUUID is undefined in browsers. We provide a robust fallback.
function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try {
      return crypto.randomUUID();
    } catch {
      // fallback below
    }
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function getUserId(): string {
  if (typeof window === 'undefined') return 'ssr';
  const account = getSession();
  if (account) return account.user.id;
  try {
    let id = localStorage.getItem('ai_cinema_user_id');
    if (!id) {
      id = generateUUID();
      localStorage.setItem('ai_cinema_user_id', id);
    }
    return id;
  } catch {
    return 'local_user';
  }
}

// The project every request speaks for. The backend stamps whatever a request
// creates with this, so an asset knows which project made it even after the node
// that made it is gone. Pushed in by the store rather than read from it: the
// store imports this module, so the dependency only runs one way.
let activeProjectId: string | null = null;

export function setActiveProjectId(id: string | null) {
  activeProjectId = id;
}

// The scene of the active project the studio has open. Canvas reads and writes
// for the active project address it unless a caller names a scene; a canvas of
// any other project is its first scene, which is what opening a project loads.
let activeSceneId = 'main';

export function setActiveSceneId(id: string) {
  activeSceneId = id || 'main';
}

function sceneFor(projectId: string, scene?: string): string {
  return scene ?? (projectId === activeProjectId ? activeSceneId : 'main');
}

// The revision of the canvas the studio has on screen, per project and scene.
// A save that does not name its base_revision is based on this one: the
// "save before switching project" calls sent none, and the backend used to take
// that as "overwrite whatever is there" -- a tab loaded before an MCP edit put
// its stale copy back (proj_852faf167de2, 2026-09-24). Set only by whoever puts
// a canvas on screen, never by a read that merely inspects one.
const shownRevisions = new Map<string, number>();

export function setShownCanvasRevision(projectId: string, scene: string, revision: number) {
  shownRevisions.set(`${projectId}/${scene || 'main'}`, revision);
}

export function shownCanvasRevision(projectId: string, scene?: string): number | undefined {
  return shownRevisions.get(`${projectId}/${sceneFor(projectId, scene)}`);
}

/** One scene of a film project, as the scene tabs and the film overview show it. */
/** One version of a canvas node as the cut room offers it for a clip to switch to. */
export interface NodeVersion {
  url: string;
  /** The full render with the overlap kept at its head, for a chained shot. */
  untrimmedUrl: string | null;
  contextFrames: number;
  createdAt?: string | number | null;
  seed?: number | null;
  adopted: boolean;
  current: boolean;
  /** The 高清 render made from this very version, when there is one. */
  hd: { url: string; headFrames: number; node?: string } | null;
}
export interface NodeVersions {
  node_id: string;
  scene: string;
  label: string;
  versions: NodeVersion[];
}

/** The state of a project's chain HD run (see POST /projects/{id}/chains/upscale). */
export interface ChainUpscaleState {
  status: 'none' | 'running' | 'done' | 'error' | 'cancelled';
  chain?: string[];
  pending?: string[];
  current?: string | null;
  done?: string[];
  skipped?: string[];
  error?: string | null;
  already_running?: boolean;
}

export interface SceneInfo {
  id: string;
  name: string;
  status: 'todo' | 'in_progress' | 'accepted';
  sequence_id: string | null;
  duration_s: number | null;
  node_count: number;
  thumbnail_url: string | null;
  revision: number;
}

export type BibleKind = 'cast' | 'environment' | 'prop' | 'voice' | 'other';

export interface BibleFile {
  url?: string;
  mediaType?: string;
  width?: number;
  height?: number;
  duration?: number;
}

export interface BibleEntry extends BibleFile {
  id: string;
  kind: BibleKind;
  name: string;
  notes: string;
  history: (BibleFile & { replaced_at: number })[];
  created_at: number;
  updated_at: number;
  usage: { scenes: string[]; nodes: number };
}

export type BibleEntryInput = BibleFile & { kind?: BibleKind; name?: string; notes?: string };

export interface BibleResponse {
  revision: number;
  entries: BibleEntry[];
  kinds: BibleKind[];
}

/** Who is asking, which project for, and the session token when signed in. */
function identityHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'X-User-Id': getUserId() };
  const token = getAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (activeProjectId) headers['X-Project-Id'] = activeProjectId;
  return headers;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...identityHeaders(),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  if (res.status === 401) expireSession();
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    const detail = err.detail;
    const message = typeof detail === 'string'
      ? detail
      : detail?.message || res.statusText || 'Request failed';
    const requestError = new Error(message) as Error & { status?: number; detail?: unknown };
    requestError.status = res.status;
    requestError.detail = detail;
    throw requestError;
  }
  return res.json();
}

export type AbortableRequest = { signal?: AbortSignal };

/** One film in a project's cut room. With include_timelines, its content comes along. */
export interface SequenceInfo {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  timeline?: unknown | null;
  revision?: number;
}

/** One generated file in the asset library, with what still references it. */
export interface Asset {
  name: string;
  url: string;
  kind: 'video' | 'image' | 'audio' | 'latent' | 'model';
  size: number;
  modified: number;
  projects: Array<{ id: string; name: string }>;
  referenced: boolean;
  /** The project this file was made in. Null for anything older than the ledger. */
  origin_project: string | null;
  origin_project_name: string | null;
  /** Files deleted together with this one — a clip's latent, above all. */
  companions: string[];
  companion_size: number;
  /** Pixel size of an image or video, when the backend has read it (a video is filled in by a background pass). */
  width?: number;
  height?: number;
}

export interface QueueJob {
  id: string;
  status: string;
  url?: string;
  error?: string;
  [k: string]: unknown;
}

export interface QueueSnapshot {
  pending: QueueJob[];
  active: (QueueJob & { progress?: { step: number; max: number; [k: string]: unknown } }) | null;
  history: QueueJob[];
  tracked?: Record<string, QueueJob>;
  missing?: string[];
}

export interface VideoRequest {
  prompt: string;
  mode?: 't2va' | 'i2va' | 'fl2va' | 'l2va' | 'ref2va' | 'edit' | 'continuation' | 'revoice';
  image_url?: string | null;            // first frame (I2VA / FL2VA start)
  last_frame_url?: string | null;       // last frame (FL2VA end / L2VA)
  last_frame_index?: number;            // pixel frame last_frame_url is pinned at (-1 = last)
  guide_frames?: { url: string; frame_index: number }[]; // images pinned at frames (AddGuide each)
  guide_frames_delivered?: boolean;     // frame numbers count the delivered clip; the motion-context overlap is added by the backend
  /** 钉住末帧: the clip shown before the re-run; its last frame is pinned at the new take's last frame. */
  pin_last_frame_of?: string;
  ref_image_urls?: string[];            // maps to <Picture 1>, <Picture 2>, ...
  ref_audio_urls?: string[];            // maps to <Audio 1>, <Audio 2>, ...
  ref_video_urls?: string[];            // maps to <Video 1>, <Video 2>, ...
  audio_strategy?: 'auto' | 'copy_source' | 'revoice' | 'reference' | 'new';
  width?: number;                       // default 1376
  height?: number;                      // default 768
  steps?: number;                       // 4 (turbo preview) / 8 (final) / 20 (base)
  seed?: number;
  length?: number;                      // 124, 175, 226, 311, 430
  duration?: number;                    // seconds
  fps?: number;                         // 24
  /**
   * Which checkpoint/LoRA/scheduler trio to sample with.
   *
   * 'singularity' is the workstation default (2026-10-02); 'fused' is the fused base: turbo
   * and Mystic 0.7 merged in, most motion and most detail. 'hybrid' swaps in the hybrid base plus its
   * turbo LoRA on the beta scheduler — measured 34.7 degrees peak-to-peak of
   * car-body pitch against 42.4 for fused on the same chase shot. Neither
   * removes the pitch: H3 draws a fast car working its springs whatever it is
   * told, so a shot that must sit still is finished in post.
   */
  motion_preset?: 'fused' | 'hybrid' | 'singularity' | 'pruned_w4a8' | 'singularity_w4a8' | 'hyperflow' | 'ref2va' | 'ref2va_full';
  /** Speed LoRA for non-fused presets; fixes steps: 'turbo8' (default) 8, 'taomate3' 3, 'none' 20. */
  accel_lora?: 'taomate3' | 'turbo8' | 'none';
  /** Attention patch: 'sol' | 'kjsage' | 'none'. Unset keeps the machine's default. The backend never runs Sol on a w4a8 checkpoint. */
  sage?: string;
  /** Block-sparse attention (sol-attn): ~21% faster, same composition, small details re-rolled. */
  block_sparse?: boolean;
  /** Recordings kept as recorded on a second of the delivered clip (see lib/audioLocks.ts). */
  audio_locks?: Array<{ url: string; at: number; strength: number; text: string; from?: number; to?: number }>;
  audio_lock_feather?: number;
  tiled_vae_decode?: boolean;
  /**
   * Style LoRA stacked on top of the base (the turbo LoRA is separate and
   * belongs to the preset). Empty or omitted = none. Until 2026-09-09 the
   * backend stacked AfterMidnight on every render by default; now the node
   * chooses, and the default is none.
   */
  style_lora_name?: string;
  style_lora_strength?: number;
  /** Several style LoRAs stacked in order; each {name, strength}. */
  style_loras?: { name: string; strength: number }[];
  /**
   * Continue from a finished clip: the latent it saved, which carries both its
   * motion and its sound across the join. The pinned frames come back at the
   * head of this clip and are trimmed off again in the graph, so the file ends
   * up `motion_context_length` frames shorter than it was generated.
   */
  motion_context_latent?: string;
  /** Continue from a clip's frames when it has no latent (e.g. a trim). */
  motion_context_video?: string;
  /** With motion_context_video: carry on from the first N frames of it instead of its last frame. */
  motion_context_end_frame?: number;
  /** Pinned video frames: 5, 22, 39 or 56. 22 is the tested one. */
  motion_context_length?: number;
  /** Pinned audio frames; 24 is exactly one second and lands on the audio grid. */
  motion_context_audio?: number;
}

export interface TemporalReshotRequest {
  video_url: string;
  prompt: string;
  start_frame: number;
  frame_count: number;
  context_before?: number;
  context_after?: number;
  edge_blend_frames?: number;
  ref_image_urls?: string[];
  steps?: number;
  seed?: number;
  lora_name?: string;
  lora_strength?: number;
  condition_source_audio?: boolean;
}

/**
 * One interval redone with both ends frozen. `context_frames` is how much of the
 * clip either side is pinned — only 39/90/141/192 exist, and a longer pin needs
 * that much untouched material on both sides of the window.
 */
export interface AVBridgeRequest {
  video_url: string;
  prompt: string;
  start_frame: number;
  frame_count: number;
  context_frames?: number;
  width?: number;
  height?: number;
  steps?: number;
  seed?: number;
}

export interface CharswapRequest {
  video_url: string;                 // driving clip: blocking, camera, set, everyone else
  character_image_url: string;       // one still of the replacement character
  /** 0 = the clip's own frame count. A cap above it mosaics the output. */
  length?: number;
  steps?: number;
  seed?: number;
  sampler?: string;
  scheduler?: string;
  megapixels?: number;
  /** "person" (换人): the whole person. "head" (换头): the face, hair colour and bangs. A frame of the clip is repainted first.
   *  "reference": the picture is already the reference and goes to Viggle as it is. */
  mode?: 'person' | 'head' | 'reference';
  /** Person mode with several people in the clip: who to replace (a point on the frame at face_frame_seconds, 0-1
   *  from the top left) and with whose photo. Everyone not pointed at stays. */
  targets?: { x: number; y: number; image_url: string }[];
  /** "viggle" (default) or "h3": MiniMax-H3's own edit of the whole clip, person mode only. */
  engine?: 'viggle' | 'h3';
  h3_accel?: 'taomate3' | 'turbo8';
  h3_size?: 'source' | 'small';
  pose?: 'auto' | 'follow' | 'upright';
  /** Face mode: the second to repaint; negative = the middle of the clip. */
  face_frame_seconds?: number;
  /** Face mode: the whole Qwen edit prompt (<image 1> = the clip's frame, <image 2> = the photo); empty = the default. */
  face_prompt?: string;
}

export interface ReangleRequest {
  video_url: string;                 // the accepted clip; performance and sound are kept
  start_frame?: number;
  /** 0 = as much of the clip as H3's 17k+5 grid allows from start_frame. */
  length?: number;
  azimuth?: number;                  // degrees, + orbits right
  elevation?: number;                // degrees, + above the subject
  distance?: number;
  keyframes?: { f: number; az: number; el: number; dist: number }[];
  ref_image_urls?: string[];         // steer what the new camera reveals
  prompt?: string;
  lora_strength?: number;
  megapixels?: number;
  steps?: number;
  seed?: number;
  keep_source_audio?: boolean;
  /** Rotation centre in the depth's camera space (z = metres ahead); omitted = automatic. */
  pivot?: { x: number; y: number; z: number } | null;
  smooth_depth?: boolean;
}

export interface VideoUpscaleRequest {
  video_url: string;
  keep_context?: boolean;
  /** Overlap frames at the head of the result: it is then served cut, with the full file as untrimmed_url. */
  overlap_frames?: number;
  width?: number;
  height?: number;
  steps?: number;
  denoise_strength?: number;
  seed?: number;
  target_fps?: number;   // 0 = keep source FPS
  repair?: boolean;
  length?: number;
  method?: 'lms' | 'h3_latent' | 'esrgan';
  latent_filename?: string | null;
  scale_by?: number;
  prompt?: string;
  /** h3_latent only: the source shot's reference images, by ComfyUI filename. */
  reference_images?: string[];
  /**
   * h3_latent only: the frames the shot was generated from, by ComfyUI filename.
   * An I2V shot has no reference images, so these are the only image anchoring
   * its refine pass can be given.
   */
  first_frame?: string;
  last_frame?: string;
  /** h3_latent only: the previous chain's HD file; its last anchor_frames frames
   *  are mounted over this latent's context window so the seam agrees at HD. */
  prev_hd_url?: string;
  anchor_frames?: number;
  /** Carry on from frame N of the previous clip: the overlap window ends at this frame of its HD file. */
  anchor_end_frame?: number;
  /** h3_latent only: spatial tile size in px, 0 = whole frame. */
  spatial_tile?: number;
  /** h3_latent only: the refine pass's sigma list, e.g. "0.6, 0.3, 0"; absent = the default single step. */
  manual_sigmas?: string;
}

export interface SpeechRequest {
  mode: 'speak' | 'convert';
  text: string;
  voice_description: string;
  delivery?: string;
  ref_audio_url?: string | null;
  source_audio_url?: string | null;
  length?: number;
  seed?: number;
  trim_silence?: boolean;
  diffusion_steps?: number;
  semitone_shift?: number;
}

export interface VideoTrimRequest {
  video_url: string;
  start_seconds: number;
  /** null = to the end */
  end_seconds: number | null;
  /** false = drop the audio track (e.g. a camera-only reference for H3) */
  keep_audio?: boolean;
  /** true = replace the picture with its per-frame depth (silent) */
  depth?: boolean;
  /** The source clip's latent and the chain-context frames at its head: when the cut starts at
   *  the head and ends on the 17n+5 grid the trim also gets a cut latent. */
  latent_filename?: string | null;
  context_frames?: number;
}

export interface VideoInterpolateRequest {
  video_url: string;
  target_fps: number;
}

export interface InpaintRequest {
  image_url: string;
  mask_url: string;
  prompt: string;
  steps: number;
  cfg: number;
  seed: number;
}

export interface WardrobeSwapRequest {
  person_image_url: string;
  outfit_image_url: string;
  width: number;
  height: number;
  steps: number;
  seed: number;
  detail?: string;
  person_detail?: string;
  extract_time?: number;
}

// ── Project types ─────────────────────────────────────────────────────────────
export interface Project {
  id: string;
  name: string;
  description?: string;
  aspect_ratio?: string;
  template?: string;
  owner_user_id: string | null;
  workspace: string;
  created_at: string;
  updated_at: string;
  node_count?: number;
  edge_count?: number;
  thumbnail_url?: string | null;
}

export interface CanvasData {
  nodes: unknown[];
  edges: unknown[];
  viewport?: { x: number; y: number; zoom: number } | null;
  revision?: number;
}

/** Per-machine H3 defaults from the backend's H3_MACHINE_PROFILE. */
export type MachineProfile = {
  name: string;
  label: string;
  motion_preset: 'fused' | 'hybrid' | 'singularity' | 'pruned_w4a8' | 'singularity_w4a8' | 'hyperflow' | 'ref2va' | 'ref2va_full';
  width: number;
  height: number;
  tiled_vae_decode: boolean;
  /** Presets that do not fit on this machine, and what runs instead. */
  preset_substitutes?: Record<string, string>;
  /** Motion presets this machine cannot run at all; the backend refuses them. */
  disabled_presets?: string[];
  /** Node types this machine cannot run; hidden from the palette, refused by the backend. */
  disabled_node_types?: string[];
  /** Video-enhance methods this machine cannot load the weights for ("h3_latent" on 16 GB). */
  disabled_upscale_methods?: string[];
  /** The enhance method a new node starts with here. */
  upscale_method?: string;
};

let machineProfilePromise: Promise<MachineProfile | null> | null = null;

/** Fetched once per page load; null when the backend is older or unreachable. */
export function loadMachineProfile(): Promise<MachineProfile | null> {
  if (!machineProfilePromise) {
    machineProfilePromise = request<MachineProfile>('/machine-profile').catch(() => {
      machineProfilePromise = null;
      return null;
    });
  }
  return machineProfilePromise;
}

export const api = {
  getVersion: () => request<{ name: string; version: string; commit: string }>('/version'),

  health: () => request<{ status: string; comfyui: boolean }>('/health'),

  getMachineProfile: () => request<MachineProfile>('/machine-profile'),

  /** Which attention patches the backend lets a preset use here, and its default (the backend decides). */
  getH3Attention: (preset: string) =>
    request<{ preset: string; unet: string; allowed: string[]; blocked: Record<string, string>; default: string }>(
      `/h3-attention?preset=${encodeURIComponent(preset)}`
    ),

  getSystemStats: () =>
    request<{
      comfyui_connected: boolean;
      vram: Array<{
        name: string;
        vram_total: number;
        vram_free: number;
        vram_used: number;
        vram_pct: number;
        gpu_util?: number | null;
        gpu_temp?: number | null;
      }>;
      ram: {
        ram_total: number;
        ram_free: number;
        ram_used: number;
        ram_pct: number;
      } | Record<string, never>;
    }>('/system-stats'),

  getVramHistory: () =>
    request<{
      samples: number;
      window_s: number;
      sample_s: number;
      covered_s?: number;
      vram_total?: number;
      generating_s?: number;
      avg_used?: number | null;
      peak_used?: number;
      peak_at?: string;
    }>('/system-stats/vram-history'),
  /** Who holds the GPU: per process, VRAM and what spilled into shared memory (Windows). */
  getVramProcesses: () =>
    request<{
      supported: boolean;
      vram_total?: number | null;
      processes: Array<{ pid: number; label: string; name: string; dedicated: number; shared: number; cmd: string; started: string | null }>;
    }>('/system-stats/vram-processes'),

  uploadStyleReference: (file: File) => {
    const body = new FormData();
    body.append('file', file);
    return request<{ comfy_filename: string; url: string }>('/style-references', {
      method: 'POST',
      body,
    });
  },

  uploadVideoFile: (file: File) => {
    const body = new FormData();
    body.append('file', file);
    return request<{ url: string; width?: number; height?: number; fps?: number; duration?: number }>('/upload-video-file', { method: 'POST', body });
  },

  /** A character sheet: Qwen three views (full front, full back, waist-up front) by default. */
  generateCharacterSheet: (req: {
    identity: string;
    costume: string;
    subject_noun?: string;
    face_image_url?: string | null;
    base_sheet_url?: string | null;
    props?: { image_url: string; description: string }[];
    engine?: 'qwen' | 'h3';
    width?: number;
    height?: number;
    steps?: number;
    seed?: number;
  }) =>
    request<{ job_id: string; status: string }>('/generate-character-sheet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),

  wardrobeSwapH3: (req: WardrobeSwapRequest) =>
    request<{ job_id: string; status: string }>('/wardrobe-swap-h3', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),

  generateVideo: (req: VideoRequest) =>
    request<{ job_id: string; status: string; video_url?: string }>('/generate-video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),

  editVideo: (req: VideoRequest) =>
    request<{ job_id: string; status: string }>('/generate-video-edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),

  /** Continuation from the tail of the source (its last shot by default) instead of all of it. */
  continueVideoTail: (req: VideoRequest & { tail_frames: number }) =>
    request<{ job_id: string; status: string }>('/generate-video-continue-tail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),

  /** Frame-based edit of one range: a padded piece goes through the ordinary edit and only the range is spliced back. */
  editVideoWindow: (req: VideoRequest & { start_frame: number; frame_count: number }) =>
    request<{ job_id: string; status: string }>('/generate-video-edit-window', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),

  /** 去水印 / 去字幕 on the whole source: the backend writes the prompt and follows the source's size, length and audio. */
  cleanupVideo: (req: { source_url: string; remove_watermark: boolean; remove_subtitles: boolean; watermark_hint?: string; scene_hint?: string; seed: number; steps?: number; motion_preset?: string }) =>
    request<{ job_id: string; status: string }>('/generate-video-cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),

  temporalReshot: (req: TemporalReshotRequest) =>
    request<{ job_id: string; status: string }>('/generate-video-reshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),

  /**
   * Redo one interval of a clip with both of its ends frozen (H3 AV bridge).
   *
   * The frame grids are resolved server-side: a preserved run must be
   * 39/90/141/192 frames and the target must be 5+17k, so what comes back is
   * rarely exactly the window that was asked for. `planAvBridge` returns that
   * resolved window without rendering anything.
   */
  avBridge: (req: AVBridgeRequest) =>
    request<{ job_id: string; status: string }>('/generate-av-bridge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),

  planAvBridge: (req: AVBridgeRequest) =>
    request<{
      ok: boolean; error?: string;
      preserve?: number; target?: number; middle?: number;
      head_end?: number; tail_start?: number;
      middle_seconds?: number; preserve_seconds?: number;
    }>('/plan-av-bridge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),

  /**
   * Character replacement through Viggle-Animate. No prompt exists on this route: the
   * still supplies the identity, the driving clip everything else. Held props are lost -
   * a prop-driven shot goes to the Ref2VA route instead.
   */
  charswap: (req: CharswapRequest) =>
    request<{ job_id: string; status: string }>('/charswap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),

  /**
   * CrossView re-angle: the clip seen from another camera, its own performance and
   * sound kept. The source is depth-warped to the new camera inside the graph.
   */
  reangle: (req: ReangleRequest) =>
    request<{ job_id: string; status: string }>('/reangle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),

  /** One frame of the real re-angled render (a 5-frame job; the still is `frame`). */
  reangleStill: (req: ReangleRequest & { frame: number }) =>
    request<{ job_id: string; status: string }>('/reangle/still', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),

  /** One warped frame at this angle -- the guide the render will follow. */
  reanglePreview: (req: { video_url: string; start_frame: number; azimuth: number; elevation: number; megapixels: number }) =>
    request<{ url: string; hole_ratio: number; azimuth: number; elevation: number }>('/reangle/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),

  upscaleVideo: (req: VideoUpscaleRequest) =>
    request<{ job_id: string; status: string }>('/upscale-video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),

  generateSpeech: (req: SpeechRequest) =>
    request<{ job_id: string; status: string }>('/generate-speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),

  trimVideo: (req: VideoTrimRequest) =>
    request<{ job_id: string; status: string }>('/generate-video-trim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),

  interpolateVideo: (req: VideoInterpolateRequest) =>
    request<{ job_id: string; status: string }>('/interpolate-video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),

  generateInpaint: (req: InpaintRequest) =>
    request<{ job_id: string; status: string }>('/generate-inpaint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),

  /** Qwen-Image-2.1. reference_urls order is the model's `<image N>` numbering. */
  generateQwenImage: (req: {
    prompt: string;
    reference_urls?: string[];
    negative_prompt?: string;
    width?: number;
    height?: number;
    steps?: number;
    cfg?: number;
    seed?: number;
    lora_name?: string;
    lora_strength?: number;
    base_model?: string;
    /** 'turbo' (backend default): 7-step distilled LoRA; steps, cfg and negative_prompt are ignored. */
    speed?: 'turbo' | 'base';
  }) =>
    request<{ job_id: string; status: string }>('/generate-qwen-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),

  generateVideoDepth: (req: { video_url: string; resolution?: number }) =>
    request<{ job_id: string; status: string }>('/generate-video-depth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),

  upscaleImage: (req: { image_url: string; mode?: 'upscale' | 'detail' | 'both'; model_name?: string; target_long_edge?: number; prompt?: string; seed?: number }) =>
    request<{ job_id: string; status: string }>('/upscale-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),

  buildTitleBlock: (req: {
    logo_url: string; line?: string; height?: number; margin?: number;
    content_width?: number; line_width?: number; line_height_scale?: number;
    /** A clean cover plate: the block is set on it at `side` and the result is the card. */
    plate_url?: string; side?: 'left' | 'right';
  }) =>
    request<{ url: string; width: number; height: number; gap: number | null }>('/title-block/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),

  generateWorldGaussian: (req: {
    image_url: string;
    prompt?: string;
    trajectory?: 'ring' | 'orbit' | 'pan';
    radius?: number;
    distance?: number;
    degrees?: number;
    vfov?: number;
  }) =>
    request<{ job_id: string; status: string }>('/generate-world-gaussian', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),

  // `ids` asks the backend for a definitive answer about those jobs: each comes
  // back under `tracked` in whatever state it is in, or in `missing` when the
  // backend has no record of it (restart, history pruned).
  getQueue: (ids?: string[]) =>
    request<QueueSnapshot>(
      ids && ids.length > 0 ? `/queue?ids=${encodeURIComponent(ids.join(','))}` : '/queue'
    ),

  pinJob: (jobId: string) =>
    request<{ status: string; pending: string[] }>(`/queue/pin/${jobId}`, {
      method: 'POST',
    }),

  cancelJob: (jobId: string) =>
    request<{ status: string }>(`/cancel-job/${jobId}`, {
      method: 'POST',
    }),

    uploadPly: (file: File) => {
      const body = new FormData();
      body.append('file', file);
      return request<{ filename: string; original_name: string; url: string; size: number }>('/upload-ply', {
        method: 'POST',
        body,
      });
    },

    /** `purpose` names the file: 'title' for a subtitle overlay of one export, 'frame' for a grabbed frame. */
    uploadImageBase64: (dataUrl: string, purpose?: 'title' | 'frame') =>
      request<{ filename: string; url: string }>('/upload-image-base64', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: dataUrl, purpose }),
      }),

  captureGaussian: (imageDataUrl: string, plyFilename: string) =>
    request<{ url: string }>('/gaussian/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageDataUrl, ply_filename: plyFilename }),
    }),

  generateGaussianModel: (imageUrl: string) =>
    request<{ url: string, filename: string, original_name: string }>('/generate-gaussian-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_url: imageUrl }),
    }),

  /** The same SHARP run as a queued job: a job id back at once, so it can be pinned, watched and cancelled. */
  generateGaussianModelJob: (imageUrl: string) =>
    request<{ job_id: string; status: string }>('/generate-gaussian-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_url: imageUrl, queued: true }),
    }),

  extractPose: (imageUrl: string) =>
    request<{ url: string }>('/extract-pose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_url: imageUrl }),
    }),

  extractDWPose: (imageUrl: string) =>
    request<{ url: string }>('/extract-dwpose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_url: imageUrl }),
    }),

  extractWholebody3D: (imageUrl: string) =>
    request<{ url: string; detected: Record<string, boolean> }>('/extract-wholebody-3d', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_url: imageUrl }),
    }),

  translatePrompt: async (text: string, options?: { customApiKey?: string; customBaseUrl?: string; targetLang?: 'auto' | 'en' | 'zh' }) => {
    return llmRequest(`prompt-translate:${options?.targetLang || 'auto'}:${text}`, async () => {
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          customApiKey: options?.customApiKey || (typeof window !== 'undefined' ? localStorage.getItem('ai_cinema_assistant_custom_key') : undefined),
          customBaseUrl: options?.customBaseUrl || (typeof window !== 'undefined' ? localStorage.getItem('ai_cinema_assistant_custom_url') : undefined),
          targetLang: options?.targetLang || 'auto',
          mode: 'translate',
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || 'Translation failed');
      }
      return res.json() as Promise<{ translatedText: string }>;
    });
  },

  optimizePrompt: async (text: string, options?: { customApiKey?: string; customBaseUrl?: string }) => {
    return llmRequest(null, async () => {
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          customApiKey: options?.customApiKey || (typeof window !== 'undefined' ? localStorage.getItem('ai_cinema_assistant_custom_key') : undefined),
          customBaseUrl: options?.customBaseUrl || (typeof window !== 'undefined' ? localStorage.getItem('ai_cinema_assistant_custom_url') : undefined),
          mode: 'optimize',
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || 'Optimize failed');
      }
      return res.json() as Promise<{ translatedText: string }>;
    });
  },

  compileH3Prompt: async (params: {
    userIntent: string;
    mode?: string;
    refImagesCount?: number;
    refVideosCount?: number;
    refAudiosCount?: number;
    audioStrategy?: string;
    duration?: number;
    customApiKey?: string;
    customBaseUrl?: string;
  }) => {
    return llmRequest(null, async () => {
      const res = await fetch('/api/h3-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...params,
          customApiKey: params.customApiKey || (typeof window !== 'undefined' ? localStorage.getItem('ai_cinema_assistant_custom_key') : undefined),
          customBaseUrl: params.customBaseUrl || (typeof window !== 'undefined' ? localStorage.getItem('ai_cinema_assistant_custom_url') : undefined),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || 'H3 Prompt Compilation failed');
      }
      return res.json() as Promise<{ prompt: string }>;
    });
  },

  /**
   * Rewrite ONE field of a shot specification. Never returns a prompt — the
   * compiler owns that. The console previews the returned value as a diff.
   */
  polishH3Field: async (params: {
    field: string;
    value: string;
    intent: string;
    context?: {
      mode?: string;
      labels?: string;
      world?: string;
      shotIndex?: number;
      neighbours?: string;
    };
  }) => {
    // Not deduplicated: asking twice for a rewrite is a legitimate request.
    return llmRequest(null, async () => {
      const res = await fetch('/api/h3-director/field', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...params, ...llmCredentials() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || t('字段改写失败'));
      }
      return res.json() as Promise<{ value: string; field: string }>;
    });
  },

  /**
   * Translate ONE field, in either direction. Translation only — the endpoint is
   * told not to improve the text, because the director edits the Chinese and what
   * comes back has to be the same field, not a better one.
   */
  translateH3Text: async (params: {
    text: string;
    direction: 'en2zh' | 'zh2en';
    /** `FIELD_RULES` key, for word choice only. */
    field?: string;
  }) => {
    // Same text, same direction, already on its way? Wait on that one.
    return llmRequest(`translate:${params.direction}:${params.text}`, async () => {
      const res = await fetch('/api/h3-director/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...params, ...llmCredentials() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || t('翻译失败'));
      }
      return res.json() as Promise<{ text: string; direction: string }>;
    });
  },

  /**
   * Scene sketch to draft specification. Returns raw draft JSON; validate it with
   * `specFromDraft` against the live wiring before it touches a spec.
   */
  draftH3Spec: async (params: {
    sketch: string;
    mode: string;
    images: number;
    videos: number;
    audios: number;
    totalFrames: number;
    fps: number;
    shotCount?: number;
  }) => {
    return llmRequest(null, async () => {
      const res = await fetch('/api/h3-director/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...params, ...llmCredentials() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || t('草稿生成失败'));
      }
      return res.json() as Promise<{ draft: unknown }>;
    });
  },

  /**
   * Vision pass over a character reference image. Returns a short clause such as
   * "is a girl who is wearing a chunky, ribbed-knit beige/cream crewneck sweater",
   * for a subject definition after `<Subject N> `.
   * `imageDataUrl` must already be downscaled — see lib/imageDownscale.ts.
   */
  describeSubject: async (params: {
    imageDataUrl: string;
    /**
     * 主体类型。读图的提示词按它切换 —— 拿"描述画面里的人"去读一张环境图，
     * 模型只能编一个人出来，写回去的定义跟画面对不上。
     */
    kind?: 'person' | 'environment' | 'prop' | 'motion' | 'effect';
    model?: string;
    customApiKey?: string;
    customBaseUrl?: string;
  }) => {
    return llmRequest(null, async () => {
      const res = await fetch('/api/describe-subject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...params,
          customApiKey: params.customApiKey || (typeof window !== 'undefined' ? localStorage.getItem('ai_cinema_assistant_custom_key') : undefined),
          customBaseUrl: params.customBaseUrl || (typeof window !== 'undefined' ? localStorage.getItem('ai_cinema_assistant_custom_url') : undefined),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || 'Subject description failed');
      }
      return res.json() as Promise<{ description: string }>;
    });
  },

  // ── Project Management API ──────────────────────────────────────────────────
  listProjects: (workspace: string = 'default') =>
    request<{ projects: Project[] }>(`/projects?workspace=${encodeURIComponent(workspace)}`),

  createProject: (
    params:
      | string
      | {
          name: string;
          description?: string;
          aspect_ratio?: string;
          template?: string;
          initial_nodes?: unknown[];
          initial_edges?: unknown[];
          workspace?: string;
        },
    workspace: string = 'default'
  ) => {
    const payload = typeof params === 'string' ? { name: params, workspace } : { workspace, ...params };
    return request<Project>('/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },

  duplicateProject: (projectId: string, workspace: string = 'default') =>
    request<Project>(`/projects/${encodeURIComponent(projectId)}/duplicate?workspace=${encodeURIComponent(workspace)}`, {
      method: 'POST',
    }),

  getProject: (projectId: string, workspace: string = 'default') =>
    request<Project>(`/projects/${encodeURIComponent(projectId)}?workspace=${encodeURIComponent(workspace)}`),

  renameProject: (
    projectId: string,
    data: string | { name?: string; description?: string; aspect_ratio?: string },
    workspace: string = 'default'
  ) => {
    const payload = typeof data === 'string' ? { name: data } : data;
    return request<Project>(`/projects/${encodeURIComponent(projectId)}?workspace=${encodeURIComponent(workspace)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },

  /** What deleting a project removes from disk: files only it uses, and how many shared ones stay. */
  projectDeletePlan: (projectId: string, workspace: string = 'default') =>
    request<{ file_count: number; latent_count: number; bytes: number; shared_count: number }>(
      `/projects/${encodeURIComponent(projectId)}/delete-plan?workspace=${encodeURIComponent(workspace)}`),

  deleteProject: (projectId: string, workspace: string = 'default') =>
    request<{ status: string; id: string; deleted_files: number; freed_bytes: number; shared_kept: number; failed: number }>(`/projects/${encodeURIComponent(projectId)}?workspace=${encodeURIComponent(workspace)}`, {
      method: 'DELETE',
    }),

  // ── Asset library ───────────────────────────────────────────────────────────
  /**
   * Pass a project id to see that project's assets — referenced or made there —
   * plus every file whose origin was never recorded. `allProjects` shows the
   * whole disk regardless.
   */
  listAssets: (projectId?: string | null, allProjects = false) =>
    request<{
      assets: Asset[];
      total_bytes: number;
      unused_count: number;
      unused_bytes: number;
      /** Latents whose clip is gone: no card of their own, cleaned with 未使用. */
      orphan_latent_count: number;
      orphan_latent_bytes: number;
    }>(
      `/assets?${new URLSearchParams({
        ...(projectId ? { project: projectId } : {}),
        ...(allProjects ? { all_projects: 'true' } : {}),
      })}`
    ),

  /**
   * How a generated clip was made, read back out of the file's own metadata.
   *
   * `found: false` for anything hand-uploaded or made before the graph was
   * embedded. Everything else is optional: an old graph may not carry every key.
   */
  assetProvenance: (name: string) =>
    request<{
      found: boolean;
      name: string;
      prompt?: string | null;
      seed?: number | null;
      width?: number | null;
      height?: number | null;
      length?: number | null;
      reference_images?: string[];
      reference_videos?: string[];
      reference_audios?: string[];
      first_frame?: string | null;
      last_frame?: string | null;
      latent_filename?: string | null;
      model?: string | null;
      loras?: string[];
    }>(`/assets/${encodeURIComponent(name)}/provenance`),

  /** Overwrite an asset in place, keeping its name and URL. Drops its latent. */
  replaceAsset: (target: string, sourceUrl: string) =>
    request<{ status: string; target: string; url: string; dropped_latents: string[] }>(
      '/assets/replace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target, source_url: sourceUrl }),
      }),

  /** Delete named assets, or every unused one. Latents go with their clip. */
  /** Dry run: superseded node takes that nothing else uses, and what removing them frees. */
  planTakeHistory: (projectId: string) =>
    request<{
      files: string[]; companions: string[]; take_count: number; bytes: number;
      nodes: Array<{ project_id: string; node_id: string; label: string; take_indexes: number[]; files: string[] }>;
      other_projects: string[]; other_project_names: string[]; kept_in_use: number;
    }>(`/projects/${encodeURIComponent(projectId)}/take-history`),

  /** Remove those takes from every canvas that lists them, then delete their files. */
  cleanTakeHistory: (projectId: string) =>
    request<{ status: string; deleted: string[]; freed_bytes: number; take_count: number; other_projects: string[] }>(
      `/projects/${encodeURIComponent(projectId)}/take-history/clean`, { method: 'POST' }),

  deleteAssets: (body: { names?: string[]; unused?: boolean; project?: string }) =>
    request<{ status: string; deleted: string[]; freed_bytes: number; skipped: string[] }>(
      '/assets/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),

  /** sinceRevision: when the canvas is still at it, only {revision, lock, unchanged} comes back. */
  loadCanvas: (projectId: string, workspace: string = 'default', scene?: string, sinceRevision?: number) =>
    request<CanvasData>(`/projects/${encodeURIComponent(projectId)}/canvas?workspace=${encodeURIComponent(workspace)}&scene=${encodeURIComponent(sceneFor(projectId, scene))}${sinceRevision !== undefined ? `&since_revision=${sinceRevision}` : ''}`),

  saveCanvas: (
    projectId: string,
    data: {
      nodes: unknown[];
      edges: unknown[];
      viewport?: { x: number; y: number; zoom: number } | null;
      base_revision?: number;
    },
    workspace: string = 'default',
    scene?: string
  ) =>
    request<{ status: string; project_id: string; revision: number }>(`/projects/${encodeURIComponent(projectId)}/canvas?workspace=${encodeURIComponent(workspace)}&scene=${encodeURIComponent(sceneFor(projectId, scene))}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, base_revision: data.base_revision ?? shownCanvasRevision(projectId, scene) }),
    }),

  // ── Scenes of a film project ────────────────────────────────────────────────
  listScenes: (projectId: string) =>
    request<{ scenes: SceneInfo[] }>(`/projects/${encodeURIComponent(projectId)}/scenes`),

  /** Redo only the sound of a finished video node with its audio locks; the picture of the take on display stays. */
  redoAudio: (projectId: string, nodeId: string, req: { mode: 'polish' | 'reroll'; seed?: number; steps?: number; denoise?: number; scene?: string }) =>
    request<{ status: string; prompt_stripped?: string[]; audio_redo?: unknown }>(
      `/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/redo-audio`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
      }),

  /** Run a 声音精修 node: the canvas server works out its conditioning and writes the result back. */
  runAudioRefine: (projectId: string, nodeId: string, scene?: string) =>
    request<{ status: string; job_id?: string; inherited_from?: string | null }>(
      `/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/audio-refine`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scene }),
      }),

  /** One click HD for a chain: shots run one after another, each on the previous shot's HD. */
  startChainUpscale: (projectId: string, req: { node_id: string; shot_ids: string[]; scene?: string; scale_by?: number }) =>
    request<ChainUpscaleState>(`/projects/${encodeURIComponent(projectId)}/chains/upscale`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),

  chainUpscaleStatus: (projectId: string, scene?: string) =>
    request<ChainUpscaleState>(
      `/projects/${encodeURIComponent(projectId)}/chains/upscale${scene ? `?scene=${encodeURIComponent(scene)}` : ''}`),

  cancelChainUpscale: (projectId: string, scene?: string) =>
    request<ChainUpscaleState>(
      `/projects/${encodeURIComponent(projectId)}/chains/upscale/cancel${scene ? `?scene=${encodeURIComponent(scene)}` : ''}`,
      { method: 'POST' }),

  /** Every version of one canvas node (any scene), each with the 高清 render made from it. */
  nodeVersions: (projectId: string, nodeId: string) =>
    request<NodeVersions>(
      `/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/versions`),

  /** Finished 视频增强 outputs of every scene, keyed by the clip each was made from. */
  projectHdMap: (projectId: string) =>
    request<{ map: Record<string, { url: string; headFrames: number }> }>(
      `/projects/${encodeURIComponent(projectId)}/hd-map`),

  createScene: (projectId: string, name: string) =>
    request<SceneInfo>(`/projects/${encodeURIComponent(projectId)}/scenes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),

  updateScene: (projectId: string, sceneId: string, patch: { name?: string; status?: SceneInfo['status']; sequence_id?: string }) =>
    request<SceneInfo>(`/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),

  reorderScenes: (projectId: string, ids: string[]) =>
    request<{ ids: string[] }>(`/projects/${encodeURIComponent(projectId)}/scenes/order`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    }),

  deleteScene: (projectId: string, sceneId: string) =>
    request<{ status: string }>(`/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}`, {
      method: 'DELETE',
    }),

  // ── Production bible (references shared by all scenes) ──────────────────────
  getBible: (projectId: string) =>
    request<BibleResponse>(`/projects/${encodeURIComponent(projectId)}/bible`),

  addBibleEntry: (projectId: string, entry: BibleEntryInput & { link?: { scene: string; node_id: string }[] }) =>
    request<BibleResponse & { entry: BibleEntry }>(`/projects/${encodeURIComponent(projectId)}/bible`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    }),

  updateBibleEntry: (projectId: string, entryId: string, patch: BibleEntryInput) =>
    request<BibleResponse & { entry: BibleEntry }>(`/projects/${encodeURIComponent(projectId)}/bible/${encodeURIComponent(entryId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),

  deleteBibleEntry: (projectId: string, entryId: string) =>
    request<BibleResponse>(`/projects/${encodeURIComponent(projectId)}/bible/${encodeURIComponent(entryId)}`, {
      method: 'DELETE',
    }),

  // ── Cut Room (timeline editor) ──────────────────────────────────────────────
  loadTimeline: (projectId: string, workspace: string = 'default') =>
    request<{ timeline: unknown | null; revision: number }>(
      `/projects/${encodeURIComponent(projectId)}/timeline?workspace=${encodeURIComponent(workspace)}`),

  saveTimeline: (
    projectId: string,
    timeline: unknown,
    baseRevision?: number,
    workspace: string = 'default'
  ) =>
    request<{ status: string; project_id: string; revision: number }>(
      `/projects/${encodeURIComponent(projectId)}/timeline?workspace=${encodeURIComponent(workspace)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeline, base_revision: baseRevision }),
      }),

  // ── Sequences: several films per project, one file each ─────────────────────
  listSequences: (projectId: string, includeTimelines = false, workspace: string = 'default') =>
    request<{ sequences: SequenceInfo[] }>(
      `/projects/${encodeURIComponent(projectId)}/sequences?workspace=${encodeURIComponent(workspace)}${includeTimelines ? '&include_timelines=true' : ''}`),

  createSequence: (projectId: string, name: string, copyFrom?: string, workspace: string = 'default') =>
    request<SequenceInfo>(
      `/projects/${encodeURIComponent(projectId)}/sequences?workspace=${encodeURIComponent(workspace)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, copy_from: copyFrom ?? null }),
      }),

  loadSequence: (projectId: string, seqId: string, workspace: string = 'default') =>
    request<{ timeline: unknown | null; revision: number }>(
      `/projects/${encodeURIComponent(projectId)}/sequences/${encodeURIComponent(seqId)}?workspace=${encodeURIComponent(workspace)}`),

  saveSequence: (projectId: string, seqId: string, timeline: unknown, baseRevision?: number, workspace: string = 'default') =>
    request<{ status: string; revision: number }>(
      `/projects/${encodeURIComponent(projectId)}/sequences/${encodeURIComponent(seqId)}?workspace=${encodeURIComponent(workspace)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeline, base_revision: baseRevision }),
      }),

  renameSequence: (projectId: string, seqId: string, name: string, workspace: string = 'default') =>
    request<SequenceInfo>(
      `/projects/${encodeURIComponent(projectId)}/sequences/${encodeURIComponent(seqId)}?workspace=${encodeURIComponent(workspace)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }),

  deleteSequence: (projectId: string, seqId: string, workspace: string = 'default') =>
    request<{ status: string }>(
      `/projects/${encodeURIComponent(projectId)}/sequences/${encodeURIComponent(seqId)}?workspace=${encodeURIComponent(workspace)}`,
      { method: 'DELETE' }),

  /**
   * Everything the editor needs about one source: real fps, exact frame count,
   * geometry, audio presence, plus the scrub proxy, thumbnail strip and peaks.
   */
  prepareTimelineAsset: (url: string) =>
    request<{
      url: string; kind: 'video' | 'image' | 'audio';
      width: number; height: number; fps: number; frames: number;
      duration: number; has_audio: boolean;
      proxy_url?: string; thumbs_url?: string; thumb_count?: number; peaks?: number[]; rms?: number[];
    }>('/timeline/prepare-asset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }),

  exportTimeline: (req: ExportPayload) =>
    request<{ job_id: string; status: string }>('/timeline/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),

  /** One video's cut-room preview proxy at a lower height (built once, on first use). */
  buildProxyLevel: (url: string, height: number) =>
    request<{ proxy_url: string; height: number }>('/timeline/proxy-level', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, height }),
    }),

  /** One batch of consecutive subtitle lines translated by the Qwen3-VL text encoder; '' marks a line it skipped. */
  translateSubtitles: (req: { lines: string[]; source_lang: string; target_lang: string }) =>
    request<{ lines: string[] }>('/subtitles/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),

  transcribeTimeline: (req: ExportPayload) =>
    request<{ job_id: string; status: string }>('/timeline/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),

  cancelTranscribe: (jobId: string) =>
    request<{ status: string }>(`/timeline/transcribe/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }),

  getTranscribeJob: (jobId: string) =>
    request<{
      id: string; status: string; progress: number; error?: string; language?: string; stage?: string;
      segments?: { start: number; end: number; text: string }[];
    }>(`/timeline/export/${encodeURIComponent(jobId)}`),

  getExportJob: (jobId: string) =>
    request<{
      id: string; status: string; progress: number;
      video_url?: string; error?: string;
    }>(`/timeline/export/${encodeURIComponent(jobId)}`),
};
