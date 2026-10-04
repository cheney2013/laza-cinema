#!/usr/bin/env python
"""
Drive a MiniMax H3 production: mint voice references, render every scene through
reference-to-video, then cut them together.

    backend\\.venv\\Scripts\\python tools\\produce_h3.py productions/sound_check --stage all

H3 changes the shape of the pipeline the Wan2.2 driver assumes. A scene is one
generation that already contains its own cuts, its own dialogue and its own foley, so
there is no keyframe stage, no i2v stage and no separate score/ambience/mix stage.
What replaces them is reference discipline: identity comes from `ref_images`, and a
character's *voice* comes from `ref_audios`, which have to be minted before any scene
runs.

Stages, in order, each independently runnable and resumable:

    voices    one short solo generation per speaking character -> voices/voice_<slug>.wav
    scenes    one ref2va generation per scene                  -> scenes/scene_NN_<slug>.mp4
    assemble  ffmpeg cut, keeping H3's native audio            -> final.mp4

Review between stages with tools/h3_review.py — it checks sound, which no contact
sheet can.

Talking to ComfyUI directly rather than through the backend on :8003: H3 has no
backend endpoint yet, and the backend runs with --reload, which kills in-flight jobs
whenever a file under backend/ is saved.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
import wave
from pathlib import Path

COMFY = os.environ.get("COMFYUI_URL", "http://127.0.0.1:8188").rstrip("/")
FPS = 24
TRAINED_MIN, TRAINED_MAX = 124, 362

DIFFUSION_R2V = "minimax_h3_ref2va_pruned_int8_convrot.safetensors"
TEXT_ENCODER = "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"
VIDEO_VAE = "minimax_h3_video_vae_fp16.safetensors"
AUDIO_VAE = "minimax_h3_audio_vae_fp32.safetensors"


class SceneFailed(RuntimeError):
    pass


# ---------------------------------------------------------------- ComfyUI plumbing

def _get(path: str, timeout: int = 60):
    with urllib.request.urlopen(f"{COMFY}{path}", timeout=timeout) as r:
        return json.load(r)


def _post(path: str, payload: dict, timeout: int = 60):
    req = urllib.request.Request(
        f"{COMFY}{path}", data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def comfy_dirs() -> tuple[Path, Path]:
    """Read ComfyUI's own input/output directories off its launch argv.

    Hardcoding D:\\ComfyUI\\input would break the moment the desktop app is moved or
    a second install is added, and this tool has to put reference files where the
    LoadImage/LoadAudio nodes will look for them.
    """
    argv = _get("/system_stats", timeout=15)["system"]["argv"]
    def flag(name: str, default: str) -> Path:
        return Path(argv[argv.index(name) + 1]) if name in argv else Path(default)
    return flag("--input-directory", "input"), flag("--output-directory", "output")


def frame_length(seconds: float) -> int:
    """Snap to H3's 17k+5 frame grid at 24fps, as the official template's math node does."""
    n = max(5, round(seconds * FPS))
    return n + (5 - n % 17) % 17


def stage_file(src: Path, comfy_input: Path) -> str:
    """Copy an asset into ComfyUI's input dir under a content-stable name."""
    name = f"h3_{src.parent.name}_{src.name}"
    dest = comfy_input / name
    if not dest.exists() or dest.stat().st_mtime < src.stat().st_mtime:
        shutil.copy2(src, dest)
    return name


# ---------------------------------------------------------------- prompt references

