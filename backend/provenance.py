"""
Recover how a generated clip was made, from the clip itself.

ComfyUI writes the whole executed graph into the mp4's `prompt` metadata tag, so
every clip carries its own provenance: the prompt, the seed, the size, and —
what actually matters here — the reference images it was generated against.

That last one is why this exists. The H3 latent refine pass re-encodes its
conditioning at the upscaled size and reads the source shot's references for
texture, so an upscale run without them lands on different micro-detail than the
approved take. On the canvas those references ride along in a node's
`submittedResources`; an old clip whose node was deleted has none, and dropping
the bare file back on the canvas silently upscales it without them.

Nothing else on this machine still knows: the job history keeps only result URLs,
and the paired latent's safetensors header carries a format tag and nothing more.
The file is the last copy of its own history.
"""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

# The conditioning node carries the prompt and every reference mount.
CONDITIONING_CLASSES = ("MiniMaxH3ReferenceToVideo", "MiniMaxH3ImageToVideo")
# Loader inputs that name a file. Checked in order; the first present wins.
FILE_INPUTS = ("image", "audio", "video", "file", "filename", "ckpt_name")

_REF_IMAGE_KEY = re.compile(r"^ref_images\.ref_image_(\d+)$")
_REF_VIDEO_KEY = re.compile(r"^ref_videos\.ref_video_(\d+)$")
_REF_AUDIO_KEY = re.compile(r"^ref_audios\.ref_audio_(\d+)$")


def read_embedded_graph(path: Path) -> Optional[dict]:
    """The ComfyUI prompt graph stored in a video's container metadata."""
    try:
        completed = subprocess.run(
            [os.environ.get("FFPROBE", "ffprobe"), "-v", "error",
             "-show_entries", "format_tags=prompt", "-of", "json", str(path)],
            capture_output=True, text=True, timeout=30, check=True,
        )
        raw = (json.loads(completed.stdout).get("format") or {}).get("tags", {}).get("prompt")
        if not raw:
            return None
        graph = json.loads(raw)
        return graph if isinstance(graph, dict) else None
    except (subprocess.SubprocessError, json.JSONDecodeError, ValueError, TypeError) as exc:
        logger.info("No usable graph in %s: %s", path.name, exc)
        return None


def _is_link(value: Any) -> bool:
    """A ComfyUI link is [node_id, output_slot]."""
    return isinstance(value, list) and len(value) == 2 and isinstance(value[0], (str, int))


def _resolve_file(graph: dict, link: Any, depth: int = 0) -> Optional[str]:
    """
    Follow a link upstream to the filename that entered the graph there.

    A reference is rarely wired straight from its loader: it goes through a
    resize, sometimes two. Walking until a node names a file keeps this working
    when the chain changes, which it does — `ref_image_size` alone decides
    whether an ImageScale sits in the middle.
    """
    if not _is_link(link) or depth > 8:
        return None
    node = graph.get(str(link[0]))
    if not isinstance(node, dict):
        return None
    inputs = node.get("inputs") or {}
    for key in FILE_INPUTS:
        value = inputs.get(key)
        if isinstance(value, str) and value:
            return value
    for value in inputs.values():
        if _is_link(value):
            found = _resolve_file(graph, value, depth + 1)
            if found:
                return found
    return None


def _find_node(graph: dict, *class_types: str) -> tuple[Optional[str], Optional[dict]]:
    for node_id, node in graph.items():
        if isinstance(node, dict) and node.get("class_type") in class_types:
            return node_id, node
    return None, None


