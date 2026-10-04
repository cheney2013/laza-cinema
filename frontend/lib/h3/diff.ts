/**
 * Field-level diffing.
 *
 * Two uses, both the same idea: show what a change actually changes, before it is
 * accepted. An LLM suggestion is previewed as one field's before/after plus the
 * exact prompt lines it will move; a pair of takes is compared as a list of
 * changed fields rather than two walls of prose. Diffing the prose is what makes
 * "which edit caused this" unanswerable in the first place.
 */

import type { H3DirectorSpec, H3Shot, H3Subject } from './spec';
import { t } from '../i18n';

export interface SpecChange {
  path: string;
  /** Field name for the console, already in the interface language. */
  label: string;
  before: string;
  after: string;
}

function push(out: SpecChange[], path: string, label: string, before: unknown, after: unknown): void {
  const b = before == null ? '' : String(before);
  const a = after == null ? '' : String(after);
  if (b === a) return;
  out.push({ path, label, before: b, after: a });
}

function subjectChanges(out: SpecChange[], i: number, before?: H3Subject, after?: H3Subject): void {
  const at = `<Subject ${i + 1}>`;
  if (!before) {
    push(out, `subjects.${i}`, `${at} ${t(t('新增'))}`, '', after?.definition ?? '');
    return;
  }
  if (!after) {
    push(out, `subjects.${i}`, `${at} ${t(t('删除'))}`, before.definition, '');
    return;
  }
  push(out, `subjects.${i}.definition`, `${at} ${t(t('定义'))}`, before.definition, after.definition);
  push(out, `subjects.${i}.kind`, `${at} ${t(t('类型'))}`, before.kind, after.kind);
  push(out, `subjects.${i}.retention`, `${at} ${t(t('保留标记'))}`, before.retention, after.retention);
  push(out, `subjects.${i}.retentionNote`, `${at} ${t(t('保留说明'))}`, before.retentionNote, after.retentionNote);
  push(out, `subjects.${i}.sourceNodeId`, `${at} ${t(t('绑定资产'))}`, before.sourceNodeId, after.sourceNodeId);
  push(
    out,
    `subjects.${i}.appearsIn`,
    `${at} ${t(t('出现镜头'))}`,
    before.appearsIn.join(','),
    after.appearsIn.join(','),
  );
}

function shotChanges(out: SpecChange[], i: number, before?: H3Shot, after?: H3Shot): void {
  const at = `[Shot ${i + 1}]`;
  if (!before || !after) {
    push(out, `shots.${i}`, before ? `${at} ${t(t('删除'))}` : `${at} ${t(t('新增'))}`, before?.action ?? '', after?.action ?? '');
    return;
  }
  push(out, `shots.${i}.frames`, `${at} ${t(t('帧数'))}`, before.frames, after.frames);
  push(out, `shots.${i}.firstFrameOccupancy`, `${at} ${t(t('首帧占位'))}`, before.firstFrameOccupancy, after.firstFrameOccupancy);
  push(out, `shots.${i}.blocking`, `${at} ${t(t('空间调度'))}`, before.blocking, after.blocking);
  push(out, `shots.${i}.sightLine`, `${at} ${t(t('视线/构图'))}`, before.sightLine, after.sightLine);
  push(out, `shots.${i}.action`, `${at} ${t(t('动作'))}`, before.action, after.action);
  push(out, `shots.${i}.diegetic`, `${at} ${t(t('现场声'))}`, before.diegetic, after.diegetic);
  push(out, `shots.${i}.layers.foreground`, `${at} ${t(t('前景'))}`, before.layers.foreground, after.layers.foreground);
  push(out, `shots.${i}.layers.midground`, `${at} ${t(t('中景'))}`, before.layers.midground, after.layers.midground);
  push(out, `shots.${i}.layers.background`, `${at} ${t(t('后景'))}`, before.layers.background, after.layers.background);
  push(out, `shots.${i}.lighting.sourceCount`, `${at} ${t(t('光源数'))}`, before.lighting.sourceCount, after.lighting.sourceCount);
  push(out, `shots.${i}.lighting.description`, `${at} ${t(t('光照'))}`, before.lighting.description, after.lighting.description);

  const cam = (s: H3Shot) =>
    `${s.camera.token} / ${s.camera.amplitude} / ${s.camera.speed}${
      s.camera.secondary ? ` + ${s.camera.secondary.token}` : ''
    }`;
  push(out, `shots.${i}.camera`, `${at} ${t(t('运镜'))}`, cam(before), cam(after));
  push(out, `shots.${i}.camera.subject`, `${at} ${t(t('运镜主体'))}`, before.camera.subject, after.camera.subject);
  push(out, `shots.${i}.camera.from`, `${at} ${t(t('运镜起点'))}`, before.camera.from, after.camera.from);
  push(out, `shots.${i}.camera.to`, `${at} ${t(t('运镜终点'))}`, before.camera.to, after.camera.to);

  const dlg = (s: H3Shot) =>
    s.dialogue
      .map((d) => `${d.lang}${d.delivery ? ` (${d.delivery})` : ''}: ${d.line}`)
      .join(' | ');
  push(out, `shots.${i}.dialogue`, `${at} ${t(t('对白'))}`, dlg(before), dlg(after));
}

