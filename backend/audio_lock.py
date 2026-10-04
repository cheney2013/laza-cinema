"""Audio locks for an H3 video node: a recording placed on a second of the clip.

A lock is a recording (a spoken line, an ambience bed) put at a time on the
DELIVERED clip. The builder keeps that stretch of the audio stream exactly as
recorded (AicinemaLockAudioRanges) while the sampler generates everything else
around it; the mouth that speaks a locked line follows the locked sound.

What was measured (2026-10-01, scratch probes; see memory
feedback_h3_ref_audio_timeline):
- a line lands within ~25 ms of where it was put;
- on a chained clip the first `context` frames are the motion-context overlap
  that MotionContextTrim later cuts, so delivered second N is generation second
  N + context/24 (0.94 s measured for 22 frames);
- a lock that reaches into the first ~1.3 s of generation time, where the
  previous clip's tail sound is pinned, broke the clip's first spoken line, so
  a chained clip refuses locks that start before GUARD_SECONDS delivered;
- a range holding only a line is digital silence (-95 dB) wherever the line is
  not: put the ambience in the locked track too, or the room tone drops out.
"""
from __future__ import annotations

import hashlib
import os
import re
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional

FPS = 24.0
GUARD_SECONDS = 0.4          # delivered seconds, chained clips only
MARGIN_SECONDS = 0.05        # lock a little either side of the recording
SAMPLE_RATE = 48000


class AudioLockError(ValueError):
    """The lock cannot be honoured as asked; the message says what to change."""


@dataclass
class LockSpec:
    path: Path                     # the recording on disk
    at: float                      # delivered-clip seconds where it starts
    strength: float = 1.0          # 1 = kept exactly, lower = partly free
    text: str = ""                 # the words, if it is speech (for the <d> check)
    duration: float = 0.0          # filled by probe_duration()
    # Lock only part of the recording (delivered-clip seconds). The recording is
    # still mixed in whole, from `at`; the mask follows [lock_from, lock_to) only.
    # This is how a whole earlier render is used as the ambience: placed at 0, locked
    # from 0.4 s, under a line that is locked on top of it.
    lock_from: Optional[float] = None
    lock_to: Optional[float] = None


@dataclass
class LockPlan:
    ranges: str                    # "a-b:s;a-b:s" on the generation timeline
    offset: float                  # generation seconds minus delivered seconds
    total: float                   # generation seconds (length / 24)
    placements: List[tuple] = field(default_factory=list)   # (spec, generation start)


def context_frames(*, motion_context_latent: str = "", motion_context_video: str = "",
                   motion_context_length: int = 22, existing_context_length: int = 0) -> int:
    """Frames of overlap MotionContextTrim will cut off the front of the clip."""
    if motion_context_video and existing_context_length:
        return int(existing_context_length)
    if motion_context_latent or motion_context_video:
        return int(motion_context_length)
    return 0


