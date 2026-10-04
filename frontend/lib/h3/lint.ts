/**
 * QA rules for an H3 shot design.
 *
 * Every rule here is a failure that has actually happened on this model, and every
 * one of them is silent: the generation succeeds, looks plausible, and is wrong.
 * Four references render the wrong target rather than a weaker one; an optics
 * clause degrades the frame instead of shaping it; a negated noun summons the
 * thing it names. Four minutes of GPU time is the cost of finding out downstream,
 * so they are checked before submit instead.
 *
 * Pure functions over (spec, assets, compileResult) — no React, no I/O, unit-tested.
 */

import type { CompileResult } from './compile';
import {
  AUDIO_RETENTION_MARKERS,
  H3_CAMERA_TOKENS,
  isOnFrameGrid,
  RETENTION_MARKERS,
  snapToFrameGrid,
  type H3Assets,
  type H3DirectorSpec,
} from './spec';
import { t } from '../i18n';

export type LintSeverity = 'error' | 'warning';

export interface LintAnchor {
  kind: 'subject' | 'shot' | 'global';
  id?: string;
  field?: string;
}

export type LintFixKind =
  | 'snap-frames'
  | 'rebalance-frames'
  | 'delete-span'
  | 'split-batch';

export interface LintFix {
  kind: LintFixKind;
  label: string;
  /** For `delete-span`: the exact substring to remove from the anchored field. */
  span?: string;
  /** For `snap-frames`: the legal frame count to move to. */
  frames?: number;
}

