/**
 * Turn a model's draft JSON into a spec, or refuse.
 *
 * The draft endpoint is the one place an LLM fills more than a single field, and
 * it is allowed there only because what it fills is a *spec* — every value lands
 * in a typed slot the director can see and change, and nothing reaches the prompt
 * without going through the compiler.
 *
 * Validation is strict on purpose. A best-effort parse that silently drops a
 * malformed shot, or keeps an invented retention marker, produces a spec that
 * looks structured and is not — which is worse than an error, because the console
 * will then show it as if a human had written it.
 */

import { toPlaceholders } from './parse';
import {
  createShot,
  createSpec,
  createSubject,
  H3_CAMERA_TOKENS,
  H3_TASK_TYPES,
  RETENTION_MARKERS,
  snapToFrameGrid,
  type CameraToken,
  type H3Assets,
  type H3DirectorSpec,
  type H3Mode,
  type H3Subject,
  type H3TaskType,
  type RetentionMarker,
  type SubjectKind,
} from './spec';
import { t } from '../i18n';

export class DraftError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(t('草稿不符合 schema：{v1}', { v1: problems.join('；') }));
    this.name = 'DraftError';
    this.problems = problems;
  }
}

const SUBJECT_KINDS: SubjectKind[] = ['person', 'environment', 'prop', 'motion', 'effect'];

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function intOr(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

/**
 * The shape the draft endpoint is asked for. Kept loose here and tightened by
 * `specFromDraft`, so a model that adds a field is not a hard failure but a model
 * that omits a required one is.
 */
export interface DraftJson {
  taskType?: string;
  summary?: string;
  world?: string;
  subjects?: unknown[];
  shots?: unknown[];
  sound?: { soundscape?: string; music?: string };
}

export interface DraftResult {
  spec: H3DirectorSpec;
  /** Things that were corrected rather than rejected. */
  notes: string[];
}

export function specFromDraft(
  raw: unknown,
  assets: H3Assets,
  mode: H3Mode = 'ref2va',
): DraftResult {
  const problems: string[] = [];
  const notes: string[] = [];

  if (!raw || typeof raw !== 'object') throw new DraftError([t('返回的不是一个 JSON 对象')]);
  const draft = raw as DraftJson;

  const shotsRaw = Array.isArray(draft.shots) ? draft.shots : [];
  if (shotsRaw.length === 0) problems.push(t('shots 为空'));

  const subjectsRaw = Array.isArray(draft.subjects) ? draft.subjects : [];
  if (mode === 'ref2va' && subjectsRaw.length === 0) problems.push(t('Ref2VA 至少要有一个 subject'));

  if (problems.length) throw new DraftError(problems);

  // ── subjects ────────────────────────────────────────────────────────────
  const subjects: H3Subject[] = subjectsRaw.map((item, i) => {
    const s = (item || {}) as Record<string, unknown>;
    const definition = str(s.definition);
    if (!definition) problems.push(t('subjects[{v1}].definition 为空', { v1: i }));

    const kind = SUBJECT_KINDS.includes(s.kind as SubjectKind)
      ? (s.kind as SubjectKind)
      : 'person';
    if (s.kind && kind !== s.kind) notes.push(t('subjects[{v1}] 的类型「{v2}」不认识，按 person 处理。', { v1: i, v2: String(s.kind) }));

    const retention = (RETENTION_MARKERS as readonly string[]).includes(str(s.retention))
      ? (str(s.retention) as RetentionMarker)
      : 'fully_preserved';
    if (s.retention && retention !== s.retention) {
      notes.push(t('subjects[{v1}] 的保留标记「{v2}」不在闭集内，按 fully_preserved 处理。', { v1: i, v2: String(s.retention) }));
    }

    // The model cites `<Picture N>`; N is an index into the live wiring.
    const pictureNo = intOr(s.picture, 0);
    const asset = pictureNo > 0 ? assets.images[pictureNo - 1] : undefined;
    if (pictureNo > 0 && !asset) {
      notes.push(t('subjects[{v1}] 引用了 <Picture {v2}>，但只连了 {v3} 张图，该绑定已丢弃。', { v1: i, v2: pictureNo, v3: assets.images.length }));
    }

    return createSubject({
      kind,
      definition,
      retention,
      retentionNote: str(s.retentionNote),
      sourceNodeId: asset?.nodeId ?? null,
      appearsIn: Array.isArray(s.appearsIn)
        ? (s.appearsIn as unknown[]).map((n) => intOr(n, 0)).filter((n) => n > 0)
        : [],
    });
  });

  const subjectIds = subjects.map((s) => s.id);
  const place = (text: string) => toPlaceholders(text, assets, subjectIds);

  subjects.forEach((s) => {
    // A subject's own picture is cited as {ref}; everything else addresses by id.
    if (s.sourceNodeId) {
      const label = assets.images.findIndex((a) => a.nodeId === s.sourceNodeId) + 1;
      s.definition = s.definition.replace(new RegExp(`<Picture ${label}>`, 'g'), '{ref}');
    }
    s.definition = place(s.definition);
    s.retentionNote = place(s.retentionNote);
  });

  // ── shots ───────────────────────────────────────────────────────────────
  const shots = shotsRaw.map((item, i) => {
    const sh = (item || {}) as Record<string, unknown>;
    const cam = (sh.camera || {}) as Record<string, unknown>;

    const token = (H3_CAMERA_TOKENS as readonly string[]).includes(str(cam.token))
      ? (str(cam.token) as CameraToken)
      : 'Static Shot';
    if (cam.token && token !== cam.token) {
      notes.push(t('shots[{v1}] 的运镜「{v2}」不在闭集内，按 Static Shot 处理。', { v1: i, v2: String(cam.token) }));
    }

    const layers = (sh.layers || {}) as Record<string, unknown>;
    const lighting = (sh.lighting || {}) as Record<string, unknown>;
    const dialogue = Array.isArray(sh.dialogue) ? sh.dialogue : [];

    return createShot({
      frames: intOr(sh.frames, 0),
      firstFrameOccupancy: place(str(sh.firstFrameOccupancy)),
      blocking: place(str(sh.blocking)),
      sightLine: place(str(sh.sightLine)),
      action: place(str(sh.action)),
      diegetic: place(str(sh.diegetic)),
      camera: {
        token,
        amplitude: str(cam.amplitude) === 'large' ? 'large' : 'small',
        speed: str(cam.speed) === 'fast' ? 'fast' : 'slow',
        subject: place(str(cam.subject)),
        from: str(cam.from),
        to: str(cam.to),
        secondary: null,
      },
      layers: {
        foreground: place(str(layers.foreground)),
        midground: place(str(layers.midground)),
        background: place(str(layers.background)),
      },
      lighting: {
        sourceCount: Math.max(0, intOr(lighting.sourceCount, 1)),
        description: place(str(lighting.description)),
      },
      dialogue: dialogue
        .map((d) => {
          const line = (d || {}) as Record<string, unknown>;
          const idx = intOr(line.subject, 0);
          const speaker = subjects[idx - 1];
          if (!speaker || !str(line.line)) return null;
          return {
            subjectId: speaker.id,
            delivery: place(str(line.delivery)),
            lang: str(line.lang) || 'Chinese',
            line: str(line.line),
          };
        })
        .filter((d): d is NonNullable<typeof d> => d != null),
    });
  });

  if (problems.length) throw new DraftError(problems);

  // The batch length is the node's, not the model's. Shot frames are rescaled to
  // fit it rather than silently changing how long the generation runs.
  const total = snapToFrameGrid(assets.totalFrames);
  const drafted = shots.reduce((a, s) => a + Math.max(0, s.frames), 0);
  if (drafted !== total) {
    if (drafted > 0) {
      let used = 0;
      shots.forEach((s, i) => {
        if (i === shots.length - 1) s.frames = total - used;
        else {
          s.frames = Math.max(1, Math.round((Math.max(0, s.frames) / drafted) * total));
          used += s.frames;
        }
      });
      notes.push(t('分镜帧数按本批的 {v1} 帧等比重算过。', { v1: total }));
    } else {
      const each = Math.floor(total / shots.length);
      shots.forEach((s, i) => {
        s.frames = i === shots.length - 1 ? total - each * (shots.length - 1) : each;
      });
      notes.push(t('草稿没给帧数，已按镜头数均分 {v1} 帧。', { v1: total }));
    }
  }

  const taskType = (H3_TASK_TYPES as readonly string[]).includes(str(draft.taskType))
    ? (str(draft.taskType) as H3TaskType)
    : '[reference generation]';

  return {
    spec: createSpec({
      mode,
      taskType,
      subjects,
      shots,
      summary: place(str(draft.summary)),
      world: place(str(draft.world)),
      sound: {
        soundscape: place(str(draft.sound?.soundscape)),
        music: str(draft.sound?.music) === 'N/A' ? '' : str(draft.sound?.music),
      },
    }),
    notes,
  };
}

/**
 * Merge a draft into an existing spec, filling only what is still empty.
 *
 * The default for a spec that already has work in it: a draft must not overwrite
 * fields a director has already tuned. Overwriting is possible, but it is an
 * explicit choice made per field in the console, not a side effect of asking for
 * a draft.
 */
export function mergeDraftIntoEmpty(
  current: H3DirectorSpec,
  drafted: H3DirectorSpec,
): H3DirectorSpec {
  const keep = (a: string, b: string) => (a.trim() ? a : b);
  const next: H3DirectorSpec = structuredClone(current);

  next.summary = keep(next.summary, drafted.summary);
  next.world = keep(next.world, drafted.world);
  next.sound.soundscape = keep(next.sound.soundscape, drafted.sound.soundscape);
  next.sound.music = keep(next.sound.music, drafted.sound.music);
  if (next.subjects.length === 0) next.subjects = drafted.subjects;

  next.shots = next.shots.map((shot, i) => {
    const from = drafted.shots[i];
    if (!from) return shot;
    return {
      ...shot,
      firstFrameOccupancy: keep(shot.firstFrameOccupancy || '', from.firstFrameOccupancy || ''),
      blocking: keep(shot.blocking, from.blocking),
      sightLine: keep(shot.sightLine, from.sightLine),
      action: keep(shot.action, from.action),
      diegetic: keep(shot.diegetic, from.diegetic),
      layers: {
        foreground: keep(shot.layers.foreground, from.layers.foreground),
        midground: keep(shot.layers.midground, from.layers.midground),
        background: keep(shot.layers.background, from.layers.background),
      },
      lighting: {
        sourceCount: shot.lighting.sourceCount,
        description: keep(shot.lighting.description, from.lighting.description),
      },
      camera: shot.camera.token === 'Static Shot' && !shot.camera.subject ? from.camera : shot.camera,
      dialogue: shot.dialogue.length ? shot.dialogue : from.dialogue,
    };
  });

  if (drafted.shots.length > next.shots.length) {
    next.shots.push(...drafted.shots.slice(next.shots.length));
  }

  return next;
}