def probe_duration(path: Path) -> float:
    out = subprocess.run(
        [os.environ.get("FFPROBE", "ffprobe"), "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(path)], capture_output=True, text=True, check=True).stdout.strip()
    return float(out)


def plan_locks(specs: List[LockSpec], *, length_frames: int, context: int) -> LockPlan:
    if not specs:
        raise AudioLockError("no audio locks given")
    total = length_frames / FPS
    offset = context / FPS
    delivered = total - offset
    parts, placements = [], []
    for i, s in enumerate(specs, 1):
        who = f"audio lock #{i} ({Path(s.path).name})"
        if not 0.0 <= s.strength <= 1.0:
            raise AudioLockError(f"{who}: strength {s.strength} must be between 0 and 1")
        if s.at < 0:
            raise AudioLockError(f"{who}: starts at {s.at}s, before the clip")
        if s.duration <= 0:
            raise AudioLockError(f"{who}: recording has no length")
        end = s.at + s.duration
        if end > delivered + 0.05:
            raise AudioLockError(
                f"{who}: runs to {end:.2f}s but the delivered clip is {delivered:.2f}s "
                f"({length_frames} frames, {context} of them overlap); shorten it or lengthen the clip.")
        # The stretch of the clip this entry actually holds (delivered seconds).
        a = s.at if s.lock_from is None else max(s.at, s.lock_from)
        b = end if s.lock_to is None else min(end, s.lock_to)
        if b <= a:
            raise AudioLockError(f"{who}: lock_from/lock_to leave nothing of the recording to lock")
        if context and s.strength > 0 and a < GUARD_SECONDS:
            raise AudioLockError(
                f"{who}: locks from {a}s, inside the first {GUARD_SECONDS}s of a chained clip where the "
                f"previous clip's sound is pinned (a lock there broke the clip's first line in testing). "
                f"Lock from {GUARD_SECONDS}s or later (lock_from), or put that line in the previous clip.")
        # The mix places the recording at `at`; only the locked stretch gets a margin.
        g0 = s.at + offset
        r0 = max(0.0, a + offset - (MARGIN_SECONDS if s.lock_from is None else 0.0))
        r1 = min(total, b + offset + (MARGIN_SECONDS if s.lock_to is None else 0.0))
        parts.append(f"{r0:.3f}-{r1:.3f}:{s.strength:g}")
        placements.append((s, g0))
    return LockPlan(ranges=";".join(parts), offset=offset, total=total, placements=placements)


def build_track(plan: LockPlan, out_dir: Path) -> str:
    """Mix the recordings onto a silent track as long as the clip; return its file name.

    The name carries a hash of the audio itself: ComfyUI skips a LoadAudio whose
    file name it has already seen, so a changed mix under an old name would
    silently not be used (2026-09 lesson, memory feedback_verify_what_reaches_the_model).
    """
    out_dir = Path(out_dir)
    cmd = [os.environ.get("FFMPEG", "ffmpeg"), "-v", "error", "-y",
           "-f", "lavfi", "-t", f"{plan.total:.3f}", "-i", f"anullsrc=r={SAMPLE_RATE}:cl=stereo"]
    filters = []
    for n, (spec, g0) in enumerate(plan.placements, 1):
        cmd += ["-i", str(spec.path)]
        ms = int(round(g0 * 1000))
        filters.append(f"[{n}:a]aformat=sample_rates={SAMPLE_RATE}:channel_layouts=stereo,"
                       f"adelay={ms}|{ms}[l{n}]")
    ins = "[0:a]" + "".join(f"[l{n}]" for n in range(1, len(plan.placements) + 1))
    filters.append(f"{ins}amix=inputs={len(plan.placements) + 1}:normalize=0:duration=first,"
                   f"atrim=0:{plan.total:.3f}[a]")
    with tempfile.NamedTemporaryFile(suffix=".wav", dir=out_dir, delete=False) as tmp:
        tmp_path = Path(tmp.name)
    try:
        subprocess.run(cmd + ["-filter_complex", ";".join(filters), "-map", "[a]",
                              "-c:a", "pcm_s16le", str(tmp_path)], check=True,
                       capture_output=True, text=True)
        digest = hashlib.sha1(tmp_path.read_bytes()).hexdigest()[:16]
        final = out_dir / f"audiolock_{digest}.wav"
        if final.is_file():
            tmp_path.unlink()
        else:
            tmp_path.replace(final)
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise
    return final.name


_D_TAG = re.compile(r"<d>(.*?)</d>", re.S | re.I)
_LANG_TAG = re.compile(r"^\s*\[[^\]]*\]\s*")


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9一-鿿]+", " ", text.lower()).strip()


def locked_lines_in_prompt(prompt: str, locks: List[LockSpec]) -> List[str]:
    """Locked speech that the prompt also has the model say.

    A `<d>` line the model is asked to speak is generated wherever it likes,
    outside the locked stretch, so the line comes out twice (tested: Tommy's line
    repeated from 5.37 s after a lock ending at 5.25 s). Write only the lines that
    are NOT locked as `<d>`.
    """
    spoken = [_norm(_LANG_TAG.sub("", m)) for m in _D_TAG.findall(prompt or "")]
    hits = []
    for s in locks:
        t = _norm(s.text)
        if t and any(t in d or (d and d in t) for d in spoken):
            hits.append(s.text)
    return hits


_CLAUSE_BREAK = re.compile(r"(?:[.;!?]\s+|\n)")


def strip_locked_lines(prompt: str, locks: List[LockSpec]) -> tuple:
    """The prompt with the clauses that speak locked lines taken out, and what was taken out.

    Redoing a take's sound keeps its picture; the prompt only conditions the new sound, and
    a locked line the prompt also has the model speak comes out twice. Rather than make
    someone keep a second copy of the prompt, cut each `<d>` that is a locked line together
    with the clause around it: from the last sentence or `;` break before it up to the
    closing tag. What was cut is returned so it can be shown. A prompt with no such line
    comes back unchanged.
    """
    removed: List[str] = []
    text = prompt or ""
    for lock in locks:
        wanted = _norm(lock.text)
        if not wanted:
            continue
        for m in _D_TAG.finditer(text):
            spoken = _norm(_LANG_TAG.sub("", m.group(1)))
            if not (wanted in spoken or (spoken and spoken in wanted)):
                continue
            start = 0
            for b in _CLAUSE_BREAK.finditer(text, 0, m.start()):
                start = b.end()
            end = m.end()
            removed.append(text[start:end].strip())
            text = (text[:start] + text[end:]).replace("  ", " ")
            break
    return text.strip(), removed