def resolve_prompt(prompt: str, images: list[str], audios: list[str],
                   clips: list[str] | None = None) -> str:
    """Rewrite <Picture:slug> / <Video:slug> / <Audio:slug> into the numbers H3 sees.

    The tokenizer numbers each *kind* separately and independently — <Picture N> counts
    only images, <Audio N> only audio, <Video N> only video — so a prompt written with
    literal numbers goes silently wrong the moment a reference is added, removed or
    reordered. Writing slugs and resolving them here makes that class of bug impossible.

    A reference clip's own soundtrack is numbered ahead of any standalone voice
    reference, because the node emits each video's `<Audio j>` label immediately before
    its `<Video k>` and only then the standalone audio.

    >>> resolve_prompt("<Picture:hui> and <Audio:chen>", ["hui", "chen"], ["chen"])
    '<Picture 1> and <Audio 1>'
    >>> resolve_prompt("<Picture:set>", ["hui", "chen", "set"], [])
    '<Picture 3>'
    >>> resolve_prompt("<Video:s1> keeps <Audio:s1>, revoice as <Audio:ge>",
    ...                [], ["ge"], ["s1"])
    '<Video 1> keeps <Audio 1>, revoice as <Audio 2>'
    """
    clips = clips or []
    # each clip's soundtrack takes an <Audio> ordinal before the standalone ones
    audio_order = [*clips, *audios]
    for kind, slugs in (("Picture", images), ("Video", clips), ("Audio", audio_order)):
        for i, slug in enumerate(slugs, start=1):
            prompt = prompt.replace(f"<{kind}:{slug}>", f"<{kind} {i}>")
    unresolved = [t for t in ("<Picture:", "<Audio:", "<Video:") if t in prompt]
    if unresolved:
        raise SceneFailed(
            f"prompt references something not in this scene's refs/voices/clips: "
            f"{prompt[prompt.index(unresolved[0]):][:60]!r}")
    return prompt


