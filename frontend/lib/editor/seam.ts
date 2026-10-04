import { type Clip, type Timeline, clipEnd, clipLength } from './types';

export type SeamPlan =
  /** Nothing of the seam is handled by hand: reveal the overlap, dissolve over all of it, and its sound is not used. */
  | { ok: true; kind: 'full'; inFrame: number; start: number; frames: number }
  /** A dissolve was set by hand over the first `from` frames: it stays as it is; the frames after it, up to the seam, follow the automatic rule. */
  | { ok: true; kind: 'rest'; from: number; to: number }
  /** The hand-set dissolve already covers every overlap frame there is. */
  | { ok: true; kind: 'none'; note: string }
  // `quiet`: not a seam at all (a title, a shot with no overlap frames, the first shot on its lane),
  // so a batch passes over it without comment; the other refusals are worth telling the user about.
  | { ok: false; reason: string; quiet?: boolean };

/**
 * One-click seam dissolve for a chained shot.
 *
 * A chained clip's file starts with the frames it was generated from, the last
 * stretch of the previous shot, regenerated rather than copied. The cut room
 * trims them off by default, which leaves a hard cut on a small jump. Dissolving
 * over exactly those frames hides it: the previous shot's last N frames and this
 * file's first N frames are the same moment, so they line up frame for frame.
 *
 * The automatic rule for the seam: the picture dissolves over the overlap and the
 * overlap belongs to the previous clip's sound; this clip's own sound there is not
 * used. When part of the seam was already handled by hand (a dissolve the user set,
 * M frames at the clip's head), that part is left exactly as it is, and the rule
 * applies only to the frames after it, up to the seam.
 *
 * The full plan moves the head back to the file's first frame and the clip's start
 * back by the same amount, so the frame that played at the seam still plays at the
 * seam and nothing after the clip moves. It refuses when that alignment does not
 * hold: a speed change, a head trimmed past the overlap, or a previous shot that
 * was cut short or moved, because then the two do not show the same moment.
 */
export function planSeamDissolve(timeline: Timeline, clipId: string): SeamPlan {
  const clip = timeline.clips.find((c) => c.id === clipId);
  const asset = clip ? timeline.assets[clip.assetId] : undefined;
  if (!clip || !asset) return { ok: false, reason: '找不到这个片段' };
  if (clip.text || clip.seqRef) return { ok: false, reason: '只有链式生成的视频片段才有接缝', quiet: true };
  const overlap = asset.chainHead?.frames ?? 0;
  if (overlap <= 0) return { ok: false, reason: '这个片段的文件没有保留重叠帧（不是接续生成的，或还没展开重叠）', quiet: true };
  if (Math.abs((clip.speed || 1) - 1) > 0.001) return { ok: false, reason: '变速的片段无法按帧对齐，请先把速度改回 1' };

  const previous = timeline.clips
    .filter((c) => c.trackId === clip.trackId && c.id !== clip.id && c.start < clip.start + 1)
    .sort((a, b) => clipEnd(b) - clipEnd(a))[0];
  if (!previous) return { ok: false, reason: '这条轨道上它前面没有片段', quiet: true };

  // Where this file's first non-overlap frame plays now, against where the previous shot ends.
  const revealed = overlap - clip.inFrame;
  const seam = clip.start + revealed;
  if (revealed < 0) return { ok: false, reason: '片头已经被裁到重叠帧之后，没有重叠可用' };
  if (Math.abs(seam - clipEnd(previous)) > 1) {
    return { ok: false, reason: '它和上一段不在接缝上（上一段被挪动或和它之间有空隙）' };
  }
  const before = timeline.assets[previous.assetId];
  if (before && previous.outFrame < (before.timelineFrames || 0) - 1) {
    return { ok: false, reason: '上一段在文件结尾之前就被裁了，接缝处两段不是同一个时刻' };
  }

  const byHand = clip.transitionIn && !clip.transitionIn.seam ? clip.transitionIn : null;
  if (byHand) {
    // The user's own frames stay where and as they are; only what lies after them is the automatic part.
    const mine = Math.max(0, byHand.frames);
    if (revealed <= mine) {
      return { ok: true, kind: 'none', note: '你手动设置的转场已经覆盖了全部重叠帧，没有需要自动处理的部分' };
    }
    return { ok: true, kind: 'rest', from: mine, to: revealed };
  }

  const frames = Math.min(overlap, clipLength(previous) - 1);
  if (frames < 1) return { ok: false, reason: '上一段太短，放不下溶解' };
  return { ok: true, kind: 'full', inFrame: overlap - frames, start: seam - frames, frames };
}

/** The clip as it is after a plan that has something to do. */
export function applySeamPlan(clip: Clip, plan: Extract<SeamPlan, { ok: true }>): Clip {
  if (plan.kind === 'full') {
    return {
      ...clip,
      inFrame: plan.inFrame,
      start: plan.start,
      transitionIn: { type: 'dissolve', frames: plan.frames, seam: true },
      seamMute: { from: 0, to: plan.frames },
    };
  }
  if (plan.kind === 'rest') return { ...clip, seamMute: { from: plan.from, to: plan.to } };
  return clip;
}

const same = (a: Clip['seamMute'], b: Clip['seamMute']) => a?.from === b?.from && a?.to === b?.to;

/** Whether the clip already is exactly what the plan would make it. */
function isDone(clip: Clip, plan: Extract<SeamPlan, { ok: true }>): boolean {
  if (plan.kind === 'none') return true;
  if (plan.kind === 'rest') return same(clip.seamMute, { from: plan.from, to: plan.to });
  return clip.inFrame === plan.inFrame && clip.start === plan.start
    && Boolean(clip.transitionIn?.seam) && clip.transitionIn?.frames === plan.frames
    && same(clip.seamMute, { from: 0, to: plan.frames });
}

export interface SeamBatch {
  timeline: Timeline;
  /** Clips whose seam was handled by this run. */
  applied: string[];
  /** Clips that already were exactly as the rule would leave them. */
  already: string[];
  /** Chained clips that could not be done, with why. */
  blocked: Array<{ clipId: string; reason: string }>;
}

/**
 * The seam rule for every chained shot on the picture lanes, front to back.
 *
 * Each plan leaves the end of its clip where it was, so the next clip's seam still
 * meets the end of this one and the order does not matter; they are planned against
 * the running result all the same. Clips that are not seams are passed over; refusals
 * are reported. A dissolve the user set by hand is never moved or replaced: only the
 * frames after it are taken over.
 */
export function planAllSeamDissolves(timeline: Timeline): SeamBatch {
  const lanes = new Set(timeline.tracks.filter((t) => t.kind === 'video').map((t) => t.id));
  const order = timeline.clips
    .filter((c) => lanes.has(c.trackId) && !c.text && !c.seqRef)
    .sort((a, b) => a.start - b.start)
    .map((c) => c.id);
  const out: SeamBatch = { timeline, applied: [], already: [], blocked: [] };
  for (const id of order) {
    const plan = planSeamDissolve(out.timeline, id);
    if (!plan.ok) {
      if (!plan.quiet) out.blocked.push({ clipId: id, reason: plan.reason });
      continue;
    }
    const clip = out.timeline.clips.find((c) => c.id === id)!;
    if (isDone(clip, plan)) {
      out.already.push(id);
      continue;
    }
    out.timeline = {
      ...out.timeline,
      clips: out.timeline.clips.map((c) => (c.id === id ? applySeamPlan(c, plan) : c)),
    };
    out.applied.push(id);
  }
  return out;
}
