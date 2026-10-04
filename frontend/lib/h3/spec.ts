import { t } from '../i18n';
/**
 * H3 DirectorSpec — the structured shot design behind an H3 video node.
 *
 * The prompt is a product, not a source. A node's `data.prompt` is compiled from
 * this spec by `compile.ts`; nothing else writes it while `promptSource` is
 * `'director'`. That is what makes a single-field edit produce a single-field
 * change in the prompt instead of a whole-prompt rewrite.
 *
 * Design rules encoded here:
 *
 * - **Reference numbers are never stored.** `<Picture N>` / `<Video N>` / `<Audio N>`
 *   come from the live wiring order at compile time (see `H3Assets`). Storing them
 *   reproduces the failure the H3 spec warns about: omitting one connection shifts
 *   every later label, silently, with no error.
 * - **Subject numbers are never stored either.** `<Subject N>` is the index in
 *   `spec.subjects`. Free text refers to a subject by `{s:<subjectId>}` and to an
 *   asset by `{a:<nodeId>}`, so reordering either one rewrites the prose too.
 * - **Camera is a token, not prose.** `CameraToken` is the closed set H3 accepts;
 *   the compiler turns it into the documented in-sentence English form.
 */

/* ────────────────────────────────────────────────────────────────────────── *
 * Closed vocabularies
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The camera vocabulary H3 actually resolves. Prose describing a move is
 * unreliable; these tokens are not. Before concluding a move "does not work",
 * check the token was used.
 */
export const H3_CAMERA_TOKENS = [
  'Zoom In',
  'Zoom Out',
  'Push In',
  'Pull Out',
  'Pan Left',
  'Pan Right',
  'Truck Left',
  'Truck Right',
  'Tilt Up',
  'Tilt Down',
  'Pedestal Up',
  'Pedestal Down',
  'Arc Shot',
  'Tracking Shot',
  'Static Shot',
  'Shake Slightly',
  'Shake Strongly',
  'POV',
  'Roll Clockwise',
  'Roll Counterclockwise',
] as const;

export type CameraToken = (typeof H3_CAMERA_TOKENS)[number];

/** Chinese labels for the token grid. The token itself is what gets emitted. */
export const CAMERA_TOKEN_LABELS: Record<CameraToken, string> = {
  'Zoom In': '变焦推近',
  'Zoom Out': '变焦拉远',
  'Push In': '推镜头',
  'Pull Out': '拉镜头',
  'Pan Left': '左摇',
  'Pan Right': '右摇',
  'Truck Left': '左横移',
  'Truck Right': '右横移',
  'Tilt Up': '上仰',
  'Tilt Down': '下俯',
  'Pedestal Up': '升机位',
  'Pedestal Down': '降机位',
  'Arc Shot': '弧线环绕',
  'Tracking Shot': '跟拍',
  'Static Shot': '固定机位',
  'Shake Slightly': '轻微晃动',
  'Shake Strongly': '强烈晃动',
  POV: '主观视点',
  'Roll Clockwise': '顺时针滚转',
  'Roll Counterclockwise': '逆时针滚转',
};

/** Visible content. Inventing other values makes the line unparseable. */
export const RETENTION_MARKERS = [
  'fully_preserved',
  'partially_preserved',
  'attribute_transfer',
  'weak_reference',
] as const;

export type RetentionMarker = (typeof RETENTION_MARKERS)[number];

/** Audio labels use their own closed set. */
export const AUDIO_RETENTION_MARKERS = [
  'fully_copy',
  'partially_copy',
  'reference',
  'weak_reference',
] as const;

export type AudioRetentionMarker = (typeof AUDIO_RETENTION_MARKERS)[number];

export type H3Mode = 'ref2va' | 't2va' | 'i2va' | 'fl2va' | 'l2va';

/** Reference-role marker that prefixes `summary`. */
export const H3_TASK_TYPES = [
  '[reference generation]',
  '[video editing]',
  '[video editing + reference generation]',
  '[video editing + reference generation + audio reuse]',
  '[continuation]',
] as const;

export type H3TaskType = (typeof H3_TASK_TYPES)[number];

