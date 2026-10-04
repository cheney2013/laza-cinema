"""Frame-based edit of one stretch of a clip.

A temporal reshot regenerates its window from noise: the frames it replaces are
never shown to the model, so a window that starts on a cut loses the camera.
H3's video edit is the opposite -- the source clip is the model's input, every
frame of it -- but it runs on a whole clip. This joins the two: cut the window
(padded out to an H3 length) from the source, edit that piece, and put back
only the frames of the window, over the untouched rest of the source and its
original audio.

Everything here is plain arithmetic and ffmpeg; the edit itself is the existing
video-edit job.
"""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

FPS = 24


def h3_length_at_least(frames: int) -> int:
    """Smallest H3 clip length (5 + 17k, k >= 1) that holds `frames` frames."""
    frames = max(1, int(frames))
    k = max(1, -(-(frames - 5) // 17))
    return 5 + 17 * k


@dataclass(frozen=True)
class EditWindowPlan:
    start: int          # first frame of the window in the source
    count: int          # frames in the window
    clip_start: int     # first source frame of the piece sent to the edit
    clip_length: int    # frames in that piece (an H3 length)
    offset: int         # where the window starts inside the piece

    def as_dict(self) -> dict:
        return {"start": self.start, "count": self.count, "clip_start": self.clip_start,
                "clip_length": self.clip_length, "offset": self.offset}


def plan_edit_window(source_frames: int, start: int, count: int) -> EditWindowPlan:
    """Place an H3-length piece around [start, start+count) inside the source.

    The padding is split evenly on both sides and pushed inward at the clip's
    ends, so the window sits as close to the middle of the piece as the source
    allows. Raises ValueError when the window does not fit the source or the
    source is shorter than the shortest H3 clip that holds the window.
    """
    source_frames, start, count = int(source_frames), int(start), int(count)
    if count <= 0:
        raise ValueError("edit window must contain at least one frame")
    if start < 0 or start + count > source_frames:
        raise ValueError(
            f"edit window {start}..{start + count} is outside the source's {source_frames} frames")
    length = h3_length_at_least(count)
    if length > source_frames:
        raise ValueError(
            f"a {count}-frame window needs a {length}-frame piece, "
            f"but the source has only {source_frames} frames")
    clip_start = start - (length - count) // 2
    clip_start = max(0, min(clip_start, source_frames - length))
    return EditWindowPlan(start, count, clip_start, length, start - clip_start)


def cut_padded_piece(source: Path, plan: EditWindowPlan, out: Path) -> None:
    """Write the piece the edit runs on: the window's own frames, padded to the
    piece length by holding its first and last frame.

    The padding is never real neighbouring footage. A window that is one shot
    between two cuts would otherwise hand the edit a piece with two cuts in it,
    and the edit is free to move a cut -- the first run on a real clip put four
    frames of the previous shot at eleven and spliced a close-up into the middle
    of a medium shot. Held frames carry no cut to move.
    """
    before = plan.offset
    after = plan.clip_length - plan.count - plan.offset
    vf = (f"fps={FPS},trim=start_frame={plan.start}:end_frame={plan.start + plan.count},"
          f"setpts=N/FRAME_RATE/TB,tpad=start={before}:stop={after}:start_mode=clone:stop_mode=clone")
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(source), "-vf", vf, "-an",
         "-frames:v", str(plan.clip_length), "-c:v", "libx264", "-pix_fmt", "yuv420p",
         "-crf", "16", "-r", str(FPS), str(out)],
        check=True, capture_output=True)


