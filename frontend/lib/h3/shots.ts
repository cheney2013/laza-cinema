/**
 * Adding and removing a shot in the middle of a batch.
 *
 * A shot list is not an array of independent things. Three other things are
 * indexed by position, and all three break silently when a shot is spliced in or
 * out:
 *
 * - **`subject.appearsIn` holds 1-based shot numbers.** Insert at the front and
 *   every one of them now points at the shot after the one it meant. Nothing
 *   errors; the subject is simply declared in the wrong shots.
 * - **The frame budget has to keep summing to the batch length.** A new shot with
 *   frames out of nowhere makes the total disagree with the node.
 * - **Only shot 1's `firstFrameOccupancy` is compiled.** Push shot 1 down to
 *   position 2 and the text is still in the spec, still shown as written, and no
 *   longer in the prompt.
 *
 * So the frames come out of a neighbour rather than a rebalance: 穿插一个镜头 takes
 * time from the shot it cuts into, and every other shot keeps the timing the
 * director gave it. The orphaned first-frame text is left where it is — moving it
 * would put a description of the old opening on a new shot that opens on something
 * else — and the QA board reports it instead.
 */

import { createShot, H3_FRAME_GRID, snapToFrameGrid, type H3DirectorSpec } from './spec';

/** The slider's floor. Below this a shot is not a shot. */
export const MIN_SHOT_FRAMES = 12;

const SUBJECT_TOKEN_RE = /\{s:([^}]+)\}/g;

function referencedSubjectIds(text: string, into: Set<string>): void {
  for (const match of text.matchAll(SUBJECT_TOKEN_RE)) into.add(match[1]);
}

/**
 * Keep only subjects that can affect the enabled batch. A subject is rooted by an
 * enabled shot scope, a global scope, a token in generated prose, or a dialogue
 * speaker. Definitions may reference other subjects, so walk those dependencies
 * before pruning instead of deleting them independently.
 */
function pruneUnusedSubjects(spec: H3DirectorSpec, hadExplicitScope: Map<string, boolean>): void {
  const used = new Set<string>();
  referencedSubjectIds(spec.world, used);
  referencedSubjectIds(spec.summary, used);
  referencedSubjectIds(spec.sound.soundscape, used);
  referencedSubjectIds(spec.sound.music, used);

  for (const shot of spec.shots) {
    referencedSubjectIds(JSON.stringify(shot), used);
    for (const line of shot.dialogue) if (line.subjectId) used.add(line.subjectId);
  }

  for (const subject of spec.subjects) {
    if (!hadExplicitScope.get(subject.id) || subject.appearsIn.length > 0) used.add(subject.id);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const subject of spec.subjects) {
      if (!used.has(subject.id)) continue;
      const before = used.size;
      referencedSubjectIds(subject.definition, used);
      referencedSubjectIds(subject.retentionNote, used);
      changed ||= used.size !== before;
    }
  }

  spec.subjects = spec.subjects.filter((subject) => used.has(subject.id));
}

/** Build the exact enabled-only batch sent to H3, preserving the editable source spec. */
export function generationSpec(spec: H3DirectorSpec): { spec: H3DirectorSpec; totalFrames: number } {
  const enabledIndexes = spec.shots
    .map((shot, index) => (shot.enabled === false ? -1 : index))
    .filter((index) => index >= 0);
  if (enabledIndexes.length === 0) {
    return { spec, totalFrames: spec.shots.reduce((sum, shot) => sum + shot.frames, 0) };
  }

  const next: H3DirectorSpec = structuredClone(spec);
  const hadExplicitScope = new Map(next.subjects.map((subject) => [subject.id, subject.appearsIn.length > 0]));
  const oldToNew = new Map(enabledIndexes.map((oldIndex, newIndex) => [oldIndex + 1, newIndex + 1]));
  next.shots = enabledIndexes.map((index) => ({ ...next.shots[index], enabled: true }));
  next.subjects = next.subjects.map((subject) => ({
    ...subject,
    appearsIn: subject.appearsIn.length === 0
      ? []
      : subject.appearsIn.flatMap((shotNumber) => {
          const mapped = oldToNew.get(shotNumber);
          return mapped == null ? [] : [mapped];
        }),
  }));
  pruneUnusedSubjects(next, hadExplicitScope);

  const rawTotal = next.shots.reduce((sum, shot) => sum + shot.frames, 0);
  const totalFrames = H3_FRAME_GRID.find((frames) => frames >= rawTotal) ?? snapToFrameGrid(rawTotal);
  next.shots[next.shots.length - 1].frames += totalFrames - rawTotal;
  return { spec: next, totalFrames };
}

/** Shift the 1-based shot numbers a subject appears in. */
function remapAppearsIn(
  spec: H3DirectorSpec,
  map: (n: number) => number | null,
): void {
  spec.subjects.forEach((s) => {
    s.appearsIn = s.appearsIn
      .map(map)
      .filter((n): n is number => n != null)
      .sort((a, b) => a - b);
  });
}

/**
 * Insert an empty shot so it becomes shot index `at` (0-based, clamped).
 *
 * Its frames are taken from the neighbour it cuts into — the shot before it, or
 * the shot it displaces when inserted at the front — so the batch total is
 * unchanged and no other shot is touched.
 */