/* ────────────────────────────────────────────────────────────────────────── *
 * Frame grid
 * ────────────────────────────────────────────────────────────────────────── */

/** Frame counts must land on 17k+5. 124 @ 24fps = 5.17s is the practical minimum. */
export const H3_FRAME_GRID: number[] = Array.from({ length: 19 }, (_, i) => 17 * (i + 7) + 5);

export function isOnFrameGrid(frames: number): boolean {
  return H3_FRAME_GRID.includes(frames);
}

export function snapToFrameGrid(frames: number): number {
  return H3_FRAME_GRID.reduce((best, n) =>
    Math.abs(n - frames) < Math.abs(best - frames) ? n : best,
  );
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Live wiring — the only source of reference numbers
 * ────────────────────────────────────────────────────────────────────────── */

export interface H3AssetRef {
  nodeId: string;
  /** Display-only, for the console. Never emitted into the prompt. */
  alias?: string;
}

/**
 * What is connected to the node right now, in wiring order. `<Picture N>` is
 * `images[N-1]`, and so on. Passed to the compiler, never stored on the spec.
 */
export interface H3Assets {
  images: H3AssetRef[];
  videos: H3AssetRef[];
  audios: H3AssetRef[];
  /** Total frames for the batch; used for the base-mode alignment headers. */
  totalFrames: number;
  fps: number;
}

export function emptyAssets(overrides: Partial<H3Assets> = {}): H3Assets {
  return { images: [], videos: [], audios: [], totalFrames: 124, fps: 24, ...overrides };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Spec
 * ────────────────────────────────────────────────────────────────────────── */

export type SubjectKind = 'person' | 'environment' | 'prop' | 'motion' | 'effect';

export interface H3Subject {
  id: string;
  kind: SubjectKind;
  /**
   * The connected asset that defines this subject, if any. Resolved to
   * `<Picture N>` / `<Video N>` at compile time.
   */
  sourceNodeId?: string | null;
  /**
   * One line, English, stating what the label denotes and the features to follow.
   * Write `{ref}` where the source asset should be cited — an image that only
   * defines a subject is cited *inside* that subject, never given a standalone
   * entry.
   *
   * Minimum critical anchors only. The reference image is the source of truth for
   * face, body, costume and texture; do not overwrite it with prose.
   */
  definition: string;
  retention: RetentionMarker;
  retentionNote: string;
  /** Shot indices (1-based), used only to scope retention after prose actually references it. */
  appearsIn: number[];
}

/**
 * A standalone `<Picture N>` / `<Video N>` / `<Audio N>` entry — reserved for a
 * first frame, keyframe, last frame, composition anchor, edit source or
 * continuation point. An asset that merely defines a scene belongs inside its
 * subject instead.
 */
export interface H3AssetDeclaration {
  nodeId: string;
  /** Predicate completing `<Video 1> `, e.g. "is the source video for the target video edit." */
  role: string;
  /** Parenthesised scope in retention_analysis, e.g. "cut and pacing structure". */
  scope: string;
  retention: RetentionMarker | AudioRetentionMarker;
  retentionNote: string;
}

export interface H3CameraMove {
  token: CameraToken;
  amplitude: 'small' | 'large';
  speed: 'slow' | 'fast';
}

export interface H3Camera extends H3CameraMove {
  /** Whether this shot explicitly specifies camera movement. Defaults to true. */
  enabled?: boolean;
  /** Explicitly state that the described motion is continuous, not an edit. */
  notACut?: boolean;
  /** Continue the preceding shot's camera path; not an H3 token of its own. */
  continuesPrevious?: boolean;
  /** What the move is on. A named move still needs a subject, a start and an end. */
  subject: string;
  from: string;
  to: string;
  /** At most one subtle secondary move. */
  secondary?: H3CameraMove | null;
}

export interface H3DialogueLine {
  /** Subject id of the speaker. */
  subjectId: string;
  /**
   * How the line is delivered — voice timbre, tone, pace, accent, or an
   * off-screen voiceover marker. Everything outside `<d>` belongs here;
   * `<d>` carries the words alone.
   *
   * Completes `says `, e.g. "in a low, tight voice with a clipped pace".
   * A speaker's first line is where the model fixes the voice for the whole
   * batch: left empty there, timbre drifts between shots.
   */
  delivery: string;
  /** Language tag inside `<d>[…]…</d>`, e.g. "Chinese". */
  lang: string;
  line: string;
}

export function createDialogueLine(
  overrides: Partial<H3DialogueLine> = {},
): H3DialogueLine {
  return { subjectId: '', delivery: '', lang: 'Chinese', line: '', ...overrides };
}

export interface H3Shot {
  id: string;
  /** False keeps the shot editable but excludes it from the next generation. */
  enabled?: boolean;
  /**
   * This shot's share of the batch. Cut timings are derived from the running total,
   * so a cut and the frames on either side of it can never disagree.
   */
  frames: number;
  /**
   * Who occupies the first frame and where. The highest-risk frame: unstated, the
   * model opens on an empty room or a decorative establishing beat. First shot only.
   */
  firstFrameOccupancy?: string;
  /** Measurable positions. World direction first, then screen direction, both written. */
  blocking: string;
  /** Phrased as composition (things lying on one line across the frame), not orientation. */
  sightLine: string;
  camera: H3Camera;
  /** Three depth layers with distinct jobs and distinct appearances. */
  layers: { foreground: string; midground: string; background: string };
  /** Causal, material motion. An impact is two events, never one. */
  action: string;
  lighting: { sourceCount: number; description: string };
  /** Diegetic sound tied to visible causes in this shot. */
  diegetic: string;
  /** Empty = silent; the compiler states that explicitly, once, for the whole batch. */
  dialogue: H3DialogueLine[];
}

export interface H3DirectorSpec {
  version: 1;
  mode: H3Mode;
  taskType: H3TaskType;
  subjects: H3Subject[];
  assetDeclarations: H3AssetDeclaration[];
  /** One or two sentences on what happens in this batch. No prior-scene recap. */
  summary: string;
  /** Leading style/world block. Constant scene description belongs here, not on one shot. */
  world: string;
  shots: H3Shot[];
  sound: { soundscape: string; music: string };
  /** Escape hatch: hand-written prompt. The compiler steps aside entirely. */
  rawOverride?: string;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Factories
 * ────────────────────────────────────────────────────────────────────────── */

let seq = 0;

/** Deterministic within a session; ids are local to one spec. */
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}${seq}`;
}

export function createSubject(overrides: Partial<H3Subject> = {}): H3Subject {
  return {
    id: nextId('sub'),
    kind: 'person',
    sourceNodeId: null,
    definition: '',
    retention: 'fully_preserved',
    retentionNote: '',
    appearsIn: [],
    ...overrides,
  };
}

export function createShot(overrides: Partial<H3Shot> = {}): H3Shot {
  return {
    id: nextId('shot'),
    enabled: true,
    frames: 124,
    firstFrameOccupancy: '',
    blocking: '',
    sightLine: '',
    camera: {
      token: 'Static Shot',
      amplitude: 'small',
      speed: 'slow',
      subject: '',
      from: '',
      to: '',
      secondary: null,
    },
    layers: { foreground: '', midground: '', background: '' },
    action: '',
    lighting: { sourceCount: 1, description: '' },
    diegetic: '',
    dialogue: [],
    ...overrides,
  };
}

export function createSpec(overrides: Partial<H3DirectorSpec> = {}): H3DirectorSpec {
  return {
    version: 1,
    mode: 'ref2va',
    taskType: '[reference generation]',
    subjects: [],
    assetDeclarations: [],
    summary: '',
    world: '',
    shots: [createShot()],
    sound: { soundscape: '', music: '' },
    ...overrides,
  };
}

/** True when the spec has nothing worth compiling yet. */
export function isSpecEmpty(spec: H3DirectorSpec | null | undefined): boolean {
  if (!spec) return true;
  if (spec.rawOverride?.trim()) return false;
  if (spec.subjects.length > 0 || spec.summary.trim() || spec.world.trim()) return false;
  return spec.shots.every(
    (s) => !s.blocking.trim() && !s.action.trim() && !s.firstFrameOccupancy?.trim(),
  );
}