def build_r2v_graph(prompt: str, image_names: list[str], audio_names: list[str],
                    clip_names: list[str],
                    width: int, height: int, length: int, seed: int, steps: int,
                    scheduler: str, ref_image_size: str, prefix: str,
                    shift: tuple[float, float] | None,
                    sage: str | None = None,
                    sol_attn: bool = False,
                    sol_tau: float = 1.3,
                    sol_int8_qk: bool = True,
                    sol_chunk_ffn: int = 2) -> dict:
    graph: dict = {
        "1": {"class_type": "UNETLoader",
              "inputs": {"unet_name": DIFFUSION_R2V, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": TEXT_ENCODER, "type": "minimax", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": VIDEO_VAE}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": AUDIO_VAE}},
        "6": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}},
        "7": {"class_type": "BasicScheduler",
              "inputs": {"model": ["1", 0], "scheduler": scheduler,
                         "steps": steps, "denoise": 1.0}},
        "8": {"class_type": "BasicGuider",
              "inputs": {"model": ["1", 0], "conditioning": ["5", 0]}},
        "9": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "10": {"class_type": "SamplerCustomAdvanced",
               "inputs": {"noise": ["9", 0], "guider": ["8", 0], "sampler": ["6", 0],
                          "sigmas": ["7", 0], "latent_image": ["5", 1]}},
        "11": {"class_type": "VAEDecode", "inputs": {"samples": ["10", 0], "vae": ["3", 0]}},
        "12": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["10", 0], "vae": ["4", 0]}},
        "13": {"class_type": "CreateVideo",
               "inputs": {"images": ["11", 0], "fps": FPS, "audio": ["12", 0]}},
        "14": {"class_type": "SaveVideo",
               "inputs": {"video": ["13", 0], "filename_prefix": prefix,
                          "format": "auto", "codec": "auto"}},
    }
    ref_inputs: dict = {}
    node = 100
    # Autogrow inputs are addressed by DOTTED PATH, not by the bare slot name:
    # `finalize_prefix` joins the Autogrow input's own id to the generated slot name, so
    # the key is "ref_images.ref_image_0". A bare "ref_image_0" passes validation — the
    # schema really does list those names — but never gets regrouped into the dict the
    # node expects, and arrives as an unexpected kwarg at execute() instead.
    # Slot numbering is zero-based while the tokenizer's <Picture N> counter is
    # one-based, so ref_image_0 is <Picture 1>.
    for i, name in enumerate(image_names):
        graph[str(node)] = {"class_type": "LoadImage", "inputs": {"image": name}}
        ref_inputs[f"ref_images.ref_image_{i}"] = [str(node), 0]
        node += 1
    for i, name in enumerate(audio_names):
        graph[str(node)] = {"class_type": "LoadAudio", "inputs": {"audio": name}}
        ref_inputs[f"ref_audios.ref_audio_{i}"] = [str(node), 0]
        node += 1
    # A reference clip enters as frames + its own soundtrack, index-paired: the node
    # looks up "ref_video_audio_" + the video's trailing index. These are *conditioning*
    # — the module docstring is explicit that reference latents are "re-injected every
    # step (never denoised)" — so H3 generates a new clip that understands the old one
    # rather than editing its pixels.
    for i, name in enumerate(clip_names):
        graph[str(node)] = {"class_type": "LoadVideo", "inputs": {"file": name}}
        graph[str(node + 1)] = {"class_type": "GetVideoComponents",
                                "inputs": {"video": [str(node), 0]}}
        ref_inputs[f"ref_videos.ref_video_{i}"] = [str(node + 1), 0]
        ref_inputs[f"ref_video_audios.ref_video_audio_{i}"] = [str(node + 1), 1]
        node += 2

    graph["5"] = {"class_type": "MiniMaxH3ReferenceToVideo",
                  "inputs": {"clip": ["2", 0], "vae": ["3", 0], "audio_vae": ["4", 0],
                             "prompt": prompt, "width": width, "height": height,
                             "length": length, "ref_image_size": ref_image_size,
                             **ref_inputs}}
    if shift:
        graph["15"] = {"class_type": "MiniMaxH3SigmaShift",
                       "inputs": {"model": ["1", 0],
                                  "shift_video": shift[0], "shift_audio": shift[1]}}
        graph["7"]["inputs"]["model"] = ["15", 0]
        graph["8"]["inputs"]["model"] = ["15", 0]
    if sage:
        # Measured on T2V: 306s -> 203s (-34%), tone and contrast unchanged, no black
        # frames. But peak VRAM went 27.4 -> 31.2 GB of 31.8, and R2V carries reference
        # tokens through every step on top of that — so this can OOM where T2V did not.
        # Apply as a node; the --use-sage-attention launch flag produces black output.
        # Only "auto" works with SageAttention 1.x.
        src = graph["7"]["inputs"]["model"]
        graph["16"] = {"class_type": "PathchSageAttentionKJ",
                       "inputs": {"model": src, "sage_attention": sage,
                                  "allow_compile": False}}
        graph["7"]["inputs"]["model"] = ["16", 0]
        graph["8"]["inputs"]["model"] = ["16", 0]
    if sol_attn:
        # Sol-Attn + Chunked FFN on Blackwell SM120: measured 119-133s vs 203s (Sage),
        # with peak VRAM kept at 28.7-29.4 GB. Exact KV sink protects ref audio/image sync.
        src = graph["7"]["inputs"]["model"]
        graph["18"] = {
            "class_type": "MiniMaxH3MemoryEfficientSolAttentionPatch",
            "inputs": {
                "model": src,
                "enabled": True,
                "tau": float(sol_tau),
                "min_tokens": 4096,
                "strict": False,
                "thresh_type": "diag",
                "int8_qk": bool(sol_int8_qk),
                "int8_pv": False,
                "sink_conditioning": "exact_kv",
                "dense_blocks": "",
            },
        }
        curr = ["18", 0]
        if sol_chunk_ffn > 0:
            graph["19"] = {
                "class_type": "MiniMaxH3ChunkFeedForward",
                "inputs": {
                    "model": curr,
                    "enabled": True,
                    "chunks": int(sol_chunk_ffn),
                    "min_tokens": 8192,
                },
            }
            curr = ["19", 0]
        graph["7"]["inputs"]["model"] = curr
        graph["8"]["inputs"]["model"] = curr
    return graph