export function diffSpecs(before: H3DirectorSpec, after: H3DirectorSpec): SpecChange[] {
  const out: SpecChange[] = [];

  push(out, 'mode', t('模式'), before.mode, after.mode);
  push(out, 'taskType', t('任务类型'), before.taskType, after.taskType);
  push(out, 'summary', 'summary', before.summary, after.summary);
  push(out, 'world', t('世界块'), before.world, after.world);
  push(out, 'sound.soundscape', t('整体声景'), before.sound.soundscape, after.sound.soundscape);
  push(out, 'sound.music', t('非叙事音乐'), before.sound.music, after.sound.music);
  push(out, 'rawOverride', t('手写覆盖'), before.rawOverride || '', after.rawOverride || '');

  const subjectCount = Math.max(before.subjects.length, after.subjects.length);
  for (let i = 0; i < subjectCount; i += 1) {
    subjectChanges(out, i, before.subjects[i], after.subjects[i]);
  }

  const shotCount = Math.max(before.shots.length, after.shots.length);
  for (let i = 0; i < shotCount; i += 1) {
    shotChanges(out, i, before.shots[i], after.shots[i]);
  }

  return out;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Line diff — "accepting this moves these lines of the prompt"
 * ────────────────────────────────────────────────────────────────────────── */

export type LineOp =
  | { kind: 'same'; text: string; line: number }
  | { kind: 'add'; text: string; line: number }
  | { kind: 'remove'; text: string; line: number };

/**
 * Line-level LCS. Prompts are tens of lines, so the quadratic table is free and
 * the result is exact — no heuristics to explain away when the preview is wrong.
 */
export function diffLines(beforeText: string, afterText: string): LineOp[] {
  const a = beforeText.split('\n');
  const b = afterText.split('\n');
  const n = a.length;
  const m = b.length;

  const table: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const out: LineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i], line: j });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push({ kind: 'remove', text: a[i], line: i });
      i += 1;
    } else {
      out.push({ kind: 'add', text: b[j], line: j });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ kind: 'remove', text: a[i], line: i });
    i += 1;
  }
  while (j < m) {
    out.push({ kind: 'add', text: b[j], line: j });
    j += 1;
  }
  return out;
}

export interface LineDiffSummary {
  added: number;
  removed: number;
  /** 1-based line numbers in the new prompt that are new or changed. */
  touched: number[];
}

export function summarizeLineDiff(ops: LineOp[]): LineDiffSummary {
  const touched: number[] = [];
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.kind === 'add') {
      added += 1;
      touched.push(op.line + 1);
    } else if (op.kind === 'remove') {
      removed += 1;
    }
  }
  return { added, removed, touched };
}
