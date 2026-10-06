"""
Route splat: several video clips of one continuous camera move -> one gaussian splat in one frame.

Why it exists: a long walk (a street, a corridor) is too long for one reconstruction, and splats made from separate
single pictures do not agree with each other.  A chain of H3 clips continued with motion context does agree.  So:

  1. Sample frames from each clip by how far the picture moves (a few dozen at most per run: WorldMirror's memory
     grows with the frame count); a clip that needs more is reconstructed in parts, chained like clips.
  2. Run WorldMirror 2.0 (HY-World-2.0, reconstruction only) on every clip.  Each run puts the clip's first camera at
     the origin and picks its own scale.  Clip k > 0 also gets the last `shared` sampled frames of clip k-1 (the same
     image files), so those views have a camera in both runs.
  3. From the shared views: rotation = mean of R_prev @ R_next^T (the path is nearly a straight line, so positions alone
     leave the roll about it undetermined), scale from the spread of the shared camera centres, then translation.
     Splats move with the same similarity (positions, log-scales, rotations).
  4. Cut each clip's splat at a plane through the last camera of the clip before it, so the overlap is not doubled.
  5. Opacity is written as a probability by WorldMirror but read as a logit by the viewer and renderer: convert.
     Normals dropped, very large translucent blobs (smoke) dropped.

Nothing here knows about any film: the caller supplies the clips in order.  Units: the first clip's reconstruction unit
is `metres_per_unit` metres (an assumption, WorldMirror has no absolute scale); positions are stored * SCENE_SCALE, as
every other splat of this repository, and the sidecar json says so.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import subprocess
import time
import uuid
import sys
from pathlib import Path
from typing import Callable, Optional

import numpy as np

COMFY_URL = os.environ.get("COMFYUI_URL", "http://127.0.0.1:8188")
COMFY_OUTPUT = os.environ.get("COMFYUI_OUTPUT_DIR", "D:/ComfyUI-sage3/ComfyUI/output")
SAM3_SIZE = 1008          # SAM 3's own input side; frames go in letterboxed to this square
SAM3_CKPT = os.environ.get("SAM3_CKPT", "sam3.1_multiplex_fp16.safetensors")   # in ComfyUI's models/checkpoints
HYWORLD_DIR = Path(os.environ.get("HYWORLD_DIR", "D:/Projects/HY-World-2.0"))
# ProPainter (github.com/sczhou/ProPainter, S-Lab License 1.0: non-commercial use) in its own venv
PROPAINTER_DIR = Path(os.environ.get("PROPAINTER_DIR", "D:/Projects/ProPainter"))
INPAINT_FPS = 30.0        # frames per second of the clip ProPainter sees: it propagates along optical flow
HF_HOME = os.environ.get("FLASHWORLD_HF_HOME", "D:/hf_cache")
SCENE_SCALE = 0.1
MAX_SPLAT = 0.09          # largest gaussian kept, in stored units (0.9 m)
CUT_AHEAD = 0.10          # seam plane this many reconstruction units ahead of the earlier clip's last camera
# Past a seam plane each run keeps the other's gaussians where it has a gap of its own: the later run's first frames
# do not see the ground at the seam (below the picture, behind the walker), the earlier run did, and a hard cut left
# an empty band 1-2 m wide across the path at every seam (route-gs-1136, 2026-10-06).
SEAM_FILL_DEPTH_M = 5.0   # how far past the plane a run may fill the other's gaps ...
SEAM_FILL_RADIUS_M = 6.0  # ... and no further than this from the seam camera: the band is the ground 1.5-5 m ahead of
                          # it; without this limit 85 % of what filled lay further than 6 m (medians 7-12 m: sparse
                          # background both runs hold, filled twice over) and the route grew from 3.7 to 4.6 M
SEAM_FILL_M = 0.3         # a gap: fewer than SEAM_FILL_NEIGHBOURS of the other run's gaussians within this many metres
SEAM_FILL_NEIGHBOURS = 8


# --------------------------------------------------------------------------------------------- frames
def _frame_count(video: Path) -> int:
    out = subprocess.run(
        [os.environ.get("FFPROBE", "ffprobe"), "-v", "error", "-count_frames", "-select_streams", "v:0",
         "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", str(video)],
        capture_output=True, text=True, timeout=300).stdout.strip()
    return int(out) if out.isdigit() else 0


PART_GAP_S = 0.35   # samples at most this far apart in time (d4's 12 s runs, 0.33-0.38 s apart, held) ...
GAP_FLOW = 0.08     # ... and in image motion: this fraction of the frame width (a swing 0.16-0.22 apart lost track
                    # in route-gs-1136 at 720.5 s, 0.06 apart it held)
ONE_RUN_SLACK = 1.4  # a clip stays one run while it needs at most this many times a run's frames


def _flow_profile(video: Path, total: int, width: int = 160) -> np.ndarray:
    """Per frame (length total, first entry 0), how far the picture moved since the frame before, as a fraction of
    the frame width: the median of DIS optical flow on small contrast-equalised grey frames.  That is what decides
    whether two samples still show the same things.  The grey difference the sampler followed before barely rose in
    a dark, fast swing (route-gs-1136 at 720.5 s: 1.4-2.6 against 2.2-3.0 in the calmer stretch before it) where the
    flow stood at six times its median."""
    import cv2
    try:
        _, W, H = _probe(video)
    except Exception:
        W, H = 16, 9
    h = max(2, int(round(width * H / W / 2)) * 2)
    proc = subprocess.run(
        [os.environ.get("FFMPEG", "ffmpeg"), "-v", "error", "-i", str(video), "-vf",
         f"scale={width}:{h}:flags=area,format=gray", "-f", "rawvideo", "-"],
        capture_output=True, timeout=600)
    fr = np.frombuffer(proc.stdout, np.uint8)
    n = min(total, fr.size // (width * h))
    out = np.zeros(total)
    if n < 2:
        return out
    fr = fr[: n * width * h].reshape(n, h, width)
    clahe = cv2.createCLAHE(2.0, (4, 4))
    dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_FAST)
    prev = clahe.apply(fr[0])
    for i in range(1, n):
        cur = clahe.apply(fr[i])
        f = dis.calc(prev, cur, None)
        out[i] = float(np.median(np.hypot(f[..., 0], f[..., 1]))) / width
        prev = cur
    return out


def _demand(total: int, fps: float, step: int, flow: Optional[np.ndarray] = None) -> np.ndarray:
    """The samples each frame asks for: one per PART_GAP_S of time (or per `step` frames, when that is sparser) or
    one per GAP_FLOW of image motion, whichever is more.  Summed over a stretch it is the frames that stretch needs,
    and samples at equal steps of it are never further apart than either allows."""
    gap_frames = max(float(step), PART_GAP_S * fps) if fps else float(max(1, step))
    d = np.full(total, 1.0 / gap_frames)
    if flow is not None and len(flow) >= total:
        d = np.maximum(d, np.asarray(flow[:total], dtype=np.float64) / GAP_FLOW)
    return d


def pick_frame_indices(total: int, count: int, motion: Optional[np.ndarray] = None, mix: float = 0.5) -> list[int]:
    """`count` frame numbers out of `total`: equal steps when there is no motion profile, otherwise equal
    steps of (1 - mix) * uniform + mix * motion, so busy stretches get more frames and still life gets fewer
    but never none (the official HY-World video sampler also follows motion)."""
    count = min(count, total)
    if count >= total:
        return list(range(total))
    w = np.ones(total) / total
    if motion is not None and motion.sum() > 0:
        w = (1 - mix) * w + mix * motion / motion.sum()
    cum = np.cumsum(w)
    cum /= cum[-1]
    idx = np.searchsorted(cum, (np.arange(count) + 0.5) / count)
    return sorted(set(int(min(i, total - 1)) for i in idx))


def sample_frames(video: Path, out_dir: Path, step: int, max_frames: int, width: int = 704,
                  adaptive: bool = True, ends: bool = False, part: Optional[tuple[int, int]] = None,
                  demand: Optional[np.ndarray] = None) -> list[Path]:
    """Frames of the clip as PNG files of the given width, at most `max_frames`. With `adaptive` they follow how far
    the picture moves (_demand: as many as the clip needs to keep them PART_GAP_S apart in time and GAP_FLOW in
    image motion, denser through a swing); otherwise about one every `step` frames; with `ends` evenly spaced from
    the very first frame to the last (a turn made from a picture has to start on that picture). part: only frames
    [start, stop) of the clip (indices.json still counts from the clip's first frame); demand: the clip's _demand,
    if the caller has it already. ffmpeg does the decoding: the backend's venv has no video reader of its own."""
    out_dir.mkdir(parents=True, exist_ok=True)
    total = _frame_count(video)
    if not total:
        raise RuntimeError(f"cannot read {video.name}")
    lo, hi = (max(0, part[0]), min(total, part[1])) if part else (0, total)
    if ends:
        count = min(max_frames, math.ceil((hi - lo) / step))
        idx = sorted(set(int(round(i)) for i in np.linspace(lo, hi - 1, count)))
    elif adaptive:
        if demand is None:
            demand = _demand(total, _probe(video)[0], step, _flow_profile(video, total))
        d = demand[lo:hi]
        count = min(max_frames, max(2, math.ceil(float(d.sum()))))
        idx = [lo + i for i in pick_frame_indices(hi - lo, count, d, mix=1.0)]
    else:
        count = min(max_frames, math.ceil((hi - lo) / step))
        idx = [lo + i for i in pick_frame_indices(hi - lo, count)]
    expr = "+".join(f"eq(n\\,{i})" for i in idx)
    proc = subprocess.run(
        [os.environ.get("FFMPEG", "ffmpeg"), "-v", "error", "-y", "-i", str(video), "-vf",
         f"select='{expr}',scale={width}:-2", "-fps_mode", "vfr", "-frames:v", str(len(idx)),
         str(out_dir / "b_%03d.png")],
        capture_output=True, text=True, timeout=600)
    files = sorted(out_dir.glob("b_*.png"))
    if not files:
        raise RuntimeError("no frames sampled: " + proc.stderr[-800:])
    (out_dir / "indices.json").write_text(json.dumps(idx[:len(files)]))
    return files


# ------------------------------------------------------------------------------------------ WorldMirror
def _venv_python() -> Path:
    python = HYWORLD_DIR / ".venv" / "Scripts" / "python.exe"
    if not python.exists():
        python = HYWORLD_DIR / ".venv" / "bin" / "python"
    if not python.exists():
        raise RuntimeError(f"HY-World-2.0 venv not found under {HYWORLD_DIR}")
    return python


def make_person_masks(frames_dir: Path, mask_dir: Path, dilate: int = 6, timeout: int = 900) -> None:
    """YOLO boxes + SAM 2.1 large person masks for every frame (person_masks_large.py, run in the HY-World venv)."""
    proc = subprocess.run([str(_venv_python()), str(Path(__file__).with_name("person_masks_large.py")), str(frames_dir),
                           str(mask_dir), "--dilate", str(dilate)],
                          capture_output=True, text=True, encoding="utf-8", errors="replace",
                          env=dict(os.environ, HF_HOME=HF_HOME), timeout=timeout)
    if proc.returncode or not any(mask_dir.glob("*.png")):
        raise RuntimeError("person masks failed: " + (proc.stderr or proc.stdout)[-1200:])


def _probe(video: Path) -> tuple[float, int, int]:
    """(fps, width, height) of the first video stream."""
    out = subprocess.run(
        [os.environ.get("FFPROBE", "ffprobe"), "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=avg_frame_rate,width,height", "-of", "json", str(video)], capture_output=True, text=True, timeout=60).stdout
    st = json.loads(out)["streams"][0]
    num, _, den = st["avg_frame_rate"].partition("/")
    return float(num) / float(den or 1), int(st["width"]), int(st["height"])


class RouteCancelled(Exception):
    """The job was cancelled; raised from the next place that checks, after its own children were stopped."""


def _kill_tree(proc: "subprocess.Popen") -> None:
    """Stop a child and everything it started (WorldMirror spawns workers)."""
    if proc.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
    else:
        proc.kill()
    try:
        proc.wait(timeout=30)
    except Exception:
        pass


def comfy_cancel(pids: list) -> None:
    """Take our SAM 3.1 prompts out of ComfyUI's queue and interrupt the one that is running, so a cancelled or
    failed job leaves nothing behind that keeps the card busy."""
    import urllib.request
    ours = set(pids)
    try:
        q = json.loads(urllib.request.urlopen(COMFY_URL + "/queue", timeout=30).read())
        pending = [it[1] for it in q.get("queue_pending", []) if it[1] in ours]
        if pending:
            urllib.request.urlopen(urllib.request.Request(COMFY_URL + "/queue", json.dumps({"delete": pending}).encode(),
                                   {"Content-Type": "application/json"}), timeout=30)
        if any(it[1] in ours for it in q.get("queue_running", [])):
            urllib.request.urlopen(urllib.request.Request(COMFY_URL + "/interrupt", b"", {}), timeout=30)
    except Exception:
        pass


def _drop_sam3(jobs: dict) -> None:
    """Cancel the queued SAM 3.1 windows of these jobs and delete what they wrote or decoded."""
    for jb in jobs.values():
        comfy_cancel(jb["pids"])
        shutil.rmtree(Path(COMFY_OUTPUT) / jb["tag"], ignore_errors=True)
        shutil.rmtree(jb["dense_dir"], ignore_errors=True)


def comfy_free() -> None:
    """Unload ComfyUI's models so WorldMirror has the card."""
    import urllib.request
    try:
        urllib.request.urlopen(urllib.request.Request(COMFY_URL + "/free", json.dumps({"unload_models": True, "free_memory": True}).encode(),
                               {"Content-Type": "application/json"}), timeout=60)
    except Exception:
        pass


def sam3_submit(clip: Path, dense_dir: Path, *, dense_fps: float = 12.0, window: int = 60,
                part: Optional[tuple[int, int]] = None) -> dict:
    """Decode `clip` at `dense_fps` and queue SAM 3.1 video tracking of "person" in ComfyUI (SAM3_VideoTrack).
    The tracker needs consecutive frames, so the whole clip is tracked, in windows of `window` frames: one long
    run loses people in the fire and smoke, and every window starts again by detecting everyone in its first
    frame. All windows are queued at once so ComfyUI runs them back to back. part: only frames [start, stop) of the
    clip (a clip reconstructed in parts). Returns what sam3_collect needs."""
    import urllib.request
    src_fps, W, H = _probe(clip)
    # SAM 3 squeezes every frame to 1008x1008.  Fed a 704x396 frame it stretched people 1.4x wide and 2.5x tall
    # and they were lost in the dark (a running crowd was missed at any threshold), so the frame goes in at
    # 1008 wide, black bars top and bottom, and the bars are cut off again in sam3_collect.
    w = SAM3_SIZE
    h = round(w * H / W / 2) * 2
    pad_top = (SAM3_SIZE - h) // 2
    shutil.rmtree(dense_dir, ignore_errors=True)
    dense_dir.mkdir(parents=True)
    t0, seek = 0.0, []
    if part:
        t0 = part[0] / src_fps
        seek = ["-ss", f"{t0:.4f}", "-t", f"{(part[1] - part[0]) / src_fps:.4f}"]
    subprocess.run([os.environ.get("FFMPEG", "ffmpeg"), "-v", "error", "-y", *seek, "-i", str(clip), "-vf",
                    f"fps={dense_fps},scale={w}:{h},pad={SAM3_SIZE}:{SAM3_SIZE}:0:{pad_top}:black",
                    str(dense_dir / "d_%04d.png")], check=True, timeout=900)
    n_dense = len(list(dense_dir.glob("d_*.png")))
    tag = f"route_sam3/{uuid.uuid4().hex[:10]}"
    pids = []
    for k, start in enumerate(range(0, n_dense, window)):
        wf = {
            "1": {"class_type": "LoadImagesFromFolderKJ", "inputs": {"folder": str(dense_dir), "width": SAM3_SIZE, "height": SAM3_SIZE,
                  "keep_aspect_ratio": "stretch", "image_load_cap": window, "start_index": start}},
            "2": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": SAM3_CKPT}},
            "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "person", "clip": ["2", 1]}},
            "4": {"class_type": "SAM3_VideoTrack", "inputs": {"images": ["1", 0], "model": ["2", 0], "conditioning": ["3", 0],
                  "detection_threshold": 0.3, "max_objects": 64, "detect_interval": 1}},
            "5": {"class_type": "SAM3_TrackToMask", "inputs": {"track_data": ["4", 0], "object_indices": ""}},
            "6": {"class_type": "MaskToImage", "inputs": {"mask": ["5", 0]}},
            "7": {"class_type": "SaveImage", "inputs": {"images": ["6", 0], "filename_prefix": f"{tag}/w{k:02d}_m"}},
        }
        req = urllib.request.Request(COMFY_URL + "/prompt", json.dumps({"prompt": wf}).encode(), {"Content-Type": "application/json"})
        pids.append(json.loads(urllib.request.urlopen(req, timeout=60).read())["prompt_id"])
    return {"pids": pids, "tag": tag, "n_dense": n_dense, "src_fps": src_fps, "dense_fps": dense_fps, "dense_dir": dense_dir,
            "pad_top": pad_top, "inner_h": h, "t0": t0}


def sam3_collect(job: dict, frames_dir: Path, mask_dir: Path, *, dilate: int = 6, timeout: int = 3600,
                 should_stop: Optional[Callable[[], bool]] = None, indices: Optional[list[int]] = None) -> None:
    """Wait for the queued tracking and write a mask for every sampled frame (b_*) in `frames_dir`: the dense
    frame nearest in time, merged with its two neighbours (the people keep moving between dense frames), then
    grown by `dilate` pixels. Frames that are not own samples of the clip (a_*) get no mask here. indices: the
    frames' numbers in the clip, when they are not in frames_dir/indices.json."""
    import urllib.request
    from PIL import Image, ImageChops, ImageFilter
    n_dense, tag = job["n_dense"], job["tag"]
    dense_masks: list[Path] = []
    t0 = time.time()
    for k, pid in enumerate(job["pids"]):
        while True:
            hist = json.loads(urllib.request.urlopen(f"{COMFY_URL}/history/{pid}", timeout=60).read())
            if pid in hist and hist[pid].get("status", {}).get("status_str"):
                st = hist[pid]["status"]
                if st["status_str"] != "success":
                    msg = [m[1].get("exception_message") for m in st.get("messages", []) if m[0] == "execution_error"]
                    raise RuntimeError(f"SAM3 tracking failed in ComfyUI: {msg}")
                break
            if should_stop and should_stop():
                raise RouteCancelled()
            if time.time() - t0 > timeout:
                raise RuntimeError("SAM3 tracking timed out")
            time.sleep(0.5)
        dense_masks += sorted((Path(COMFY_OUTPUT) / tag).glob(f"w{k:02d}_m_*.png"))
    out = Path(COMFY_OUTPUT) / tag
    if len(dense_masks) != n_dense:
        raise RuntimeError(f"SAM3 returned {len(dense_masks)} masks for {n_dense} frames")
    idx = indices if indices is not None else json.loads((frames_dir / "indices.json").read_text())
    mask_dir.mkdir(parents=True, exist_ok=True)
    for f, fi in zip(sorted(frames_dir.glob("b_*.png")), idx):
        j = min(n_dense - 1, max(0, round((fi / job["src_fps"] - job.get("t0", 0.0)) * job["dense_fps"])))
        m = None
        for k in (j - 1, j, j + 1):
            if 0 <= k < n_dense:
                with Image.open(dense_masks[k]) as im:
                    g = im.convert("L").crop((0, job["pad_top"], SAM3_SIZE, job["pad_top"] + job["inner_h"]))
                m = g if m is None else ImageChops.lighter(m, g)
        if dilate:
            m = m.filter(ImageFilter.MaxFilter(2 * dilate + 1))
        m.save(mask_dir / f.name)
    shutil.rmtree(out, ignore_errors=True)
    shutil.rmtree(job["dense_dir"], ignore_errors=True)


def add_box_masks(frames_dir: Path, mask_dir: Path, work: Path, dilate: int = 4) -> None:
    """Add what YOLO + SAM 2.1 large find to the masks SAM 3.1 wrote.  SAM 3.1 tracks well but skips people who
    are small, dark and against a dark street (a running crowd at night); the box detector finds those, and the
    two disagree about different people, so the masks are united."""
    from PIL import Image, ImageChops
    shutil.rmtree(work, ignore_errors=True)
    make_person_masks(frames_dir, work, dilate=dilate)
    for f in sorted(frames_dir.glob("b_*.png")):
        a_path, b_path = mask_dir / f.name, work / f.name
        if not (a_path.exists() and b_path.exists()):
            continue
        with Image.open(a_path) as a, Image.open(b_path) as b:
            a = a.convert("L")
            b = b.convert("L").resize(a.size, Image.NEAREST)
            ImageChops.lighter(a, b).save(a_path)
    shutil.rmtree(work, ignore_errors=True)


def dense_frames(video: Path, out_dir: Path, lo: int, hi: int, every: int, also: list[int], width: int) -> list[int]:
    """Consecutive frames [lo, hi) of the clip, one every `every`, and the frames in `also`, as b_NNNNN.png of the
    given width in frame order (nothing else in the folder: ProPainter reads every file in it). Returns their frame
    numbers."""
    out_dir.mkdir(parents=True, exist_ok=True)
    extra = sorted(i for i in set(also) if lo <= i < hi and (i - lo) % every)
    idx = sorted(set(range(lo, hi, every)) | set(extra))
    expr = f"between(n\\,{lo}\\,{hi - 1})*(not(mod(n-{lo}\\,{every}))" + "".join(f"+eq(n\\,{i})" for i in extra) + ")"
    subprocess.run([os.environ.get("FFMPEG", "ffmpeg"), "-v", "error", "-y", "-i", str(video), "-vf",
                    f"select='{expr}',scale={width}:-2", "-fps_mode", "vfr", "-frames:v", str(len(idx)),
                    str(out_dir / "b_%05d.png")], check=True, capture_output=True, timeout=900)
    n = len(list(out_dir.glob("b_*.png")))
    if n != len(idx):
        raise RuntimeError(f"wanted {len(idx)} frames of {video.name} for inpainting, got {n}")
    return idx


def _propainter_python() -> Path:
    for python in (PROPAINTER_DIR / ".venv" / "Scripts" / "python.exe", PROPAINTER_DIR / ".venv" / "bin" / "python"):
        if python.exists():
            return python
    raise RuntimeError(f"ProPainter is not installed under {PROPAINTER_DIR} (with its own .venv); people can still be "
                       "masked out without inpainting (inpaint_people=false)")


def inpaint_frames(frames_dir: Path, mask_dir: Path, out_dir: Path, timeout: int = 3600,
                   should_stop: Optional[Callable[[], bool]] = None) -> list[Path]:
    """ProPainter on consecutive frames and their person masks: what the people cover is filled with what the frames
    before and after show behind them (optical-flow propagation; a transformer for what no frame saw). In a follow
    shot that is the ground along the route, which no frame shows unmasked up close: the masked build left a hole
    1-1.5 m wide down the whole path, the inpainted one a continuous dirt path (route-gs-1136 part 2, 2026-10-06).
    Returns the inpainted frames in the order of frames_dir's files."""
    python = _propainter_python()
    shutil.rmtree(out_dir, ignore_errors=True)
    out_dir.mkdir(parents=True)
    log = out_dir / "propainter.log"
    with open(log, "w", encoding="utf-8") as fo:
        proc = subprocess.Popen(
            [str(python), "inference_propainter.py", "--video", str(frames_dir), "--mask", str(mask_dir),
             "--output", str(out_dir), "--fp16", "--subvideo_length", "50", "--neighbor_length", "10",
             "--ref_stride", "10", "--mask_dilation", "4", "--save_frames"],
            stdout=fo, stderr=subprocess.STDOUT, cwd=str(PROPAINTER_DIR), text=True)
        t0 = time.time()
        try:
            while proc.poll() is None:
                if should_stop and should_stop():
                    raise RouteCancelled()
                if time.time() - t0 > timeout:
                    raise RuntimeError(f"ProPainter ran longer than {timeout} s")
                time.sleep(0.5)
        except BaseException:
            _kill_tree(proc)
            raise
    files = sorted((out_dir / frames_dir.name / "frames").glob("*.png"))
    want = len(list(frames_dir.glob("*.png")))
    if proc.returncode or len(files) != want:
        raise RuntimeError(f"ProPainter gave {len(files)} of {want} frames: " + log.read_text(encoding="utf-8", errors="replace")[-1500:])
    return files


def composite_inpainted(original: Path, inpainted: Path, mask: Path, out: Path, grow: int = 4) -> None:
    """The original frame with only the masked pixels (grown by `grow`, edge feathered) taken from the inpainted
    one: ProPainter works at a size divisible by 8 and is resized back, which would soften every other pixel."""
    from PIL import Image, ImageFilter
    with Image.open(original) as a, Image.open(inpainted) as b, Image.open(mask) as m:
        a = a.convert("RGB")
        b = b.convert("RGB").resize(a.size, Image.BICUBIC)
        m = m.convert("L").resize(a.size, Image.NEAREST)
        if grow:
            m = m.filter(ImageFilter.MaxFilter(2 * grow + 1)).filter(ImageFilter.GaussianBlur(1.5))
        Image.composite(b, a, m).save(out)


def _paint_masks(clip: Path, cdir: Path, own: list[Path], own_idx: list[int], lo: int, hi: int, width: int,
                 masks: Path, job: Optional[dict] = None, should_stop: Optional[Callable[[], bool]] = None) -> list[int]:
    """For inpainting a run: consecutive frames [lo, hi) of the clip (cdir/pp_frames, INPAINT_FPS, every own frame
    among them), their person masks (cdir/pp_masks: the SAM 3.1 tracking `job` plus YOLO + SAM 2.1 boxes, or the
    boxes alone without a job -- the fallback), and the own frames' masks taken from those (masks/). Returns the
    consecutive frames' numbers."""
    pp, pm, idx_file = cdir / "pp_frames", cdir / "pp_masks", cdir / "pp_indices.json"
    if idx_file.exists() and any(pp.glob("b_*.png")):
        pp_idx = json.loads(idx_file.read_text())
    else:
        shutil.rmtree(pp, ignore_errors=True)
        every = max(1, round(_probe(clip)[0] / INPAINT_FPS))
        pp_idx = dense_frames(clip, pp, lo, hi, every, own_idx, width)
        idx_file.write_text(json.dumps(pp_idx))
    shutil.rmtree(pm, ignore_errors=True)
    if job is not None:
        sam3_collect(job, pp, pm, should_stop=should_stop, indices=pp_idx)
        if should_stop and should_stop():
            raise RouteCancelled()
        add_box_masks(pp, pm, cdir / "box_masks")
    else:
        make_person_masks(pp, pm)
    masks.mkdir(parents=True, exist_ok=True)
    at = {fi: n for n, fi in enumerate(pp_idx)}
    for f, fi in zip(own, own_idx):
        shutil.copy2(pm / f"b_{at[fi] + 1:05d}.png", masks / f.name)
    return pp_idx


def _paint_own(cdir: Path, own: list[Path], own_idx: list[int], pp_idx: list[int], masks: Path,
               should_stop: Optional[Callable[[], bool]] = None) -> None:
    """ProPainter on cdir/pp_frames, composited into the run's own frames in place (composite_inpainted; the frames
    as sampled, people and all, go to cdir/frames_masked); the consecutive frames are removed afterwards."""
    painted = inpaint_frames(cdir / "pp_frames", cdir / "pp_masks", cdir / "pp_out", should_stop=should_stop)
    at = {fi: n for n, fi in enumerate(pp_idx)}
    keep = cdir / "frames_masked"
    keep.mkdir(exist_ok=True)
    for f, fi in zip(own, own_idx):
        shutil.copy2(f, keep / f.name)
        composite_inpainted(keep / f.name, painted[at[fi]], masks / f.name, f)
    for d in ("pp_frames", "pp_out", "pp_masks"):
        shutil.rmtree(cdir / d, ignore_errors=True)
    (cdir / "pp_indices.json").unlink(missing_ok=True)


def sam3_person_masks(clip: Path, frames_dir: Path, mask_dir: Path, dense_dir: Path, **kw) -> None:
    """One clip: sam3_submit + sam3_collect, then free the card."""
    sam3_collect(sam3_submit(clip, dense_dir), frames_dir, mask_dir, **kw)
    comfy_free()


def run_worldmirror(frames_dir: Path, out_dir: Path, timeout: int = 1500, mask_dir: Optional[Path] = None,
                    should_stop: Optional[Callable[[], bool]] = None) -> Path:
    """Run HY-World-2.0's reconstruction on a folder of frames; returns the output folder holding
    gaussians.ply and camera_params.json."""
    python = _venv_python()
    env = dict(os.environ, HF_HOME=HF_HOME)
    # The pipeline ends in an interactive prompt; 'quit' on stdin ends it.  Output goes to files so that
    # the loop below can watch for a cancel instead of blocking in communicate().
    out_dir.mkdir(parents=True, exist_ok=True)
    log_out, log_err = out_dir / "wm.stdout.txt", out_dir / "wm.stderr.txt"
    with open(log_out, "w", encoding="utf-8") as fo, open(log_err, "w", encoding="utf-8") as fe:
        proc = subprocess.Popen(
            [str(python), "-m", "hyworld2.worldrecon.pipeline", "--input_path", str(frames_dir),
             "--output_path", str(out_dir), "--enable_bf16"] + (["--mask_dir", str(mask_dir)] if mask_dir else []),
            stdin=subprocess.PIPE, stdout=fo, stderr=fe, text=True, encoding="utf-8", errors="replace",
            cwd=str(HYWORLD_DIR), env=env)
        try:
            proc.stdin.write("quit\n")
            proc.stdin.close()
        except OSError:
            pass
        t0 = time.time()
        try:
            while proc.poll() is None:
                if should_stop and should_stop():
                    raise RouteCancelled()
                if time.time() - t0 > timeout:
                    raise RuntimeError(f"WorldMirror ran longer than {timeout} s")
                time.sleep(0.5)
        except BaseException:
            _kill_tree(proc)
            raise
    found = sorted(out_dir.rglob("camera_params.json"), key=lambda p: p.stat().st_mtime)
    if not found or not (found[-1].parent / "gaussians.ply").exists():
        tail = (log_err.read_text(encoding="utf-8", errors="replace") or log_out.read_text(encoding="utf-8", errors="replace"))
        raise RuntimeError("WorldMirror produced no splat: " + tail[-1500:])
    return found[-1].parent


# --------------------------------------------------------------------------------------------- geometry
def read_ply(path: Path):
    with open(path, "rb") as fh:
        header = []
        while True:
            line = fh.readline()
            header.append(line)
            if line.strip() == b"end_header":
                break
        names = [ln.split()[-1].decode() for ln in header if ln.startswith(b"property")]
        n = next(int(ln.split()[-1]) for ln in header if ln.startswith(b"element vertex"))
        data = np.frombuffer(fh.read(n * 4 * len(names)), dtype=np.float32).reshape(n, len(names)).copy()
    return header, names, data


def similarity(prev: np.ndarray, nxt: np.ndarray):
    """prev, nxt: (k, 4, 4) camera-to-world of the same views in two runs.  prev ~ s R nxt + t."""
    M = sum(p[:3, :3] @ n[:3, :3].T for p, n in zip(prev, nxt)) / len(prev)
    U, _, Vt = np.linalg.svd(M)
    R = U @ np.diag([1, 1, np.linalg.det(U @ Vt)]) @ Vt
    pp, nn = prev[:, :3, 3], nxt[:, :3, 3]
    pc, nc = pp - pp.mean(0), nn - nn.mean(0)
    s = float(np.sqrt((pc ** 2).sum() / max((nc ** 2).sum(), 1e-12)))
    t = pp.mean(0) - s * (R @ nn.mean(0))
    resid = np.linalg.norm(pp - (s * (nn @ R.T) + t), axis=1)
    rot = [math.degrees(math.acos(float(np.clip((np.trace(R @ n[:3, :3] @ p[:3, :3].T) - 1) / 2, -1, 1))))
           for p, n in zip(prev, nxt)]
    return s, R, t, resid, rot


def _quat(R: np.ndarray) -> np.ndarray:
    w = math.sqrt(max(0.0, 1 + R[0, 0] + R[1, 1] + R[2, 2])) / 2
    x = math.copysign(math.sqrt(max(0.0, 1 + R[0, 0] - R[1, 1] - R[2, 2])) / 2, R[2, 1] - R[1, 2])
    y = math.copysign(math.sqrt(max(0.0, 1 - R[0, 0] + R[1, 1] - R[2, 2])) / 2, R[0, 2] - R[2, 0])
    z = math.copysign(math.sqrt(max(0.0, 1 - R[0, 0] - R[1, 1] + R[2, 2])) / 2, R[1, 0] - R[0, 1])
    return np.array([w, x, y, z])


def _qmul(a, b):
    aw, ax, ay, az = a
    bw, bx, by, bz = b[:, 0], b[:, 1], b[:, 2], b[:, 3]
    return np.stack([aw * bw - ax * bx - ay * by - az * bz, aw * bx + ax * bw + ay * bz - az * by,
                     aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw], axis=1)


def move_splat(data: np.ndarray, names: list[str], s: float, R: np.ndarray, t: np.ndarray) -> np.ndarray:
    ix = [names.index(c) for c in "xyz"]
    data[:, ix] = (data[:, ix] @ R.T) * s + t
    for k in range(3):
        data[:, names.index(f"scale_{k}")] += math.log(s)
    r = [names.index(f"rot_{k}") for k in range(4)]
    data[:, r] = _qmul(_quat(R), data[:, r])
    return data


def _fit_ground(q: np.ndarray, az_lo: float, az_hi: float, rng, r_lo=0.05, r_hi=0.9):
    """Ground plane (unit normal pointing up = -y, distance from the camera) of points in the anchor camera frame
    (x right, y down, z forward), from the points below the camera in an azimuth range; RANSAC then least squares."""
    az = np.degrees(np.arctan2(q[:, 0], q[:, 2]))
    r = np.hypot(q[:, 0], q[:, 2])
    pts = q[(q[:, 1] > 0) & (r > r_lo) & (r < r_hi) & (az > az_lo) & (az < az_hi)]
    if len(pts) < 3000:
        return None
    pts = pts[rng.integers(0, len(pts), min(len(pts), 40000))]
    best = None
    for _ in range(300):
        a, b, c = pts[rng.integers(0, len(pts), 3)]
        n = np.cross(b - a, c - a)
        nn = float(np.linalg.norm(n))
        if nn < 1e-9:
            continue
        n = n / nn
        if n[1] > 0:
            n = -n
        if abs(n[1]) < 0.8:
            continue
        inl = int((np.abs((pts - a) @ n) < 0.004).sum())
        if best is None or inl > best[0]:
            best = (inl, n, a)
    if best is None:
        return None
    _, n, a = best
    P = pts[np.abs((pts - a) @ n) < 0.004]
    if len(P) < 1500:
        return None
    cen = P.mean(0)
    n = np.linalg.svd(P - cen, full_matrices=False)[2][2]
    if n[1] > 0:
        n = -n
    return n.astype(np.float64), abs(float(cen @ n))


def _street_direction(P: np.ndarray, around: float, half: float = 60.0, radius: float = 1.0,
                      samples: int = 6000, seed: int = 0) -> tuple[Optional[float], int]:
    """The direction most walls in plan points P run along: (degrees of azimuth, folded into around +- 90, or None;
    number of line-like neighbourhoods).  P is (n, 2): x right, z forward, metres.  A histogram of the principal
    directions of line-like `radius` neighbourhoods, so the long facades of a street win over jogs, steps and cross
    walls (a straight-line fit through the same points swung by 5-8 degrees with the window)."""
    from scipy.spatial import cKDTree
    rng = np.random.default_rng(seed)
    if len(P) > 150_000:
        P = P[rng.choice(len(P), 150_000, replace=False)]
    if len(P) < 50:
        return None, 0
    tree = cKDTree(P)
    angs, wts = [], []
    for nb in tree.query_ball_point(P[rng.choice(len(P), min(samples, len(P)), replace=False)], radius, workers=-1):
        if len(nb) < 8:
            continue
        X = P[nb] - P[nb].mean(0)
        ev, vec = np.linalg.eigh(X.T @ X)
        lin = 1 - ev[0] / max(ev[1], 1e-12)
        if lin < 0.85:
            continue
        angs.append((math.degrees(math.atan2(vec[0, 1], vec[1, 1])) - around + 90) % 180 - 90)
        wts.append(lin)
    if len(angs) < 200:
        return None, len(angs)
    angs, wts = np.array(angs), np.array(wts)
    keep = np.abs(angs) <= half
    if wts[keep].sum() <= 0:
        return None, len(angs)
    h, e = np.histogram(angs[keep], bins=np.arange(-half, half + 0.5, 0.5), weights=wts[keep])
    k = int(np.argmax(np.convolve(h, np.ones(7) / 7, "same")))
    peak = (e[k] + e[k + 1]) / 2
    m = keep & (np.abs(angs - peak) < 3)
    return around + float(np.average(angs[m], weights=wts[m])), len(angs)


def _mode(x: np.ndarray, lo: float, hi: float, step: float) -> float:
    """Densest value of x (a 3-bin running sum of a histogram), e.g. the wall among the parked cars and poles."""
    h, e = np.histogram(x, bins=np.arange(lo, hi + step, step))
    k = int(np.argmax(np.convolve(h, np.ones(3), "same")))
    return float((e[k] + e[k + 1]) / 2)


def _bend_turn(data: np.ndarray, names: list[str], anchor_ply: Path, anchor_cam: np.ndarray, new_cams: list,
               new_intr: list, metres_per_unit: float) -> tuple[np.ndarray, dict]:
    """Bend the splat of a generated turn (already placed at the anchor camera) onto the route's street.

    Measured on an H3 pan that was asked to turn until it looked back along the street (2026-10-06): the frames fit a
    pure rotation to under a pixel, the rotation chained from them is 146 deg (focal length self-calibrated per third
    of the clip: 666 / 698 / 658 px) and WorldMirror gets 149 deg, yet the last frame looks straight down a street.
    H3 turns the camera less than the street around it: it bends the space it invents.  The reconstruction is right
    about the video; what has to change is the video's world.  In the anchor's frame levelled on the route's ground:

      * the first frame's own content (azimuth up to its half field of view) is the anchor frame: kept;
      * the last frame's content (azimuth from the last heading minus its half field of view) is one coherent street
        view: turned about the anchor's vertical axis by alpha = route street direction - that street's direction,
        both read from the walls (a histogram of local wall directions; about 30 deg on that pan);
      * what H3 invented in between is spread over the gap that leaves (azimuth stretched linearly);
      * across the street, each 5 deg of the turn side is scaled so its wall lands on the route's wall in the same
        5 deg, or on the route's wall beside the anchor where the route has none (a pan gives no parallax, so
        WorldMirror put that wall on an arc ~25% too far), and the far side behind the anchor likewise;
      * the ground gets a vertical offset per 10 deg so it meets the route's ground near the camera; no tilt and no
        scaling: the turn's ground behind the anchor falls the way the route's own ground rises ahead (a slope, not a
        drift), and scaling to a ground height shrank the street behind by a third.
    Gaussians are turned with their azimuth change.  Returns the data and the measured numbers."""
    rng = np.random.default_rng(0)
    mpu = float(metres_per_unit)
    c0, Rc = anchor_cam[:3, 3].astype(np.float64), anchor_cam[:3, :3].astype(np.float64)
    _, onames, old = read_ply(anchor_ply)
    qo = (old[:, [onames.index(c) for c in "xyz"]].astype(np.float64) - c0) @ Rc
    ix = [names.index(c) for c in "xyz"]
    qn = (data[:, ix].astype(np.float64) - c0) @ Rc
    g = _fit_ground(qo.astype(np.float32), -35, 35, rng)
    if g is None:
        return data, {"bend": "skipped: no ground found in the anchor's view"}
    up, h0 = np.asarray(g[0], dtype=np.float64), float(g[1]) * mpu
    fwd = np.array([0.0, 0.0, 1.0]) - up * up[2]
    fwd /= np.linalg.norm(fwd)
    right = np.array([1.0, 0.0, 0.0]) - up * up[0] - fwd * fwd[0]
    right /= np.linalg.norm(right)
    B = np.stack([right, up, fwd], 1)                  # level axes (right, up, forward) in anchor-camera coordinates
    Lo, Ln = qo @ B * mpu, qn @ B * mpu                 # metres, the camera at the origin
    Lo[:, 1] += h0
    Ln[:, 1] += h0                                      # height above the route's ground
    # the turn's headings in this frame (its first camera is the anchor camera) and where its first / last frame end
    R0 = new_cams[0][:3, :3]
    heads = np.degrees(np.unwrap([math.atan2(*((((R0.T @ c[:3, :3])[:, 2]) @ B)[[0, 2]])) for c in new_cams]))
    s = 1.0 if heads[-1] >= heads[0] else -1.0
    t_a = math.degrees(math.atan2(new_intr[0][0, 2], new_intr[0][0, 0]))
    t_b = s * (heads[-1] - heads[0]) - math.degrees(math.atan2(new_intr[-1][0, 2], new_intr[-1][0, 0]))
    rep = {"turn_deg": round(float(s * (heads[-1] - heads[0])), 1), "theta_a": round(t_a, 1), "theta_b": round(t_b, 1)}
    if t_b - t_a < 10:
        return data, {**rep, "bend": "skipped: the turn is shorter than one field of view"}

    def turn_az(L):                                     # azimuth along the turn, in [-90, 270)
        return (s * (np.degrees(np.arctan2(L[:, 0], L[:, 2])) - heads[0]) + 90) % 360 - 90

    def walls(L):
        return (L[:, 1] > 0.6) & (L[:, 1] < 4.0)

    to, tn = turn_az(Lo), turn_az(Ln)
    phi_o, n_o = _street_direction(Lo[walls(Lo) & (np.abs(Lo[:, 2]) < 15) & (np.abs(Lo[:, 0]) < 15)][:, [0, 2]], 0.0)
    last = walls(Ln) & (tn >= t_b) & (np.hypot(Ln[:, 0], Ln[:, 2]) > 4)
    phi_n, n_n = _street_direction(Ln[last][:, [0, 2]], phi_o if phi_o is not None else 0.0)
    if phi_o is None or phi_n is None:
        return data, {**rep, "bend": f"skipped: no street direction (route {n_o}, turn {n_n} wall pieces)"}
    alpha = s * (((phi_o - phi_n) + 90) % 180 - 90)     # along the turn
    rep.update(street_deg=round(phi_o, 2), turn_street_deg=round(phi_n, 2), alpha=round(alpha, 2))
    if abs(alpha) > 60:
        return data, {**rep, "bend": "skipped: the turn's street is more than 60 deg off the route's"}
    tw = np.where(tn <= t_a, tn, np.where(tn >= t_b, tn + alpha, t_a + (tn - t_a) * (t_b + alpha - t_a) / (t_b - t_a)))
    az_w = np.radians(heads[0] + s * tw)
    r = np.hypot(Ln[:, 0], Ln[:, 2])
    Lw = np.stack([r * np.sin(az_w), Ln[:, 1], r * np.cos(az_w)], 1)

    # ground: offset per 10 deg of the bent azimuth, from the densest height 2-7 m from the camera in both splats
    gc, go = [], []
    near_o = (np.hypot(Lo[:, 0], Lo[:, 2]) > 2) & (np.hypot(Lo[:, 0], Lo[:, 2]) < 7) & (Lo[:, 1] > -1.2) & (Lo[:, 1] < 0.6)
    near_n = (r > 2) & (r < 7) & (Lw[:, 1] > -1.2) & (Lw[:, 1] < 0.6)
    for lo in range(-90, 270, 10):
        mo, mn = near_o & (to >= lo) & (to < lo + 10), near_n & (tw >= lo) & (tw < lo + 10)
        if mo.sum() >= 400 and mn.sum() >= 400:
            gc.append(lo + 5.0)
            go.append(_mode(Lo[mo, 1], -1.2, 0.6, 0.04) - _mode(Lw[mn, 1], -1.2, 0.6, 0.04))
    if gc:
        go = [float(np.median(go[max(0, i - 1): i + 2])) for i in range(len(go))]
        Lw[:, 1] += np.interp(tw, gc, go)
        rep["ground_offset_m"] = [round(min(go), 2), round(max(go), 2)]

    # across the street: u along the route's street, v to the turn side
    d = np.array([math.sin(math.radians(phi_o)), math.cos(math.radians(phi_o))])
    nv = s * np.array([d[1], -d[0]])
    P = Lw[:, [0, 2]]
    u, v = P @ d, P @ nv
    uo, vo_ = Lo[:, [0, 2]] @ d, Lo[:, [0, 2]] @ nv
    wo, wn = walls(Lo) & (np.abs(uo) < 5), walls(Lw)      # the route's walls beside the anchor: the seam is there
    k = np.ones(len(v))
    if (wo & (vo_ > 1)).sum() > 500:
        wall_t = _mode(vo_[wo & (vo_ > 1)], 1, 25, 0.2)
        # the target is the route's own wall in the same 5 deg where it has one (its facades step in and out:
        # 5.5 m ahead of the anchor, 6.7 m beside it on the pan this was made on), else the wall beside the anchor
        walls_o = walls(Lo) & (vo_ > 1) & (np.hypot(Lo[:, 0], Lo[:, 2]) < 25)
        kc, kv, tg = [t_a], [1.0], []
        for lo in np.arange(t_a, tw.max(), 5.0):
            m = wn & (v > 1) & (tw >= lo) & (tw < lo + 5)
            if m.sum() >= 300:
                mo = walls_o & (to >= lo) & (to < lo + 5)
                tg.append(_mode(vo_[mo], 1, 25, 0.2) if mo.sum() >= 600 else wall_t)
                kc.append(lo + 2.5)
                kv.append(_mode(v[m], 1, 25, 0.2))
        tg = [float(np.median(tg[max(0, i - 1): i + 2])) for i in range(len(tg))]
        kv = [1.0] + [float(np.clip(t_ / n_, 0.7, 1.3)) for t_, n_ in zip(tg, kv[1:])]
        kv = [kv[0]] + [float(np.median(kv[max(1, i - 1): i + 2])) for i in range(1, len(kv))]
        side = (v > 0) & (tw > t_a)
        k[side] = np.interp(tw[side], kc, kv)
        rep.update(wall_turn_side_m=round(wall_t, 2),
                   across_turn_side={f"{c:.0f}": round(x, 3) for c, x in zip(kc, kv)})
    behind = wn & (v < -1) & (u < -8)
    if (wo & (vo_ < -1)).sum() > 500 and behind.sum() > 500:
        wall_f = _mode(-vo_[wo & (vo_ < -1)], 1, 25, 0.2)
        k_f = float(np.clip(wall_f / _mode(-v[behind], 1, 25, 0.2), 0.7, 1.3))
        far = (v < 0) & (u < 0)
        k[far] = 1 + (k_f - 1) * np.clip(-u[far] / 8, 0, 1)
        rep.update(wall_far_side_m=round(wall_f, 2), across_far_side=round(k_f, 3))
    P = u[:, None] * d + (v * k)[:, None] * nv
    Lw[:, 0], Lw[:, 2] = P[:, 0], P[:, 1]

    Lw[:, 1] -= h0
    data[:, ix] = (((Lw / mpu) @ B.T) @ Rc.T + c0).astype(data.dtype)
    # turn every gaussian by its azimuth change about the vertical: in the (left-handed) level frame a turn of +delta
    # toward +x is a turn of -delta about `up` in the camera's right-handed frame
    ax = Rc @ up
    half = -np.radians(s * (tw - tn)) / 2
    aw, axx, ayy, azz = np.cos(half), np.sin(half) * ax[0], np.sin(half) * ax[1], np.sin(half) * ax[2]
    rc = [names.index(f"rot_{j}") for j in range(4)]
    bw, bx, by, bz = (data[:, c].astype(np.float64) for c in rc)
    data[:, rc] = np.stack([aw * bw - axx * bx - ayy * by - azz * bz, aw * bx + axx * bw + ayy * bz - azz * by,
                            aw * by - axx * bz + ayy * bw + azz * bx, aw * bz + axx * by - ayy * bx + azz * bw], axis=1)
    return data, rep


def append_view_splat(base_ply: Path, out_ply: Path, new_run: Path, anchor_run: Path, anchor_index: int, *,
                      seam_index: Optional[int] = None, metres_per_unit: float = 30.5, min_angle: float = 40.0,
                      to_route: Optional[tuple] = None, fill_only_m: float = 0.5, fill_only_below_deg: float = 110.0,
                      fill_only_neighbours: int = 8, bend: bool = True) -> dict:
    """Add the gaussians of a video that turns (or looks) from a known camera into a finished route splat.

    A video made from one frame of the route (a pan or an orbit that H3 generated from that frame, with the
    camera staying put) shows the space around that camera that the route's own clips never faced.  Its
    WorldMirror run (`new_run`) is aligned to the route through its first camera, which is the anchor frame's
    camera: the rotation and the position follow from the two camera poses, the scale from the ratio of the two
    depth maps of that same view.  Only gaussians more than `min_angle` degrees away from the anchor's viewing
    direction are added (the rest is what the route already holds), and, with `seam_index`, only those on this
    side of the seam plane through that camera of the anchor run (the same cut the route uses between clips).
    `to_route` is the anchor run's own (scale, R, t) into the route frame when the anchor clip is not the first.
    The two reconstructions never agree exactly toward the edge of the old frames (a generated turn is not a rigid
    rotation, and the old side is sparse there), and a wall present in both would show twice; so only gaussians
    with fewer than `fill_only_neighbours` base gaussians within `fill_only_m` metres are added where the two
    overlap (within `fill_only_below_deg` of the anchor's view): a surface the base already holds densely is not
    added twice, a gap in the base is filled.  A plain 'distance to the nearest base gaussian' test is wrong: the
    base's scattered stray gaussians ate holes into the generated street (35% lost), and a hard angle cut left a
    void between where the base ends and where the new part starts.  0 turns this off.
    `bend` (default) unbends a generated turn onto the route's street before any of that (_bend_turn): H3 turns the
    camera less than the street it shows at the end, so the part it invented lies rotated off the route's street.
    base_ply is a route_gs output; out_ply has the same format."""
    def cams(run, key="extrinsics"):
        return [np.array(e["matrix"]) for e in json.loads((run / "camera_params.json").read_text())[key]]
    cn, co = cams(new_run), cams(anchor_run)
    dn = np.load(new_run / "depth" / "depth_0000.npy")
    do = np.load(anchor_run / "depth" / f"depth_{anchor_index:04d}.npy")
    h = dn.shape[0]
    ratio = (do / dn)[: int(h * 0.75), :]          # the street, not the foreground where people were removed
    lo, hi = np.percentile(ratio, [20, 80])
    scale = float(np.median(ratio[(ratio > lo) & (ratio < hi)]))
    R = co[anchor_index][:3, :3] @ np.linalg.inv(cn[0][:3, :3])
    t = co[anchor_index][:3, 3] - scale * R @ cn[0][:3, 3]
    header, names, data = read_ply(new_run / "gaussians.ply")
    io = names.index("opacity")
    pr = np.clip(data[:, io], 1e-4, 1 - 1e-4)
    data[:, io] = np.log(pr / (1 - pr))
    data = move_splat(data, names, scale, R, t)
    ix = [names.index(c) for c in "xyz"]
    report = {}
    if bend:
        data, report = _bend_turn(data, names, anchor_run / "gaussians.ply", co[anchor_index], cn,
                                  cams(new_run, "intrinsics"), metres_per_unit)
    c0, fwd = co[anchor_index][:3, 3], co[anchor_index][:3, 2]
    v = data[:, ix] - c0
    keep = (v @ fwd) / (np.linalg.norm(v, axis=1) + 1e-9) < math.cos(math.radians(min_angle))
    if seam_index is not None:
        cs = co[seam_index]
        keep &= (data[:, ix] - (cs[:3, 3] + CUT_AHEAD * cs[:3, 2])) @ cs[:3, 2] <= 0
    data = data[keep]
    if to_route is not None:
        data = move_splat(data, names, *to_route)
    f = metres_per_unit * SCENE_SCALE
    data[:, ix] *= f
    for k in range(3):
        data[:, names.index(f"scale_{k}")] += math.log(f)
    cols = [i for i, n in enumerate(names) if n not in ("nx", "ny", "nz")]
    data = data[:, cols]
    names2 = [names[i] for i in cols]
    data = data[np.exp(data[:, [names2.index(f"scale_{k}") for k in range(3)]]).max(axis=1) <= MAX_SPLAT]
    bheader, bnames, base = read_ply(base_ply)
    if bnames != names2:
        raise ValueError("the base splat and the new run have different columns")
    if fill_only_m > 0 and len(data):
        from scipy.spatial import cKDTree
        f_ = metres_per_unit * SCENE_SCALE
        c0_final, fwd_final = np.asarray(c0, dtype=np.float64) * f_, np.asarray(fwd, dtype=np.float64)
        if to_route is not None:
            s_, R_, t_ = to_route
            c0_final, fwd_final = (s_ * (R_ @ np.asarray(c0, dtype=np.float64)) + t_) * f_, R_ @ fwd_final
        pos = data[:, [names2.index(c) for c in "xyz"]]
        bpos = base[:, [names2.index(c) for c in "xyz"]]
        lo, hi = pos.min(0) - 1.0, pos.max(0) + 1.0
        near = bpos[((bpos >= lo) & (bpos <= hi)).all(axis=1)]
        if len(near):
            cnt = cKDTree(near).query_ball_point(pos, fill_only_m * SCENE_SCALE, return_length=True, workers=-1)   # metres x SCENE_SCALE
            vnew = pos - c0_final
            ang_deg = np.degrees(np.arccos(np.clip((vnew @ fwd_final) / (np.linalg.norm(vnew, axis=1) + 1e-9), -1, 1)))
            data = data[~((cnt >= fill_only_neighbours) & (ang_deg < fill_only_below_deg))]
    allg = np.concatenate([base, data])
    props = [ln for ln in bheader if ln.startswith(b"property")]
    out_header = b"".join((b"element vertex %d\n" % len(allg)) if ln.startswith(b"element vertex") else ln
                          for ln in bheader if not ln.startswith(b"property") and ln.strip() != b"end_header")
    out_header += b"".join(props) + b"end_header\n"
    out_ply.parent.mkdir(parents=True, exist_ok=True)
    with open(out_ply, "wb") as fh:
        fh.write(out_header)
        fh.write(np.ascontiguousarray(allg, dtype=np.float32).tobytes())
    return {"base": int(len(base)), "added": int(len(data)), "scale": scale, **report}


# --------------------------------------------------------------------------------------------- pipeline
PIPELINE_VERSION = "4"    # bump when frame sampling or masking changes: old cache entries then stop matching
                          # (4: samples follow optical flow, long clips in parts)


POSE_JUMP = 5.0     # a camera step this many times the route's median speed is reported as a break


def _clip_key(clip: Path, prev_key: str, frame_step, shared, max_frames, adaptive, mask_people, mask_fallback, index,
              frame_width=704, version: Optional[str] = None, part: Optional[tuple[int, int]] = None,
              inpaint: bool = False) -> str:
    h = hashlib.sha1()
    with open(clip, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    h.update(json.dumps([version or PIPELINE_VERSION, prev_key, frame_step, shared, max_frames, adaptive, mask_people,
                         mask_fallback, index > 0, frame_width]).encode())
    if part:            # a clip in one run is keyed as it always was
        h.update(json.dumps({"part": [int(part[0]), int(part[1])]}).encode())
    if inpaint:         # and so is one whose people are masked rather than inpainted
        h.update(b'{"inpaint": "propainter"}')
    return h.hexdigest()[:20]


def _clip_parts(total: int, fps: float, step: int, budget: int, own_budget: int,
                flow: Optional[np.ndarray] = None) -> list[Optional[tuple[int, int]]]:
    """How a clip is reconstructed: [None] is one run, as always; otherwise the frame ranges [start, stop) of
    consecutive parts, each a WorldMirror run of its own chained to the part before through shared frames, like
    the clips of a route.  A clip is split when it needs (_demand) more than ONE_RUN_SLACK times the `budget` frames
    of one run: 28 s of the original game in one run, 0.78 s apart, lost track in a fast swing at 720.5 s and put
    the last three seconds 20.7 m back down the route; in three parts, 0.3 s apart, it still did; with the swing
    0.07 s apart it held (route-gs-1136, 2026-10-06).  The parts take equal shares of the need at `own_budget`
    frames (a later part also carries the shared frames), and each cut moves to the calmest half second within a
    sixth of a part of it: the shared frames should not be a swing."""
    if not total or not fps or step <= 0 or budget <= 0:
        return [None]
    d = _demand(total, fps, step, flow)
    need = float(d.sum())
    if need <= budget * ONE_RUN_SLACK:
        return [None]
    n = max(2, math.ceil(need / max(1, own_budget)))
    cum = np.cumsum(d)
    size = total / n
    smooth = None
    if flow is not None and len(flow) >= total:
        win = max(1, int(round(fps / 2)))
        smooth = np.convolve(np.asarray(flow[:total], dtype=np.float64), np.ones(win) / win, mode="same")
    cuts = []
    for k in range(1, n):
        c = int(np.searchsorted(cum, k * need / n))
        if smooth is not None:
            r = max(1, int(size / 6))
            lo, hi = max(1, c - r), min(total - 1, c + r + 1)
            near = np.abs(np.arange(lo, hi) - c) * 1e-12          # ties (a still stretch) stay at the even cut
            c = lo + int(np.argmin(smooth[lo:hi] + near))
        cuts.append(min(max(c, 1), total - 1))
    edges = sorted({0, total, *cuts})
    return [(edges[i], edges[i + 1]) for i in range(len(edges) - 1)]


def _pose_breaks(route: list, times: list) -> list[dict]:
    """Steps between consecutive route cameras far faster than the route's median: WorldMirror lost track there and
    put frames where the camera cannot have been (route-gs-1136 before parts: 20.7 m in 0.78 s, 11x the median).
    times: per route camera (clip number, seconds into that clip) or None; no step is timed across two clips."""
    P = np.asarray(route, dtype=np.float64)
    if len(P) < 3 or len(times) != len(P):
        return []
    steps = np.linalg.norm(np.diff(P, axis=0), axis=1)
    speeds = []
    for i in range(1, len(P)):
        a, b = times[i - 1], times[i]
        ok = a is not None and b is not None and a[0] == b[0] and b[1] > a[1]
        speeds.append(steps[i - 1] / (b[1] - a[1]) if ok else None)
    valid = [v for v in speeds if v is not None]
    if not valid:
        return []
    med = float(np.median(valid))
    out = []
    for i, v in enumerate(speeds):
        if v is not None and med > 0 and v > POSE_JUMP * med and steps[i] > 1.0:
            out.append({"clip": int(times[i][0]), "from_s": round(float(times[i][1]), 2),
                        "to_s": round(float(times[i + 1][1]), 2), "jump_m": round(float(steps[i]), 2),
                        "times_median_speed": round(float(v / med), 1)})
    return out


def _align_runs(runs: list[dict]) -> tuple[list[tuple], list[dict]]:
    """Transform (s, R, t) of every clip's reconstruction into clip 0's frame, from the cameras of the frames each
    clip repeats from the one before, and the residuals of each seam."""
    T = [(1.0, np.eye(3), np.zeros(3))]
    report = []
    for i in range(1, len(runs)):
        k = runs[i]["n_shared"]
        prev_last = runs[i - 1]["cams"][-k:]          # the clip before ended on these sampled frames
        this_first = runs[i]["cams"][:k]
        s, R, t, resid, rot = similarity(prev_last, this_first)
        sp, Rp, tp = T[i - 1]
        T.append((sp * s, Rp @ R, sp * (Rp @ t) + tp))
        report.append({"seam": f"{i - 1}->{i}", "scale": s, "centre_residual_units": [float(r) for r in resid],
                       "rotation_residual_deg": [float(r) for r in rot]})
    return T, report


def _run_dir(out: Path) -> Path:
    """The WorldMirror result folder under a clip's out/ (the newest one holding camera_params.json)."""
    found = sorted(out.rglob("camera_params.json"), key=lambda p: p.stat().st_mtime)
    if not found:
        raise RuntimeError(f"no WorldMirror result under {out}")
    return found[-1].parent


def _manifest(clips: list[Path], cdirs: list[Path], runs: list[dict], T: list[tuple], metres_per_unit: float,
              frame_width: int, settings: Optional[dict] = None, parts: Optional[list] = None) -> dict:
    """What a later step needs to place something on a finished route: per clip its cache folder, WorldMirror
    run, sampled frames (file names and frame numbers in the clip) and its transform into the route frame.
    n_shared / n_tail: the run's frames before / after the clip's own that repeat a neighbouring clip's.
    A clip reconstructed in parts has one entry per part, each with its frame range ("part")."""
    entries = []
    for k, (clip, cdir, run, (sc, R, t)) in enumerate(zip(clips, cdirs, runs, T)):
        done = cdir / "done.json"
        own = json.loads(done.read_text())["own"] if done.exists() else sorted(f.name for f in (cdir / "frames").glob("b_*.png"))
        idx = cdir / "frames" / "indices.json"
        try:
            fps = _probe(clip)[0]
        except Exception:
            fps = None
        entries.append({"clip": str(clip), "cache": str(cdir), "run": str(run["dir"]), "n_shared": int(run["n_shared"]),
                        "n_tail": int(run.get("n_tail", 0)),
                        "own": own, "indices": json.loads(idx.read_text()) if idx.exists() else None, "fps": fps,
                        "transform": {"s": float(sc), "R": np.asarray(R).tolist(), "t": np.asarray(t).tolist()}})
        if parts and parts[k]:
            entries[-1]["part"] = [int(parts[k][0]), int(parts[k][1])]
    out = {"metres_per_unit": metres_per_unit, "frame_width": frame_width, "clips": entries}
    if settings:
        out["settings"] = settings
    return out


def _run_cams(run_dir: Path) -> np.ndarray:
    """Camera-to-world matrices of a WorldMirror run, in its frame order."""
    j = json.loads((run_dir / "camera_params.json").read_text(encoding="utf-8"))
    return np.array([c["matrix"] for c in j["extrinsics"]])


def _cam_in_route(run: dict, T: tuple, idx: int) -> np.ndarray:
    s, R, t = T
    m = run["cams"][idx]
    c = np.eye(4)
    c[:3, :3] = R @ m[:3, :3]
    c[:3, 3] = s * (R @ m[:3, 3]) + t
    return c


def _gaps(P: np.ndarray, cand: np.ndarray, other: np.ndarray, r: float) -> np.ndarray:
    """Rows of P among `cand` with fewer than SEAM_FILL_NEIGHBOURS points of `other` within r."""
    out = np.zeros(len(P), dtype=bool)
    idx = np.nonzero(cand)[0]
    if not len(idx):
        return out
    if not len(other):
        out[idx] = True
        return out
    from scipy.spatial import cKDTree
    cnt = cKDTree(other).query_ball_point(P[idx], r, return_length=True, workers=-1)
    out[idx[np.asarray(cnt) < SEAM_FILL_NEIGHBOURS]] = True
    return out


def _merge_runs(runs: list[dict], T: list[tuple], out_ply: Path, metres_per_unit: float,
                max_gaussians: int = 0, seam_fill: bool = False) -> tuple[int, list, Optional[list]]:
    """Write the route splat of runs in route order (dir, cams, n_shared, n_tail) and their transforms into the route
    frame: each run's splat is moved into that frame and cut at the seam planes, each through the last camera of the
    run before it, along its heading, CUT_AHEAD ahead (the earlier run keeps what lies behind, the later what lies
    beyond). Returns the gaussian count, the route's own cameras in metres (x right, y down, z forward), where a
    render camera can stand, and each run's rows [first, end) in the file (None when max_gaussians reordered them)."""
    parts, header, names = [], None, None
    for run, (s, R, t) in zip(runs, T):
        h, nm, d = read_ply(run["dir"] / "gaussians.ply")
        header, names = h, nm
        io = names.index("opacity")
        p = np.clip(d[:, io], 1e-4, 1 - 1e-4)
        d[:, io] = np.log(p / (1 - p))
        parts.append(move_splat(d, names, s, R, t))

    ix = [names.index(c) for c in "xyz"]
    planes, seam_cams = [], []
    for i in range(len(runs) - 1):
        c = _cam_in_route(runs[i], T[i], -1)
        planes.append((c[:3, 3] + CUT_AHEAD * c[:3, 2], c[:3, 2]))
        seam_cams.append(c[:3, 3])
    keep = []
    for i, d in enumerate(parts):
        m = np.ones(len(d), dtype=bool)
        if i > 0:
            pc, pf = planes[i - 1]
            m &= (d[:, ix] - pc) @ pf > 0
        if i < len(planes):
            pc, pf = planes[i]
            m &= (d[:, ix] - pc) @ pf <= 0
        keep.append(m)
    if seam_fill and metres_per_unit > 0:      # each side of a seam fills the other's gaps near it (SEAM_FILL_*)
        r, depth = SEAM_FILL_M / metres_per_unit, SEAM_FILL_DEPTH_M / metres_per_unit
        reach = SEAM_FILL_RADIUS_M / metres_per_unit
        for i, (pc, pf) in enumerate(planes):
            a, b = parts[i][:, ix].astype(np.float64), parts[i + 1][:, ix].astype(np.float64)
            da, db = (a - pc) @ pf, (b - pc) @ pf          # > 0: past the seam, the later run's side
            ra = np.linalg.norm(a - seam_cams[i], axis=1) <= reach
            rb = np.linalg.norm(b - seam_cams[i], axis=1) <= reach
            near_b = keep[i + 1] & (db > -r) & (db <= depth + r) & (np.linalg.norm(b - seam_cams[i], axis=1) <= reach + r)
            keep[i] |= _gaps(a, ~keep[i] & (da > 0) & (da <= depth) & ra, b[near_b], r)
            near_a = keep[i] & (da < r) & (da >= -depth - r) & (np.linalg.norm(a - seam_cams[i], axis=1) <= reach + r)
            keep[i + 1] |= _gaps(b, ~keep[i + 1] & (db <= 0) & (db >= -depth) & rb, a[near_a], r)
    kept = [d[m] for d, m in zip(parts, keep)]
    sizes = [len(d) for d in kept]
    data = np.concatenate(kept)

    f = metres_per_unit * SCENE_SCALE
    data[:, ix] *= f
    for k in range(3):
        data[:, names.index(f"scale_{k}")] += math.log(f)
    cols = [i for i, n in enumerate(names) if n not in ("nx", "ny", "nz")]
    data = data[:, cols]
    names2 = [names[i] for i in cols]
    big = np.exp(data[:, [names2.index(f"scale_{k}") for k in range(3)]]).max(axis=1) > MAX_SPLAT
    edges = np.cumsum([0] + sizes)
    counts = [int((~big[edges[i]:edges[i + 1]]).sum()) for i in range(len(sizes))]
    rows = [[int(a), int(b)] for a, b in zip(np.cumsum([0] + counts)[:-1], np.cumsum(counts))]
    data = data[~big]
    if max_gaussians and len(data) > max_gaussians:    # 0 = keep every gaussian
        data = data[np.argsort(-data[:, names2.index("opacity")])[:max_gaussians]]
        rows = None
    props = [ln for ln in header if ln.startswith(b"property") and ln.split()[-1].decode() in names2]
    out_header = b"".join((b"element vertex %d\n" % len(data)) if ln.startswith(b"element vertex") else ln
                          for ln in header if not ln.startswith(b"property") and ln.strip() != b"end_header")
    out_header += b"".join(props) + b"end_header\n"
    out_ply.parent.mkdir(parents=True, exist_ok=True)
    with open(out_ply, "wb") as fh:
        fh.write(out_header)
        fh.write(np.ascontiguousarray(data, dtype=np.float32).tobytes())

    route = []
    for run, Ti in zip(runs, T):
        for idx in range(run["n_shared"], len(run["cams"]) - run.get("n_tail", 0)):
            route.append((_cam_in_route(run, Ti, idx)[:3, 3] * metres_per_unit).tolist())
    return int(len(data)), route, rows


def _write_route_sidecars(out_ply: Path, route: list, report: list, gaussians: int, metres_per_unit: float,
                          source: str, extra: Optional[dict] = None) -> float:
    """<ply>.json (units, scale, route length), <ply>_cams.json (route cameras, metres), <ply>_stitch.json (seams)."""
    length = float(np.linalg.norm(np.diff(np.array(route), axis=0), axis=1).sum()) if len(route) > 1 else 0.0
    out_ply.with_suffix(".json").write_text(json.dumps({
        "source": source, "frame": "picture_camera_opencv",
        "units": "metres", "scene_scale": SCENE_SCALE, "trajectory": "video", "gaussians": int(gaussians),
        "metres_per_unit": metres_per_unit, "route_length_m": length, **(extra or {})}), encoding="utf-8")
    out_ply.with_name(out_ply.stem + "_cams.json").write_text(json.dumps(route), encoding="utf-8")
    out_ply.with_name(out_ply.stem + "_stitch.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    return length


def _manifest_runs(manifest: dict) -> tuple[list[dict], list[tuple]]:
    """The runs and transforms a manifest names, as _merge_runs takes them."""
    runs, T = [], []
    for c in manifest["clips"]:
        d = Path(c["run"])
        runs.append({"dir": d, "cams": _run_cams(d), "n_shared": int(c["n_shared"]), "n_tail": int(c.get("n_tail", 0))})
        tr = c["transform"]
        T.append((float(tr["s"]), np.array(tr["R"], dtype=np.float64), np.array(tr["t"], dtype=np.float64)))
    return runs, T


def recompose_route(manifest: dict, out_ply: Path) -> tuple[int, list]:
    """The route splat again from the WorldMirror runs its manifest names (no reconstruction): what
    build_route_gaussian wrote, byte for byte, for the same runs."""
    runs, T = _manifest_runs(manifest)
    n, route, _ = _merge_runs(runs, T, out_ply, float(manifest["metres_per_unit"]),
                              seam_fill=bool(manifest.get("seam_fill")))
    return n, route


def manifest_from_cache(clips: list[Path], cache_dir: Path, *, frame_step: int, shared: int, max_frames: int,
                        adaptive: bool, mask_people: bool, mask_fallback: bool, frame_width: int,
                        metres_per_unit: float) -> dict:
    """The manifest of a route built before build_route_gaussian wrote one: the same clip keys (trying older
    pipeline versions too), the cached runs and the same alignment.  Every clip has to be in the cache."""
    for version in sorted({PIPELINE_VERSION, *(str(v) for v in range(1, int(PIPELINE_VERSION) + 1))}, reverse=True):
        prev, cdirs = "", []
        for i, clip in enumerate(clips):
            prev = _clip_key(clip, prev, frame_step, shared, max_frames, adaptive, mask_people, mask_fallback, i,
                             frame_width, version=version)
            cdirs.append(cache_dir / prev)
        if all((d / "done.json").exists() for d in cdirs):
            break
    else:
        raise RuntimeError("the route's clips are not all in the reconstruction cache; build the route again")
    runs = []
    for d in cdirs:
        out = _run_dir(d / "out")
        cams = np.array([c["matrix"] for c in json.load(open(out / "camera_params.json", encoding="utf-8"))["extrinsics"]])
        runs.append({"dir": out, "cams": cams, "n_shared": json.loads((d / "done.json").read_text())["n_shared"]})
    T, _ = _align_runs(runs)
    m = _manifest(clips, cdirs, runs, T, metres_per_unit, frame_width)
    m["pipeline_version"] = version
    return m


def _own_indices(e: dict) -> list[int]:
    return json.loads((e["frames"] / "indices.json").read_text())


def _run_range(e: dict) -> tuple[int, int]:
    return tuple(e["part"]) if e["part"] else (0, e["total"] or _frame_count(e["clip"]))


def build_route_gaussian(clips: list[Path], out_ply: Path, work: Path, *, frame_step: int = 9, shared: int = 5,
                         max_frames: int = 36, metres_per_unit: float = 30.5, max_gaussians: int = 0,
                         progress: Optional[Callable[[str], None]] = None, keep_work: bool = False,
                         mask_people: bool = False, adaptive: bool = True, mask_fallback: bool = False,
                         cache_dir: Optional[Path] = None, frame_width: int = 704,
                         should_stop: Optional[Callable[[], bool]] = None, inpaint_people: bool = False) -> dict:
    """clips in route order -> out_ply (+ .json sidecar, _cams.json, _stitch.json).  Blocking; run it in a thread.

    inpaint_people (with mask_people): the people are not only masked out but painted over with ProPainter from the
    frames around them (inpaint_frames above), so WorldMirror reconstructs the ground they hid -- and never sees
    them, so they do not hold the camera still for it either.

    cache_dir: keeps each clip's frames, masks and WorldMirror result there (see the key below), so a longer
    route made of the same first clips only reconstructs the new ones.  Cached clips are never deleted here.
    frame_width: width of the frames WorldMirror sees (it takes up to 952; more pixels, more memory per frame)."""
    say = progress or (lambda _m: None)

    def check() -> None:
        if should_stop and should_stop():
            raise RouteCancelled()

    if not clips:
        raise ValueError("no clips")
    if shared < 3 and len(clips) > 1:
        raise ValueError("at least 3 shared frames are needed to align neighbouring clips")
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)

    # Stage 1: key every run, take what the cache has, sample frames for the rest (cheap, no GPU).  A run is a
    # clip, or a part of a clip too long for one run (_clip_parts); parts chain to each other like clips.
    # Stage 2: person masks for every new run, queued together so SAM 3.1 stays loaded and busy.
    # Stage 3: WorldMirror on the new runs, one after another.
    # A run's result depends on the clip, the settings and the run before it (its first frames are the
    # previous run's last samples), so that chain is the cache key: adding clips at the end of a route
    # reuses every earlier run, and a failed build resumes where it stopped.
    inpaint = bool(inpaint_people and mask_people)
    if inpaint:
        _propainter_python()           # missing: say so before an hour of work, not after
    plan = []
    prev_files: list[Path] = []
    prev_key = ""
    fps_of: list[Optional[float]] = []
    for ci, clip in enumerate(clips):
        check()
        parts, demand, fps, total = [None], None, None, 0
        try:
            fps = _probe(clip)[0]
            total = _frame_count(clip)
            budget = max_frames - (shared if plan else 0)
            flow = _flow_profile(clip, total) if adaptive else None
            demand = _demand(total, fps, frame_step, flow) if adaptive else None
            if shared >= 3:            # parts are chained through shared frames
                parts = _clip_parts(total, fps, frame_step, budget, max_frames - shared, flow)
        except Exception as exc:          # unreadable here: sample_frames reports it below
            say(f"clip {ci + 1}/{len(clips)}: not measured ({exc})")
        fps_of.append(fps)
        for pi, part in enumerate(parts):
            i = len(plan)
            name = f"clip {ci + 1}/{len(clips)}" + (f" part {pi + 1}/{len(parts)}" if part else "")
            key = _clip_key(clip, prev_key, frame_step, shared, max_frames, adaptive, mask_people, mask_fallback, i,
                            frame_width, part=part, inpaint=inpaint)
            prev_key = key
            cdir = (cache_dir / key) if cache_dir else (work / f"clip{i}")
            e = {"clip": clip, "clip_no": ci, "part": part, "name": name, "cdir": cdir, "frames": cdir / "frames",
                 "masks": cdir / "masks", "out": cdir / "out", "done": cdir / "done.json", "fps": fps, "total": total}
            if cache_dir and e["done"].exists():
                say(f"{name}: reusing the saved reconstruction")
                meta = json.loads(e["done"].read_text())
                e.update(cached=True, n_shared=meta["n_shared"], own=[e["frames"] / n for n in meta["own"]])
            else:
                shutil.rmtree(cdir, ignore_errors=True)
                say(f"{name}: sampling frames")
                own = sample_frames(clip, e["frames"], frame_step, max_frames - (shared if i else 0), width=frame_width,
                                    adaptive=adaptive, **({"part": part} if part else {}),
                                    **({"demand": demand} if demand is not None else {}))
                n_shared = 0
                if i:
                    for k, src in enumerate(prev_files[-shared:]):
                        shutil.copy2(src, e["frames"] / f"a_{k:03d}.png")
                    n_shared = min(shared, len(prev_files))
                e.update(cached=False, n_shared=n_shared, own=own)
            prev_files = e["own"]
            plan.append(e)

    new = [i for i, e in enumerate(plan) if not e["cached"]]
    if mask_people and new:
        jobs = {}
        try:
            for i in new:
                check()
                say(f"{plan[i]['name']}: queuing SAM 3.1 tracking")
                jobs[i] = sam3_submit(plan[i]["clip"], plan[i]["cdir"] / "dense",
                                      **({"part": plan[i]["part"]} if plan[i]["part"] else {}))
            for i in new:
                e = plan[i]
                if inpaint:            # every frame ProPainter will see needs its mask
                    say(f"{e['name']}: person masks for inpainting")
                    e["pp_idx"] = _paint_masks(e["clip"], e["cdir"], e["own"], _own_indices(e), *_run_range(e),
                                               frame_width, e["masks"], job=jobs[i], should_stop=should_stop)
                else:
                    say(f"{e['name']}: person masks")
                    sam3_collect(jobs[i], e["frames"], e["masks"], should_stop=should_stop)
                    check()
                    add_box_masks(e["frames"], e["masks"], e["cdir"] / "box_masks")
                k = e["n_shared"]
                for n in range(k):      # repeated frames keep the mask the previous run made for them
                    prev = plan[i - 1]
                    shutil.copy2(prev["masks"] / prev["own"][-k:][n].name, e["masks"] / f"a_{n:03d}.png")
        except RouteCancelled:
            _drop_sam3(jobs)
            raise
        except Exception as exc:
            _drop_sam3(jobs)      # whatever is still queued is of no use now
            if not mask_fallback:
                raise RuntimeError(f"SAM 3.1 person masks failed: {exc}. ComfyUI must be running with "
                                   f"{SAM3_CKPT} in models/checkpoints; pass mask_fallback=true to accept the "
                                   "weaker SAM 2.1 large masks instead.") from exc
            say(f"SAM 3.1 masks unavailable ({exc}); using SAM 2.1 large")
            for i in new:
                e = plan[i]
                shutil.rmtree(e["masks"], ignore_errors=True)
                if inpaint:
                    e["pp_idx"] = _paint_masks(e["clip"], e["cdir"], e["own"], _own_indices(e), *_run_range(e),
                                               frame_width, e["masks"])
                else:
                    make_person_masks(e["frames"], e["masks"])
                k = e["n_shared"]
                for n in range(k):
                    prev = plan[i - 1]
                    shutil.copy2(prev["masks"] / prev["own"][-k:][n].name, e["masks"] / f"a_{n:03d}.png")
        for i in new:
            shutil.rmtree(plan[i]["cdir"] / "dense", ignore_errors=True)
        comfy_free()          # ProPainter and WorldMirror need the card next

    if inpaint and new:
        for i in new:
            check()
            e = plan[i]
            say(f"{e['name']}: inpainting the people (ProPainter, {len(e['pp_idx'])} frames)")
            _paint_own(e["cdir"], e["own"], _own_indices(e), e["pp_idx"], e["masks"], should_stop=should_stop)
            if e["n_shared"]:      # the repeated frames are the run before's own: inpainted now (or in its cache)
                prev = plan[i - 1]
                for n, src in enumerate(prev["own"][-e["n_shared"]:]):
                    shutil.copy2(src, e["frames"] / f"a_{n:03d}.png")

    runs = []                      # per run: dict(dir, cams (n,4,4), own (index of first own camera))
    for i, e in enumerate(plan):
        check()
        if e["cached"]:
            out = e["out"]
            for f in sorted(out.rglob("camera_params.json")):
                out = f.parent
        else:
            say(f"{e['name']}: WorldMirror on {len(e['own']) + e['n_shared']} frames")
            # inpainted frames show no one: nothing to drop from the result (the masks stay beside them)
            out = run_worldmirror(e["frames"], e["out"], mask_dir=e["masks"] if mask_people and not inpaint else None,
                                  should_stop=should_stop)
            if cache_dir:
                e["done"].write_text(json.dumps({"n_shared": e["n_shared"], "own": [f.name for f in e["own"]]}))
        j = json.load(open(out / "camera_params.json", encoding="utf-8"))
        cams = np.array([c["matrix"] for c in j["extrinsics"]])
        runs.append({"dir": out, "cams": cams, "n_shared": e["n_shared"]})

    say("aligning runs")
    T, report = _align_runs(runs)            # every run into run 0's frame
    say("writing the splat")
    n, route, rows = _merge_runs(runs, T, out_ply, metres_per_unit, max_gaussians, seam_fill=True)
    times = []                               # each route camera's time in its clip, for _pose_breaks
    for e in plan:
        idx_file = e["frames"] / "indices.json"
        idx = json.loads(idx_file.read_text()) if idx_file.exists() else []
        fps = fps_of[e["clip_no"]]
        own = len(e["own"])
        times += [(e["clip_no"], idx[j] / fps) if fps and j < len(idx) else None for j in range(own)]
    breaks = _pose_breaks(route, times)
    for b in breaks:
        say(f"camera jumps {b['jump_m']} m between {b['from_s']} s and {b['to_s']} s of clip {b['clip'] + 1} "
            f"({b['times_median_speed']}x the route's median speed): the reconstruction lost track there")
    source = (f"WorldMirror route splat, {len(clips)} clips" + (f" in {len(plan)} runs" if len(plan) != len(clips) else "")
              + (", people inpainted (ProPainter)" if inpaint else ""))
    length = _write_route_sidecars(out_ply, route, report, n, metres_per_unit, source,
                                   extra={"runs": len(plan), "pose_breaks": breaks})
    if cache_dir:          # the runs outlive the job only in the cache; a manifest pointing into `work` would dangle
        settings = {"frame_step": frame_step, "shared": shared, "max_frames": max_frames, "adaptive": adaptive,
                    "mask_people": mask_people, "mask_fallback": mask_fallback, "pipeline_version": PIPELINE_VERSION,
                    **({"inpaint": "propainter"} if inpaint else {})}
        man = _manifest([e["clip"] for e in plan], [e["cdir"] for e in plan], runs, T, metres_per_unit, frame_width,
                        settings=settings, parts=[e["part"] for e in plan])
        for entry, r in zip(man["clips"], rows or [None] * len(runs)):
            entry["rows"] = r
        man["seam_fill"] = True               # recomposing it fills the seams again; older routes stay as written
        out_ply.with_name(out_ply.stem + "_route.json").write_text(json.dumps(man), encoding="utf-8")
    if not keep_work:
        shutil.rmtree(work, ignore_errors=True)
    return {"gaussians": n, "route_length_m": length, "stitch": report, "runs": len(plan), "pose_breaks": breaks}


# --------------------------------------------------------------------------------------- a turn onto a route
TURN_FRAMES = 31          # sampled frames of a turn clip, first and last included (a 5 s pan at 952 px fits)


def _frame_scores(image: Path, manifest: dict, what: str, width: int = 640) -> list[tuple[int, int, int]]:
    """SIFT matches of a picture against every own frame of the route, RANSAC homography inliers:
    [(inliers, clip, own frame), ...], best first. `what` names the picture in the errors."""
    import cv2
    clahe = cv2.createCLAHE(3.0, (8, 8))
    sift = cv2.SIFT_create(nfeatures=4000)
    matcher = cv2.BFMatcher()

    def feats(path: Path):
        im = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
        if im is None:
            raise RuntimeError(f"cannot read {path}")
        im = cv2.resize(im, (width, max(1, round(im.shape[0] * width / im.shape[1]))), interpolation=cv2.INTER_AREA)
        return sift.detectAndCompute(clahe.apply(im), None)

    kq, dq = feats(image)
    if dq is None or len(kq) < 20:
        raise RuntimeError(f"{what} has too little detail to find on the route")
    scores = []
    for ci, clip in enumerate(manifest["clips"]):
        for j, name in enumerate(clip["own"]):
            k2, d2 = feats(Path(clip["cache"]) / "frames" / name)
            if d2 is None or len(k2) < 20:
                continue
            good = [m[0] for m in matcher.knnMatch(dq, d2, k=2) if len(m) == 2 and m[0].distance < 0.8 * m[1].distance]
            if len(good) < 12:
                continue
            src = np.float32([kq[m.queryIdx].pt for m in good])
            dst = np.float32([k2[m.trainIdx].pt for m in good])
            H, inl = cv2.findHomography(src, dst, cv2.RANSAC, 3.0)
            if H is not None:
                scores.append((int(inl.sum()), ci, j))
    if not scores:
        raise RuntimeError(f"{what} matches no frame of the route")
    scores.sort(reverse=True)
    return scores


def find_anchor(image: Path, manifest: dict, width: int = 640) -> dict:
    """Which sampled frame of the route a picture shows: SIFT matches against every clip's own frames, RANSAC
    homography inliers; the picture a turn was made from (de-peopled, re-textured) keeps the route frame's layout.
    Returns the clip, its run's camera index and the time in the clip, with the runner-up for comparison."""
    scores = _frame_scores(image, manifest, "the turn's first frame", width)
    n, ci, j = scores[0]
    clip = manifest["clips"][ci]
    t = None
    if clip.get("indices") and clip.get("fps") and j < len(clip["indices"]):
        t = round(clip["indices"][j] / clip["fps"], 2)
    other = next(((n2, c2, j2) for n2, c2, j2 in scores[1:] if (c2, abs(j2 - j)) != (ci, 1) and (c2, j2) != (ci, j)), None)
    # a turn made from a frame of this route lands on that frame far above the rest (259 matches against 59 on
    # the street this was made for); a clip of another place still clears a handful somewhere, and would be bent
    # and merged in silently
    if n < 40 or (other is not None and n < 2 * other[0]):
        raise RuntimeError(
            f"the turn's first frame shows no frame of this route clearly (best: clip {ci + 1} frame {j + 1}, "
            f"{n} matches; next: {other[0] if other else 0}) -- is the turn made from a frame of this route?")
    return {"clip": ci, "own": j, "index": int(clip["n_shared"]) + j, "time_s": t, "inliers": n,
            "runner_up": {"clip": other[1], "own": other[2], "inliers": other[0]} if other else None}


def _turn_run(clip: Path, cache_dir: Path, frame_width: int, say, should_stop,
              cached_only: bool = False) -> tuple[Path, Path]:
    """WorldMirror run of a turn clip (cached by the clip's bytes and the frame width): (run dir, frames dir).
    cached_only: refuse rather than reconstruct (a quick step that must not take the card)."""
    h = hashlib.sha1()
    with open(clip, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    h.update(json.dumps(["turn", TURN_FRAMES, frame_width]).encode())
    cdir = cache_dir / f"turn_{h.hexdigest()[:20]}"
    if (cdir / "done.json").exists():
        say(f"{clip.name}: reusing the saved reconstruction")
        return _run_dir(cdir / "out"), cdir / "frames"
    if cached_only:
        raise RuntimeError(f"the turn {clip.name} is not in the reconstruction cache; add the turns again "
                           "(接转身视频) before adjusting")
    shutil.rmtree(cdir, ignore_errors=True)
    say(f"{clip.name}: sampling frames")
    sample_frames(clip, cdir / "frames", 1, TURN_FRAMES, width=frame_width, adaptive=False, ends=True)
    say(f"{clip.name}: WorldMirror")
    comfy_free()
    run = run_worldmirror(cdir / "frames", cdir / "out", should_stop=should_stop)
    (cdir / "done.json").write_text(json.dumps({"clip": str(clip)}))
    return run, cdir / "frames"


def append_route_turn(route_ply: Path, turns: list[Path], out_ply: Path, cache_dir: Path, manifest: dict, *,
                      min_angle: float = 40.0, progress: Optional[Callable[[str], None]] = None,
                      should_stop: Optional[Callable[[], bool]] = None, anchors: Optional[dict] = None,
                      cached_only: bool = False) -> dict:
    """Add generated turns (videos that pan from one frame of the route, e.g. H3 asked to look back along the
    street) to a finished route splat.  For each turn: WorldMirror on it, the route frame its first frame shows
    (find_anchor), then append_view_splat with the bend onto the route's street, onto the result of the turn
    before.  route_ply is the route without turns; out_ply gets the route's sidecars and a manifest naming that
    base, so running the turns again starts from the route, not from the last result.
    anchors: per turn clip name, where an earlier run anchored it (its report's "anchor"): no matching then, as long
    as the clip it names is still on the route.  cached_only: every turn must be in the reconstruction cache."""
    say = progress or (lambda _m: None)
    cur, parts, reports = route_ply, [], []
    files = [_entry_ref(c) for c in manifest["clips"]]
    for k, clip in enumerate(turns):
        if should_stop and should_stop():
            raise RouteCancelled()
        run, frames = _turn_run(clip, cache_dir, int(manifest.get("frame_width") or 704), say, should_stop,
                                cached_only=cached_only)
        known = (anchors or {}).get(clip.name)
        if known and known.get("clip_file") in files:
            ci = files.index(known["clip_file"])
            anchor = {**known, "clip": ci, "index": int(manifest["clips"][ci]["n_shared"]) + int(known["own"])}
        else:
            anchor = find_anchor(sorted(frames.glob("b_*.png"))[0], manifest)
        entry = manifest["clips"][anchor["clip"]]
        anchor["clip_file"] = _entry_ref(entry)
        say(f"{clip.name}: starts on clip {anchor['clip'] + 1} frame {anchor['own'] + 1}"
            + (f" ({anchor['time_s']} s)" if anchor["time_s"] is not None else "") + f", {anchor['inliers']} matches")
        to_route = _route_transform(entry)        # clip 0 too: after a clip added at the start it is not the frame
        dst = out_ply if k == len(turns) - 1 else out_ply.with_name(f"{out_ply.stem}_part{k}.ply")
        res = append_view_splat(cur, dst, run, Path(entry["run"]), anchor["index"], to_route=to_route,
                                metres_per_unit=float(manifest["metres_per_unit"]), min_angle=min_angle)
        reports.append({"clip": clip.name, "anchor": anchor, **res})
        parts.append(dst)
        cur = dst
    for part in parts[:-1]:
        part.unlink(missing_ok=True)
    side = route_ply.with_suffix(".json")
    meta = json.loads(side.read_text(encoding="utf-8")) if side.exists() else {
        "frame": "picture_camera_opencv", "units": "metres", "scene_scale": SCENE_SCALE,
        "metres_per_unit": manifest["metres_per_unit"]}
    n = int(reports[-1]["base"] + reports[-1]["added"]) if reports else 0
    meta.update(source=f"{meta.get('source', 'route splat')} + {len(turns)} generated turn(s)", gaussians=n,
                base_ply=route_ply.name, turns=reports)
    out_ply.with_suffix(".json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    cams = route_ply.with_name(route_ply.stem + "_cams.json")
    if cams.exists():
        shutil.copyfile(cams, out_ply.with_name(out_ply.stem + "_cams.json"))
    out_ply.with_name(out_ply.stem + "_route.json").write_text(json.dumps({**manifest, "base_ply": route_ply.name}),
                                                             encoding="utf-8")
    return {"gaussians": n, "turns": reports}


def _entry_ref(entry: dict) -> str:
    """A manifest entry's name: its clip file, with the frame range when the clip was reconstructed in parts."""
    part = entry.get("part")
    return entry["clip"] + (f"#{part[0]}-{part[1]}" if part else "")


def _route_transform(entry: dict) -> Optional[tuple]:
    """A manifest clip's (s, R, t) into the route frame, or None when its run is in the route frame already."""
    tr = entry["transform"]
    s, R, t = float(tr["s"]), np.array(tr["R"], dtype=np.float64), np.array(tr["t"], dtype=np.float64)
    if s == 1.0 and np.array_equal(R, np.eye(3)) and not t.any():
        return None
    return s, R, t


# ------------------------------------------------------------------------------ clips added at a route's start or end
END_MIN_INLIERS = 40      # SIFT inliers a clip's first (last) frame needs on the route's last (first) frames


def _compose(a: tuple, b: tuple) -> tuple:
    """a after b, each (s, R, t): x -> s_a R_a (s_b R_b x + t_b) + t_a."""
    sa, Ra, ta = a
    sb, Rb, tb = b
    return sa * sb, Ra @ Rb, sa * (Ra @ tb) + ta


def _end_frames(clip: Path, out_dir: Path, width: int) -> tuple[Path, Path]:
    """The clip's very first and very last frame, as PNGs of the given width."""
    out_dir.mkdir(parents=True, exist_ok=True)
    ff = os.environ.get("FFMPEG", "ffmpeg")
    first, last = out_dir / "first.png", out_dir / "last.png"
    subprocess.run([ff, "-v", "error", "-y", "-i", str(clip), "-vf", f"scale={width}:-2", "-frames:v", "1", str(first)],
                   capture_output=True, timeout=300)
    n = _frame_count(clip)
    subprocess.run([ff, "-v", "error", "-y", "-i", str(clip), "-vf", f"select='eq(n\\,{max(0, n - 1)})',scale={width}:-2",
                    "-fps_mode", "vfr", "-frames:v", "1", str(last)], capture_output=True, timeout=300)
    if not (first.exists() and last.exists()):
        raise RuntimeError(f"cannot read the first and last frames of {clip.name}")
    return first, last


def _end_match(image: Path, manifest: dict, at_end: bool, k: int, what: str) -> dict:
    """Does `image` show one of the route's last k own frames (at_end) or one of its first k?  The best SIFT match
    over every own frame has to lie there, clear END_MIN_INLIERS and double the best frame more than 2k frames from
    that end (a picture from the middle of the route is a branch, which this does not do)."""
    clips = manifest["clips"]
    ce = len(clips) - 1 if at_end else 0
    n_own = len(clips[ce]["own"])

    def within(ci: int, j: int, w: int) -> bool:
        return ci == ce and (j >= n_own - w if at_end else j < w)

    try:
        scores = _frame_scores(image, manifest, what)
    except RuntimeError as exc:
        return {"ok": False, "inliers": 0, "clip": None, "own": None, "far": 0, "why": str(exc)}
    n, ci, j = scores[0]
    far = next((s for s in scores if not within(s[1], s[2], 2 * k)), None)
    ok = within(ci, j, k) and n >= END_MIN_INLIERS and (far is None or n >= 2 * far[0])
    return {"ok": ok, "inliers": n, "clip": ci, "own": j, "far": far[0] if far else 0}


def _extension_run(clip: Path, manifest: dict, where: str, k: int, settings: dict, cache_dir: Path, say,
                   should_stop) -> tuple[Path, Path, dict]:
    """WorldMirror run of a clip added at the route's `where` end, with the route's k own frames at that end in it
    (a_* before the clip's own frames at the end, c_* after them at the start: WorldMirror reads frames in name
    order, and masks by name).  As many frames per run as the clip next to it had.  Cached by the clip, the frames
    it joins and the settings: (run dir, cache dir, done record)."""
    adj = manifest["clips"][-1] if where == "end" else manifest["clips"][0]
    adj_cache = Path(adj["cache"])
    shared = adj["own"][-k:] if where == "end" else adj["own"][:k]
    own_count = max(1, int(adj["n_shared"]) + int(adj.get("n_tail", 0)) + len(adj["own"]) - k)
    width = int(manifest.get("frame_width") or 704)
    step = int(settings.get("frame_step") or 9)
    adaptive = bool(settings.get("adaptive", True))
    mask_people = all((adj_cache / "masks" / n).exists() for n in shared)     # the route was built with masks
    # and painted over: the route's frames it repeats are, so its own must be too (painted frames, no mask)
    inpaint = mask_people and settings.get("inpaint") == "propainter"
    mask_fallback = bool(settings.get("mask_fallback", False))
    h = hashlib.sha1()
    with open(clip, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    h.update(json.dumps([PIPELINE_VERSION, "extend", where, adj["run"], shared, own_count, width, step, adaptive,
                         mask_people, mask_fallback]).encode())
    if inpaint:
        h.update(b'{"inpaint": "propainter"}')
    cdir = cache_dir / f"ext_{h.hexdigest()[:20]}"
    if (cdir / "done.json").exists():
        say(f"{clip.name}: reusing the saved reconstruction")
        return _run_dir(cdir / "out"), cdir, json.loads((cdir / "done.json").read_text())
    shutil.rmtree(cdir, ignore_errors=True)
    frames, masks = cdir / "frames", cdir / "masks"
    say(f"{clip.name}: sampling frames")
    own = sample_frames(clip, frames, step, own_count, width=width, adaptive=adaptive)
    prefix = "a" if where == "end" else "c"
    for i, name in enumerate(shared):
        shutil.copy2(adj_cache / "frames" / name, frames / f"{prefix}_{i:03d}.png")
    comfy_free()              # only now: a clip already in the cache needs neither ComfyUI's card nor WorldMirror's
    if mask_people:
        say(f"{clip.name}: person masks" + (" for inpainting" if inpaint else ""))
        if inpaint:
            _propainter_python()
            own_idx = json.loads((frames / "indices.json").read_text())
            span = (0, _frame_count(clip))
        job, pp_idx = None, None
        try:
            job = sam3_submit(clip, cdir / "dense")
            if inpaint:
                pp_idx = _paint_masks(clip, cdir, own, own_idx, *span, width, masks, job=job, should_stop=should_stop)
            else:
                sam3_collect(job, frames, masks, should_stop=should_stop)
                add_box_masks(frames, masks, cdir / "box_masks")
        except RouteCancelled:
            if job:
                _drop_sam3({0: job})
            raise
        except Exception as exc:
            if job:
                _drop_sam3({0: job})
            if not mask_fallback:
                raise RuntimeError(f"SAM 3.1 person masks failed: {exc}. ComfyUI must be running with {SAM3_CKPT} "
                                   "in models/checkpoints.") from exc
            say(f"SAM 3.1 masks unavailable ({exc}); using SAM 2.1 large")
            shutil.rmtree(masks, ignore_errors=True)
            if inpaint:
                pp_idx = _paint_masks(clip, cdir, own, own_idx, *span, width, masks)
            else:
                make_person_masks(frames, masks)
        for i, name in enumerate(shared):     # the route's frames keep the masks the route was built with
            shutil.copy2(adj_cache / "masks" / name, masks / f"{prefix}_{i:03d}.png")
        shutil.rmtree(cdir / "dense", ignore_errors=True)
        comfy_free()          # ProPainter and WorldMirror need the card next
        if inpaint:
            say(f"{clip.name}: inpainting the people (ProPainter, {len(pp_idx)} frames)")
            _paint_own(cdir, own, own_idx, pp_idx, masks, should_stop=should_stop)
    say(f"{clip.name}: WorldMirror on {len(own) + k} frames")
    run = run_worldmirror(frames, cdir / "out", mask_dir=masks if mask_people and not inpaint else None,
                          should_stop=should_stop)
    done = {"where": where, "n_shared": k if where == "end" else 0, "n_tail": 0 if where == "end" else k,
            "own": [f.name for f in own], "mask_people": mask_people, "inpaint": inpaint, "shared": shared,
            "clip": str(clip)}
    (cdir / "done.json").write_text(json.dumps(done))
    return run, cdir, done


SHARED_MIN_M = 5.0        # the route frames an added clip is aligned through span at least this far...
SHARED_MAX = 10           # ...with up to this many frames (the scale comes from their spread)
OWN_MIN = 15              # frames of its own an added clip keeps in its run at the least


def _shared_count(run: dict, T: tuple, at_end: bool, k_min: int, mpu: float) -> int:
    """How many of the route's own frames at that end go into an added clip's run: k_min, or more until their
    cameras span SHARED_MIN_M (five frames of a slow start spanned 2.6 m, of a walk 6.9 m)."""
    own = list(range(run["n_shared"], len(run["cams"]) - run.get("n_tail", 0)))
    order = own[::-1] if at_end else own                  # from the junction inwards
    pos = np.array([_cam_in_route(run, T, i)[:3, 3] * mpu for i in order[:SHARED_MAX]])
    k = min(k_min, len(pos))
    while k < len(pos) and np.linalg.norm(pos[:k] - pos[0], axis=1).max() < SHARED_MIN_M:
        k += 1
    return k


def _orthonormal(M) -> np.ndarray:
    """The rotation nearest M (a camera rotation from float32 parameters is orthonormal to ~1e-7 only, and an
    adjustment about it would then move the clip a few micrometres even when it is zero)."""
    U, _, Vt = np.linalg.svd(np.asarray(M, dtype=np.float64))
    if np.linalg.det(U @ Vt) < 0:
        U[:, -1] *= -1
    return U @ Vt


def _rot(axis: str, deg: float) -> np.ndarray:
    a = math.radians(float(deg))
    c, s = math.cos(a), math.sin(a)
    if axis == "x":
        return np.array([[1.0, 0, 0], [0, c, -s], [0, s, c]])
    if axis == "y":
        return np.array([[c, 0, s], [0, 1.0, 0], [-s, 0, c]])
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1.0]])


ADJUST_KEYS = ("scale", "yaw", "pitch", "roll", "right", "up", "forward")


def adjustment(adj: Optional[dict], pivot, axes, units_per_metre: float) -> tuple:
    """A hand adjustment of an added clip as (s, R, t): x -> pivot + s R (x - pivot) + offset, about the seam camera
    (`pivot`, and `axes` its camera-to-route rotation, columns right / down / forward as OpenCV has them).  scale;
    yaw turns the clip's far end to the right (about the camera's vertical), pitch lifts it, roll lowers its right
    side; then right / up / forward in metres (units_per_metre: the route unit per metre).  gs_route_adjust.js does
    the same sums for the viewer's preview (test_route_gs.AdjustParity)."""
    adj = adj or {}
    C = np.asarray(axes, dtype=np.float64)
    p = np.asarray(pivot, dtype=np.float64)
    s = float(adj.get("scale", 1.0))
    R = C @ (_rot("y", adj.get("yaw", 0.0)) @ _rot("x", adj.get("pitch", 0.0)) @ _rot("z", adj.get("roll", 0.0))) @ C.T
    off = C @ np.array([float(adj.get("right", 0.0)), -float(adj.get("up", 0.0)), float(adj.get("forward", 0.0))])
    return s, R, p - s * (R @ p) + off * units_per_metre


def _depth_scale(prev_run: Path, prev_idx: list[int], new_run: Path, new_idx: list[int]) -> Optional[float]:
    """Median ratio of the two runs' depth maps of the same frames (the street, not the bottom quarter): the scale
    between the runs as the surfaces have it, beside the one the camera spread gives."""
    ratios = []
    for a, b in zip(prev_idx, new_idx):
        fa, fb = prev_run / "depth" / f"depth_{a:04d}.npy", new_run / "depth" / f"depth_{b:04d}.npy"
        if not (fa.exists() and fb.exists()):
            return None
        da, db = np.load(fa), np.load(fb)
        q = (da / db)[: int(da.shape[0] * 0.75)]
        q = q[np.isfinite(q) & (q > 0)]
        if not len(q):
            return None
        lo, hi = np.percentile(q, [20, 80])
        ratios.append(float(np.median(q[(q > lo) & (q < hi)])))
    return float(np.median(ratios)) if ratios else None


def _added_name(entry: dict) -> str:
    """How callers name an added clip in `adjustments`: its URL when the job gave one, else its file."""
    return entry.get("url") or entry["clip"]


def _with_adjustment(entry: dict, adj: Optional[dict], mpu: float) -> None:
    """Set an added clip's transform to its hand adjustment after its automatic alignment (no adjustment: the
    automatic one exactly)."""
    neutral = {"scale": 1.0}
    a = {k: float(v) for k, v in (adj or {}).items() if k in ADJUST_KEYS and float(v) != neutral.get(k, 0.0)}
    at = entry["auto_transform"]
    entry["adjust"] = a
    if not a:
        entry["transform"] = json.loads(json.dumps(at))
        return
    T0 = (float(at["s"]), np.array(at["R"], dtype=np.float64), np.array(at["t"], dtype=np.float64))
    D = adjustment(a, entry["pivot"], entry["axes"], 1.0 / mpu)
    s, R, t = _compose(D, T0)
    entry["transform"] = {"s": float(s), "R": np.asarray(R).tolist(), "t": np.asarray(t).tolist()}


def _write_extended(m: dict, runs: list, T: list, out_ply: Path, core_name: str, stitch: list) -> dict:
    """Merge, sidecars, manifest (with each run's rows) of a route with clips added at its ends."""
    mpu = float(m["metres_per_unit"])
    n, route, rows = _merge_runs(runs, T, out_ply, mpu, seam_fill=bool(m.get("seam_fill")))
    for entry, r in zip(m["clips"], rows or [None] * len(runs)):
        entry["rows"] = r
    added = [c for c in m["clips"] if "auto_transform" in c]
    length = _write_route_sidecars(out_ply, route, stitch, n, mpu, f"WorldMirror route splat, {len(m['clips'])} clips "
                                                                   f"({len(added)} added at its ends)")
    m["core_ply"] = core_name
    m["scene_scale"] = SCENE_SCALE
    out_ply.with_name(out_ply.stem + "_route.json").write_text(json.dumps(m), encoding="utf-8")
    return {"gaussians": n, "route_length_m": length}


def extend_route(core_ply: Path, manifest: dict, clips: list[Path], out_ply: Path, cache_dir: Path, *,
                 urls: Optional[list[str]] = None, adjustments: Optional[dict] = None,
                 placements: Optional[dict] = None, progress: Optional[Callable[[str], None]] = None,
                 should_stop: Optional[Callable[[], bool]] = None) -> dict:
    """Add clips that continue a finished route at either end: a clip whose first frame is one of the route's last
    sampled frames goes on after it, a clip whose last frame is one of its first goes before it.  Each is
    reconstructed with WorldMirror together with the route's frames at that end (_shared_count of them), aligned
    through them, and the route is merged again from all the runs (as recompose_route: between its ends the route is
    the same as before).  The seam is the builder's: the earlier run keeps what lies behind the plane just past its
    last camera, so a clip added at the start also takes over the stretch of the route frames it was aligned through,
    whose sides the route's own forward view never saw.  The clips may come in any order; one that continues another
    goes on after it.  A clip that meets neither end is refused (a branch from the middle of the route is not this).

    urls: how the caller names the clips (stored, and the keys of `adjustments`); adjustments: per clip, a hand
    adjustment after the automatic alignment (adjustment(): scale, yaw, pitch, roll, right, up, forward);
    placements: per clip "start" / "end" when an earlier run already found it (no matching then).
    core_ply / manifest: the route as built, without turns; out_ply gets the sidecars and a manifest naming core_ply,
    with each added clip's automatic alignment, its adjustment, and the seam camera they are about."""
    say = progress or (lambda _m: None)

    def check() -> None:
        if should_stop and should_stop():
            raise RouteCancelled()

    m = json.loads(json.dumps(manifest))
    for key in ("base_ply", "core_ply", "extensions"):
        m.pop(key, None)
    settings = dict(m.get("settings") or {})
    k = int(settings.get("shared") or max([int(c["n_shared"]) for c in m["clips"]] + [0]) or 5)
    mpu = float(m["metres_per_unit"])
    runs, T = _manifest_runs(m)
    name_of = dict(zip(clips, urls or [None] * len(clips)))
    adjustments = adjustments or {}
    placements = placements or {}
    probe = cache_dir / f"_ends_{uuid.uuid4().hex[:8]}"
    ends: dict[Path, tuple[Path, Path]] = {}
    reports: list[dict] = []
    pending = list(clips)
    try:
        while pending:
            placed = None
            tried = []
            for clip in pending:
                check()
                known = placements.get(name_of[clip] or str(clip))
                if known in ("start", "end"):
                    placed = (clip, known, {"inliers": None, "far": None})
                    break
                if clip not in ends:
                    ends[clip] = _end_frames(clip, probe / f"{len(ends):02d}", int(m.get("frame_width") or 704))
                first, last = ends[clip]
                at_end = _end_match(first, m, True, k, f"{clip.name}'s first frame")
                at_start = _end_match(last, m, False, k, f"{clip.name}'s last frame")
                tried.append((clip, at_end, at_start))
                if at_end["ok"] or at_start["ok"]:
                    where = "end" if at_end["ok"] and (not at_start["ok"] or at_end["inliers"] >= at_start["inliers"]) else "start"
                    placed = (clip, where, at_end if where == "end" else at_start)
                    break
            if placed is None:
                def lands(r: dict) -> str:
                    if r["clip"] is None:
                        return r.get("why", "nothing")
                    return f"clip {r['clip'] + 1} frame {r['own'] + 1} ({r['inliers']} matches)"
                lines = [f"{c.name}: its first frame is closest to {lands(e)}, its last to {lands(s)}" for c, e, s in tried]
                raise RuntimeError(
                    "these clips continue the route at neither end -- a clip added at the end has to start on one of "
                    f"the route's last {k} sampled frames, one added at the start has to end on one of its first {k}; "
                    + "; ".join(lines))
            clip, where, match = placed
            pending.remove(clip)
            at_end = where == "end"
            adj_run, Ta = (runs[-1], T[-1]) if at_end else (runs[0], T[0])
            adj_entry = m["clips"][-1] if at_end else m["clips"][0]
            total = int(adj_entry["n_shared"]) + int(adj_entry.get("n_tail", 0)) + len(adj_entry["own"])
            kx = min(_shared_count(adj_run, Ta, at_end, k, mpu), max(k, total - OWN_MIN))
            run, cdir, done = _extension_run(clip, m, where, kx, settings, cache_dir, say, should_stop)
            check()
            cams = _run_cams(run)
            if at_end:
                lo = len(adj_run["cams"]) - adj_run.get("n_tail", 0) - kx
                prev_idx, new_idx = list(range(lo, lo + kx)), list(range(kx))
            else:
                lo = adj_run["n_shared"]
                prev_idx, new_idx = list(range(lo, lo + kx)), list(range(len(cams) - kx, len(cams)))
            prev, nxt = adj_run["cams"][prev_idx], cams[new_idx]
            s, R, t, resid, rot = similarity(prev, nxt)
            Tn = _compose(Ta, (s, R, t))
            depth = _depth_scale(Path(adj_entry["run"]), prev_idx, run, new_idx)
            seam_cam = _cam_in_route(adj_run, Ta, prev_idx[-1] if at_end else prev_idx[0])
            shared_pos = np.array([_cam_in_route(adj_run, Ta, i)[:3, 3] for i in prev_idx])
            baseline = float(np.linalg.norm(shared_pos - seam_cam[:3, 3], axis=1).max()) * mpu
            run_entry = {"dir": run, "cams": cams, "n_shared": int(done["n_shared"]), "n_tail": int(done["n_tail"])}
            idx = cdir / "frames" / "indices.json"
            try:
                fps = _probe(clip)[0]
            except Exception:
                fps = None
            entry = {"clip": str(clip), "url": name_of[clip], "where": where, "cache": str(cdir), "run": str(run),
                     "n_shared": int(done["n_shared"]), "n_tail": int(done["n_tail"]), "own": done["own"],
                     "indices": json.loads(idx.read_text()) if idx.exists() else None, "fps": fps,
                     "auto_transform": {"s": float(Tn[0]), "R": np.asarray(Tn[1]).tolist(), "t": np.asarray(Tn[2]).tolist()},
                     "pivot": seam_cam[:3, 3].tolist(), "axes": _orthonormal(seam_cam[:3, :3]).tolist(),
                     "depth_scale_hint": (depth / s) if depth else None}
            _with_adjustment(entry, adjustments.get(_added_name(entry)), mpu)
            tr = entry["transform"]
            Tn = (float(tr["s"]), np.array(tr["R"], dtype=np.float64), np.array(tr["t"], dtype=np.float64))
            if at_end:
                runs.append(run_entry)
                T.append(Tn)
                m["clips"].append(entry)
            else:
                runs.insert(0, run_entry)
                T.insert(0, Tn)
                m["clips"].insert(0, entry)
            rep = {"clip": clip.name, "url": name_of[clip], "where": where, "matches": match["inliers"],
                   "next_best_far": match["far"], "scale": s, "depth_scale": depth,
                   "seam_residual_m": [float(r) * Ta[0] * mpu for r in resid],
                   "rotation_residual_deg": [float(r) for r in rot], "shared_frames": kx,
                   "shared_baseline_m": baseline, "frames": len(done["own"]) + kx, "masks": bool(done["mask_people"]),
                   "adjust": entry["adjust"]}
            reports.append(rep)
            say(f"{clip.name}: added at the {where} through {kx} route frames over {baseline:.1f} m (seam residual up "
                f"to {max(rep['seam_residual_m']):.2f} m)")
    finally:
        shutil.rmtree(probe, ignore_errors=True)

    say("writing the splat")
    stitch_file = core_ply.with_name(core_ply.stem + "_stitch.json")
    stitch = json.loads(stitch_file.read_text(encoding="utf-8")) if stitch_file.exists() else []
    m["settings"] = {**settings, "shared": k}
    m["extensions"] = reports
    res = _write_extended(m, runs, T, out_ply, core_ply.name,
                          stitch + [{"seam": f"added at the {r['where']}", **r} for r in reports])
    return {**res, "extensions": reports}


METRE_KEYS = ("right", "up", "forward")      # the parts of a hand adjustment given in metres


def _scale_ply(src: Path, dst: Path, k: float) -> int:
    """A splat k times larger about the origin (the route's first camera): positions x k, log sizes + log k."""
    header, names, data = read_ply(src)
    for c in "xyz":
        data[:, names.index(c)] *= k
    for i in range(3):
        data[:, names.index(f"scale_{i}")] += math.log(k)
    with open(dst, "wb") as fh:
        fh.write(b"".join(header))
        fh.write(np.ascontiguousarray(data, dtype=np.float32).tobytes())
    return len(data)


def _scaled_adjust(adj: Optional[dict], k: float) -> Optional[dict]:
    if not adj:
        return adj
    return {key: (float(v) * k if key in METRE_KEYS else v) for key, v in adj.items()}


def scale_route(route_ply: Path, manifest: dict, metres_per_unit: float, out_ply: Path) -> dict:
    """The same route in another unit: every gaussian and route camera k = new / old times as far from the route's
    origin (its first camera) and every gaussian k times as large, so the shape stays exactly as it is and only how
    many metres a unit is changes.  Nothing is reconstructed, re-aligned or re-bent: a turn's bend and the merge use
    thresholds in metres, so running them again in the new unit would change an accepted route.  A route made in
    steps -- a turn result over its base, an extended route over its core -- is scaled at every step, so later runs
    that start from the base or the core keep the new unit; the hand adjustments' metres (right / up / forward) are
    scaled with it, so recomposing reproduces the same shape.  The manifests name the new files.
    route_ply / manifest: a route_gs output and its manifest; out_ply: the scaled route (its base and core, if any,
    go beside it as <out>_base.ply / <out>_core.ply)."""
    old = float(manifest["metres_per_unit"])
    new = float(metres_per_unit)
    if not (new > 0 and old > 0):
        raise ValueError("metres_per_unit must be positive")
    k = new / old
    chain = [(route_ply, manifest, out_ply)]               # (source, its manifest, destination), final first
    m = manifest
    if m.get("base_ply"):
        base = route_ply.with_name(m["base_ply"])
        bm_file = base.with_name(base.stem + "_route.json")
        bm = json.loads(bm_file.read_text(encoding="utf-8")) if bm_file.exists() else {k_: v for k_, v in m.items() if k_ != "base_ply"}
        chain.append((base, bm, out_ply.with_name(out_ply.stem + "_base.ply")))
        m = bm
    if m.get("core_ply"):
        core = chain[-1][0].with_name(m["core_ply"])
        cm_file = core.with_name(core.stem + "_route.json")
        cm = json.loads(cm_file.read_text(encoding="utf-8")) if cm_file.exists() else None
        if cm is None:          # a core written before cores kept a manifest: the extended one, without its added clips
            cm = {**m, "clips": [c for c in m["clips"] if "auto_transform" not in c]}
            cm.pop("core_ply", None)
            cm.pop("extensions", None)
        chain.append((core, cm, out_ply.with_name(out_ply.stem + "_core.ply")))
    rename = {src.name: dst.name for src, _, dst in chain}
    result = {"metres_per_unit": new, "scale": k}
    for src, man, dst in chain:
        n = _scale_ply(src, dst, k)
        side = src.with_suffix(".json")
        meta = json.loads(side.read_text(encoding="utf-8")) if side.exists() else {}
        meta.update(metres_per_unit=new, gaussians=n)
        if "route_length_m" in meta:
            meta["route_length_m"] = float(meta["route_length_m"]) * k
        if meta.get("base_ply") in rename:
            meta["base_ply"] = rename[meta["base_ply"]]
        meta["scaled_from"] = {"ply": src.name, "metres_per_unit": old}
        dst.with_suffix(".json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
        cams = src.with_name(src.stem + "_cams.json")
        if cams.exists():
            pts = np.array(json.loads(cams.read_text(encoding="utf-8")), dtype=np.float64) * k
            dst.with_name(dst.stem + "_cams.json").write_text(json.dumps(pts.tolist()), encoding="utf-8")
        stitch = src.with_name(src.stem + "_stitch.json")
        if stitch.exists():
            seams = json.loads(stitch.read_text(encoding="utf-8"))
            for seam in seams if isinstance(seams, list) else []:
                for key in [key for key in seam if key.endswith("_m")]:
                    seam[key] = [float(v) * k for v in seam[key]] if isinstance(seam[key], list) else float(seam[key]) * k
                if "adjust" in seam:
                    seam["adjust"] = _scaled_adjust(seam["adjust"], k)
            dst.with_name(dst.stem + "_stitch.json").write_text(json.dumps(seams, indent=1), encoding="utf-8")
        m2 = json.loads(json.dumps(man))
        m2["metres_per_unit"] = new
        for key in ("base_ply", "core_ply"):
            if m2.get(key) in rename:
                m2[key] = rename[m2[key]]
        for entry in m2.get("clips") or []:
            if "adjust" in entry:
                entry["adjust"] = _scaled_adjust(entry["adjust"], k)
        for rep in m2.get("extensions") or []:
            if "adjust" in rep:
                rep["adjust"] = _scaled_adjust(rep["adjust"], k)
        dst.with_name(dst.stem + "_route.json").write_text(json.dumps(m2), encoding="utf-8")
        if dst == out_ply:
            result.update(gaussians=n, route_length_m=meta.get("route_length_m"))
    if len(chain) > 1:
        result["base_ply" if manifest.get("base_ply") else "core_ply"] = chain[1][2].name
    if manifest.get("base_ply") and len(chain) > 2:
        result["core_ply"] = chain[2][2].name
    return result


def adjust_route(route_ply: Path, manifest: dict, adjustments: dict, out_ply: Path) -> dict:
    """Hand adjustments of the clips added at a route's ends, with no reconstruction: each added clip's transform
    becomes its adjustment after its automatic alignment (a clip not named in `adjustments` goes back to that), and
    the route is merged again from the runs its manifest names.  route_ply / manifest: a route extend_route made
    (or adjust_route), without turns."""
    m = json.loads(json.dumps(manifest))
    m.pop("base_ply", None)
    added = [c for c in m["clips"] if "auto_transform" in c]
    if not added or not m.get("core_ply"):
        raise ValueError("this route has no clips added at its ends to adjust")
    mpu = float(m["metres_per_unit"])
    for entry in added:
        _with_adjustment(entry, adjustments.get(_added_name(entry)), mpu)
    for rep in m.get("extensions") or []:
        hit = next((c for c in added if _added_name(c) == (rep.get("url") or rep.get("clip"))
                    or Path(c["clip"]).name == rep.get("clip")), None)
        if hit:
            rep["adjust"] = hit["adjust"]
    stitch_file = route_ply.with_name(route_ply.stem + "_stitch.json")
    stitch = json.loads(stitch_file.read_text(encoding="utf-8")) if stitch_file.exists() else []
    for seam in stitch:
        hit = next((c for c in added if seam.get("url") and _added_name(c) == seam["url"]), None)
        if hit:
            seam["adjust"] = hit["adjust"]
    runs, T = _manifest_runs(m)
    return {**_write_extended(m, runs, T, out_ply, m["core_ply"], stitch), "extensions": m.get("extensions") or []}