export function insertShotAt(
  spec: H3DirectorSpec,
  at: number,
  totalFrames = 124,
): H3DirectorSpec {
  const next: H3DirectorSpec = structuredClone(spec);
  const index = Math.max(0, Math.min(at, next.shots.length));

  const donor = next.shots.length === 0 ? null : next.shots[index > 0 ? index - 1 : 0];
  const frames = donor ? Math.max(1, Math.floor(donor.frames / 2)) : Math.max(1, totalFrames);
  if (donor) donor.frames -= frames;

  next.shots.splice(index, 0, createShot({ frames }));
  remapAppearsIn(next, (n) => (n >= index + 1 ? n + 1 : n));
  return next;
}

/**
 * Remove shot `index` (0-based). The last shot cannot be removed — a spec with no
 * shots has nothing to compile.
 *
 * Its frames go to the neighbour that absorbs its place in time, so the batch
 * total is unchanged.
 */
export function removeShotAt(spec: H3DirectorSpec, index: number): H3DirectorSpec {
  if (spec.shots.length <= 1 || index < 0 || index >= spec.shots.length) return spec;

  const next: H3DirectorSpec = structuredClone(spec);
  const [removed] = next.shots.splice(index, 1);
  const heir = next.shots[index - 1] ?? next.shots[0];
  heir.frames += removed.frames;

  const gone = index + 1;
  remapAppearsIn(next, (n) => (n === gone ? null : n > gone ? n - 1 : n));
  return next;
}


/**
 * Set one shot's length, taking the difference out of its neighbours.
 *
 * The batch total is fixed by the node, so a shot can only get longer by making
 * another shorter — the question is which. Spreading the difference evenly over
 * every other shot keeps the sum right and rewrites timings the director set on
 * purpose, which is the same mistake as rebalancing on insert. The cut nearest
 * the change moves first: the following shot, then the preceding one, then
 * outward, each down to `MIN_SHOT_FRAMES` before the next one is touched.
 *
 * The current total is preserved, whatever it is — if the spec already disagrees
 * with the node's length, that is the frame-budget rule's finding to report, not
 * something to silently correct here.
 */
export function setShotFrames(
  spec: H3DirectorSpec,
  index: number,
  frames: number,
): H3DirectorSpec {
  const shots = spec.shots;
  if (!shots[index]) return spec;

  const next: H3DirectorSpec = structuredClone(spec);
  const n = next.shots.length;
  if (n === 1) {
    next.shots[0].frames = Math.max(1, Math.round(frames));
    return next;
  }

  const sum = shots.reduce((a, s) => a + s.frames, 0);
  const ceiling = Math.max(MIN_SHOT_FRAMES, sum - MIN_SHOT_FRAMES * (n - 1));
  const want = Math.max(MIN_SHOT_FRAMES, Math.min(Math.round(frames), ceiling));

  let owed = want - next.shots[index].frames;
  next.shots[index].frames = want;

  // Nearest cut first: after, before, then outward.
  const order: number[] = [];
  for (let d = 1; d < n; d += 1) {
    if (index + d < n) order.push(index + d);
    if (index - d >= 0) order.push(index - d);
  }

  for (const i of order) {
    if (owed === 0) break;
    if (owed > 0) {
      const canGive = next.shots[i].frames - MIN_SHOT_FRAMES;
      const take = Math.min(Math.max(0, canGive), owed);
      next.shots[i].frames -= take;
      owed -= take;
    } else {
      // Frames freed by shrinking go to the neighbour that absorbs the time.
      next.shots[i].frames -= owed;
      owed = 0;
    }
  }

  // Nobody had room to give: keep the total right rather than the request.
  if (owed > 0) next.shots[index].frames -= owed;
  return next;
}

/** Set one shot's length without touching any other shot, snapping the batch to 17k+5. */
export function setShotFramesAndSnapTotal(
  spec: H3DirectorSpec,
  index: number,
  frames: number,
): H3DirectorSpec {
  if (!spec.shots[index]) return spec;
  const next: H3DirectorSpec = structuredClone(spec);
  const otherFrames = next.shots.reduce(
    (sum, shot, i) => (i === index ? sum : sum + shot.frames),
    0,
  );
  const requested = Math.max(MIN_SHOT_FRAMES, Math.round(frames));
  const snappedTotal = snapToFrameGrid(otherFrames + requested);
  next.shots[index].frames = Math.max(MIN_SHOT_FRAMES, snappedTotal - otherFrames);
  return next;
}

/** Move the cut between `boundary - 1` and `boundary`, preserving the batch total. */
export function moveShotBoundary(
  spec: H3DirectorSpec,
  boundary: number,
  deltaFrames: number,
): H3DirectorSpec {
  if (boundary <= 0 || boundary >= spec.shots.length) return spec;
  const next: H3DirectorSpec = structuredClone(spec);
  const left = next.shots[boundary - 1];
  const right = next.shots[boundary];
  const delta = Math.max(
    MIN_SHOT_FRAMES - left.frames,
    Math.min(Math.round(deltaFrames), right.frames - MIN_SHOT_FRAMES),
  );
  left.frames += delta;
  right.frames -= delta;
  return next;
}
