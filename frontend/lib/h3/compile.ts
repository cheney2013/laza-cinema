/**
 * Deterministic H3 prompt compiler.
 *
 * `compileDirectorSpec(spec, assets)` is the only producer of a director-mode
 * node's `data.prompt`. It is a pure template: the same spec and the same wiring
 * always yield the same bytes, so a one-field edit is a one-field diff and an LLM
 * never gets to rewrite the parts nobody touched.
 *
 * Output format follows the official MiniMax H3 specification, and the base-mode
 * alignment headers are kept byte-identical to `backend/h3_prompt_builder.py` so
 * the backend fallback speaks the same dialect.
 */

import type {
  CameraToken,
  H3Assets,
  H3AssetDeclaration,
  H3Camera,
  H3CameraMove,
  H3DirectorSpec,
  H3Mode,
  H3Shot,
  H3Subject,
} from './spec';
import { t } from '../i18n';

export interface CompileWarning {
  code:
    | 'unresolved-token'
    | 'missing-ref'
    | 'ref-placeholder-missing'
    | 'orphan-declaration';
  severity: 'error' | 'warning';
  message: string;
  subjectId?: string;
  shotId?: string;
}

export interface CompileResult {
  prompt: string;
  mode: H3Mode;
  warnings: CompileWarning[];
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Label resolution — wiring order is the only authority
 * ────────────────────────────────────────────────────────────────────────── */

type LabelMap = Map<string, string>;

function buildLabelMap(assets: H3Assets): LabelMap {
  const map: LabelMap = new Map();
  assets.images.forEach((a, i) => map.set(a.nodeId, `<Picture ${i + 1}>`));
  assets.videos.forEach((a, i) => map.set(a.nodeId, `<Video ${i + 1}>`));
  assets.audios.forEach((a, i) => map.set(a.nodeId, `<Audio ${i + 1}>`));
  return map;
}

function buildSubjectMap(spec: H3DirectorSpec): LabelMap {
  const map: LabelMap = new Map();
  spec.subjects.forEach((s, i) => map.set(s.id, `<Subject ${i + 1}>`));
  return map;
}

const TOKEN_RE = /\{([sa]):([^}]+)\}/g;

function collectSubjectTokens(text: string, into: Set<string>): void {
  if (!text) return;
  for (const match of text.matchAll(/\{s:([^}]+)\}/g)) into.add(match[1]);
}

/**
 * Subject cards are an editing library, not automatically part of the generated
 * scene. Root the final list in prose and dialogue that H3 will actually receive,
 * then retain any subjects referenced by those subjects' definitions. This keeps
 * unused cards out of both subject_definitions and retention_analysis.
 */
function subjectsUsedByPrompt(spec: H3DirectorSpec): H3Subject[] {
  const used = new Set<string>();
  collectSubjectTokens(spec.world, used);
  collectSubjectTokens(spec.summary, used);
  collectSubjectTokens(spec.sound.soundscape, used);
  collectSubjectTokens(spec.sound.music, used);

  for (const shot of spec.shots) {
    collectSubjectTokens(shot.firstFrameOccupancy || '', used);
    collectSubjectTokens(shot.blocking, used);
    collectSubjectTokens(shot.sightLine, used);
    collectSubjectTokens(shot.camera.subject, used);
    collectSubjectTokens(shot.camera.from, used);
    collectSubjectTokens(shot.camera.to, used);
    collectSubjectTokens(shot.layers.foreground, used);
    collectSubjectTokens(shot.layers.midground, used);
    collectSubjectTokens(shot.layers.background, used);
    collectSubjectTokens(shot.action, used);
    collectSubjectTokens(shot.lighting.description, used);
    collectSubjectTokens(shot.diegetic, used);
    for (const dialogue of shot.dialogue) {
      if (dialogue.subjectId) used.add(dialogue.subjectId);
      collectSubjectTokens(dialogue.delivery, used);
      collectSubjectTokens(dialogue.line, used);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const subject of spec.subjects) {
      if (!used.has(subject.id)) continue;
      const before = used.size;
      collectSubjectTokens(subject.definition, used);
      collectSubjectTokens(subject.retentionNote, used);
      changed ||= used.size !== before;
    }
  }

  return spec.subjects.filter((subject) => used.has(subject.id));
}