def run_graph(graph: dict, label: str) -> Path:
    resp = _post("/prompt", {"prompt": graph, "client_id": str(uuid.uuid4())})
    if "prompt_id" not in resp:
        raise SceneFailed(f"ComfyUI rejected the graph: "
                          f"{json.dumps(resp, ensure_ascii=False)[:2000]}")
    pid = resp["prompt_id"]
    t0 = time.time()
    last = 0.0
    while True:
        time.sleep(4)
        # ComfyUI stalls its event loop while paging the 15GB text encoder, so a poll
        # can time out mid-render. The job keeps running; only the poll failed.
        try:
            hist = _get(f"/history/{pid}", timeout=30)
        except (urllib.error.URLError, OSError):
            continue
        el = time.time() - t0
        if pid in hist:
            status = hist[pid].get("status", {})
            if status.get("completed"):
                for out in hist[pid].get("outputs", {}).values():
                    for items in out.values():
                        if isinstance(items, list):
                            for v in items:
                                if isinstance(v, dict) and v.get("filename"):
                                    print(f"  [{label}] done in {el:.0f}s")
                                    return Path(v.get("subfolder", "")) / v["filename"]
                raise SceneFailed("completed but produced no file")
            if status.get("status_str") == "error":
                msgs = json.dumps(status.get("messages", []), ensure_ascii=False)
                raise SceneFailed(msgs[:2000])
        if el - last >= 60:
            last = el
            print(f"  [{label}] {el:.0f}s...")


# ---------------------------------------------------------------- stages

def is_stale(out: Path, inputs: list[Path]) -> bool:
    """Existence alone is not enough — a scene built from a superseded reference sits
    on disk reporting success while the fix never reaches the screen."""
    if not out.exists():
        return True
    return any(p.exists() and p.stat().st_mtime > out.stat().st_mtime for p in inputs)


def asset_path(prod: Path, slug: str) -> Path:
    """A ref slug resolves to refs/<slug>.png; a path is taken as written."""
    p = prod / "refs" / f"{slug}.png"
    return p if p.exists() else (prod / slug)


def clip_path(prod: Path, slug: str) -> Path:
    """A clip slug resolves to an already-rendered scene; a path is taken as written."""
    hits = sorted((prod / "scenes").glob(f"scene_*_{slug}.mp4"))
    return hits[0] if hits else (prod / slug)


def materialise_anchor(prod: Path, anchor: dict) -> Path:
    """Pull a still out of an already-rendered scene to use as a composition anchor.

    Words do not cross a generation boundary. Each scene is an independent generation
    and its prompt has no idea what the previous one actually rendered, so "the windows
    are on the right" is re-interpreted from scratch every time — which is how a film
    with an explicit blocking rule still drifts between scenes. A frame does cross:
    fed back as a standalone `<Picture N>`, the guide's shot-planning anchor, it carries
    viewpoint, subject placement and room geography as latent conditioning instead of
    as an adjective.

    Distinct from a `<Subject N>` reference, which says what someone looks like. This
    says where the camera is and who stands where.
    """
    src = clip_path(prod, anchor["from"])
    dest = prod / "anchors" / f"{anchor['slug']}.png"
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not src.exists():
        return dest  # caller reports it missing
    if dest.exists() and dest.stat().st_mtime >= src.stat().st_mtime:
        return dest

    n = int(subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames",
         "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", str(src)],
        capture_output=True, text=True, check=True).stdout.strip())
    idx = min(n - 1, max(0, int(n * float(anchor.get("at", 0.95)))))
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", str(src),
         "-vf", f"select='eq(n\\,{idx})'", "-frames:v", "1", str(dest)], check=True)
    print(f"  anchor {anchor['slug']}: frame {idx}/{n} of {src.name}")
    return dest


