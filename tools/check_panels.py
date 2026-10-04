"""Compare each storyboard panel against the first frame of its shot.

The first frame of a shot is the model's direct answer to "how is this shot
framed": camera position, lens, who is in it, where they stand. Sampling the
middle of a shot mixes that answer up with drift over time, so a per-shot
head-to-head against the panel is the cleaner check.

    python check_panels.py OUT.png CLIP.mp4 52,80,64,98 panel1.png panel2.png ...

The lengths are the shot lengths in frames, in order; the first frame of shot N
is the sum of the lengths before it. Output is one column per shot, panel on
top and generated first frame below.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

# Ensure UTF-8 output encoding for terminals
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

CELL_W = 420
LABEL_H = 26
GAP = 8
BACKING = (16, 16, 18)


def detect_cuts(clip, want):
    """Find the real cut frames, rather than trusting the nominal ones.

    H3's cuts land a few frames off the times the prompt asks for -- late, in
    practice. Sampling the nominal first frame of a shot then catches the tail
    of the shot before it and the comparison reads as a framing failure when it
    is really a timing offset. So the cuts are measured, and the drift is
    reported: it is worth knowing on its own.
    """
    out = subprocess.run(
        ["ffmpeg", "-loglevel", "info", "-i", str(clip),
         "-vf", "select='gt(scene,0.2)',showinfo", "-f", "null", "-"],
        capture_output=True, text=True)
    frames = []
    for line in out.stderr.splitlines():
        if "showinfo" in line and "pts_time:" in line:
            t = line.split("pts_time:")[1].split()[0]
            frames.append(round(float(t) * 24))
    # Keep the `want` strongest candidates in order, dropping duplicates.
    seen, keep = set(), []
    for f in frames:
        if f > 2 and f not in seen:
            seen.add(f)
            keep.append(f)
    return keep[:want]


def frame_at(clip, n, out):
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(clip),
         "-vf", f"select=eq(n\\,{n})", "-frames:v", "1", str(out)],
        check=True)
    return Image.open(out).convert("RGB")


def get_video_info(clip):
    """Get fps, duration and total frames using ffprobe."""
    cmd = [
        "ffprobe", "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=nb_frames,r_frame_rate,duration",
        "-of", "json", str(clip)
    ]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, check=True)
        info = json.loads(res.stdout)
        stream = info.get("streams", [{}])[0]
        fps_str = stream.get("r_frame_rate", "24/1")
        if "/" in fps_str:
            num, den = fps_str.split("/")
            fps = float(num) / float(den)
        else:
            fps = float(fps_str)
        nb_frames = stream.get("nb_frames")
        if nb_frames and nb_frames.isdigit():
            total_frames = int(nb_frames)
        else:
            duration = float(stream.get("duration", 0))
            total_frames = round(duration * fps) if duration > 0 else 0
        return {"fps": fps, "total_frames": total_frames, "duration": float(stream.get("duration", 0))}
    except Exception:
        return {"fps": 24.0, "total_frames": 0, "duration": 0.0}


def parse_seg_script(script_path, available_stems=None):
    """Parse shot order and nominal lengths from a segNN.py script."""
    try:
        content = script_path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return None, None

    # 1. Docstring shot table: e.g.
    #    1  s5_med_coat    medium, she unhooks...  84 f
    #    2  s5_med_him     medium on him...        64 f  cut 00:03.500
    pattern = r'^\s*(\d+)\s+([a-zA-Z0-9_\-]+)\s+(.*?)\s+(\d+)\s*f(?:\s+cut\s+(\d{1,2}:\d{2}(?:\.\d+)?))?'
    matches = re.findall(pattern, content, re.MULTILINE)
    if matches:
        cand_shots = [m[1] for m in matches]
        cand_lengths = [int(m[3]) for m in matches]
        # Verify these look like real shot identifiers
        if available_stems:
            if any(s.lower() in available_stems for s in cand_shots):
                return cand_shots, cand_lengths
        elif any(re.match(r'^s\d+_', s, re.I) for s in cand_shots):
            return cand_shots, cand_lengths

    # 2. Python code: SHOTS = [("name", ..., frames)]
    m_shots = re.search(r'SHOTS\s*=\s*\[(.*?)\]', content, re.DOTALL)
    if m_shots:
        items = re.findall(r'\(\s*["\']([^"\']+)["\']', m_shots.group(1))
        # Docstring frame lengths: Shots (362 = 70 + 80 + 70 + 70 + 72)
        m_doc = re.search(r'Shots\s*\([^=]+=\s*([0-9\s\+]+)', content)
        lengths = []
        if m_doc:
            lengths = [int(x.strip()) for x in m_doc.group(1).split("+") if x.strip().isdigit()]
        return items, lengths

    return None, None


def find_segment_assets(segdir, panels_arg=None, clip_arg=None):
    """Discover panels, clip, and nominal timing with strict order guarantees."""
    segdir = Path(segdir).resolve()
    if not segdir.is_dir():
        raise SystemExit(f"Error: {segdir} is not a directory")

    # 1. Resolve panels
    png_map = {}
    for p in list(segdir.glob("*.png")) + list(segdir.glob("panels/*.png")):
        name = p.stem.lower()
        if any(k in name for k in ["check", "sheet", "montage", "comparison", "diff"]):
            continue
        png_map[name] = p
        # Also store full filename
        png_map[p.name.lower()] = p

    panels = []
    nominal_starts = []
    nominal_lengths = []

    if panels_arg:
        # User specified exact panel sequence
        names = [x.strip() for x in panels_arg.split(",") if x.strip()]
        for n in names:
            matched = png_map.get(n.lower()) or png_map.get(Path(n).stem.lower())
            if not matched:
                # Try direct path
                direct = Path(n) if Path(n).is_absolute() else (segdir / n)
                if direct.exists():
                    matched = direct
            if not matched:
                raise SystemExit(f"Error: Specified panel not found: '{n}' (in {segdir})")
            panels.append(matched)
    else:
        # Auto-discover from segNN.py in segdir or parent
        script_candidates = []
        for py in segdir.glob("*.py"):
            script_candidates.append(py)
        # Check parent directory (e.g. <dir>/seg05.py for <dir>/seg05_out)
        dir_slug = segdir.name.lower().replace("_out", "").replace("out", "")
        if segdir.parent.exists():
            for py in segdir.parent.glob("*.py"):
                if dir_slug in py.name.lower():
                    script_candidates.append(py)

        shot_order, parsed_lens = None, None
        for py in script_candidates:
            s_order, s_lens = parse_seg_script(py, set(png_map.keys()))
            if s_order:
                shot_order, parsed_lens = s_order, s_lens
                break

        if shot_order:
            for s in shot_order:
                s_lower = s.lower()
                matched = png_map.get(s_lower)
                if not matched:
                    # Partial match
                    for k, p in png_map.items():
                        if s_lower == k or s_lower in k:
                            matched = p
                            break
                if matched and matched not in panels:
                    panels.append(matched)

            if parsed_lens:
                nominal_lengths = parsed_lens
                acc = 0
                for l in nominal_lengths:
                    nominal_starts.append(acc)
                    acc += l

    # Strict check: NEVER fall back to alphabetical guessing!
    if not panels:
        print(f"\n[check_panels] Error: Cannot determine reliable shot order for panels in:")
        print(f"  {segdir}")
        print("\nTo prevent misleading comparisons, alphabetical guessing is strictly disabled.")
        print("Please specify the shot sequence explicitly:")
        print("  python check_panels.py --auto DIR --panels s5_med_coat.png,s5_med_him.png,...\n")
        sys.exit(1)

    # 2. Discover video clip
    clip = None
    if clip_arg:
        cpath = Path(clip_arg) if Path(clip_arg).is_absolute() else (segdir / clip_arg)
        if not cpath.exists():
            raise SystemExit(f"Error: Specified clip not found: {clip_arg}")
        clip = cpath
    else:
        h3_clips = sorted(segdir.glob("H3_Video_*.mp4"), key=lambda p: p.stat().st_mtime, reverse=True)
        if not h3_clips:
            all_mp4 = sorted(segdir.glob("*.mp4"), key=lambda p: p.stat().st_mtime, reverse=True)
            non_previs = [c for c in all_mp4 if "previs" not in c.stem.lower()]
            h3_clips = non_previs if non_previs else all_mp4
        if h3_clips:
            clip = h3_clips[0]

    return panels, clip, nominal_starts, nominal_lengths


def render_comparison_sheet(out, clip, panels, actual, starts=None, cell_w=CELL_W):
    with tempfile.TemporaryDirectory() as tmp:
        shots = [frame_at(clip, n + 2, Path(tmp) / f"f{n}.png") for n in actual]
        tops = [Image.open(p).convert("RGB") for p in panels]

        cell_h = round(cell_w * tops[0].height / tops[0].width)
        sheet = Image.new("RGB",
                          (cell_w * len(panels) + GAP * (len(panels) - 1),
                           cell_h * 2 + GAP + LABEL_H),
                          BACKING)
        draw = ImageDraw.Draw(sheet)

        for i, (top, bot) in enumerate(zip(tops, shots)):
            x = i * (cell_w + GAP)
            got = actual[i]
            want = starts[i] if starts and i < len(starts) else None
            
            # Header label
            if want is not None:
                diff = got - want
                drift_txt = f"{diff:+d}f" if diff != 0 else "0f"
                color = (120, 220, 120) if diff == 0 else ((255, 200, 100) if abs(diff) <= 6 else (255, 120, 120))
                header_text = f"Shot {i + 1}  [Frame {got}]  (drift: {drift_txt})"
            else:
                color = (200, 200, 200)
                header_text = f"Shot {i + 1}  [Frame {got}]"

            draw.text((x + 6, 6), header_text, fill=color)
            sheet.paste(top.resize((cell_w, cell_h), Image.LANCZOS), (x, LABEL_H))
            sheet.paste(bot.resize((cell_w, cell_h), Image.LANCZOS),
                        (x, LABEL_H + cell_h + GAP))

        Path(out).parent.mkdir(parents=True, exist_ok=True)
        sheet.save(out)


def print_report_table(segdir, clip, panels, actual, starts, vinfo):
    fps = vinfo.get("fps", 24.0)
    total_frames = vinfo.get("total_frames", 0)

    print("=" * 96)
    print(f" [check_panels] Segment Batch Verification Report")
    print(f" Directory   : {segdir}")
    print(f" Video Clip  : {clip.name} ({total_frames} frames @ {fps:.1f} fps, {total_frames / fps:.2f}s)")
    print(f" Panels Found: {len(panels)} shots")
    print("=" * 96)
    print(f" {'Shot':<8} | {'Panel File':<26} | {'Actual Frames':<15} | {'Duration':<15} | {'Nominal Cut':<11} | {'Drift (vs Nominal)'}")
    print("-" * 96)

    drifts = []
    for i in range(len(panels)):
        p_name = panels[i].name
        if len(p_name) > 26:
            p_name = p_name[:23] + "..."
        act_start = actual[i]
        act_end = (actual[i+1] - 1) if (i + 1 < len(actual)) else (total_frames - 1 if total_frames else act_start)
        dur_frames = max(1, act_end - act_start + 1)
        dur_sec = dur_frames / fps

        range_str = f"[{act_start:4d} -> {act_end:4d}]"
        dur_str = f"{dur_frames:3d}f ({dur_sec:4.2f}s)"

        if starts and i < len(starts):
            nom = starts[i]
            nom_str = f"{nom:4d}"
            diff = act_start - nom
            if i == 0:
                drift_str = f"{diff:+d} frames" if diff != 0 else "  0 frames"
            else:
                drifts.append(diff)
                if diff > 0:
                    drift_str = f"{diff:+d}f (late {diff / fps:.2f}s)"
                elif diff < 0:
                    drift_str = f"{diff:+d}f (early {abs(diff) / fps:.2f}s)"
                else:
                    drift_str = "  0f (exact)"
        else:
            nom_str = "   N/A"
            drift_str = "   N/A"

        shot_label = f"Shot {i + 1}"
        print(f" {shot_label:<8} | {p_name:<26} | {range_str:<15} | {dur_str:<15} | {nom_str:<11} | {drift_str}")

    print("-" * 96)
    if drifts:
        avg_drift = sum(drifts) / len(drifts)
        max_drift = max(drifts, key=abs)
        print(f" Cut Timing Drift Summary: {len(drifts)} cuts detected | Mean: {avg_drift:+.1f}f ({avg_drift / fps:+.2f}s) | Max: {max_drift:+d}f")
    else:
        print(f" Summary: {len(panels)} shots processed without timing reference")
    print("=" * 96)


def auto_main(segdir_arg, out_arg=None, nominal_arg=None, panels_arg=None, clip_arg=None):
    segdir = Path(segdir_arg).resolve()
    if not segdir.exists():
        raise SystemExit(f"Directory not found: {segdir}")

    panels, clip, nominal_starts, nominal_lengths = find_segment_assets(
        segdir, panels_arg=panels_arg, clip_arg=clip_arg
    )

    if not panels:
        raise SystemExit(f"No panel images found in {segdir} (expected segNN_*.png or *.png)")
    if not clip:
        raise SystemExit(f"No video clip found in {segdir} (expected H3_Video_*.mp4 or *.mp4)")

    # Override nominals if supplied via CLI
    if nominal_arg:
        values = [int(v.strip()) for v in nominal_arg.split(",")]
        # If values are cumulative starts or lengths
        if all(values[i] <= values[i+1] for i in range(len(values)-1)) and values[0] == 0:
            nominal_starts = values
        else:
            acc, starts = 0, []
            for l in values:
                starts.append(acc)
                acc += l
            nominal_starts = starts

    vinfo = get_video_info(clip)
    want_cuts = len(panels) - 1
    cuts = detect_cuts(clip, want_cuts) if want_cuts > 0 else []

    if len(cuts) == want_cuts:
        actual = [0] + cuts
    else:
        if nominal_starts and len(nominal_starts) == len(panels):
            print(f"  ! detected {len(cuts)} cuts, expected {want_cuts} ({cuts}); falling back to nominal frames")
            actual = list(nominal_starts)
        else:
            actual = [0] + cuts

    print_report_table(segdir, clip, panels, actual, nominal_starts, vinfo)

    out_file = Path(out_arg) if out_arg else (segdir / f"{segdir.name}_panel_check.png")
    render_comparison_sheet(out_file, clip, panels, actual, nominal_starts)
    print(f"-> Comparison montage saved to: {out_file}\n")


def main(out, clip, lengths, panels):
    starts, acc = [], 0
    for ln in lengths:
        starts.append(acc)
        acc += ln
    if len(panels) != len(lengths):
        raise SystemExit(f"{len(panels)} panels but {len(lengths)} shot lengths")

    cuts = detect_cuts(clip, len(lengths) - 1)
    if len(cuts) == len(lengths) - 1:
        actual = [0] + cuts
    else:
        # Say so rather than falling back quietly: a silent fallback to the
        # nominal frames is how a 3-frame timing offset got read as a framing
        # failure in the first place.
        print(f"  ! detected {len(cuts)} cuts, expected {len(lengths) - 1} "
              f"({cuts}); falling back to nominal frames")
        actual = list(starts)
    for i, (want, got) in enumerate(zip(starts, actual)):
        note = "" if want == got else f"  ({got - want:+d} frames)"
        print(f"  shot {i + 1}: nominal {want:4d}   actual {got:4d}{note}")

    render_comparison_sheet(out, clip, panels, actual, starts)
    print(f"{out}  {len(panels)} shots, sampled at {[n + 2 for n in actual]}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Compare each storyboard panel against the first frame of its shot."
    )
    parser.add_argument("--auto", metavar="SEGDIR", help="Auto-discover clip and panels in SEGDIR and report cut drift")
    parser.add_argument("--panels", help="Explicit comma-separated panel filenames or slugs in exact shot order")
    parser.add_argument("--clip", help="Explicit video clip path (defaults to newest H3_Video_*.mp4 in SEGDIR)")
    parser.add_argument("-o", "--out", help="Output montage image path")
    parser.add_argument("-n", "--nominal", help="Nominal shot lengths or starts (e.g. 52,80,64,98)")
    parser.add_argument("positional", nargs="*", help="Legacy positional arguments: OUT CLIP LENGTHS PANELS...")

    # Handle cases like `python check_panels.py --auto DIR` or `python check_panels.py DIR --auto`
    if "--auto" in sys.argv:
        auto_idx = sys.argv.index("--auto")
        # Check if DIR is the next arg
        if auto_idx + 1 < len(sys.argv) and not sys.argv[auto_idx + 1].startswith("-"):
            seg_target = sys.argv[auto_idx + 1]
        else:
            # Maybe passed before --auto
            non_flags = [a for a in sys.argv[1:] if not a.startswith("-")]
            seg_target = non_flags[0] if non_flags else "."
        
        # Check for --panels
        panels_val = None
        if "--panels" in sys.argv:
            panels_val = sys.argv[sys.argv.index("--panels") + 1]

        # Check for --clip
        clip_val = None
        if "--clip" in sys.argv:
            clip_val = sys.argv[sys.argv.index("--clip") + 1]

        # Check for -o / --out
        out_val = None
        if "-o" in sys.argv:
            out_val = sys.argv[sys.argv.index("-o") + 1]
        elif "--out" in sys.argv:
            out_val = sys.argv[sys.argv.index("--out") + 1]

        # Check for -n / --nominal
        nom_val = None
        if "-n" in sys.argv:
            nom_val = sys.argv[sys.argv.index("-n") + 1]
        elif "--nominal" in sys.argv:
            nom_val = sys.argv[sys.argv.index("--nominal") + 1]

        auto_main(seg_target, out_val, nom_val, panels_arg=panels_val, clip_arg=clip_val)
    elif len(sys.argv) >= 5:
        # Legacy positional mode: OUT.png CLIP.mp4 52,80,64,98 panel1.png panel2.png ...
        main(sys.argv[1], sys.argv[2],
             [int(v) for v in sys.argv[3].split(",")], sys.argv[4:])
    else:
        parser.print_help()

