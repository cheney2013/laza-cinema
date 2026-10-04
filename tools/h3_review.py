"""Review gate for H3 clips — picture *and* sound.

The existing `review-clips` gate samples three frames per clip because the failures
that matter are failures of motion. H3 adds a second axis: the clip carries its own
dialogue, foley and room tone, and a silent-but-pretty clip passes every visual check
ever written.

**Count events, don't measure loudness.** The first version of this gate failed a take
whose RMS sat at -39 dBFS with an 8 dB envelope swing — and those footsteps were
perfectly audible on playback. H3 mixes dialogue roughly 20 dB hotter than foley, so
any level-based threshold either fails good foley takes or passes silent ones. Spectral
flux answers the question actually being asked: did the sound event happen?

    backend\\.venv\\Scripts\\python tools\\h3_review.py productions/sound_check/scenes/*.mp4

Writes <production>/review/<name>_sheet.png per clip and prints the report.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

MONO_CORRELATION = 0.995
# A clip with no discernible sound event at all is the one real audio failure. Levels
# are deliberately not gated — see the module docstring.
MIN_ONSETS = 1
DEAD_TRACK_DBFS = -60.0


def probe_frames(src: Path, dest: Path, at: tuple[float, ...] = (0.15, 0.5, 0.85)) -> None:
    """Tile frames sampled through the clip, so motion is judged, not pose.

    Three frames answer "is this shot broadly right". They do **not** answer "did that
    beat happen" — a 0.8s head-lift inside an 11.5s take is missed by 15/50/85% sampling
    far more often than not, and this gate reported "the eye-lift never happens" about a
    take where it plainly does, at 7.4-8.2s. When checking a specific beat, use --dense
    (or --window) and look at the span where it should land.
    """
    n = int(subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames",
         "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", str(src)],
        capture_output=True, text=True, check=True).stdout.strip())
    picks = "+".join(f"eq(n\\,{min(n - 1, int(n * p))})" for p in at)
    cols = 1 if len(at) <= 4 else 3
    rows = -(-len(at) // cols)
    width = 520 if cols == 1 else 300
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", str(src),
         "-vf", f"select='{picks}',scale={width}:-1,"
                f"tile={cols}x{rows}:margin=6:padding=6",
         "-frames:v", "1", str(dest)], check=True)


def audio_stats(src: Path, tmp: Path) -> dict:
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(src), "-vn",
                    "-acodec", "pcm_s16le", str(tmp)], check=True)
    with wave.open(str(tmp)) as w:
        sr, ch, n = w.getframerate(), w.getnchannels(), w.getnframes()
        if n == 0:
            return {"silent": True}
        data = (np.frombuffer(w.readframes(n), dtype=np.int16)
                .reshape(-1, ch).astype(np.float32) / 32768)

    mono = data.mean(axis=1)
    win = max(1, sr // 20)
    env = np.array([
        20 * np.log10(np.sqrt(np.mean(mono[i:i + win] ** 2)) + 1e-12)
        for i in range(0, max(1, len(mono) - win), win)
    ])
    corr = 1.0
    if ch == 2 and np.std(data[:, 0]) > 0 and np.std(data[:, 1]) > 0:
        corr = float(np.corrcoef(data[:, 0], data[:, 1])[0, 1])
    return {
        "silent": False, "sr": sr, "ch": ch, "seconds": n / sr, "env": env, "corr": corr,
        "peak_db": float(20 * np.log10(np.abs(mono).max() + 1e-12)),
        "rms_db": float(20 * np.log10(np.sqrt(np.mean(mono ** 2)) + 1e-12)),
        "onsets": detect_onsets(mono, sr),
    }


def detect_onsets(x: np.ndarray, sr: int,
                  hop: int = 256, win: int = 1024) -> list[tuple[float, float]]:
    """Percussive onsets by spectral flux — footsteps, door slams, syllables.

    Dialogue shows up as a tight run of onsets ~120-150ms apart (one per syllable),
    foley as isolated impacts, so the timing pattern tells the two apart without
    needing to hear them.
    """
    if len(x) < win * 2:
        return []
    window = np.hanning(win)
    frames = np.array([x[i:i + win] * window for i in range(0, len(x) - win, hop)])
    mag = np.abs(np.fft.rfft(frames, axis=1))
    flux = np.maximum(0, np.diff(mag, axis=0)).sum(axis=1)
    peak = flux.max()
    if peak <= 0:
        return []
    flux = flux / peak
    times = np.arange(len(flux)) * hop / sr
    med = float(np.median(flux))
    thresh = med + 0.20 * (1.0 - med)
    out: list[tuple[float, float]] = []
    for i in range(1, len(flux) - 1):
        if flux[i] > thresh and flux[i] >= flux[i - 1] and flux[i] > flux[i + 1]:
            if not out or times[i] - out[-1][0] > 0.12:  # 120ms refractory
                out.append((float(times[i]), float(flux[i])))
    return out


def sparkline(env: np.ndarray, width: int = 64) -> str:
    blocks = " .:-=+*#%@"
    lo, hi = env.min(), max(env.max(), env.min() + 1e-6)
    step = max(1, len(env) // width)
    return "".join(
        blocks[min(len(blocks) - 1, int((env[i] - lo) / (hi - lo) * (len(blocks) - 1)))]
        for i in range(0, len(env), step))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("clips", nargs="+", type=Path)
    ap.add_argument("--review-dir", type=Path,
                    help="where the contact sheets go (default: <clip parent>/../review)")
    ap.add_argument("--dense", type=int, metavar="N",
                    help="sample N frames evenly instead of 3 — use when checking "
                         "whether a specific beat happened, not just whether the shot "
                         "looks right")
    ap.add_argument("--window", metavar="A-B",
                    help="restrict --dense sampling to a time span in seconds, "
                         "e.g. 7-10.5")
    ap.add_argument("--cross", action="store_true",
                    help="also tile one mid-frame from every clip into a single strip. "
                         "Per-clip sheets cannot show continuity: this film passed three "
                         "individual reviews with an empty classroom in scene 1, a full "
                         "one in scenes 2-3, and the camera on the opposite wall between "
                         "them. None of that is visible one clip at a time.")
    args = ap.parse_args()

    problems = 0
    for clip in args.clips:
        if not clip.exists():
            print(f"!! {clip} does not exist")
            problems += 1
            continue
        review = args.review_dir or clip.parent.parent / "review"
        review.mkdir(parents=True, exist_ok=True)
        sheet = review / f"{clip.stem}_sheet.png"
        if args.dense:
            lo, hi = 0.0, 1.0
            if args.window:
                a, b = (float(x) for x in args.window.split("-"))
                dur = float(subprocess.run(
                    ["ffprobe", "-v", "error", "-show_entries", "format=duration",
                     "-of", "csv=p=0", str(clip)],
                    capture_output=True, text=True, check=True).stdout.strip())
                lo, hi = a / dur, b / dur
            at = tuple(lo + (hi - lo) * i / max(1, args.dense - 1)
                       for i in range(args.dense))
        else:
            at = (0.15, 0.5, 0.85)
        probe_frames(clip, sheet, at)
        st = audio_stats(clip, review / f"{clip.stem}_probe.wav")

        print(f"\n=== {clip.name}")
        print(f"    sheet  {sheet}")
        if st["silent"]:
            print("    audio  NO AUDIO TRACK  <-- H3 should always emit one")
            problems += 1
            continue
        print(f"    audio  {st['sr']}Hz {st['ch']}ch {st['seconds']:.2f}s   "
              f"peak {st['peak_db']:+.1f} dBFS   rms {st['rms_db']:+.1f} dBFS   "
              f"L/R corr {st['corr']:.3f}")
        print(f"    env    {sparkline(st['env'])}")
        onsets = st["onsets"]
        marks = "  ".join(f"{t:.2f}s" for t, _ in onsets[:14])
        print(f"    events {len(onsets)} onsets   {marks}"
              + ("  ..." if len(onsets) > 14 else ""))

        if st["rms_db"] < DEAD_TRACK_DBFS or len(onsets) < MIN_ONSETS:
            print("    FAIL   no sound event in the whole clip. Rewrite the audio line "
                  "as present and close-miked; drop every 'quiet' / 'faint' / 'soft'.")
            problems += 1
        if st["ch"] == 2 and st["corr"] > MONO_CORRELATION:
            print(f"    WARN   L/R correlation {st['corr']:.4f} — effectively mono, "
                  "the native stereo did not land.")

    if args.cross and len(args.clips) > 1:
        existing = [c for c in args.clips if c.exists()]
        review = args.review_dir or existing[0].parent.parent / "review"
        strip = review / "cross_scene.png"
        cmd = ["ffmpeg", "-y", "-v", "error"]
        for c in existing:
            cmd += ["-i", str(c)]
        parts, labels = [], []
        for i, c in enumerate(existing):
            n = int(subprocess.run(
                ["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames",
                 "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", str(c)],
                capture_output=True, text=True, check=True).stdout.strip())
            parts.append(f"[{i}:v]select='eq(n\\,{n // 2})',scale=300:-1[s{i}]")
            labels.append(f"[s{i}]")
        parts.append("".join(labels) + f"hstack=inputs={len(existing)}")
        cmd += ["-filter_complex", ";".join(parts), "-frames:v", "1", str(strip)]
        subprocess.run(cmd, check=True)
        print(f"\ncross-scene strip  {strip}")
        print("    check: same room population, same wall behind, characters on the "
              "same sides, props in the same state")

    print(f"\n{len(args.clips)} clip(s), {problems} blocking problem(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