export interface LintFinding {
  code: string;
  severity: LintSeverity;
  /** Short line for the light board. */
  title: string;
  /** What will go wrong, concretely. */
  detail: string;
  /** Where the rule comes from, so the reason survives the fix. */
  source: string;
  anchor: LintAnchor;
  fix?: LintFix;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Field collection
 * ────────────────────────────────────────────────────────────────────────── */

interface Field {
  text: string;
  anchor: LintAnchor;
  /** Human name for messages. */
  where: string;
}

function shotFields(spec: H3DirectorSpec): Field[] {
  const out: Field[] = [];
  spec.shots.forEach((shot, i) => {
    const at = (field: string, text: string, name: string) =>
      out.push({ text, anchor: { kind: 'shot', id: shot.id, field }, where: `[Shot ${i + 1}] ${name}` });
    at('firstFrameOccupancy', shot.firstFrameOccupancy || '', t('首帧占位'));
    at('blocking', shot.blocking, t('空间调度'));
    at('sightLine', shot.sightLine, t('视线/构图'));
    at('action', shot.action, t('动作'));
    at('layers.foreground', shot.layers.foreground, t('前景'));
    at('layers.midground', shot.layers.midground, t('中景'));
    at('layers.background', shot.layers.background, t('后景'));
    at('lighting.description', shot.lighting.description, t('光照'));
    at('diegetic', shot.diegetic, t('现场声'));
    shot.dialogue.forEach((d) => at('dialogue', d.delivery || '', t('对白语气')));
  });
  return out;
}

function allFields(spec: H3DirectorSpec): Field[] {
  const out: Field[] = [
    { text: spec.world, anchor: { kind: 'global', field: 'world' }, where: t('世界块') },
    { text: spec.summary, anchor: { kind: 'global', field: 'summary' }, where: 'summary' },
  ];
  spec.subjects.forEach((s, i) => {
    out.push({
      text: s.definition,
      anchor: { kind: 'subject', id: s.id, field: 'definition' },
      where: t('<Subject {n}> 定义', { n: i + 1 }),
    });
    out.push({
      text: s.retentionNote,
      anchor: { kind: 'subject', id: s.id, field: 'retentionNote' },
      where: t('<Subject {n}> 保留说明', { n: i + 1 }),
    });
  });
  out.push(...shotFields(spec));
  return out.filter((f) => f.text.trim());
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Word-level scanners
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Optics language. Half the Seedance optics module is actively counterproductive
 * here: the framing half lands, every depth-of-field clause backfires. Depth is
 * bought with the three-layer appearance system instead.
 */
const OPTICS_TERMS = [
  'depth of field',
  'shallow focus',
  'shallow depth',
  'bokeh',
  'rack focus',
  'focal length',
  'defocus',
  'out-of-focus background',
  'anamorphic',
  'telephoto compression',
];

// `35mm film grain` is film-stock language and lands fine; `85mm lens` is a focal
// length and does nothing at all. The lookahead is what separates the two.
const OPTICS_PATTERNS = [
  /\bf\/\d(?:\.\d)?\b/i, // f/1.8
  /\b\d{2,3}\s?mm\b(?!\s+(?:film|grain|stock|print|footage))/i, // 85mm lens
  /\bT\d(?:\.\d)?\s+(?:lens|prime)\b/i,
];

/**
 * A named thing is rendered whether or not the sentence negates it.
 *
 * `comes no further` negates a degree, not an object, and nothing gets summoned —
 * so the words that only ever follow in that sense are excused. Without this the
 * rule fires on ordinary prose and the light board stops being believed.
 */
const NEGATION_ALLOWED =
  'further|longer|other|others|more|less|one|matter|sooner|later|doubt|' +
  'detail|details|motion|movement|change|sound|noise|contrast|colour|color|dialogue|hesitation|time';

const NEGATION_PATTERNS = [
  new RegExp(`\\bno\\s+(?!(?:${NEGATION_ALLOWED})\\b)[a-z]+`, 'i'),
  new RegExp(`\\bwithout\\s+(?:a\\s+|any\\s+)?(?!(?:${NEGATION_ALLOWED})\\b)[a-z]+`, 'i'),
  /\bavoid(?:s|ing)?\s+[a-z]+/i,
  /\bnever\s+(?:shows?|includes?|contains?)\b/i,
  /\bdo(?:es)?\s+not\s+(?:show|include|contain)\b/i,
];

/** Orientation lands poorly; composition lands well. */
const ORIENTATION_PATTERNS = [
  /\bfaces?\s+(?:the|him|her|it|them|toward)/i,
  /\bfacing\s+(?:the|him|her|it|them|away|toward)/i,
  /\bturns?\s+(?:to face|toward|towards)\b/i,
  /\bwith (?:his|her|their) back to\b/i,
];

/** Phrasings that make composition explicit; their presence excuses an orientation word. */
const COMPOSITION_PATTERNS = [
  /\bon one (?:straight )?line\b/i,
  /\blie on\b/i,
  /\bacross the frame\b/i,
  /\bscreen (?:left|right|centre|center)\b/i,
  /\bin the (?:fore|mid|back)ground\b/i,
];

/** An impact is two events. Written as one, the second half is simply not rendered. */
const SINGLE_EVENT_IMPACT = [
  /\bknocks?\s+\w+\s+(?:flying|back|down|over)\b/i,
  /\bsends?\s+\w+\s+(?:flying|sprawling|tumbling)\b/i,
  /\bblasts?\s+\w+\s+(?:back|away|apart)\b/i,
  /\bthrows?\s+\w+\s+across\b/i,
];

const LIGHT_SOURCE_NOUNS = [
  'sconce',
  'lamp',
  'candle',
  'bulb',
  'window',
  'torch',
  'fire',
  'lantern',
  'headlight',
  'flashlight',
  'neon sign',
  'monitor',
  'streetlight',
  'skylight',
  'chandelier',
];

const STOPWORDS = new Set(
  'the a an and or of in on at to for with from into over under is are was were be been it its his her their they he she that this those these as by not no so than then there here'.split(
    ' ',
  ),
);

/** Placeholders are addressing, not prose; they must not feed the word scanners. */
function stripTokens(text: string): string {
  return text.replace(/\{(?:[sa]:[^}]+|ref)\}/g, ' ');
}

function words(text: string): string[] {
  return stripTokens(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function tokenSet(text: string): Set<string> {
  return new Set(words(text).filter((w) => !STOPWORDS.has(w)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  a.forEach((w) => {
    if (b.has(w)) shared += 1;
  });
  return shared / (a.size + b.size - shared);
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Rules
 * ────────────────────────────────────────────────────────────────────────── */

function checkReferenceCount(assets: H3Assets, out: LintFinding[]): void {
  const total = assets.images.length + assets.videos.length + assets.audios.length;
  if (total <= 3) return;
  out.push({
    code: 'ref-overflow',
    severity: 'error',
    title: t('参考资产 {n} 个，超过 3', { n: total }),
    detail: t('第 4 个参考会发生指针错乱：<Subject 4> 渲染出的是另一个参考的内容。这不是效果变弱，是渲染错对象。把这一镜拆成单参考的几次生成再接起来。'),
    source: t('h3-director §1.3 参考数量：1–2 可靠，3 可用，4 指针错乱'),
    anchor: { kind: 'global', field: 'assets' },
    fix: { kind: 'split-batch', label: t('按硬切拆批') },
  });
}

function checkFrameGrid(spec: H3DirectorSpec, assets: H3Assets, out: LintFinding[]): void {
  if (isOnFrameGrid(assets.totalFrames)) return;
  out.push({
    code: 'off-grid-frames',
    severity: 'error',
    title: t('帧数 {n} 不在 17k+5 网格上', { n: assets.totalFrames }),
    detail: t('不在网格上的帧数会被工作流自行取整，实际时长与你写进提示词的切点时刻对不上。'),
    source: t('h3-director §1.7 帧数网格'),
    anchor: { kind: 'global', field: 'length' },
    fix: {
      kind: 'snap-frames',
      label: t('吸附到 {n} 帧', { n: snapToFrameGrid(assets.totalFrames) }),
      frames: snapToFrameGrid(assets.totalFrames),
    },
  });
}

function checkFrameBudget(spec: H3DirectorSpec, assets: H3Assets, out: LintFinding[]): void {
  if (spec.shots.length === 0) return;
  const sum = spec.shots.reduce((a, s) => a + (s.frames || 0), 0);
  if (sum === assets.totalFrames) return;
  out.push({
    code: 'frames-mismatch',
    severity: 'error',
    title: t('分镜帧数合计 {sum}，与本批的 {total} 帧不符', { sum, total: assets.totalFrames }),
    detail: t('切点时刻是按每镜帧数累加算出来的。合计对不上，写进 RULES 的每一个切点时刻就都落在错的位置上。'),
    source: t('h3-director §1.7 切点：数量与时刻都要在 RULES 里写明'),
    anchor: { kind: 'global', field: 'shots' },
    fix: { kind: 'rebalance-frames', label: t('按镜头数均分') },
  });
}

function checkFirstFrame(spec: H3DirectorSpec, out: LintFinding[]): void {
  const first = spec.shots[0];
  if (!first || first.firstFrameOccupancy?.trim()) return;
  out.push({
    code: 'first-frame-occupancy',
    severity: 'warning',
    title: t('首帧占位未声明'),
    detail: t('第一帧是风险最高的一帧。不写明谁在画面里、在哪，模型会先给一段空镜或装饰性建置镜头，动作从第二秒才开始。'),
    source: t('h3-director §2.3 首帧占位锁'),
    anchor: { kind: 'shot', id: first.id, field: 'firstFrameOccupancy' },
  });
}

/**
 * Only shot 1's first-frame occupancy is compiled. Insert a shot in front of the
 * one that had it and the text stays in the spec, still reads as written, and is
 * no longer anywhere in the prompt.
 */
function checkOrphanFirstFrame(spec: H3DirectorSpec, out: LintFinding[]): void {
  spec.shots.forEach((shot, i) => {
    if (i === 0) return;
    const text = shot.firstFrameOccupancy?.trim();
    if (!text) return;
    out.push({
      code: 'orphan-first-frame',
      severity: 'warning',
      title: t('[Shot {n}] 的首帧占位不会进提示词', { n: i + 1 }),
      detail: t('首帧占位只对第 1 镜编译 —— 这一批只有一个第一帧。这段文字留在 spec 里，看得见但发不出去；要么清掉，要么把它挪到第 1 镜。'),
      source: t('h3-director §2.3 首帧占位锁只作用于批次的第一帧'),
      anchor: { kind: 'shot', id: shot.id, field: 'firstFrameOccupancy' },
      fix: { kind: 'delete-span', label: t('清掉这段'), span: text },
    });
  });
}

function checkOptics(fields: Field[], out: LintFinding[]): void {
  for (const f of fields) {
    for (const term of OPTICS_TERMS) {
      const idx = f.text.toLowerCase().indexOf(term);
      if (idx === -1) continue;
      const span = f.text.slice(idx, idx + term.length);
      out.push({
        code: 'optics-term',
        severity: 'warning',
        title: t('{where} 出现光学词「{span}」', { where: f.where, span }),
        detail: t('景深类措辞在 H3 上是反效果的：它不会做出浅景深，只会让整帧质量下降。景深要靠前/中/后三层各自不同的外观来买。'),
        source: t('h3-director §1.9 光学：构图的一半有效，景深的一半反效果'),
        anchor: f.anchor,
        fix: { kind: 'delete-span', label: t('删除该词'), span },
      });
    }
    for (const re of OPTICS_PATTERNS) {
      const m = f.text.match(re);
      if (!m) continue;
      out.push({
        code: 'optics-term',
        severity: 'warning',
        title: t('{where} 出现镜头参数「{param}」', { where: f.where, param: m[0] }),
        detail: t('焦段和光圈数字不会改变画面，只会占掉提示词预算。要控制视野就直接写构图。'),
        source: t('h3-director §1.9 光学'),
        anchor: f.anchor,
        fix: { kind: 'delete-span', label: t('删除该词'), span: m[0] },
      });
    }
  }
}

function checkNegation(fields: Field[], out: LintFinding[]): void {
  for (const f of fields) {
    for (const re of NEGATION_PATTERNS) {
      const m = f.text.match(re);
      if (!m) continue;
      out.push({
        code: 'negation',
        severity: 'warning',
        title: t('{where} 用了否定式「{span}」', { where: f.where, span: m[0].trim() }),
        detail: t('否定在这里是失效的：你命名了一个不该出现的东西，模型读到的是那个名词。改成正面陈述你要的东西，写进该镜头的正文里。'),
        source: t('h3-director §1.12 负向约束在 H3 上是反的'),
        anchor: f.anchor,
      });
      break;
    }
  }
}

function checkOrientation(fields: Field[], out: LintFinding[]): void {
  for (const f of fields) {
    if (COMPOSITION_PATTERNS.some((re) => re.test(f.text))) continue;
    for (const re of ORIENTATION_PATTERNS) {
      const m = f.text.match(re);
      if (!m) continue;
      out.push({
        code: 'orientation-phrasing',
        severity: 'warning',
        title: t('{where} 用了朝向表述「{span}」', { where: f.where, span: m[0].trim() }),
        detail: t('朝向指令在 H3 上落地很差，构图指令落得很好。改写成共线关系——「他的眼睛、杖尖和目标在画面上连成一条直线」，而不是「他面向目标」。'),
        source: t('h3-director §3.4 构图指令落地，朝向指令失败'),
        anchor: f.anchor,
      });
      break;
    }
  }
}

function checkImpact(fields: Field[], out: LintFinding[]): void {
  for (const f of fields) {
    for (const re of SINGLE_EVENT_IMPACT) {
      const m = f.text.match(re);
      if (!m) continue;
      out.push({
        code: 'single-event-impact',
        severity: 'warning',
        title: t('{where} 把撞击写成了一个事件', { where: f.where }),
        detail: t('「A 把 B 撞飞」写成一句，只会渲染出其中一半。拆成两段：先写撞击本体停住，再写被撞者因为自己的动量向后去。'),
        source: t('h3-director §2.7 物理锁：绝不把撞击写成单一事件'),
        anchor: f.anchor,
      });
      break;
    }
  }
}

/**
 * Where the camera *is* belongs in blocking — §2.4 asks for camera position and
 * facing. Where it *goes* belongs in the camera field and nowhere else, so this
 * matches movement verbs rather than the word "camera".
 */
const CAMERA_MOVE_IN_PROSE =
  /\bcamera\s+(?:slowly\s+|then\s+)?(?:pans?|tilts?|pushes|pulls?|zooms?|tracks?|trucks?|arcs?|rolls?|dollies|orbits?|circles?|glides?|moves?|shakes?|drifts?|creeps?|sweeps?|whips?|cranes?|floats?)\b/i;

function checkCameraInProse(spec: H3DirectorSpec, out: LintFinding[]): void {
  const prose = shotFields(spec);
  for (const f of prose) {
    const hit = H3_CAMERA_TOKENS.find((t) => f.text.toLowerCase().includes(t.toLowerCase()));
    const dolly = /\b(dolly|steadicam|crane shot|whip pan|orbit)\b/i.exec(f.text);
    const moved = CAMERA_MOVE_IN_PROSE.exec(f.text);
    if (!hit && !dolly && !moved) continue;
    out.push({
      code: 'camera-in-prose',
      severity: 'warning',
      title: t('{where} 里描述了运镜', { where: f.where }),
      detail: t('运镜只在运镜盘那一处生效。散文里的第二个运镜说法要么被忽略，要么和 token 打架——一个镜头只能有一个主运镜。'),
      source: t('h3-director §1.8 运镜是闭集 token，一镜一个主运镜'),
      anchor: f.anchor,
    });
  }
}

/**
 * A speaker's first line is where H3 fixes the voice for the rest of the batch.
 * With nothing outside `<d>` but "says", timbre and pace are re-guessed at every
 * later line, and the same character comes back in a different voice after a cut.
 */
function checkSpeakerVoice(spec: H3DirectorSpec, out: LintFinding[]): void {
  const heard = new Set<string>();
  spec.shots.forEach((shot, i) => {
    for (const d of shot.dialogue) {
      if (heard.has(d.subjectId)) continue;
      heard.add(d.subjectId);
      if ((d.delivery || '').trim()) continue;
      out.push({
        code: 'speaker-no-delivery',
        severity: 'warning',
        title: t('[Shot {n}] 说话人第一句没写语气', { n: i + 1 }),
        detail: t('第一句是把音色、语调、语速钉死的地方。只写 says，模型会在每一句重新猜一遍声音，同一个人过了切点就换了嗓子。语气写在 <d> 外面，<d> 里只留原话。'),
        source: t('h3-guide §4.4 说话人首次出现要给出音高、音色、语速、口音'),
        anchor: { kind: 'shot', id: shot.id, field: 'dialogue' },
      });
    }
  });
}

function checkLighting(spec: H3DirectorSpec, out: LintFinding[]): void {
  spec.shots.forEach((shot, i) => {
    const desc = shot.lighting.description.toLowerCase();
    if (!desc.trim()) return;
    const found = LIGHT_SOURCE_NOUNS.filter((n) => desc.includes(n));
    if (found.length <= shot.lighting.sourceCount) return;
    out.push({
      code: 'light-count-mismatch',
      severity: 'warning',
      title: t('[Shot {n}] 声明 {declared} 个光源，正文写了 {found} 种',
        { n: i + 1, declared: shot.lighting.sourceCount, found: found.length }),
      detail: t('正文里出现了 {found}。光源数量必须只有一个说法，正文要服从它，否则打光会在镜头之间漂。',
        { found: found.join('、') }),
      source: t('h3-director §2.8 光照优先锁：只有一个光源数量声明'),
      anchor: { kind: 'shot', id: shot.id, field: 'lighting.description' },
    });
  });
}

function checkLayers(spec: H3DirectorSpec, out: LintFinding[]): void {
  spec.shots.forEach((shot, i) => {
    const pairs: [string, string, string][] = [
      ['前景', 'midground', 'foreground'],
      ['中景', 'background', 'midground'],
      ['前景', 'background', 'foreground'],
    ];
    for (const [, bKey, aKey] of pairs) {
      const a = shot.layers[aKey as keyof typeof shot.layers];
      const b = shot.layers[bKey as keyof typeof shot.layers];
      if (!a.trim() || !b.trim()) continue;
      if (jaccard(tokenSet(a), tokenSet(b)) < 0.6) continue;
      out.push({
        code: 'layer-collision',
        severity: 'warning',
        title: t('[Shot {n}] 两层景深描述几乎相同', { n: i + 1 }),
        detail: t('三层必须各有各的活、各有各的外观，否则深度分离就不存在了——这是 H3 上唯一能买到景深的办法。'),
        source: t('h3-director §1.9 三层外观系统'),
        anchor: { kind: 'shot', id: shot.id, field: `layers.${aKey}` },
      });
      break;
    }
  });
}

function checkDuplicateAssertions(fields: Field[], out: LintFinding[]): void {
  const seen = new Map<string, Field>();
  const reported = new Set<string>();
  for (const f of fields) {
    const w = words(f.text);
    for (let i = 0; i + 5 <= w.length; i += 1) {
      const gram = w.slice(i, i + 5);
      if (gram.filter((x) => !STOPWORDS.has(x)).length < 3) continue;
      const key = gram.join(' ');
      const prev = seen.get(key);
      if (!prev) {
        seen.set(key, f);
        continue;
      }
      if (prev.anchor === f.anchor || reported.has(key)) continue;
      reported.add(key);
      out.push({
        code: 'duplicate-assertion',
        severity: 'warning',
        title: t('{a} 与 {b} 重复断言', { a: prev.where, b: f.where }),
        detail: t('两处都写了「{key}」。同一属性被断言两次，两处一旦不同步就会互相打架，而且没有报错。', { key }),
        source: t('h3-director §3.11 一个属性只断言一次'),
        anchor: f.anchor,
      });
    }
  }
}

function checkLiteralLabels(fields: Field[], out: LintFinding[]): void {
  const re = /<(?:Subject|Picture|Video|Audio)\s*\d+>/;
  for (const f of fields) {
    const m = f.text.match(re);
    if (!m) continue;
    out.push({
      code: 'literal-label',
      severity: 'warning',
      title: t('{where} 写死了标签「{label}」', { where: f.where, label: m[0] }),
      detail: t('编号是从接线顺序和主体顺序推导出来的。写死的标签在你拖动参考条或调换主体顺序之后不会跟着变，指向就错了，而且没有任何报错。改用占位符引用。'),
      source: t('h3-director §1.3 编号必须等于接线顺序'),
      anchor: f.anchor,
    });
  }
}

function checkEmptyEssentials(spec: H3DirectorSpec, out: LintFinding[]): void {
  spec.subjects.forEach((s, i) => {
    if (s.definition.trim()) return;
    out.push({
      code: 'empty-subject',
      severity: 'error',
      title: t('<Subject {n}> 没有定义', { n: i + 1 }),
      detail: t('空的主体定义会编译出一行只有标签的句子，模型无从知道这个标签指什么。'),
      source: 'h3-director §1.4 subject_definitions',
      anchor: { kind: 'subject', id: s.id, field: 'definition' },
    });
  });
  spec.shots.forEach((shot, i) => {
    if (shot.blocking.trim() || shot.action.trim()) return;
    out.push({
      code: 'empty-shot',
      severity: 'error',
      title: t('[Shot {n}] 既没有调度也没有动作', { n: i + 1 }),
      detail: t('这一镜编译出来只有运镜和光照，画面内容完全交给模型自由发挥。'),
      source: t('h3-director §2.4 空间调度锁'),
      anchor: { kind: 'shot', id: shot.id, field: 'blocking' },
    });
  });
}

/** rawOverride bypasses the typed fields, so the closed sets have to be checked in text. */
function checkOverrideMarkers(spec: H3DirectorSpec, out: LintFinding[]): void {
  const raw = spec.rawOverride?.trim();
  if (!raw) return;
  const legal = new Set<string>([...RETENTION_MARKERS, ...AUDIO_RETENTION_MARKERS]);
  const re = /^<(?:Subject|Picture|Video|Audio)[^>]*>[^:]*:\s*([a-z_]+)/gm;
  const bad = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    if (!legal.has(m[1])) bad.add(m[1]);
  }
  bad.forEach((marker) =>
    out.push({
      code: 'bad-retention-marker',
      severity: 'error',
      title: t('保留标记「{v1}」不在闭集内', { v1: marker }),
      detail: t('关系标记是一个封闭集合：fully_preserved / partially_preserved / attribute_transfer / weak_reference（音频是 fully_copy / partially_copy / reference / weak_reference）。自造的值让整行无法解析。'),
      source: t('h3-director §1.5 retention_analysis 的四个固定标记'),
      anchor: { kind: 'global', field: 'rawOverride' },
    }),
  );
}

function fromCompile(compiled: CompileResult | null, out: LintFinding[]): void {
  if (!compiled) return;
  for (const w of compiled.warnings) {
    out.push({
      code: w.code,
      severity: w.severity,
      title: w.message,
      detail:
        w.code === 'unresolved-token'
          ? t('占位符原样留在了提示词里。生成前必须重新指到一个还在的主体或资产上。')
          : w.code === 'missing-ref'
            ? t('主体绑定的图已经断开，定义里没有可引用的编号。')
            : t('这条引用指向的连接已经不在了。'),
      source: 'compile',
      anchor: w.subjectId
        ? { kind: 'subject', id: w.subjectId }
        : w.shotId
          ? { kind: 'shot', id: w.shotId }
          : { kind: 'global' },
    });
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Entry point
 * ────────────────────────────────────────────────────────────────────────── */

const SEVERITY_ORDER: Record<LintSeverity, number> = { error: 0, warning: 1 };

export function lintSpec(
  spec: H3DirectorSpec,
  assets: H3Assets,
  compiled: CompileResult | null = null,
): LintFinding[] {
  const out: LintFinding[] = [];
  const fields = allFields(spec);

  checkReferenceCount(assets, out);
  checkFrameGrid(spec, assets, out);
  fromCompile(compiled, out);
  checkOverrideMarkers(spec, out);

  if (!spec.rawOverride?.trim()) {
    checkFrameBudget(spec, assets, out);
    checkEmptyEssentials(spec, out);
    checkFirstFrame(spec, out);
    checkOrphanFirstFrame(spec, out);
    checkOptics(fields, out);
    checkNegation(fields, out);
    checkOrientation(fields, out);
    checkImpact(fields, out);
    checkCameraInProse(spec, out);
    checkSpeakerVoice(spec, out);
    checkLighting(spec, out);
    checkLayers(spec, out);
    checkDuplicateAssertions(fields, out);
    checkLiteralLabels(fields, out);
  }

  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

export function hasBlockingErrors(findings: LintFinding[]): boolean {
  return findings.some((f) => f.severity === 'error');
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Mechanical fixes
 * ────────────────────────────────────────────────────────────────────────── */

function setField(spec: H3DirectorSpec, anchor: LintAnchor, edit: (text: string) => string): H3DirectorSpec {
  const next: H3DirectorSpec = structuredClone(spec);
  const path = anchor.field || '';

  if (anchor.kind === 'subject') {
    const s = next.subjects.find((x) => x.id === anchor.id);
    if (!s) return next;
    if (path === 'definition') s.definition = edit(s.definition);
    if (path === 'retentionNote') s.retentionNote = edit(s.retentionNote);
    return next;
  }

  if (anchor.kind === 'shot') {
    const shot = next.shots.find((x) => x.id === anchor.id);
    if (!shot) return next;
    if (path.startsWith('layers.')) {
      const key = path.slice('layers.'.length) as keyof typeof shot.layers;
      shot.layers[key] = edit(shot.layers[key]);
    } else if (path === 'lighting.description') {
      shot.lighting.description = edit(shot.lighting.description);
    } else if (path === 'firstFrameOccupancy') {
      shot.firstFrameOccupancy = edit(shot.firstFrameOccupancy || '');
    } else if (path in shot) {
      const key = path as 'blocking' | 'sightLine' | 'action' | 'diegetic';
      shot[key] = edit(shot[key]);
    }
    return next;
  }

  if (path === 'world') next.world = edit(next.world);
  if (path === 'summary') next.summary = edit(next.summary);
  return next;
}

/**
 * Apply a mechanical fix. Only edits that have one obviously correct outcome are
 * offered — deleting a term the model cannot use, snapping to a legal frame count,
 * spacing cuts evenly. Anything requiring judgement stays a finding.
 *
 * `snap-frames` and `split-batch` are not spec edits; the console handles those.
 */
export function applyFix(
  spec: H3DirectorSpec,
  finding: LintFinding,
  ctx: { totalFrames: number; fps: number },
): H3DirectorSpec {
  const fix = finding.fix;
  if (!fix) return spec;

  if (fix.kind === 'delete-span' && fix.span) {
    return setField(spec, finding.anchor, (text) =>
      text
        .replace(fix.span as string, '')
        .replace(/\s{2,}/g, ' ')
        .replace(/\s+([,.;])/g, '$1')
        .replace(/(^[,\s]+|[,\s]+$)/g, '')
        .trim(),
    );
  }

  if (fix.kind === 'rebalance-frames') {
    const next: H3DirectorSpec = structuredClone(spec);
    const n = next.shots.length || 1;
    const each = Math.floor(ctx.totalFrames / n);
    next.shots.forEach((shot, i) => {
      shot.frames = i === n - 1 ? ctx.totalFrames - each * (n - 1) : each;
    });
    return next;
  }

  return spec;
}