/**
 * Replace `{s:<subjectId>}` and `{a:<nodeId>}` with their current labels.
 *
 * An unresolved token is left in place verbatim and reported as an error. Visible
 * garbage that the QA panel blocks beats a sentence quietly losing its subject.
 */
function resolveTokens(
  text: string,
  subjects: LabelMap,
  assets: LabelMap,
  warnings: CompileWarning[],
  where: { subjectId?: string; shotId?: string } = {},
): string {
  if (!text) return '';
  return text.replace(TOKEN_RE, (raw, kind: string, id: string) => {
    const label = kind === 's' ? subjects.get(id) : assets.get(id);
    if (label) return label;
    warnings.push({
      code: 'unresolved-token',
      severity: 'error',
      message: t('未解析的引用 {v1}：{v2}已不存在或已断开连接', { v1: raw, v2: kind === 's' ? t('该主体') : t('该资产') }),
      ...where,
    });
    return raw;
  });
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Text helpers
 * ────────────────────────────────────────────────────────────────────────── */

const SENTENCE_END = /[.!?…:;"')\]]$/;

/** Give an author-written fragment a terminator so joined sentences stay readable. */
function endSentence(text: string): string {
  const t = text.trim();
  if (!t) return '';
  return SENTENCE_END.test(t) ? t : `${t}.`;
}

function joinSentences(parts: (string | null | undefined)[]): string {
  return parts
    .map((p) => (p ? endSentence(p) : ''))
    .filter(Boolean)
    .join(' ');
}

function lines(parts: (string | null | undefined)[]): string {
  return parts.map((p) => (p ? p.trim() : '')).filter(Boolean).join('\n');
}

/** `00:01.200` — the form the shot body and RULES both use. */
export function formatTimecode(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const millis = total % 1000;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(
    millis,
  ).padStart(3, '0')}`;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Camera — token in, documented English out
 * ────────────────────────────────────────────────────────────────────────── */

const CAMERA_VERBS: Record<CameraToken, string> = {
  'Zoom In': 'zooms in',
  'Zoom Out': 'zooms out',
  'Push In': 'pushes in',
  'Pull Out': 'pulls out',
  'Pan Left': 'pans left',
  'Pan Right': 'pans right',
  'Truck Left': 'trucks left',
  'Truck Right': 'trucks right',
  'Tilt Up': 'tilts up',
  'Tilt Down': 'tilts down',
  'Pedestal Up': 'pedestals up',
  'Pedestal Down': 'pedestals down',
  'Arc Shot': 'arcs',
  'Tracking Shot': 'tracks',
  'Static Shot': 'holds still',
  'Shake Slightly': 'shakes slightly',
  'Shake Strongly': 'shakes strongly',
  POV: 'takes the point of view',
  'Roll Clockwise': 'rolls clockwise',
  'Roll Counterclockwise': 'rolls counterclockwise',
};

const CAMERA_PREPOSITIONS: Partial<Record<CameraToken, string>> = {
  'Zoom In': 'toward',
  'Push In': 'toward',
  'Zoom Out': 'away from',
  'Pull Out': 'away from',
  'Arc Shot': 'around',
  'Tracking Shot': 'with',
};

function moveClause(move: H3CameraMove): string {
  return `${CAMERA_VERBS[move.token]} with ${move.amplitude} amplitude at ${move.speed} speed`;
}

/**
 * Write the move inside the sentence, which is the documented form — not a
 * stacked `Push In with large amplitude,` label at the head of the shot.
 */
export function buildCameraSentence(camera: H3Camera): string {
  if (camera.enabled === false) return '';

  const subject = camera.subject.trim();
  const from = camera.from.trim();
  const to = camera.to.trim();

  let main: string;
  if (camera.token === 'Static Shot') {
    main = 'The camera is locked off on a tripod and does not move at all';
    if (subject) main += `, holding ${subject} in frame`;
  } else if (camera.token === 'POV') {
    main = subject
      ? `The shot is the point of view of ${subject}`
      : 'The shot is a first-person point of view';
  } else {
    main = `The camera ${moveClause(camera)}`;
    if (subject) {
      const prep = CAMERA_PREPOSITIONS[camera.token] ?? 'on';
      main += ` ${prep} ${subject}`;
    }
    if (from && to) main += `, moving continuously from ${from} until ${to}`;
    else if (from) main += `, beginning continuously from ${from}`;
    else if (to) main += `, continuing until ${to}`;
  }

  const secondary = camera.secondary
    ? `The camera also ${moveClause(camera.secondary)}`
    : null;

  const continuity = camera.continuesPrevious
    ? 'The camera movement continues seamlessly from the previous shot'
    : null;
  return joinSentences([continuity, main, secondary]);
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Shot body
 * ────────────────────────────────────────────────────────────────────────── */

function renderLayers(shot: H3Shot): string {
  const { foreground, midground, background } = shot.layers;
  return joinSentences([
    foreground.trim() ? `In the foreground, ${foreground.trim()}` : null,
    midground.trim() ? `In the midground, ${midground.trim()}` : null,
    background.trim() ? `In the background, ${background.trim()}` : null,
  ]);
}

function renderLighting(shot: H3Shot): string | null {
  const { sourceCount, description } = shot.lighting;
  const desc = description.trim();
  if (sourceCount <= 0) return desc || null;
  const noun = sourceCount === 1 ? 'light source' : 'light sources';
  const verb = sourceCount === 1 ? 'is' : 'are';
  const head = `There ${verb} exactly ${sourceCount} ${noun} in this shot`;
  return desc ? `${head}: ${desc.replace(/\.$/, '')}` : head;
}

/**
 * Everything about *how* a line is said stays outside `<d>`; inside it there is
 * only the language tag and the words, verbatim. The delivery clause completes
 * `says `, so a director writing "says in a low voice" and one writing "in a low
 * voice" compile to the same sentence.
 */
function renderDelivery(delivery: string): string {
  const manner = delivery
    .trim()
    .replace(/^(?:says?|said|speaks?)\s+/i, '')
    .replace(/[,.;:]+$/, '')
    .trim();
  return manner ? `says ${manner}` : 'says';
}

const VOICEOVER = /off-?screen voice-?over/i;

function renderDialogue(
  shot: H3Shot,
  speakerIds: Map<string, number>,
  subjectLabels: LabelMap,
  t: (text: string) => string,
): string | null {
  if (shot.dialogue.length === 0) return null;
  return shot.dialogue
    .map((d) => {
      const label = subjectLabels.get(d.subjectId) ?? '<Subject 1>';
      const sid = speakerIds.get(d.subjectId) ?? 1;
      const verb = renderDelivery(t(d.delivery || ''));
      // A voiceover that does not also say the lips stay shut gets lip-synced anyway.
      const lips = VOICEOVER.test(verb) ? ` while ${label}'s lips remain completely closed.` : '';
      return `${label} (S${sid}) ${verb}: <d>[${d.lang}] ${d.line.trim()}</d>${lips}`;
    })
    .join(' ');
}

