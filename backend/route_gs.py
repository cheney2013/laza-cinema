"""
Route splat: several video clips of one continuous camera move -> one gaussian splat in one frame.

Why it exists: a long walk (a street, a corridor) is too long for one reconstruction, and splats made from separate
single pictures do not agree with each other.  A chain of H3 clips continued with motion context does agree.  So:

  1. Sample frames from each clip (a few dozen at most per run: WorldMirror's memory grows with the frame count).
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
SAM3_CKPT = os.environ.get("SAM3_CKPT", "sam3.1_multiplex_fp16.safetensors")   # in ComfyUI's models/checkpoints
HYWORLD_DIR = Path(os.environ.get("HYWORLD_DIR", "D:/Projects/HY-World-2.0"))
HF_HOME = os.environ.get("FLASHWORLD_HF_HOME", "D:/hf_cache")
SCENE_SCALE = 0.1
MAX_SPLAT = 0.09          # largest gaussian kept, in stored units (0.9 m)
CUT_AHEAD = 0.10          # seam plane this many reconstruction units ahead of the earlier clip's last camera


# --------------------------------------------------------------------------------------------- frames
def _frame_count(video: Path) -> int:
    out = subprocess.run(
        [os.environ.get("FFPROBE", "ffprobe"), "-v", "error", "-count_frames", "-select_streams", "v:0",
         "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", str(video)],
        capture_output=True, text=True, timeout=300).stdout.strip()
    return int(out) if out.isdigit() else 0


def _motion_profile(video: Path, total: int, size: int = 96) -> np.ndarray:
    """Mean absolute grey difference between consecutive frames (length total, first entry 0), from a
    tiny ffmpeg decode. Camera motion and moving subjects both show up, which is what the sampler wants."""
    proc = subprocess.run(
        [os.environ.get("FFMPEG", "ffmpeg"), "-v", "error", "-i", str(video), "-vf",
         f"scale={size}:{size // 2 * 2}:flags=area,format=gray", "-f", "rawvideo", "-"],
        capture_output=True, timeout=600)
    fr = np.frombuffer(proc.stdout, np.uint8)
    n = fr.size // (size * (size // 2 * 2))
    if n < 2:
        return np.zeros(total)
    fr = fr[: n * size * (size // 2 * 2)].reshape(n, -1).astype(np.int16)
    m = np.zeros(total)
    m[1:n] = np.abs(np.diff(fr, axis=0)).mean(axis=1)
    return m


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
                  adaptive: bool = True) -> list[Path]:
    """About total/step frames (at most `max_frames`), as PNG files of the given width. With `adaptive` the
    frames follow the clip's motion instead of a fixed step. ffmpeg does the decoding: the backend's venv has
    no video reader of its own."""
    out_dir.mkdir(parents=True, exist_ok=True)
    total = _frame_count(video)
    if not total:
        raise RuntimeError(f"cannot read {video.name}")
    count = min(max_frames, math.ceil(total / step))
    idx = pick_frame_indices(total, count, _motion_profile(video, total) if adaptive else None)
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


def sam3_submit(clip: Path, dense_dir: Path, *, dense_fps: float = 12.0, window: int = 60) -> dict:
    """Decode `clip` at `dense_fps` and queue SAM 3.1 video tracking of "person" in ComfyUI (SAM3_VideoTrack).
    The tracker needs consecutive frames, so the whole clip is tracked, in windows of `window` frames: one long
    run loses people in the fire and smoke, and every window starts again by detecting everyone in its first
    frame. All windows are queued at once so ComfyUI runs them back to back. Returns what sam3_collect needs."""
    import urllib.request
    src_fps, W, H = _probe(clip)
    w = 704
    h = round(w * H / W / 2) * 2
    shutil.rmtree(dense_dir, ignore_errors=True)
    dense_dir.mkdir(parents=True)
    subprocess.run([os.environ.get("FFMPEG", "ffmpeg"), "-v", "error", "-y", "-i", str(clip), "-vf",
                    f"fps={dense_fps},scale={w}:{h}", str(dense_dir / "d_%04d.png")], check=True, timeout=900)
    n_dense = len(list(dense_dir.glob("d_*.png")))
    tag = f"route_sam3/{uuid.uuid4().hex[:10]}"
    pids = []
    for k, start in enumerate(range(0, n_dense, window)):
        wf = {
            "1": {"class_type": "LoadImagesFromFolderKJ", "inputs": {"folder": str(dense_dir), "width": w, "height": h,
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
    return {"pids": pids, "tag": tag, "n_dense": n_dense, "src_fps": src_fps, "dense_fps": dense_fps, "dense_dir": dense_dir}


def sam3_collect(job: dict, frames_dir: Path, mask_dir: Path, *, dilate: int = 4, timeout: int = 3600,
                 should_stop: Optional[Callable[[], bool]] = None) -> None:
    """Wait for the queued tracking and write a mask for every sampled frame (b_*) in `frames_dir`: the dense
    frame nearest in time, merged with its two neighbours (the people keep moving between dense frames), then
    grown by `dilate` pixels. Frames that are not own samples of the clip (a_*) get no mask here."""
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
    idx = json.loads((frames_dir / "indices.json").read_text())
    mask_dir.mkdir(parents=True, exist_ok=True)
    for f, fi in zip(sorted(frames_dir.glob("b_*.png")), idx):
        j = min(n_dense - 1, max(0, round(fi / job["src_fps"] * job["dense_fps"])))
        m = None
        for k in (j - 1, j, j + 1):
            if 0 <= k < n_dense:
                with Image.open(dense_masks[k]) as im:
                    g = im.convert("L")
                m = g if m is None else ImageChops.lighter(m, g)
        if dilate:
            m = m.filter(ImageFilter.MaxFilter(2 * dilate + 1))
        m.save(mask_dir / f.name)
    shutil.rmtree(out, ignore_errors=True)
    shutil.rmtree(job["dense_dir"], ignore_errors=True)


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


# --------------------------------------------------------------------------------------------- pipeline
PIPELINE_VERSION = "1"    # bump when frame sampling or masking changes: old cache entries then stop matching


def _clip_key(clip: Path, prev_key: str, frame_step, shared, max_frames, adaptive, mask_people, mask_fallback, index,
              frame_width=704) -> str:
    h = hashlib.sha1()
    with open(clip, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    h.update(json.dumps([PIPELINE_VERSION, prev_key, frame_step, shared, max_frames, adaptive, mask_people,
                         mask_fallback, index > 0, frame_width]).encode())
    return h.hexdigest()[:20]


def build_route_gaussian(clips: list[Path], out_ply: Path, work: Path, *, frame_step: int = 9, shared: int = 5,
                         max_frames: int = 36, metres_per_unit: float = 30.5, max_gaussians: int = 0,
                         progress: Optional[Callable[[str], None]] = None, keep_work: bool = False,
                         mask_people: bool = False, adaptive: bool = True, mask_fallback: bool = False,
                         cache_dir: Optional[Path] = None, frame_width: int = 704,
                         should_stop: Optional[Callable[[], bool]] = None) -> dict:
    """clips in route order -> out_ply (+ .json sidecar, _cams.json, _stitch.json).  Blocking; run it in a thread.

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

    # Stage 1: key every clip, take what the cache has, sample frames for the rest (cheap, no GPU).
    # Stage 2: person masks for every new clip, queued together so SAM 3.1 stays loaded and busy.
    # Stage 3: WorldMirror on the new clips, one after another.
    # A clip's result depends on the clip, the settings and the clip before it (its first frames are the
    # previous clip's last samples), so that chain is the cache key: adding clips at the end of a route
    # reuses every earlier clip, and a failed run resumes where it stopped.
    plan = []
    prev_files: list[Path] = []
    prev_key = ""
    for i, clip in enumerate(clips):
        check()
        key = _clip_key(clip, prev_key, frame_step, shared, max_frames, adaptive, mask_people, mask_fallback, i, frame_width)
        prev_key = key
        cdir = (cache_dir / key) if cache_dir else (work / f"clip{i}")
        e = {"clip": clip, "cdir": cdir, "frames": cdir / "frames", "masks": cdir / "masks", "out": cdir / "out",
             "done": cdir / "done.json"}
        if cache_dir and e["done"].exists():
            say(f"clip {i + 1}/{len(clips)}: reusing the saved reconstruction")
            meta = json.loads(e["done"].read_text())
            e.update(cached=True, n_shared=meta["n_shared"], own=[e["frames"] / n for n in meta["own"]])
        else:
            shutil.rmtree(cdir, ignore_errors=True)
            say(f"clip {i + 1}/{len(clips)}: sampling frames")
            own = sample_frames(clip, e["frames"], frame_step, max_frames - (shared if i else 0), width=frame_width,
                                adaptive=adaptive)
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
                say(f"clip {i + 1}/{len(clips)}: queuing SAM 3.1 tracking")
                jobs[i] = sam3_submit(plan[i]["clip"], plan[i]["cdir"] / "dense")
            for i in new:
                say(f"clip {i + 1}/{len(clips)}: person masks")
                sam3_collect(jobs[i], plan[i]["frames"], plan[i]["masks"], should_stop=should_stop)
                k = plan[i]["n_shared"]
                for n in range(k):      # repeated frames keep the mask the previous clip made for them
                    prev = plan[i - 1]
                    shutil.copy2(prev["masks"] / prev["own"][-k:][n].name, plan[i]["masks"] / f"a_{n:03d}.png")
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
                shutil.rmtree(plan[i]["masks"], ignore_errors=True)
                make_person_masks(plan[i]["frames"], plan[i]["masks"])
        for i in new:
            shutil.rmtree(plan[i]["cdir"] / "dense", ignore_errors=True)
        comfy_free()          # WorldMirror needs the card next

    runs = []                      # per clip: dict(dir, cams (n,4,4), own (index of first own camera))
    for i, e in enumerate(plan):
        check()
        if e["cached"]:
            out = e["out"]
            for f in sorted(out.rglob("camera_params.json")):
                out = f.parent
        else:
            say(f"clip {i + 1}/{len(clips)}: WorldMirror on {len(e['own']) + e['n_shared']} frames")
            out = run_worldmirror(e["frames"], e["out"], mask_dir=e["masks"] if mask_people else None,
                                  should_stop=should_stop)
            if cache_dir:
                e["done"].write_text(json.dumps({"n_shared": e["n_shared"], "own": [f.name for f in e["own"]]}))
        j = json.load(open(out / "camera_params.json", encoding="utf-8"))
        cams = np.array([c["matrix"] for c in j["extrinsics"]])
        runs.append({"dir": out, "cams": cams, "n_shared": e["n_shared"]})

    say("aligning clips")
    # transform of every clip into clip 0's frame
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

    def cam_in_frame0(i, idx):
        s, R, t = T[i]
        m = runs[i]["cams"][idx]
        c = np.eye(4)
        c[:3, :3] = R @ m[:3, :3]
        c[:3, 3] = s * (R @ m[:3, 3]) + t
        return c

    parts, header, names = [], None, None
    for i in range(len(runs)):
        h, nm, d = read_ply(runs[i]["dir"] / "gaussians.ply")
        header, names = h, nm
        io = names.index("opacity")
        p = np.clip(d[:, io], 1e-4, 1 - 1e-4)
        d[:, io] = np.log(p / (1 - p))
        s, R, t = T[i]
        parts.append(move_splat(d, names, s, R, t))

    # seam planes: through the last camera of clip i, along its heading, a little ahead
    ix = [names.index(c) for c in "xyz"]
    planes = []
    for i in range(len(runs) - 1):
        c = cam_in_frame0(i, -1)
        planes.append((c[:3, 3] + CUT_AHEAD * c[:3, 2], c[:3, 2]))
    kept = []
    for i, d in enumerate(parts):
        m = np.ones(len(d), dtype=bool)
        if i > 0:
            pc, pf = planes[i - 1]
            m &= (d[:, ix] - pc) @ pf > 0
        if i < len(planes):
            pc, pf = planes[i]
            m &= (d[:, ix] - pc) @ pf <= 0
        kept.append(d[m])
    data = np.concatenate(kept)

    say("writing the splat")
    f = metres_per_unit * SCENE_SCALE
    data[:, ix] *= f
    for k in range(3):
        data[:, names.index(f"scale_{k}")] += math.log(f)
    cols = [i for i, n in enumerate(names) if n not in ("nx", "ny", "nz")]
    data = data[:, cols]
    names2 = [names[i] for i in cols]
    big = np.exp(data[:, [names2.index(f"scale_{k}") for k in range(3)]]).max(axis=1) > MAX_SPLAT
    data = data[~big]
    if max_gaussians and len(data) > max_gaussians:    # 0 = keep every gaussian
        data = data[np.argsort(-data[:, names2.index("opacity")])[:max_gaussians]]
    props = [ln for ln in header if ln.startswith(b"property") and ln.split()[-1].decode() in names2]
    out_header = b"".join((b"element vertex %d\n" % len(data)) if ln.startswith(b"element vertex") else ln
                          for ln in header if not ln.startswith(b"property") and ln.strip() != b"end_header")
    out_header += b"".join(props) + b"end_header\n"
    out_ply.parent.mkdir(parents=True, exist_ok=True)
    with open(out_ply, "wb") as fh:
        fh.write(out_header)
        fh.write(np.ascontiguousarray(data, dtype=np.float32).tobytes())

    # route cameras in metres (frame 0: x right, y down, z forward) -- where a render camera can stand
    route = []
    for i in range(len(runs)):
        start = runs[i]["n_shared"]
        for idx in range(start, len(runs[i]["cams"])):
            route.append((cam_in_frame0(i, idx)[:3, 3] * metres_per_unit).tolist())
    length = float(np.linalg.norm(np.diff(np.array(route), axis=0), axis=1).sum()) if len(route) > 1 else 0.0
    out_ply.with_suffix(".json").write_text(json.dumps({
        "source": f"WorldMirror route splat, {len(clips)} clips", "frame": "picture_camera_opencv",
        "units": "metres", "scene_scale": SCENE_SCALE, "trajectory": "video", "gaussians": int(len(data)),
        "metres_per_unit": metres_per_unit, "route_length_m": length}), encoding="utf-8")
    out_ply.with_name(out_ply.stem + "_cams.json").write_text(json.dumps(route), encoding="utf-8")
    out_ply.with_name(out_ply.stem + "_stitch.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    if not keep_work:
        shutil.rmtree(work, ignore_errors=True)
    return {"gaussians": int(len(data)), "route_length_m": length, "stitch": report}
