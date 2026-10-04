/**
 * Read a structured H3 prompt back into a spec.
 *
 * Used by the console's "import the existing prompt" path, so a node that was
 * written by hand (or by the old LLM compiler) can be adopted without retyping.
 *
 * What can be recovered exactly is recovered exactly: sections, subject
 * definitions, retention markers, the trailing blocks, and — for prompts this
 * compiler wrote — the camera move, back out of its sentence into a token.
 * A shot's prose cannot be decomposed into blocking / sight line / layers without
 * guessing, so it is parked in `action` intact and left for the director to split.
 * Guessing there would produce a spec that looks structured and is not.
 */

import {
  createShot,
  createSpec,
  createSubject,
  H3_CAMERA_TOKENS,
  H3_TASK_TYPES,
  RETENTION_MARKERS,
  type CameraToken,
  type H3Assets,
  type H3DirectorSpec,
  type H3Mode,
  type H3TaskType,
  type RetentionMarker,
} from './spec';
import { t } from '../i18n';

const SECTION_NAMES = [
  'subject_definitions',
  'summary',
  'retention_analysis',
  'detailed_description',
  'integrated_multimodal_description',
  'overall_soundscape',
  'non_diegetic_music',
] as const;

export interface ParseResult {
  spec: H3DirectorSpec;
  /** What could not be recovered and needs a human. */
  notes: string[];
}

export function isStructuredH3Prompt(text: string): boolean {
  const t = (text || '').toLowerCase();
  return (
    t.includes('subject_definitions:') ||
    t.includes('integrated_multimodal_description:') ||
    (t.includes('overall_soundscape:') && t.includes('non_diegetic_music:'))
  );
}

function splitSections(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = new RegExp(`^(${SECTION_NAMES.join('|')}):\\s*$`, 'gim');
  const marks: { name: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    marks.push({ name: m[1].toLowerCase(), start: m.index, end: m.index + m[0].length });
  }
  marks.forEach((mark, i) => {
    const bodyEnd = i + 1 < marks.length ? marks[i + 1].start : text.length;
    out.set(mark.name, text.slice(mark.end, bodyEnd).trim());
  });
  return out;
}

/** Everything before the first section header — the base-mode alignment line. */
function leadingHeader(text: string): string {
  const re = new RegExp(`^(${SECTION_NAMES.join('|')}):\\s*$`, 'im');
  const m = re.exec(text);
  return m ? text.slice(0, m.index).trim() : '';
}

function detectMode(text: string, sections: Map<string, string>): H3Mode {
  const header = leadingHeader(text);
  if (sections.has('subject_definitions')) return 'ref2va';
  if (/at 0\.00 seconds into the target video/i.test(header)) return 'i2va';
  if (/Picture 2 \(from Shot 1\)/i.test(header)) return 'fl2va';
  if (/aligns with the [\d.]+-second mark/i.test(header)) return 'l2va';
  return 't2va';
}

/** Undo the compiler's own camera sentence. Anything else stays prose. */
function parseCameraSentence(body: string): {
  camera: ReturnType<typeof createShot>['camera'] | null;
  rest: string;
} {
  const locked = /The camera is locked off on a tripod and does not move at all(?:, holding ([^.]+) in frame)?\./;
  const lockedMatch = body.match(locked);
  if (lockedMatch) {
    return {
      camera: {
        token: 'Static Shot',
        amplitude: 'small',
        speed: 'slow',
        subject: lockedMatch[1]?.trim() || '',
        from: '',
        to: '',
        secondary: null,
      },
      rest: body.replace(locked, '').trim(),
    };
  }

  const verbs = H3_CAMERA_TOKENS.map((t) => t.toLowerCase());
  const re =
    /The camera ([a-z]+(?: [a-z]+)?) with (small|large) amplitude at (slow|fast) speed(?: (?:toward|away from|around|with|on) ([^,.]+))?(?:, (?:(?:starting on ([^,]+?)(?: and ending on ([^.]+))?)|(?:moving continuously from ([^,]+?) until ([^.]+))|(?:beginning continuously from ([^.]+))|(?:continuing until ([^.]+))))?\./i;
  const m = body.match(re);
  if (!m) return { camera: null, rest: body };

  const phrase = m[1].toLowerCase();
  const token = H3_CAMERA_TOKENS.find((t) => {
    const head = t.toLowerCase().split(' ')[0];
    return phrase.startsWith(head.replace(/e?$/, '')) || phrase === t.toLowerCase();
  });
  if (!token || !verbs.length) return { camera: null, rest: body };

  return {
    camera: {
      token: token as CameraToken,
      amplitude: m[2] as 'small' | 'large',
      speed: m[3] as 'slow' | 'fast',
      subject: (m[4] || '').trim(),
      from: (m[5] || m[7] || m[9] || '').trim(),
      to: (m[6] || m[8] || m[10] || '').trim(),
      secondary: null,
    },
    rest: body.replace(re, '').trim(),
  };
}

/** Turn emitted labels back into placeholders so reordering keeps working. */
export function toPlaceholders(text: string, assets: H3Assets, subjectIds: string[]): string {
  return text
    .replace(/<Subject (\d+)>/g, (raw, n) => subjectIds[Number(n) - 1] ? `{s:${subjectIds[Number(n) - 1]}}` : raw)
    .replace(/<Picture (\d+)>/g, (raw, n) => {
      const a = assets.images[Number(n) - 1];
      return a ? `{a:${a.nodeId}}` : raw;
    })
    .replace(/<Video (\d+)>/g, (raw, n) => {
      const a = assets.videos[Number(n) - 1];
      return a ? `{a:${a.nodeId}}` : raw;
    })
    .replace(/<Audio (\d+)>/g, (raw, n) => {
      const a = assets.audios[Number(n) - 1];
      return a ? `{a:${a.nodeId}}` : raw;
    });
}