function renderShot(
  shot: H3Shot,
  index: number,
  ctx: {
    subjects: LabelMap;
    assets: LabelMap;
    speakerIds: Map<string, number>;
    cutTimes: number[];
    warnings: CompileWarning[];
  },
): string {
  const where = { shotId: shot.id };
  const t = (text: string) => resolveTokens(text, ctx.subjects, ctx.assets, ctx.warnings, where);

  const cutLine = index > 0
    ? `At ${formatTimecode(ctx.cutTimes[index - 1])}, ${shot.camera.notACut ? 'not a cut' : 'the shot cuts'}`
    : null;

  const body = joinSentences([
    cutLine,
    index === 0 ? t(shot.firstFrameOccupancy || '') : null,
    t(shot.blocking),
    renderLayers({ ...shot, layers: {
      foreground: t(shot.layers.foreground),
      midground: t(shot.layers.midground),
      background: t(shot.layers.background),
    } }),
    t(shot.sightLine),
    buildCameraSentence({ ...shot.camera, subject: t(shot.camera.subject) }),
    t(shot.action),
    renderLighting({ ...shot, lighting: { ...shot.lighting, description: t(shot.lighting.description) } }),
    t(shot.diegetic),
    renderDialogue(shot, ctx.speakerIds, ctx.subjects, t),
  ]);

  return `[Shot ${index + 1}] ${body}`.trim();
}