def stage_voices(prod: Path, spec: dict, comfy_in: Path, comfy_out: Path,
                 only: set[str] | None) -> list[str]:
    """Mint one voice reference per speaking character.

    These have to be *solo* generations. A voice reference cut out of a two-hander is
    two voices in one file, and feeding that back in as `ref_audio` asks the model to
    reproduce both — which is not what "lock this character's voice" means.
    """
    (prod / "voices").mkdir(parents=True, exist_ok=True)
    failures = []
    for slug, cast in spec.get("cast", {}).items():
        if only and slug not in only:
            continue
        if not cast.get("voice_prompt"):
            continue
        dest = prod / "voices" / f"voice_{slug}.wav"
        ref = asset_path(prod, slug)
        if not is_stale(dest, [ref, prod / "scenes.json"]):
            print(f"[voice {slug}] cached")
            continue
        if not ref.exists():
            print(f"[voice {slug}] SKIP — no reference still at {ref}")
            failures.append(slug)
            continue

        seconds = cast.get("voice_seconds", 5.2)
        length = frame_length(seconds)
        images = [slug]
        prompt = resolve_prompt(
            f"{spec.get('style', '')}\n\n{cast['voice_prompt']}\n\n"
            f"{spec.get('negative_tail', '')}".strip(), images, [])
        print(f"[voice {slug}] generating {length} frames ({length / FPS:.1f}s)")
        graph = build_r2v_graph(
            prompt, [stage_file(ref, comfy_in)], [],
            spec.get("width", 1344), spec.get("height", 768), length,
            spec.get("base_seed", 81000) + hash(slug) % 1000,
            spec.get("steps", 20), spec.get("scheduler", "beta"),
            spec.get("ref_image_size", "match"), f"video/h3_voice_{slug}", None,
            spec.get("sage_attention"),
            spec.get("sol_attention", True),
            spec.get("sol_tau", 1.3),
            spec.get("sol_int8_qk", True),
            spec.get("sol_chunk_ffn", 2))
        try:
            rel = run_graph(graph, f"voice {slug}")
        except SceneFailed as e:
            print(f"  FAILED — {e}")
            failures.append(slug)
            continue
        # Keep the clip for review, but the deliverable is the isolated audio.
        clip = comfy_out / rel
        shutil.copy2(clip, prod / "voices" / f"voice_{slug}.mp4")
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(clip), "-vn",
                        "-acodec", "pcm_s16le", "-ar", "32000", str(dest)], check=True)
        trim_to_speech(dest)
        print(f"  -> {dest.relative_to(prod)}")
    return failures