def describe_generation(graph: dict) -> dict:
    """
    Normalise an executed graph into the inputs a re-run would need.

    Everything is optional: this reads graphs written by builders that have
    already changed shape once and will again, so a key that cannot be found is
    reported missing rather than guessed at.
    """
    record: dict[str, Any] = {
        "prompt": None,
        "seed": None,
        "width": None,
        "height": None,
        "length": None,
        "reference_images": [],
        "reference_videos": [],
        "reference_audios": [],
        "first_frame": None,
        "last_frame": None,
        "model": None,
        "loras": [],
        # Sampler steps decide whether fine strokes survive (4 is the preview tier,
        # 8 the final one); a take adopted onto the canvas has to carry it.
        "steps": None,
        # Audio locks: the mixed track and the ranges, in GENERATION seconds (a
        # chained clip's delivered clip starts `context` frames later). None when
        # nothing was locked.
        "audio_locks": None,
        # Sound redone on a finished render: the latent it started from and the refine
        # schedule (steps / denoise). None for an ordinary render.
        "audio_redo": None,
    }

    _, cond = _find_node(graph, *CONDITIONING_CLASSES)
    if cond:
        inputs = cond.get("inputs") or {}
        for key in ("prompt", "width", "height", "length"):
            if isinstance(inputs.get(key), (str, int, float)):
                record[key] = inputs[key]

        # Reference mounts are numbered keys, and their order is the order the
        # labels (<Picture 1>, <Video 1>…) were assigned in — so it is part of
        # the meaning, not just presentation.
        for key, pattern, bucket in (
            ("image", _REF_IMAGE_KEY, "reference_images"),
            ("video", _REF_VIDEO_KEY, "reference_videos"),
            ("audio", _REF_AUDIO_KEY, "reference_audios"),
        ):
            mounted: list[tuple[int, str]] = []
            for input_key, value in inputs.items():
                match = pattern.match(input_key)
                if not match:
                    continue
                name = _resolve_file(graph, value)
                if name:
                    mounted.append((int(match.group(1)), name))
            record[bucket] = [name for _, name in sorted(mounted)]

        # The lightweight image-to-video path mounts the first frame directly.
        for key in ("first_frame", "last_frame"):
            name = _resolve_file(graph, inputs.get(key))
            if name:
                record[key] = name

    # The reference path anchors frames with guide nodes instead: frame 0 is the
    # first frame, -1 the last.
    for node in graph.values():
        if not isinstance(node, dict) or node.get("class_type") != "MiniMaxH3AddGuide":
            continue
        inputs = node.get("inputs") or {}
        name = _resolve_file(graph, inputs.get("image"))
        if not name:
            continue
        slot = "first_frame" if inputs.get("frame_idx") == 0 else "last_frame"
        record.setdefault(slot, None)
        if not record.get(slot):
            record[slot] = name

    for node in graph.values():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs") or {}
        if node.get("class_type") == "RandomNoise" and record["seed"] is None:
            seed = inputs.get("noise_seed")
            if isinstance(seed, int):
                record["seed"] = seed
        if node.get("class_type") == "BasicScheduler" and record["steps"] is None:
            steps = inputs.get("steps")
            if isinstance(steps, int):
                record["steps"] = steps
        if node.get("class_type") == "AicinemaLockAudioRanges" and record["audio_locks"] is None:
            ranges = inputs.get("ranges")
            if isinstance(ranges, str) and ranges:
                record["audio_locks"] = {
                    "ranges": ranges,
                    "feather_seconds": inputs.get("feather_seconds"),
                    "duration_seconds": inputs.get("duration_seconds"),
                    "track": _resolve_file(graph, inputs.get("audio_latent")),
                }
        if node.get("class_type") == "H3AudioRefineMask" and record["audio_redo"] is None:
            sched = graph.get("ar:sched") or {}
            src = graph.get("ar:load") or {}
            record["audio_redo"] = {
                "source_latent": (src.get("inputs") or {}).get("latent_path"),
                "steps": (sched.get("inputs") or {}).get("steps"),
                "denoise": (sched.get("inputs") or {}).get("denoise"),
            }
        if node.get("class_type") in ("UNETLoader", "UnetLoaderGGUF") and not record["model"]:
            record["model"] = inputs.get("unet_name")
        if str(node.get("class_type", "")).startswith("LoraLoader"):
            lora = inputs.get("lora_name")
            if isinstance(lora, str):
                record["loras"].append(lora)

    return record


def describe_media(path: Path) -> Optional[dict]:
    """Provenance for one generated file, or None when it carries none."""
    graph = read_embedded_graph(path)
    if not graph:
        return None
    record = describe_generation(graph)
    # A graph with no prompt and no references tells us nothing worth carrying.
    if not record["prompt"] and not record["reference_images"]:
        return None
    return record