export function parseH3Prompt(text: string, assets: H3Assets): ParseResult {
  const notes: string[] = [];
  const raw = (text || '').trim();
  if (!isStructuredH3Prompt(raw)) {
    return {
      spec: createSpec({ rawOverride: raw }),
      notes: [t('这不是结构化的 H3 提示词，已整段放进手写覆盖，导演台的字段规则对它不生效。')],
    };
  }

  const sections = splitSections(raw);
  const mode = detectMode(raw, sections);

  // ── subjects ────────────────────────────────────────────────────────────
  const subjects: ReturnType<typeof createSubject>[] = [];
  const defs = sections.get('subject_definitions') || '';
  for (const line of defs.split('\n')) {
    const m = line.match(/^<Subject (\d+)>\s*(.*)$/);
    if (!m) continue;
    subjects.push(createSubject({ definition: m[2].trim(), appearsIn: [] }));
  }
  const subjectIds = subjects.map((s) => s.id);

  // Bind each subject to the picture its own definition cites, and turn that
  // citation into {ref} so the number stops being stored in prose.
  subjects.forEach((s) => {
    const cite = s.definition.match(/<Picture (\d+)>/);
    if (!cite) return;
    const asset = assets.images[Number(cite[1]) - 1];
    if (!asset) return;
    s.sourceNodeId = asset.nodeId;
    s.definition = s.definition.replace(cite[0], '{ref}');
  });
  subjects.forEach((s) => {
    s.definition = toPlaceholders(s.definition, assets, subjectIds);
  });

  // ── retention ───────────────────────────────────────────────────────────
  const retention = sections.get('retention_analysis') || '';
  for (const line of retention.split('\n')) {
    const m = line.match(/^<Subject (\d+)>([^:]*):\s*([a-z_]+)\s*(?:-\s*(.*))?$/);
    if (!m) continue;
    const subject = subjects[Number(m[1]) - 1];
    if (!subject) continue;
    if ((RETENTION_MARKERS as readonly string[]).includes(m[3])) {
      subject.retention = m[3] as RetentionMarker;
    } else {
      notes.push(t('保留标记「{v1}」不在闭集内，已回落为 fully_preserved。', { v1: m[3] }));
    }
    subject.retentionNote = toPlaceholders((m[4] || '').trim(), assets, subjectIds);
    const shots = [...(m[2] || '').matchAll(/\[Shot (\d+)\]/g)].map((x) => Number(x[1]));
    subject.appearsIn = shots;
  }

  // ── summary ─────────────────────────────────────────────────────────────
  const summaryRaw = (sections.get('summary') || '').trim();
  const taskMatch = summaryRaw.match(/^(\[[^\]]+\])\s*/);
  const taskType = (
    taskMatch && (H3_TASK_TYPES as readonly string[]).includes(taskMatch[1])
      ? taskMatch[1]
      : '[reference generation]'
  ) as H3TaskType;
  if (taskMatch && taskType !== taskMatch[1]) {
    notes.push(t('任务类型「{v1}」不在预设里，已回落为 {v2}。', { v1: taskMatch[1], v2: taskType }));
  }
  const summary = toPlaceholders(summaryRaw.replace(/^\[[^\]]+\]\s*/, ''), assets, subjectIds);

  // ── body ────────────────────────────────────────────────────────────────
  const body =
    sections.get('detailed_description') || sections.get('integrated_multimodal_description') || '';
  const bodyLines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  const worldLines: string[] = [];
  const shotChunks: string[] = [];
  for (const line of bodyLines) {
    if (/^\[Shot \d+\]/.test(line)) shotChunks.push(line);
    else if (shotChunks.length === 0) worldLines.push(line);
    else if (!/^There is no spoken dialogue/i.test(line)) {
      shotChunks[shotChunks.length - 1] += ` ${line}`;
    }
  }

  const shots = (shotChunks.length ? shotChunks : ['']).map((chunk) => {
    const text = chunk.replace(/^\[Shot \d+\]\s*/, '').replace(/^At \d\d:\d\d\.\d\d\d, the shot cuts\.\s*/, '');
    const { camera, rest } = parseCameraSentence(text);
    return createShot({
      action: toPlaceholders(rest, assets, subjectIds),
      ...(camera ? { camera } : {}),
    });
  });
  if (shotChunks.length > 0) {
    notes.push(
      t('{v1} 个镜头的正文整段放进了「动作」字段——散文没法可靠地拆成调度/视线/景深层，拆分留给你做。', { v1: shots.length }),
    );
  }

  // ── frames ──────────────────────────────────────────────────────────────
  const each = Math.floor(assets.totalFrames / shots.length);
  shots.forEach((s, i) => {
    s.frames = i === shots.length - 1 ? assets.totalFrames - each * (shots.length - 1) : each;
  });

  const soundscape = (sections.get('overall_soundscape') || '').trim();
  const music = (sections.get('non_diegetic_music') || '').trim();

  return {
    spec: createSpec({
      mode,
      taskType,
      subjects,
      summary,
      world: toPlaceholders(worldLines.join(' '), assets, subjectIds),
      shots,
      sound: {
        soundscape: soundscape === 'N/A' ? '' : toPlaceholders(soundscape, assets, subjectIds),
        music: music === 'N/A' ? '' : music,
      },
    }),
    notes,
  };
}