def trim_to_speech(wav: Path, pad: float = 0.15) -> None:
    """Crop a minted voice reference down to the part that actually contains speech.

    H3 drifts spoken beats late, so a 5.9s solo take routinely holds ~0.7s of voice at
    the very end and five seconds of room tone before it. The whole file is encoded by
    the audio VAE, so that silence spends most of the reference's tokens saying nothing
    about the character's timbre. Trimming is free and strictly better than not.
    """
    import numpy as np

    with wave.open(str(wav)) as w:
        sr, ch, n = w.getframerate(), w.getnchannels(), w.getnframes()
        if n == 0:
            return
        data = np.frombuffer(w.readframes(n), dtype=np.int16).reshape(-1, ch)

    mono = data.astype(np.float32).mean(axis=1) / 32768
    win = max(1, sr // 50)  # 20ms
    env = np.array([np.sqrt(np.mean(mono[i:i + win] ** 2))
                    for i in range(0, len(mono) - win, win)])
    if env.size == 0 or env.max() <= 0:
        return
    db = 20 * np.log10(env + 1e-12)
    # speech sits well above the room tone; take everything within 18 dB of the peak
    loud = np.flatnonzero(db > db.max() - 18.0)
    if loud.size == 0:
        return
    start = max(0, int((loud[0] * win) - pad * sr))
    end = min(len(mono), int(((loud[-1] + 1) * win) + pad * sr))
    if end - start < sr * 0.3 or (end - start) >= len(mono) * 0.95:
        return  # nothing worth cropping, or the whole file is speech already

    with wave.open(str(wav), "wb") as w:
        w.setnchannels(ch)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(data[start:end].tobytes())
    print(f"  trimmed {n / sr:.2f}s -> {(end - start) / sr:.2f}s of speech")


def stage_scenes(prod: Path, spec: dict, comfy_in: Path, comfy_out: Path,
                 only: set[int] | None) -> list[int]:
    (prod / "scenes").mkdir(parents=True, exist_ok=True)
    failures = []
    for scene in spec["scenes"]:
        sid, slug = scene["id"], scene["slug"]
        if only and sid not in only:
            continue
        dest = prod / "scenes" / f"scene_{sid:02d}_{slug}.mp4"

        image_slugs = list(scene.get("refs", spec.get("refs", [])))
        voice_slugs = scene.get("voices", [])
        clip_slugs = scene.get("clips", [])
        image_paths = [asset_path(prod, s) for s in image_slugs]
        # Anchors extend the image references, so their <Picture N> ordinals follow the
        # cast and set stills. Materialise before the staleness check: re-rendering the
        # source scene must invalidate every scene anchored to it.
        for anchor in scene.get("anchors", []):
            image_slugs.append(anchor["slug"])
            image_paths.append(materialise_anchor(prod, anchor))
        voice_paths = [prod / "voices" / f"voice_{s}.wav" for s in voice_slugs]
        clip_paths = [clip_path(prod, s) for s in clip_slugs]
        missing = [str(p) for p in image_paths + voice_paths + clip_paths if not p.exists()]
        if missing:
            print(f"[scene {sid:02d}] SKIP — missing {missing}")
            failures.append(sid)
            continue
        if not is_stale(dest, image_paths + voice_paths + clip_paths
                        + [prod / "scenes.json"]):
            print(f"[scene {sid:02d} {slug}] cached")
            continue

        length = frame_length(scene["seconds"])
        if not TRAINED_MIN <= length <= TRAINED_MAX:
            print(f"[scene {sid:02d}] ! {length} frames outside trained range "
                  f"{TRAINED_MIN}-{TRAINED_MAX}")
        # `blocking` is appended to every scene verbatim. Continuity of population and
        # geography is invisible shot-by-shot and obvious the moment two scenes sit side
        # by side: this film's first cut had an empty classroom in one scene and a packed
        # one in the next, the camera crossed the line between the noticeboard wall and
        # the window wall, and one character swapped screen sides — because none of it
        # was ever stated. Keep it short; added text competes with the shot description.
        #
        # A scene may override it with its own string, or opt out with "". **The shot
        # where a character moves must opt out.** A blocking rule that pins someone to
        # one side of frame while the action walks them somewhere else is a
        # contradiction, and the model resolves a contradiction by drawing the subject
        # twice — once in each place — rather than by compromising.
        blocking = scene.get("blocking", spec.get("blocking", ""))
        body = "\n".join(x for x in (spec.get("style", ""), scene["prompt"], blocking,
                                     spec.get("negative_tail", "")) if x)
        try:
            prompt = resolve_prompt(body, image_slugs, voice_slugs, clip_slugs)
        except SceneFailed as e:
            print(f"[scene {sid:02d}] SKIP — {e}")
            failures.append(sid)
            continue

        seed = scene.get("seed_override", spec.get("base_seed", 81000) + sid * 17)
        shift = None
        if "shift_video" in spec:
            shift = (spec["shift_video"], spec.get("shift_audio", 3.0))
        print(f"[scene {sid:02d} {slug}] {length} frames ({length / FPS:.1f}s) "
              f"seed={seed} refs={image_slugs} voices={voice_slugs}"
              + (f" clips={clip_slugs}" if clip_slugs else ""))
        graph = build_r2v_graph(
            prompt, [stage_file(p, comfy_in) for p in image_paths],
            [stage_file(p, comfy_in) for p in voice_paths],
            [stage_file(p, comfy_in) for p in clip_paths],
            spec.get("width", 1344), spec.get("height", 768), length, seed,
            spec.get("steps", 20), spec.get("scheduler", "beta"),
            spec.get("ref_image_size", "match"),
            f"video/h3_{prod.name}_{sid:02d}", shift,
            spec.get("sage_attention"),
            spec.get("sol_attention", True),
            spec.get("sol_tau", 1.3),
            spec.get("sol_int8_qk", True),
            spec.get("sol_chunk_ffn", 2))
        try:
            rel = run_graph(graph, f"scene {sid:02d}")
        except SceneFailed as e:
            print(f"  FAILED — {e}")
            failures.append(sid)
            continue
        shutil.copy2(comfy_out / rel, dest)
        print(f"  -> {dest.relative_to(prod)}")
    return failures


def stage_assemble(prod: Path, spec: dict) -> None:
    """Cut with a filter graph so each scene carries its own screen time, and so the
    native audio rides along with its own trim rather than being re-synced by hand."""
    parts = []
    for scene in spec["scenes"]:
        clip = prod / "scenes" / f"scene_{scene['id']:02d}_{scene['slug']}.mp4"
        if not clip.exists():
            print(f"!! missing {clip.name} — run --stage scenes first")
            return
        parts.append((clip, scene))

    args: list[str] = ["ffmpeg", "-y", "-v", "error"]
    for clip, _ in parts:
        args += ["-i", str(clip)]
    chains, vlabels, alabels = [], [], []
    for i, (_, scene) in enumerate(parts):
        start = scene.get("edit_in", 0)
        dur = scene.get("edit_duration")
        trim = f"start={start}" + (f":duration={dur}" if dur else "")
        chains.append(f"[{i}:v]trim={trim},setpts=PTS-STARTPTS[v{i}]")
        chains.append(f"[{i}:a]atrim={trim},asetpts=PTS-STARTPTS[a{i}]")
        vlabels.append(f"[v{i}]")
        alabels.append(f"[a{i}]")
    concat = "".join(v + a for v, a in zip(vlabels, alabels))
    chains.append(f"{concat}concat=n={len(parts)}:v=1:a=1[vout][aout]")

    out = prod / "final.mp4"
    args += ["-filter_complex", ";".join(chains), "-map", "[vout]", "-map", "[aout]",
             "-c:v", "libx264", "-crf", "16", "-preset", "slow", "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-b:a", "256k", "-ar", "48000", str(out)]
    subprocess.run(args, check=True)
    dur = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(out)], capture_output=True, text=True, check=True)
    print(f"final.mp4  {float(dur.stdout.strip()):.1f}s  <- {len(parts)} scenes")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("production", type=Path)
    ap.add_argument("--stage", default="all",
                    choices=["all", "voices", "scenes", "assemble"])
    ap.add_argument("--scenes", help="comma-separated scene ids to limit to")
    ap.add_argument("--only", help="comma-separated cast slugs (voices stage)")
    args = ap.parse_args()

    prod = args.production.resolve()
    spec = json.loads((prod / "scenes.json").read_text(encoding="utf-8"))
    try:
        comfy_in, comfy_out = comfy_dirs()
    except (urllib.error.URLError, OSError) as e:
        print(f"!! ComfyUI unreachable at {COMFY}: {e}")
        return 2
    only_scenes = {int(s) for s in args.scenes.split(",")} if args.scenes else None
    only_cast = {s.strip() for s in args.only.split(",")} if args.only else None

    failed: list = []
    if args.stage in ("all", "voices"):
        failed += stage_voices(prod, spec, comfy_in, comfy_out, only_cast)
    if args.stage in ("all", "scenes"):
        failed += stage_scenes(prod, spec, comfy_in, comfy_out, only_scenes)
    if args.stage in ("all", "assemble"):
        stage_assemble(prod, spec)

    if failed:
        print(f"\nfailed: {failed} — re-run the stage to retry")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
