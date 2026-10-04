#!/usr/bin/env python
"""Erase one performer's identity from a clip, keeping their motion and the set.

    backend\\.venv\\Scripts\\python tools\\mask_performer.py --clip src_shot1.mp4 --preview
    backend\\.venv\\Scripts\\python tools\\mask_performer.py --clip src_shot1.mp4 \\
        --out masked_ref.mp4

The output is the source clip with the performer replaced by a flat grey silhouette: their
pose, scale and timing survive, their face and clothing do not. Feed it to
`charswap_test.py` as the reference clip and the replacement character comes from the
reference image alone.

Who gets erased is worked out automatically: SAM3 tracks every person in the clip and the
one holding the most frame area wins. On `productions/h3_charswap/src_shot1.mp4` that
picks the lead — 35.7% mean area against 14.5% for the nearest extra — and lands on the
same person a hand-placed point prompt does. Override with `--object`, or place the points
yourself with `--point` when the performer is not the largest figure in frame.

Why this exists — measured 2026-08-24 on `productions/h3_charswap`, see RUNLOG.md.
`charswap_test.py` needs no matting when the replacement character looks nothing like the
source's performer. When they share a wardrobe it fails, and it fails *bistably*: reference
video and reference image each carry a complete person, the model never blends them, and
whichever conditioning wins takes the whole frame. Five runs with a girl in the same school
tracksuit as the source's boy kept the boy outright; a sixth, on a single-shot reference,
flipped the other way and collapsed 65 of 141 frames into the reference still's studio
backdrop. Masking removes the conflict instead of trying to out-argue it in prose, and the
same prompt then lands the swap with no bleed at all.

Two things to respect:

  * **Verify the mask before generating.** `--preview` writes an overlay video of the mask
    on the source. Auto-selection is a heuristic — a foreground extra can outweigh the
    performer — and a wrong mask otherwise costs a full H3 run to discover.
  * **Multi-shot input is handled, per shot.** SAM3 loses the object across a cut and the
    track silently stops producing a mask, so a clip with cuts is split, masked shot by
    shot and concatenated back into one clip. H3 then reproduces the cut from the masked
    reference to within 2 frames, so the caller still generates once. Cuts are found by
    mean absolute frame difference — `scdet` both misses soft cuts and cries wolf at
    handheld moves (41 false boundaries against 1 real one on this source).

Text conditioning alone will not do the picking: `SAM3_Detect` with "person" returns a
single best match at any threshold down to 0.05, and on this clip that match is an extra,
not the lead. The area ranking over a full `SAM3_VideoTrack` is what separates them.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

from charswap_test import COMFY_OUT, stage, submit  # noqa: E402

SAM3 = "sam3.1_multiplex_fp16.safetensors"
GREY = 8421504  # 0x808080


def probe(clip: Path) -> tuple[int, int, int]:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames",
         "-show_entries", "stream=width,height,nb_read_frames", "-of", "json", str(clip)],
        capture_output=True, text=True, check=True).stdout
    s = json.loads(out)["streams"][0]
    return int(s["width"]), int(s["height"]), int(s["nb_read_frames"])


def cuts(clip: Path) -> list[int]:
    """Frames where the clip cuts, by mean absolute frame difference.

    `scdet` is not usable for this: on a handheld source it reported 41 boundaries at
    threshold 0.02 where there was exactly one real cut, and it misses soft ones. A cut
    stands far outside the clip's own motion distribution, so threshold on that instead.
    """
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(clip), "-vf", "scale=96:168",
                          "-pix_fmt", "gray", "-f", "rawvideo", "-"],
                         capture_output=True).stdout
    if not raw:
        return []
    f = np.frombuffer(raw, np.uint8).reshape(-1, 168, 96).astype(np.int16)
    if f.shape[0] < 5:
        return []
    d = np.abs(np.diff(f, axis=0)).mean(axis=(1, 2))
    med = float(np.median(d))
    out = []
    for i in range(len(d)):
        # All three tests, because any one alone misfires: mean+3sigma flagged six "cuts"
        # in a continuous handheld shot, since with no real outlier the deviation is small
        # and ordinary motion clears the bar.
        if d[i] < 20 or d[i] < 4 * med:
            continue
        nb = [d[k] for k in (i - 2, i - 1, i + 1, i + 2) if 0 <= k < len(d)]
        if nb and d[i] < 2.5 * max(nb):
            continue
        out.append(int(i) + 1)
    return out


def coords(pairs: list[str]) -> str:
    return json.dumps([{"x": int(x), "y": int(y)}
                       for x, y in (p.split(",") for p in pairs)])


def base(clip_name: str) -> dict:
    return {
        "1": {"class_type": "LoadVideo", "inputs": {"file": clip_name}},
        "2": {"class_type": "GetVideoComponents", "inputs": {"video": ["1", 0]}},
        "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": SAM3}},
    }


def tracker(g: dict, text: str, max_objects: int, pos: str, neg: str) -> None:
    """Wire a SAM3 track into `g` under node "10", either point-seeded or text-seeded."""
    if pos:
        # The point prompt only has to be right on frame 0; the track carries it from
        # there. detect_interval is huge on purpose — re-detection would add whoever else
        # walks through frame, and a point prompt means exactly one person is wanted.
        g["3"] = {"class_type": "ImageFromBatch",
                  "inputs": {"image": ["2", 0], "batch_index": 0, "length": 1}}
        g["6"] = {"class_type": "SAM3_Detect",
                  "inputs": {"model": ["4", 0], "image": ["3", 0], "threshold": 0.5,
                             "refine_iterations": 2, "individual_masks": False,
                             "positive_coords": pos, "negative_coords": neg}}
        g["10"] = {"class_type": "SAM3_VideoTrack",
                   "inputs": {"images": ["2", 0], "model": ["4", 0],
                              "detection_threshold": 0.5, "max_objects": 1,
                              "detect_interval": 999, "initial_mask": ["6", 0]}}
    else:
        g["5"] = {"class_type": "CLIPTextEncode",
                  "inputs": {"clip": ["4", 1], "text": text}}
        g["10"] = {"class_type": "SAM3_VideoTrack",
                   "inputs": {"images": ["2", 0], "model": ["4", 0],
                              "detection_threshold": 0.20,
                              "max_objects": max_objects, "detect_interval": 8,
                              "conditioning": ["5", 0]}}


def rank_graph(clip_name: str, text: str, max_objects: int) -> dict:
    """One mask video per tracked object, so their frame areas can be compared."""
    g = base(clip_name)
    tracker(g, text, max_objects, "", "")
    for i in range(max_objects):
        g[f"2{i}"] = {"class_type": "SAM3_TrackToMask",
                      "inputs": {"track_data": ["10", 0], "object_indices": str(i)}}
        g[f"3{i}"] = {"class_type": "MaskToImage", "inputs": {"mask": [f"2{i}", 0]}}
        g[f"4{i}"] = {"class_type": "CreateVideo",
                      "inputs": {"images": [f"3{i}", 0], "fps": 24}}
        g[f"5{i}"] = {"class_type": "SaveVideo",
                      "inputs": {"video": [f"4{i}", 0], "filename_prefix": f"MaskRank{i}",
                                 "format": "mp4", "codec": "h264"}}
    return g


def rank(files: list[str], w: int, h: int) -> list[dict]:
    """Per tracked object: how much frame it holds, and a seed point on it in frame 0.

    Object indices are NOT stable between two SAM3 runs — with re-detection on, the same
    person comes back under a different index — so the winner is carried forward as its
    mask video, not as an index.
    """
    rows = []
    for name in files:
        i = int(name.split("MaskRank")[1].split("_")[0])
        raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(COMFY_OUT / name),
                              "-vf", f"scale={w}:{h}", "-pix_fmt", "gray",
                              "-f", "rawvideo", "-"], capture_output=True).stdout
        m = np.frombuffer(raw, np.uint8).reshape(-1, h, w) > 127
        area = m.mean(axis=(1, 2))
        present = np.flatnonzero(area > 0.002)
        if not len(present):
            continue
        cols = m.sum(axis=(0, 1))
        row = {"obj": i, "present": float((area > 0.002).mean()),
               "area": float(area.mean()), "cx": float(np.nonzero(cols)[0].mean() / w),
               "file": name, "frame": int(present[0])}
        rows.append(row)
    return sorted(rows, key=lambda r: -r["area"])


def out_graph(clip_name: str, w: int, h: int, n: int, text: str, max_objects: int,
              index: int, pos: str, neg: str, expand: int, preview: bool,
              mask_clip: str = "") -> dict:
    """Composite the grey silhouette, or preview the mask over the source.

    `mask_clip` is a mask video already produced by the ranking pass: reusing it skips a
    second SAM3 run and, more importantly, cannot pick a different body. Object indices are
    not stable between runs, and a point re-derived from the mask under-segments — one seed
    point took the mask from 43% of frame down to 28%. The exact mask is the only faithful
    carrier.
    """
    g = base(clip_name)
    if mask_clip:
        g["7"] = {"class_type": "LoadVideo", "inputs": {"file": mask_clip}}
        g["8"] = {"class_type": "GetVideoComponents", "inputs": {"video": ["7", 0]}}
        g["11"] = {"class_type": "ImageToMask",
                   "inputs": {"image": ["8", 0], "channel": "red"}}
    else:
        tracker(g, text, max_objects, pos, neg)
        g["11"] = {"class_type": "SAM3_TrackToMask",
                   "inputs": {"track_data": ["10", 0], "object_indices": str(index)}}
    if preview:
        g["12"] = {"class_type": "MaskToImage", "inputs": {"mask": ["11", 0]}}
        g["13"] = {"class_type": "ImageBlend",
                   "inputs": {"image1": ["2", 0], "image2": ["12", 0],
                              "blend_factor": 0.45, "blend_mode": "normal"}}
        images, prefix = ["13", 0], "MaskPreview"
    else:
        # Grow then feather: SAM3's edge clings to the silhouette, and a few surviving
        # pixels of the original hair or collar are enough to seed the wrong identity.
        g["16"] = {"class_type": "GrowMask",
                   "inputs": {"mask": ["11", 0], "expand": expand, "tapered_corners": True}}
        g["17"] = {"class_type": "FeatherMask",
                   "inputs": {"mask": ["16", 0], "left": 6, "top": 6, "right": 6, "bottom": 6}}
        g["18"] = {"class_type": "EmptyImage",
                   "inputs": {"width": w, "height": h, "batch_size": n, "color": GREY}}
        g["19"] = {"class_type": "ImageCompositeMasked",
                   "inputs": {"destination": ["2", 0], "source": ["18", 0],
                              "x": 0, "y": 0, "resize_source": False, "mask": ["17", 0]}}
        images, prefix = ["19", 0], "MaskedRef"
    g["20"] = {"class_type": "CreateVideo",
               "inputs": {"images": images, "fps": 24, "audio": ["2", 1]}}
    g["21"] = {"class_type": "SaveVideo",
               "inputs": {"video": ["20", 0], "filename_prefix": prefix,
                          "format": "mp4", "codec": "h264"}}
    return g


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--clip", type=Path, required=True,
                    help="single-shot source clip; split at cuts first")
    ap.add_argument("--point", action="append", default=[], metavar="X,Y",
                    help="pixel on the performer in frame 0; skips auto-selection")
    ap.add_argument("--neg", action="append", default=[], metavar="X,Y",
                    help="pixel to keep out of the mask; only with --point")
    ap.add_argument("--text", default="person", help="what to track (default 'person')")
    ap.add_argument("--max-objects", type=int, default=10)
    ap.add_argument("--object", type=int,
                    help="tracked object to erase, skipping the area ranking")
    ap.add_argument("--expand", type=int, default=14,
                    help="grow the mask by N px before compositing (default 14)")
    ap.add_argument("--preview", action="store_true",
                    help="write the mask overlaid on the source instead of the masked clip")
    ap.add_argument("--allow-cuts", action="store_true",
                    help="mask a multi-shot clip anyway; the mask will stop at the cut")
    ap.add_argument("--out", type=Path, help="where to copy the result")
    args = ap.parse_args()

    n = probe(args.clip)[2]
    print(f"[{args.clip.name}] {n}f")

    # SAM3 does not carry an object across a cut, and re-detection cannot recover one
    # either — every slot is already held by someone from the first shot, so the track ends
    # and the mask silently disappears for the rest of the clip. Masking is therefore done
    # one shot at a time. The *output* stays a single multi-shot clip: H3 reproduces a cut
    # in a masked reference to within 2 frames, so there is no reason to make the caller
    # generate per shot.
    cut = cuts(args.clip)
    if cut and not args.allow_cuts:
        print(f"  检测到 {len(cut) + 1} 个镜头，剪切于帧 {', '.join(map(str, cut))}"
              f" —— 逐镜头抠图后拼回")
        parts, tmp = [], args.clip.parent / f"_{args.clip.stem}_shots"
        tmp.mkdir(exist_ok=True)
        for k, (a, b) in enumerate(zip([0] + cut, cut + [n])):
            shot = tmp / f"shot{k + 1}.mp4"
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(args.clip),
                            "-vf", f"trim=start_frame={a}:end_frame={b},setpts=PTS-STARTPTS",
                            "-af", f"atrim=start={a / 24}:end={b / 24},asetpts=PTS-STARTPTS",
                            "-c:v", "libx264", "-crf", "16", "-preset", "veryfast",
                            "-c:a", "aac", str(shot)], check=True)
            print(f"  --- 镜头 {k + 1}/{len(cut) + 1}  帧 {a}-{b}")
            done = tmp / f"masked{k + 1}.mp4"
            rc = run_one(shot, done, args)
            if rc:
                return rc
            parts.append(done.resolve())
        listing = tmp / "concat.txt"
        listing.write_text(
            "".join("file '" + q.as_posix() + "'" + chr(10) for q in parts),
            encoding="utf-8")
        dest = args.out if args.out else args.clip.parent / f"masked_{args.clip.name}"
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0",
                        "-i", str(listing), "-c:v", "libx264", "-crf", "16",
                        "-preset", "veryfast", "-c:a", "aac", str(dest)], check=True)
        print("  ->", dest)
        return 0
    return run_one(args.clip, args.out, args)


def run_one(clip: Path, out: Path | None, args) -> int:
    """Mask one shot. Assumes `clip` has no cut in it."""
    w, h, n = probe(clip)
    clip_name = stage(clip)

    points, mask_clip = args.point, ""
    index = args.object if args.object is not None else 0
    if not points and args.object is None:
        ranked = rank(submit(rank_graph(clip_name, args.text, args.max_objects), 1200),
                      w, h)
        if not ranked:
            print("  跟踪失败：没有对象"); return 1
        print(f"  {'obj':>5s} {'在场':>8s} {'平均面积':>9s} {'水平中心':>9s}")
        for r in ranked:
            print(f"  {r['obj']:5d} {r['present']:8.0%} {r['area']:9.2%} "
                  f"{r['cx']:9.2f}")
        win = ranked[0]
        if len(ranked) > 1 and win["area"] < 1.5 * ranked[1]["area"]:
            print(f"  面积差距小（{win['area']:.1%} vs {ranked[1]['area']:.1%}）——"
                  f"主角未必是最大的那个，先 --preview，必要时 --object/--point")
        if win["present"] < 0.9:
            print(f"  选中对象只在 {win['present']:.0%} 的帧里出现，其余帧不会被抹除")
        mask_clip = stage(COMFY_OUT / win["file"])
        print(f"  -> 选中 obj {win['obj']}（面积最大），复用其掩码 {win['file']}")

    made = submit(out_graph(clip_name, w, h, n, args.text, args.max_objects, index,
                            coords(points), coords(args.neg),
                            args.expand, args.preview, mask_clip), 1200)
    for f in made:
        dest = out if out else clip.parent / f
        shutil.copy2(COMFY_OUT / f, dest)
        print("  ->", dest)
    if made and args.preview:
        print("  检查掩码是否全程贴在目标身上；镜头切换后掩码会静默消失")
    return 0 if made else 1


if __name__ == "__main__":
    raise SystemExit(main())