def splice_edit(source: Path, edited: Path, plan: EditWindowPlan, out: Path) -> None:
    """Write `out`: the source with frames of the window taken from `edited`.

    The edited piece is conformed to the source's size and 24 fps first, and the
    audio is the source's own track, untouched. The result has exactly as many
    frames as the source.
    """
    w, h = _video_size(source)
    s, e = plan.start, plan.start + plan.count
    o = plan.offset
    has_audio = _has_audio(source)
    graph = (
        f"[0:v]fps={FPS},setsar=1,split=2[sa][sb];"
        f"[1:v]fps={FPS},scale={w}:{h}:flags=lanczos,setsar=1,"
        f"trim=start_frame={o}:end_frame={o + plan.count},setpts=N/FRAME_RATE/TB[mid];"
        f"[sa]trim=start_frame=0:end_frame={s},setpts=N/FRAME_RATE/TB[head];"
        f"[sb]trim=start_frame={e},setpts=N/FRAME_RATE/TB[tail];"
    )
    parts = []
    if s > 0:
        parts.append("[head]")
    else:
        graph += "[head]nullsink;"
    parts.append("[mid]")
    total = _frame_count(source)
    if e < total:
        parts.append("[tail]")
    else:
        graph += "[tail]nullsink;"
    graph += "".join(parts) + f"concat=n={len(parts)}:v=1:a=0[v]"
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(source), "-i", str(edited),
           "-filter_complex", graph, "-map", "[v]"]
    if has_audio:
        cmd += ["-map", "0:a:0", "-c:a", "aac", "-b:a", "192k", "-ar", "48000"]
    cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", "-r", str(FPS), str(out)]
    subprocess.run(cmd, check=True, capture_output=True)


def seam_differences(video: Path, plan: EditWindowPlan) -> dict:
    """Mean absolute luma difference across each seam, next to the clip's typical step.

    `head`/`tail` are the jumps into and out of the window (None at a clip end);
    `typical` is the median frame-to-frame difference of the whole result, so a
    seam reads as visible when it is well above it.
    """
    import numpy as np

    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(video), "-vf", "scale=160:90,format=gray",
         "-f", "rawvideo", "-"], check=True, capture_output=True).stdout
    frames = np.frombuffer(raw, np.uint8).reshape(-1, 90, 160).astype(np.float32)
    steps = np.abs(np.diff(frames, axis=0)).mean(axis=(1, 2))

    def at(i: int):
        return round(float(steps[i - 1]), 2) if 0 < i <= len(steps) else None

    return {"head": at(plan.start), "tail": at(plan.start + plan.count),
            "typical": round(float(np.median(steps)), 2) if len(steps) else None}


def _video_size(path: Path) -> tuple[int, int]:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=width,height", "-of", "csv=p=0", str(path)],
        check=True, capture_output=True, text=True).stdout.strip()
    w, h = out.splitlines()[0].split(",")[:2]
    return int(w), int(h)


def _frame_count(path: Path) -> int:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0",
         "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", str(path)],
        check=True, capture_output=True, text=True).stdout.strip()
    return int(out.splitlines()[0])


def _has_audio(path: Path) -> bool:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries",
         "stream=index", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True).stdout.strip()
    return bool(out)


# ── Continuation from the tail of a clip ─────────────────────────────────────
#
# A continuation feeds its whole source clip to the model as <Video 1>, and the
# cost grows with that clip. What the next shot has to carry on from is only the
# end: the last shot, or the last few seconds. So the source is cut to its tail
# first. H3 takes a reference video of 2-15 s.

TAIL_MIN_FRAMES = 2 * FPS
TAIL_MAX_FRAMES = 15 * FPS


def last_cut_frame(path: Path, threshold: float = 0.1) -> int:
    """Frame index where the last shot of `path` begins (0 when there is no cut).

    0.1, not the usual 0.3: a cut between two dark night shots scores about 0.19,
    while frames inside a shot stay under 0.03 (measured on the a large scene clips).
    """
    proc = subprocess.run(
        ["ffmpeg", "-v", "info", "-i", str(path), "-an",
         "-vf", f"select='gt(scene,{threshold})',showinfo", "-f", "null", "-"],
        capture_output=True, text=True)
    frames = [int(round(float(m) * FPS)) for m in
              re.findall(r"pts_time:([0-9.]+)", proc.stderr)]
    return frames[-1] if frames else 0


def cuts_inside(path: Path, start: int, count: int, threshold: float = 0.1) -> list[int]:
    """Source frames in (start, start+count) where a new shot begins.

    An edit window that crosses a cut rewrites frames of the next shot too: on
    2026-09-23 a 39-frame window on C17a's 26-frame opening shot turned the first
    13 frames of the following wide shot into more close-up.
    """
    start, end = int(start), int(start) + int(count)
    proc = subprocess.run(
        ["ffmpeg", "-v", "info", "-i", str(path), "-an",
         "-vf", f"trim=start_frame={start}:end_frame={end},setpts=PTS-STARTPTS,"
                f"select='gt(scene,{threshold})',showinfo", "-f", "null", "-"],
        capture_output=True, text=True)
    frames = [start + int(round(float(m) * FPS)) for m in
              re.findall(r"pts_time:([0-9.]+)", proc.stderr)]
    return [f for f in frames if start < f < end]


