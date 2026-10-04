/** Where each [Shot N] starts inside a rendered clip, read from its prompt. */
export interface ShotMark {
  shot: number;
  /** Seconds from the start of the output clip. */
  start: number;
}

/**
 * Parse `[Shot N] At MM:SS.mmm` cut points. [Shot 1] has no timestamp and starts
 * at 0. `offset` is subtracted from every timestamp: a chained segment's prompt
 * counts from the start of its generation, which includes the motion-context
 * overlap that is dropped from the output clip.
 */
export function parseShotMarks(prompt: string, offset = 0): ShotMark[] {
  const marks: ShotMark[] = [];
  const re = /\[Shot (\d+)\](?:\s*At\s+(\d+):(\d+(?:\.\d+)?))?/g;
  const seen = new Set<number>();
  for (const m of prompt.matchAll(re)) {
    const shot = Number(m[1]);
    if (seen.has(shot)) continue;
    if (m[2] === undefined) {
      if (shot !== 1) continue; // a reference like "the man in [Shot 2]" in a summary line
      seen.add(shot);
      marks.push({ shot, start: 0 });
      continue;
    }
    seen.add(shot);
    marks.push({ shot, start: Math.max(0, Number(m[2]) * 60 + Number(m[3]) - offset) });
  }
  return marks.sort((a, b) => a.start - b.start);
}

/** The shot playing at `time` seconds, or null when the prompt has no shots. */
export function shotAt(marks: ShotMark[], time: number): number | null {
  let current: number | null = null;
  for (const mark of marks) {
    if (mark.start <= time + 1e-3) current = mark.shot;
    else break;
  }
  return current ?? (marks[0]?.shot ?? null);
}
