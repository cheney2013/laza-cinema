import { clipEnd, type Timeline } from './types';

const pad = (n: number, width: number) => String(n).padStart(width, '0');

/** SRT time code `HH:MM:SS,mmm` of a frame on the timeline grid. */
export function srtTime(frame: number, fps: number): string {
  const ms = Math.max(0, Math.round((frame / fps) * 1000));
  return `${pad(Math.floor(ms / 3_600_000), 2)}:${pad(Math.floor(ms / 60_000) % 60, 2)}:${pad(Math.floor(ms / 1000) % 60, 2)},${pad(ms % 1000, 3)}`;
}

/**
 * The film's subtitles as an SRT file: every text clip that is not bypassed, in time order.
 * A cue that would run into the next one is cut where the next begins (Bilibili reads overlaps
 * badly); blank lines inside a cue are dropped because a blank line ends a cue in SRT.
 */
export function timelineToSrt(timeline: Timeline): string {
  const cues = timeline.clips
    .filter((c) => c.text && !c.bypassed && c.text.content.trim())
    .map((c) => ({
      start: c.start,
      end: clipEnd(c),
      text: c.text!.content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join('\n'),
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  return cues
    .map((cue, i) => {
      const next = cues[i + 1];
      const end = next && next.start > cue.start ? Math.min(cue.end, next.start) : cue.end;
      return `${i + 1}\n${srtTime(cue.start, timeline.fps)} --> ${srtTime(Math.max(end, cue.start + 1), timeline.fps)}\n${cue.text}\n`;
    })
    .join('\n');
}