def plan_tail(total: int, cut: int, tail_frames: int = 0) -> int:
    """First source frame of the tail: `tail_frames` from the end, or from the last cut."""
    total = int(total)
    if total < TAIL_MIN_FRAMES:
        raise ValueError(f"source has {total} frames; a continuation needs at least {TAIL_MIN_FRAMES}")
    start = total - int(tail_frames) if tail_frames and tail_frames > 0 else int(cut)
    start = min(start, total - TAIL_MIN_FRAMES)
    return max(start, total - TAIL_MAX_FRAMES, 0)


def cut_tail(source: Path, start: int, out: Path) -> None:
    """Frames start..end of `source`, with its audio for the same span."""
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(source),
           "-vf", f"trim=start_frame={int(start)},setpts=PTS-STARTPTS"]
    if _has_audio(source):
        cmd += ["-af", f"atrim=start={int(start) / FPS:.6f},asetpts=PTS-STARTPTS", "-c:a", "aac"]
    else:
        cmd += ["-an"]
    cmd += ["-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", str(out)]
    subprocess.run(cmd, check=True)


# ── Trim to a time range ─────────────────────────────────────────────────────

def probe_fps(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=r_frame_rate", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True).stdout.strip()
    try:
        num, _, den = out.splitlines()[0].partition("/")
        fps = float(num) / float(den or 1)
        return fps if fps > 0 else float(FPS)
    except (ValueError, IndexError, ZeroDivisionError):
        return float(FPS)


def plan_trim(total: int, fps: float, start_s: float, end_s: float | None) -> tuple[int, int]:
    """Frame range [start, end) for seconds start_s..end_s, clamped to the clip."""
    start = max(0, int(round(float(start_s) * fps)))
    end = total if end_s is None else min(total, int(round(float(end_s) * fps)))
    if end - start < 1:
        raise ValueError(f"empty trim: frames {start}..{end} of {total}")
    return start, end


def probe_frame_count_fast(path: Path, fps: float) -> int:
    """Frame count from the container header (no decoding), else duration * fps.

    `ffprobe -count_frames` decodes the whole file, which on a feature-length
    source film takes minutes; the header value is exact for mp4/mov.
    """
    def _probe(entries: str, stream: bool) -> str:
        cmd = ["ffprobe", "-v", "error"]
        if stream:
            cmd += ["-select_streams", "v:0"]
        cmd += ["-show_entries", entries, "-of", "csv=p=0", str(path)]
        return subprocess.run(cmd, capture_output=True, text=True).stdout.strip()
    try:
        n = int(_probe("stream=nb_frames", True).splitlines()[0])
        if n > 0:
            return n
    except (ValueError, IndexError):
        pass
    try:
        return int(float(_probe("format=duration", False).splitlines()[0]) * fps)
    except (ValueError, IndexError):
        return 0


def trim_range(source: Path, start: int, end: int, fps: float, out: Path,
               keep_audio: bool = True) -> None:
    """Frames start..end-1 of `source` re-encoded, with audio for the same span.

    Seeks on the input (-ss before -i) so only the span is decoded, not every
    frame before it; seeking half a frame early makes frame `start` the first
    one kept, and -frames:v cuts the exact count.
    """
    count = int(end) - int(start)
    seek = max(0.0, (int(start) - 0.5) / fps)
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{seek:.6f}", "-i", str(source),
           "-frames:v", str(count), "-vf", "setpts=PTS-STARTPTS"]
    if keep_audio and _has_audio(source):
        cmd += ["-af", f"atrim=start={0.5 / fps:.6f}:duration={count / fps:.6f},asetpts=PTS-STARTPTS",
                "-c:a", "aac", "-b:a", "192k"]
    else:
        cmd += ["-an"]
    cmd += ["-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p",
            "-r", f"{fps:g}", "-movflags", "+faststart", str(out)]
    subprocess.run(cmd, check=True)