const NO_DIALOGUE_STATEMENT =
  'There is no spoken dialogue anywhere in this video; every character stays silent with lips closed and communicates through physical movement and facial expression alone.';

function renderShots(spec: H3DirectorSpec, ctx: Parameters<typeof renderShot>[2]): string {
  const hasDialogue = spec.shots.some((s) => s.dialogue.length > 0);
  return lines([
    resolveTokens(spec.world, ctx.subjects, ctx.assets, ctx.warnings),
    ...spec.shots.map((shot, i) => renderShot(shot, i, ctx)),
    hasDialogue ? null : NO_DIALOGUE_STATEMENT,
  ]);
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Sections
 * ────────────────────────────────────────────────────────────────────────── */

function renderSubjectDefinition(
  subject: H3Subject,
  index: number,
  ctx: { subjects: LabelMap; assets: LabelMap; warnings: CompileWarning[] },
): string {
  const where = { subjectId: subject.id };
  let text = resolveTokens(subject.definition, ctx.subjects, ctx.assets, ctx.warnings, where);

  if (subject.sourceNodeId) {
    const label = ctx.assets.get(subject.sourceNodeId);
    if (!label) {
      ctx.warnings.push({
        code: 'missing-ref',
        severity: 'error',
        message: t('<Subject {v1}> 绑定的资产已断开连接，定义里没有可引用的编号', { v1: index + 1 }),
        ...where,
      });
      text = text.replace(/\{ref\}/g, '');
    } else if (text.includes('{ref}')) {
      text = text.replace(/\{ref\}/g, label);
    } else {
      ctx.warnings.push({
        code: 'ref-placeholder-missing',
        severity: 'warning',
        message: t('<Subject {v1}> 的定义里没有 {ref} 位置，引用被追加到句尾', { v1: index + 1 }),
        ...where,
      });
      text = `${text.trim().replace(/\.$/, '')}, as seen in ${label}`;
    }
  } else {
    text = text.replace(/\{ref\}/g, '');
  }

  return `<Subject ${index + 1}> ${endSentence(text.replace(/\s+/g, ' ').trim())}`;
}

function renderAssetDeclaration(
  decl: H3AssetDeclaration,
  ctx: { subjects: LabelMap; assets: LabelMap; warnings: CompileWarning[] },
): string | null {
  const label = ctx.assets.get(decl.nodeId);
  if (!label) {
    ctx.warnings.push({
      code: 'orphan-declaration',
      severity: 'error',
      message: t('有一条独立资产声明指向已断开的连接，已从提示词中略去'),
    });
    return null;
  }
  const role = resolveTokens(decl.role, ctx.subjects, ctx.assets, ctx.warnings);
  return `${label} ${endSentence(role)}`;
}

function renderRetention(
  spec: H3DirectorSpec,
  ctx: { subjects: LabelMap; assets: LabelMap; warnings: CompileWarning[] },
): string {
  const shotCount = spec.shots.length;

  const subjectLines = spec.subjects.map((s, i) => {
    const shots = (s.appearsIn.length ? s.appearsIn : spec.shots.map((_, k) => k + 1))
      .filter((n) => n >= 1 && n <= shotCount)
      .map((n) => `[Shot ${n}]`)
      .join(', ');
    const note = resolveTokens(s.retentionNote, ctx.subjects, ctx.assets, ctx.warnings, {
      subjectId: s.id,
    });
    const scope = shots ? ` (appears in ${shots})` : '';
    return `<Subject ${i + 1}>${scope}: ${s.retention}${note ? ` - ${note.trim()}` : ''}`;
  });

  const assetLines = spec.assetDeclarations.map((d) => {
    const label = ctx.assets.get(d.nodeId);
    if (!label) return null;
    const note = resolveTokens(d.retentionNote, ctx.subjects, ctx.assets, ctx.warnings);
    const scope = d.scope.trim() ? ` (${d.scope.trim()})` : '';
    return `${label}${scope}: ${d.retention}${note ? ` - ${note.trim()}` : ''}`;
  });

  return lines([...subjectLines, ...assetLines]);
}

/**
 * Where each cut falls, in ms, derived from the running frame total. One source of
 * truth: a cut is exactly the point at which one shot's frames end.
 */
export function cutTimesMs(spec: H3DirectorSpec, fps: number): number[] {
  const rate = fps || 24;
  const out: number[] = [];
  let running = 0;
  for (let i = 0; i < spec.shots.length - 1; i += 1) {
    running += spec.shots[i].frames;
    out.push(Math.round((running / rate) * 1000));
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Base-mode alignment headers
 *
 * Kept byte-identical to backend/h3_prompt_builder.py. Two dialects of the same
 * header is how a fallback path starts producing subtly different results.
 * ────────────────────────────────────────────────────────────────────────── */

function alignmentHeader(mode: H3Mode, durationSec: string): string | null {
  switch (mode) {
    case 'i2va':
      return 'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.';
    case 'fl2va':
      return `How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the ${durationSec}-second mark of the target video.`;
    case 'l2va':
      return `How the reference pictures align with the target video — <Picture 1> (from [Shot 1]) aligns with the ${durationSec}-second mark of the target video.`;
    default:
      return null;
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Entry point
 * ────────────────────────────────────────────────────────────────────────── */

export function compileDirectorSpec(spec: H3DirectorSpec, assets: H3Assets): CompileResult {
  const raw = spec.rawOverride?.trim();
  if (raw) return { prompt: raw, mode: spec.mode, warnings: [] };

  const usedSubjects = subjectsUsedByPrompt(spec);
  const compiledSpec = usedSubjects.length === spec.subjects.length
    ? spec
    : { ...spec, subjects: usedSubjects };

  const warnings: CompileWarning[] = [];
  const ctx = {
    subjects: buildSubjectMap(compiledSpec),
    assets: buildLabelMap(assets),
    warnings,
  };

  // Speaker ids are assigned in first-spoken order across the batch, so S1 stays S1
  // when a later shot's dialogue is edited.
  const speakerIds = new Map<string, number>();
  for (const shot of compiledSpec.shots) {
    for (const d of shot.dialogue) {
      if (!speakerIds.has(d.subjectId)) speakerIds.set(d.subjectId, speakerIds.size + 1);
    }
  }

  const fps = assets.fps || 24;
  const shotCtx = { ...ctx, speakerIds, cutTimes: cutTimesMs(compiledSpec, fps) };
  const body = renderShots(compiledSpec, shotCtx);
  const soundscape = resolveTokens(compiledSpec.sound.soundscape, ctx.subjects, ctx.assets, warnings).trim();
  const music = resolveTokens(
    compiledSpec.sound.music,
    ctx.subjects,
    ctx.assets,
    warnings,
  ).trim();
  const durationSec = (assets.totalFrames / fps).toFixed(2);

  let sections: string[];

  if (compiledSpec.mode === 'ref2va') {
    const definitions = lines([
      ...compiledSpec.subjects.map((s, i) => renderSubjectDefinition(s, i, ctx)),
      ...compiledSpec.assetDeclarations.map((d) => renderAssetDeclaration(d, ctx)),
    ]);
    sections = [
      `subject_definitions:\n${definitions}`,
      `summary:\n${`${compiledSpec.taskType} ${resolveTokens(compiledSpec.summary, ctx.subjects, ctx.assets, warnings)}`.trim()}`,
      `retention_analysis:\n${renderRetention(compiledSpec, ctx)}`,
      `detailed_description:\n${body}`,
      `overall_soundscape:\n${soundscape || 'N/A'}`,
      `non_diegetic_music:\n${music || 'N/A'}`,
    ];
  } else {
    const header = alignmentHeader(compiledSpec.mode, durationSec);
    sections = [
      ...(header ? [header] : []),
      `integrated_multimodal_description:\n${body}`,
      `overall_soundscape:\n${soundscape || 'N/A'}`,
      `non_diegetic_music:\n${music || 'N/A'}`,
    ];
  }

  return {
    prompt: sections.join('\n\n'),
    mode: compiledSpec.mode,
    warnings,
  };
}
