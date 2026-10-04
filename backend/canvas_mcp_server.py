"""MCP tools for arranging and running LAZA CINEMA STUDIO projects on the React Flow canvas.

The canvas is the production's record. A render that did not go through a
canvas node -- posted straight to ComfyUI from a script -- leaves the canvas
describing a film that no longer exists: the human reviewing it sees last
night's prompt under this morning's clip. So this server is the only sanctioned
way for an agent to change a project: authoring (`apply_canvas_operations`),
running a node through the backend (`run_canvas_node` / `refresh_canvas_node`),
and, for renders that already happened elsewhere, adopting the clip with the
provenance ComfyUI embedded in it (`adopt_render`) so the node says what the
file says.

Every tool here is a plain function under its decorator, so scripts can import
this module and go through the same code path instead of writing canvas.json or
talking to ComfyUI themselves (see tools/canvas_segment.py).
"""

from __future__ import annotations

import functools
import hashlib
import json
import re
import sys
import os
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from contextvars import ContextVar
from copy import deepcopy
from datetime import datetime
from pathlib import Path
from typing import Any

import anyio
import httpx
import ssl
from mcp.server.fastmcp import FastMCP, Image

import win_accept_patch

# A client dropping mid-accept must not close the :8004 listener (see the module).
win_accept_patch.install()

try:
    from workflow_builders import DEFAULT_H3_STEPS, accel_for_unet
except ImportError:
    from backend.workflow_builders import DEFAULT_H3_STEPS, accel_for_unet


# httpx.request() builds a client, and so loads the CA bundle (~67 ms of CPU), on every call. The job
# watchers make dozens of calls a second, so this process sat at ~2 cores. One shared client; httpx.Client
# is thread-safe.
_HTTP = httpx.Client(verify=ssl.create_default_context())

BACKEND_URL = os.environ.get("AI_CINEMA_BACKEND_URL", "http://127.0.0.1:8003").rstrip("/")

try:
    from machine_profile import PROFILE as _MACHINE_PROFILE
    from envfile import env_value
except ImportError:
    from backend.machine_profile import PROFILE as _MACHINE_PROFILE
    from backend.envfile import env_value

#: Mirrors DEFAULT_H3_MOTION_PRESET in backend/main.py. A node that carries no
#: motionPreset renders the same way here as it does from the studio. Both come
#: from H3_MACHINE_PROFILE, so the MCP client must see the same variable.
DEFAULT_MOTION_PRESET = _MACHINE_PROFILE["motion_preset"]
DEFAULT_WIDTH = _MACHINE_PROFILE["width"]
DEFAULT_HEIGHT = _MACHINE_PROFILE["height"]
#: Who is writing. Sent as X-Agent on every backend call and used as the lock holder.
AGENT = os.environ.get("RELAY_AGENT") or os.environ.get("AI_CINEMA_AGENT") or "claude"
WORKSPACE = os.environ.get("AI_CINEMA_WORKSPACE", "default")
_BACKEND_DIR = Path(__file__).resolve().parent
#: Text fields that run to hundreds of words; `get_canvas(summary=True)` trims them.
LONG_TEXT_FIELDS = ("prompt", "text", "compiledPrompt", "userIntent")
SUMMARY_TEXT_CHARS = 160

mcp = FastMCP(
    "ai-cinema-canvas",
    # Sent to every client on connect -- the only project guidance an agent on
    # another machine gets. Keep it to the rules that keep the canvas honest.
    instructions=(
        "The canvas is the film's record: the director reviews work there and nowhere else.\n"
        "- Read: get_canvas(summary=True) first; afterwards pass since_revision=<its revision> to "
        "get only changes. node_ids=[...] for one node in full; read_canvas_export(grep/lines) to "
        "search prompts server-side.\n"
        "- Edit only with apply_canvas_operations, render only with run_canvas_node then "
        "refresh_canvas_node. Never submit renders to ComfyUI directly; a clip made elsewhere "
        "is attached with adopt_render, never by hand-typing seed/prompt fields.\n"
        "- Prompts live in files: prompt_file (a path on the server, repo-relative). To use a "
        "file on your own machine, read it and pass the text as data.prompt. Editing the prompt "
        "of a node bound to a file writes the file (and the content archive) too, so edit in "
        "place with replace_in_node_text; do not unbind.\n"
        "- To check a render, get_frames(node_id, seconds=[...]) returns stills from its clip.\n"
        "- Edge order into a node IS its <Picture N> numbering. After run_canvas_node check "
        "input_counts matches what you wired.\n"
        "- Iterate a shot in place: update_node on the same node and rerun; do not start a new "
        "node or chain per attempt.\n"
        "- A node's prompt is the next run; compiledPrompt is what produced the clip shown. Keep "
        "the label honest: which clip it shows and whether it was accepted.\n"
        "- After adding nodes run arrange_canvas. Long edit sessions: lock_project / unlock_project.\n"
        "- Writing an H3 prompt needs the h3-prompt-writing skill and the project's H3 "
        "specification; ask the owner for them rather than improvising the format."
    ),
)


# --------------------------------------------------------------------------- output
#
# Every tool result goes into the calling agent's context, so it is sent once
# (no structured duplicate), as compact JSON with CJK kept as characters, and
# without fields that only echo the call back or say nothing: the ids the
# caller just passed, node/edge counts, null and empty values.

_ECHO_KEYS = {"project_id", "project_name", "node_count", "edge_count"}


def _slim(value: Any, top: bool = True) -> Any:
    if isinstance(value, dict):
        return {k: _slim(v, False) for k, v in value.items()
                if not (top and k in _ECHO_KEYS) and v is not None and v != "" and v != [] and v != {}}
    if isinstance(value, list):
        return [_slim(v, False) for v in value]
    return value


def _caller() -> str:
    """Who is calling this tool: client address and User-Agent of the HTTP request."""
    try:
        request = mcp.get_context().request_context.request
        host = request.client.host if request and request.client else "stdio"
        agent = request.headers.get("user-agent", "") if request else ""
        return f"{host} {agent}".strip()
    except Exception:
        return "unknown"


# Tools whose every call is logged with its caller. 2026-09-28: someone's client
# kept re-sending transcribe_media three windows at a time, and the backend log
# only ever showed 127.0.0.1 (this server).
_LOGGED_TOOLS = {"transcribe_media"}


def _tool(fn):
    """Register fn as an MCP tool whose result is slimmed compact JSON."""
    @functools.wraps(fn)
    async def wrapper(*args: Any, **kwargs: Any) -> str:
        if fn.__name__ in _LOGGED_TOOLS:
            line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {fn.__name__} from {_caller()}: {kwargs}"
            print(line, file=sys.stderr, flush=True)
            try:
                with open(Path(__file__).parent / "logs" / "mcp_calls.log", "a", encoding="utf-8") as log:
                    log.write(line + "\n")
            except OSError:
                pass
        # In a worker thread: under --http several clients share one event loop, and
        # a tool waiting on the backend must not stall the others.
        result = await anyio.to_thread.run_sync(functools.partial(fn, *args, **kwargs))
        if isinstance(result, dict) and "node_id" in kwargs:
            # refresh/cancel address the node, not the job, so neither id is news.
            result = {k: v for k, v in result.items()
                      if not (k == "node_id" and v == kwargs["node_id"]) and k != "job_id"}
        return json.dumps(_slim(result), ensure_ascii=False, separators=(",", ":"), default=str)
    wrapper.__annotations__ = {**fn.__annotations__, "return": "str"}
    mcp.tool(structured_output=False)(wrapper)
    return fn


NODE_CATALOG: dict[str, dict[str, Any]] = {
    "group": {
        "label": "分组框",
        # A titled frame drawn behind the nodes, not a step in the pipeline: it
        # generates nothing and takes no edges. Membership is spatial -- whatever
        # sits inside the frame below its 34 px title bar -- so a group is moved
        # by moving its frame, and nothing on a member node records that it
        # belongs to one. Set "collapsed": true to fold the group away for
        # archiving; the studio then records the member ids and the expanded
        # height on the node itself (frontend/lib/canvasGroups.ts).
        "defaults": {"title": "分组", "color": "#3f4756", "collapsed": False},
        "inputs": [],
        "outputs": [],
    },
    "prompt": {
        "label": "提示词节点",
        "defaults": {"text": ""},
        "inputs": ["in-prompt"],
        "outputs": ["out-prompt"],
    },
    "video": {
        "label": "H3 电影镜头 (MiniMax H3)",
        # motionPreset: "singularity" (default) is the Singularity ref2va v1.3
        # checkpoint plus the ref2v 8-step turbo LoRA — it renders the light the
        # set actually has, so an unlit corner stays unlit. "fused" is the fused
        # checkpoint: widest expression range, and the only one carrying
        # adaln_basis / adaln_mean. "hybrid" swaps in the hybrid base plus its
        # turbo LoRA on the beta scheduler; measured 34.7 vs 42.4 degrees
        # peak-to-peak of car-body pitch on a chase shot. shiftVideo trades
        # motion against detail on any of them: 5.0 measured calmer than 12.0.
        "defaults": {"prompt": "", "generatedUrl": None, "status": "idle", "width": 1376,
                     "height": 768, "steps": DEFAULT_H3_STEPS, "length": 124, "seed": 81000,
                     "seedMode": "fixed", "motionPreset": "singularity", "shiftVideo": 12.0,
                     # New shots get block-sparse attention (~21% faster, details
                     # re-rolled); older nodes lack the field and stay dense.
                     "blockSparse": True},
        # in-motion-context takes the clip this one continues from, so the chain
        # is a line on the canvas instead of a hand-typed latent filename. The
        # clips remain separate assets and can be watched in a chainPreview node.
        "inputs": ["in-prompt", "in-image", "in-last-frame", "in-ref-image", "in-ref-audio",
                   "in-ref-video", "in-motion-context"],
        "outputs": ["out-video"],
    },
    # The H3 edit operations, one node type each (frontend VideoEditNode.tsx).
    # A canvas saved before the split may still hold a "videoEdit" with editMode
    # set to one of the others; running it follows that editMode.
    "videoEdit": {
        "label": "改原片 · 动作不变",
        "defaults": {"prompt": "", "userIntent": "", "generatedUrl": None, "status": "idle", "width": 1376, "height": 768, "steps": DEFAULT_H3_STEPS, "length": 124, "seed": 81000, "seedMode": "fixed", "audioStrategy": "copy_source"},
        # in-guide-frame: images pinned through MiniMaxH3AddGuide in an edit window,
        # data.guideFrameIndexes[i] = the SOURCE clip's frame for the i-th image.
        "inputs": ["in-video", "in-character", "in-audio", "in-prompt", "in-guide-frame"],
        "outputs": ["out-video"],
    },
    "videoReshot": {
        # Regenerates only reshotStartSeconds..+reshotDurationSeconds of the source.
        "label": "重拍一段 · 前后不动",
        "defaults": {"prompt": "", "userIntent": "", "generatedUrl": None, "status": "idle", "width": 1376, "height": 768, "steps": 20, "length": 124, "seed": 81000, "seedMode": "fixed", "reshotStartSeconds": 0, "reshotDurationSeconds": 3},
        "inputs": ["in-video", "in-character", "in-prompt"],
        "outputs": ["out-video"],
    },
    "videoBridge": {
        # Freezes bridgeContextFrames (39/90/141/192) on both sides of the window and
        # regenerates the middle. No reference images or audio on this path.
        "label": "重拍中间 · 两端冻住",
        "defaults": {"prompt": "", "userIntent": "", "generatedUrl": None, "status": "idle", "width": 1376, "height": 768, "steps": 20, "length": 124, "seed": 81000, "seedMode": "fixed", "reshotStartSeconds": 0, "reshotDurationSeconds": 3, "bridgeContextFrames": 39},
        "inputs": ["in-video", "in-prompt"],
        "outputs": ["out-video"],
    },
    "videoContinue": {
        "label": "往后续拍",
        "defaults": {"prompt": "", "userIntent": "", "generatedUrl": None, "status": "idle", "width": 1376, "height": 768, "steps": DEFAULT_H3_STEPS, "length": 124, "seed": 81000, "seedMode": "fixed", "audioStrategy": "copy_source"},
        "inputs": ["in-video", "in-character", "in-audio", "in-prompt"],
        "outputs": ["out-video"],
    },
    "videoFrames": {
        "label": "首尾帧过渡",
        "defaults": {"prompt": "", "userIntent": "", "generatedUrl": None, "status": "idle", "width": 1376, "height": 768, "steps": DEFAULT_H3_STEPS, "length": 124, "seed": 81000, "seedMode": "fixed", "audioStrategy": "copy_source"},
        "inputs": ["in-first-frame", "in-last-frame", "in-character", "in-audio", "in-prompt"],
        "outputs": ["out-video"],
    },
    "characterSheet": {
        # Four synchronized H3 views composed into one sheet. identity = what the
        # character is whatever they wear; costume = what they wear in this film.
        # in-face takes a HEAD CROP (a full-body picture drags its clothes in);
        # each node on in-prop needs a line in propDescriptions keyed by its id.
        "label": "定妆照",
        "defaults": {"generatedUrl": None, "status": "idle", "identity": "", "costume": "",
                     "subjectNoun": "person", "propDescriptions": {}, "width": 768,
                     "height": 1376, "steps": 4, "seed": 81000, "seedMode": "fixed"},
        "inputs": ["in-base", "in-face", "in-prop"],
        "outputs": ["out-image"],
    },
    "charswap": {
        "label": "换人 · Viggle",
        # No prompt port by design: this route's text encoder is a frozen embedding, so
        # identity comes from the reference still and everything else from the driving
        # clip. `length` 0 means the clip's own frame count, read on the server.
        "defaults": {"generatedUrl": None, "status": "idle", "width": 1376, "height": 768,
                     "length": 0, "megapixels": 0.8, "seed": 95051,
                     "seedMode": "fixed"},
        "inputs": ["in-video", "in-character"],
        "outputs": ["out-video"],
    },
    "videoReangle": {
        "label": "换机位 · CrossView",
        # The clip on in-video seen from another camera; performance, timing and
        # sound stay the source's. azimuth/elevation in degrees (+ = right / above).
        # keyframes [{f, az, el, dist}] (f from 1 within the window) cuts between
        # several cameras; empty = one fixed camera. in-ref-image (optional, in
        # order) steers what the model fills where the source camera never saw.
        # length 0 = as much of the clip from startFrame as H3's grid allows.
        "defaults": {"generatedUrl": None, "status": "idle", "azimuth": 30.0, "elevation": 0.0,
                     "distance": 1.0, "keyframes": [], "startFrame": 0, "length": 0,
                     "prompt": "crossview", "loraStrength": 0.8, "megapixels": 0.5,
                     "steps": 8, "seed": 81000, "seedMode": "fixed", "keepSourceAudio": True,
                     "width": 960, "height": 544},
        "inputs": ["in-video", "in-ref-image"],
        "outputs": ["out-video"],
    },
    "qwenImage": {
        # Qwen-Image-2.1. One node for both routes: with nothing on in-ref it is
        # text-to-image at width x height; with references it edits against them
        # and the canvas takes reference 1's aspect ratio instead (width/height
        # are then ignored, as in the model's own template). Edge order into
        # in-ref IS the prompt's `<image 1>`, `<image 2>` ... numbering, the same
        # rule H3 follows for `<Picture N>`. At most ten.
        # denoise is not a field: this graph's latent carries the references as a
        # sequence, so a lower denoise decodes to noise, not to a lighter edit.
        # anyAngle: re-shoot <image 1> at the camera of <image 2>, a coarse render of
        # the new view (render_gaussian_view, a grey-box render). Exactly two
        # references in that order; the run adds the QI2.1_AnyAngle LoRA and cfg 3,
        # and the prompt is "Change the camera angle from <image2> to <image1>."
        # baseModel: "qwen21" (default) or "noctAnime" (Noct Q Anime, a merged
        # anime checkpoint on the same graph; runs at cfg 3, prompt starts
        # "An anime illustration of...").
        # speed: "turbo" (default) runs the Viggle distilled LoRA, 7 steps, 2-4x
        # faster with the same look on plates, edits and sheets; steps, cfg and
        # negativePrompt are then ignored. "base" is the 25-step graph. Dense small
        # print (several columns of body text, credit blocks) is the one place both
        # write badly; headlines and short lines are fine on turbo.
        "label": "生成图片",
        "defaults": {"prompt": "", "negativePrompt": "", "generatedUrl": None,
                     "status": "idle", "width": 1376, "height": 768, "steps": 25,
                     "cfg": 1.0, "seed": 81000, "seedMode": "fixed", "speed": "turbo"},
        "inputs": ["in-ref"],
        "outputs": ["out-image"],
    },
    "inpaint": {
        "label": "局部重绘 (Inpaint)",
        "defaults": {"prompt": "", "generatedUrl": None, "status": "idle", "steps": 20,
                     "cfg": 4.0, "seed": 81000, "seedMode": "fixed"},
        "inputs": ["in-image"],
        "outputs": ["out-image"],
    },
    "image": {
        "label": "上传素材 (图片/视频)",
        "defaults": {"url": None},
        "inputs": [],
        "outputs": ["out-image", "out-video", "out-audio"],
    },
    "audioRefine": {
        "label": "声音精修",
        # The sound of the clip on in-video done again, its picture kept as it is (the picture stream
        # is copied into the result). Works on any clip: a render, an edit, a trim, an upload.
        # Conditioning is inherited from the nearest H3 video node upstream (the prompt that made the
        # clip, its references and audio locks); a prompt typed on this node replaces all of it and then
        # only the wires on in-ref-image / in-ref-audio count. mode "polish" (4 steps @ 0.5) keeps the
        # lines and cleans the sound; "reroll" (8 steps @ 1.0) makes a new soundtrack against the
        # same picture and can turn a spoken line into a whisper, so lock lines with audioLocks.
        # steps / denoise 0 = the mode's own. The lips keep following the OLD sound.
        "defaults": {"generatedUrl": None, "status": "idle", "mode": "polish", "steps": 0, "denoise": 0,
                     "seed": 81000, "seedMode": "fixed", "prompt": ""},
        "inputs": ["in-video", "in-ref-image", "in-ref-audio"],
        "outputs": ["out-video"],
    },
    "videoUpscale": {
        "label": "视频增强",
        # No width/height here: a hard-coded pair (it used to say 1664x960) wins over
        # the source size in _run_upscale_locked and silently upscales to the wrong
        # size. Left unset, the runner takes the source clip times scaleBy.
        "defaults": {"generatedUrl": None, "status": "idle", "scaleBy": 2.0,
                     "steps": 6, "denoiseStrength": 0.25, "seed": 81000,
                     "seedMode": "fixed", "targetFps": 0, "length": 0},
                     # upscaleRefs ("inherit" | "wired" | "none", see _run_upscale_locked) is
                     # left unset on purpose: unset means wired images if any, else the
                     # source's own -- the same default the studio's own new nodes get.
        "inputs": ["in-video", "in-first-frame", "in-ref-image"],
        "outputs": ["out-video"],
    },
    "videoTrim": {
        "label": "视频剪切",
        # Frame-accurate cut of the in-video clip; trimEndSeconds None = to the end.
        # No latent comes out: a chain continuing from it reads its frames.
        "defaults": {"generatedUrl": None, "status": "idle",
                     "trimStartSeconds": 0, "trimEndSeconds": None},
        "inputs": ["in-video"],
        "outputs": ["out-video"],
    },
    "depthVideo": {
        "label": "深度视频",
        # The whole in-video clip as a silent per-frame depth video (Depth Anything V2); trim it first to use a part.
        # Wire it to a video node's in-ref-video: a camera reference, or with useRefVideoAsControl the Fun ControlNet's control video.
        "defaults": {"generatedUrl": None, "status": "idle", "resolution": 518},
        "inputs": ["in-video"],
        "outputs": ["out-video"],
    },
    "videoInterpolate": {
        "label": "视频插帧 (RIFE 60FPS)",
        "defaults": {"generatedUrl": None, "status": "idle", "targetFps": 30},
        "inputs": ["in-video"],
        "outputs": ["out-video"],
    },
    "audioGen": {
        "label": "配音 / 换音色",
        # mode "speak": H3 says `text` in the voice of `voiceDescription` and/or the
        # clip on in-ref-audio; only the sound is kept. mode "convert": Seed-VC
        # re-voices the clip on in-source-audio (words and timing kept) with the
        # voice on in-ref-audio, or of a sample H3 speaks from the description.
        "defaults": {"mode": "speak", "text": "", "voiceDescription": "", "delivery": "",
                     "generatedUrl": None, "status": "idle", "length": 0, "seed": 81000,
                     "seedMode": "fixed", "trimSilence": True, "diffusionSteps": 30,
                     "semitoneShift": 0},
        "inputs": ["in-ref-audio", "in-source-audio"],
        "outputs": ["out-audio"],
    },
    "videoCompare": {
        "label": "视频对比",
        "defaults": {"mode": "wipe"},
        "inputs": ["in-video-a", "in-video-b"],
        "outputs": [],
    },
    "pose": {
        "label": "3D骨骼姿态 (Pose)",
        "defaults": {"glbUrl": None, "generatedUrl": None, "status": "idle",
                     "skeletonMode": "openpose"},
        "inputs": ["in-image"],
        "outputs": ["out-pose"],
    },
    "gaussian": {
        # engine "sharp": this picture's own geometry, in seconds. engine "flashworld":
        # the whole scene, its unseen sides generated along worldTrajectory ("ring":
        # walk a 1.5 m circle looking out -- all round, and a metre or two of room to
        # move; "orbit": push in and arc left round a point 10 m ahead; "pan": turn in
        # place), described by worldPrompt (English, including what is off-picture).
        # ~5 min. render_gaussian_view takes a still from any camera in the result.
        "label": "高斯模型 (3DGS PLY)",
        "defaults": {"plyUrl": None, "plyFilename": None, "plyOriginalName": None,
                     "generatedUrl": None, "status": "idle", "engine": "sharp",
                     "worldTrajectory": "ring", "worldPrompt": ""},
        "inputs": ["in-image"],
        "outputs": ["out-image", "out-gaussian"],  # out-image: the screenshot of the current view; out-gaussian: the point cloud
    },
    "preview": {
        "label": "大图预览 (Preview)",
        "defaults": {},
        "inputs": ["in-image"],
        "outputs": ["out-image"],
    },
    "chainPreview": {
        # Plays every in-video source back to back: a plain clip as itself, a
        # chain tail as its whole motion-context chain. data.sourceOrder (edge
        # ids) sets the order; unlisted edges follow in wiring order.
        "label": "智能视频预览 (Smart Video Preview)",
        "defaults": {},
        "inputs": ["in-video"],
        "outputs": [],
    },
}


def _request(method: str, path: str, project_id: str | None = None, **kwargs: Any) -> Any:
    """
    Call the backend. `project_id` states who the call is for, which is how
    anything the backend creates ends up attributed to the right project — the
    studio sends the same header from the browser.
    """
    headers = {**kwargs.get("headers", {}), "X-Agent": AGENT}
    if project_id:
        headers["X-Project-Id"] = project_id
    kwargs["headers"] = headers
    try:
        response = _HTTP.request(method, f"{BACKEND_URL}{path}", timeout=20, **kwargs)
        response.raise_for_status()
        return response.json()
    except httpx.HTTPStatusError as error:
        try:
            detail = error.response.json().get("detail", error.response.text)
        except ValueError:
            detail = error.response.text
        raise ValueError(f"LAZA CINEMA STUDIO backend rejected the request ({error.response.status_code}): {detail}") from error
    except httpx.HTTPError as error:
        raise RuntimeError(f"Cannot reach LAZA CINEMA STUDIO backend at {BACKEND_URL}: {error}") from error


# The scene the current tool call works in. A film is one project with a canvas
# per scene; every tool takes an optional `scene` (id or name, the first scene
# when empty) and sets it here once, so the canvas read, save and lock helpers
# below address that scene's canvas without every helper passing it along.
_SCENE: ContextVar[str] = ContextVar("scene", default="main")


def _cuts_in_window(url: str, start: int, count: int) -> list[int]:
    """Shot cuts inside an edit window of a canvas media url; [] when the file is not local."""
    local = _local_media(url)
    if local is None:
        return []
    sys.path.insert(0, str(_BACKEND_DIR))
    import edit_window
    return edit_window.cuts_inside(local, start, count)


def _scene_params() -> dict[str, str]:
    scene = _SCENE.get()
    return {} if scene == "main" else {"scene": scene}


def _resolve_scene(project_id: str, scene: str) -> str:
    if not scene or scene == "main":
        return "main"
    scenes = _request("GET", f"/projects/{project_id}/scenes", params={"workspace": WORKSPACE}).get("scenes", [])
    exact = next((s for s in scenes if s.get("id") == scene), None) or next(
        (s for s in scenes if s.get("name") == scene), None)
    if exact is None:
        partial = [s for s in scenes if scene.casefold() in str(s.get("name", "")).casefold()]
        if len(partial) != 1:
            available = ", ".join(f"{s.get('name')} ({s.get('id')})" for s in scenes)
            raise ValueError(f"Scene {scene!r} was not found or is ambiguous. Scenes: {available}")
        exact = partial[0]
    return exact["id"]


def _resolve_project(project: str, scene: str = "") -> dict[str, Any]:
    """Find the project, and make `scene` the canvas this tool call reads and writes."""
    resolved = _find_project(project)
    sid = _resolve_scene(resolved["id"], scene)
    _SCENE.set(sid)
    return {**resolved, "scene": sid}


def _find_project(project: str) -> dict[str, Any]:
    projects = _request("GET", "/projects", params={"workspace": WORKSPACE}).get("projects", [])
    exact_id = next((item for item in projects if item.get("id") == project), None)
    if exact_id:
        return exact_id
    exact_name = [item for item in projects if item.get("name") == project]
    if len(exact_name) == 1:
        return exact_name[0]
    if len(exact_name) > 1:
        raise ValueError(f"More than one project is named {project!r}; use the project id.")
    partial = [item for item in projects if project.casefold() in str(item.get("name", "")).casefold()]
    if len(partial) == 1:
        return partial[0]
    available = ", ".join(f"{p.get('name')} ({p.get('id')})" for p in projects)
    raise ValueError(f"Project {project!r} was not found. Available projects: {available or 'none'}")


def _canvas(project_id: str) -> dict[str, Any]:
    canvas = _request(
        "GET", f"/projects/{project_id}/canvas", params={"workspace": WORKSPACE, **_scene_params()}
    )
    canvas.setdefault("nodes", [])
    canvas.setdefault("edges", [])
    canvas.setdefault("viewport", {"x": 0, "y": 0, "zoom": 1})
    canvas.setdefault("revision", 0)
    return canvas


def _find_node(nodes: list[dict[str, Any]], node_id: str) -> dict[str, Any]:
    node = next((item for item in nodes if item.get("id") == node_id), None)
    if node is None:
        raise ValueError(f"Canvas node not found: {node_id}")
    return node


DEFAULT_NODE_WIDTH = 240


CHROME_FLOOR_BY_TYPE: dict[str, int] = {
    "image": 32,
    "video": 32,
    "videoEdit": 32,
    "videoReshot": 32,
    "videoBridge": 32,
    "videoContinue": 32,
    "videoFrames": 32,
    "preview": 32,
    "chainPreview": 32,
}


# Node types whose height is the card's own layout (frontend hooks/useAutoHeightNode): only the width is kept, so a height
# written here would just be taken off again by the studio.
AUTO_HEIGHT_TYPES = {"charswap", "video", "videoEdit", "image", "qwenImage", "preview", "imageUpscale", "videoUpscale", "videoInterpolate"}


def _apply_size(node: dict[str, Any], operation: dict[str, Any]) -> None:
    """Write React Flow's top-level width/height.

    v12 reads size from node.width/node.height; node.style.width is ignored the
    moment the canvas's ResizeObserver writes node.width. Nodes created over MCP
    never reach that observer, so they carry no size unless one is set here.

    Width defaults to the 240 the canvas uses everywhere; height follows from
    aspect_ratio when given, plus chrome and label space so media content actually
    fills the node without letterbox/pillarbox gaps.
    """
    width = operation.get("width")
    height = operation.get("height")
    aspect = operation.get("aspect_ratio")
    data = node.setdefault("data", {})
    if aspect is None and data.get("width") and data.get("height"):
        try:
            aspect = float(data["width"]) / float(data["height"])
        except (ValueError, ZeroDivisionError):
            pass

    if width is None and height is None and aspect is None:
        return
    w = int(width) if width is not None else DEFAULT_NODE_WIDTH
    if node.get("type") in AUTO_HEIGHT_TYPES:
        node["width"] = w
        node.pop("height", None)
        if "userWidth" not in data:
            data["userWidth"] = w
        return
    if height is not None:
        h = int(height)
    elif aspect:
        ntype = node.get("type", "")
        base_chrome = CHROME_FLOOR_BY_TYPE.get(ntype, 32)
        label_text = data.get("label") or operation.get("data", {}).get("label")
        label_extra = 0
        if label_text and ntype not in {"image", "preview"}:
            label_extra = 36 if len(str(label_text)) > 30 else 20
        media_h = max(1, round(w / float(aspect)))
        h = media_h + base_chrome + label_extra
    else:
        h = node.get("height") or DEFAULT_NODE_WIDTH
    node["width"] = w
    node["height"] = h
    if "userWidth" not in data:
        data["userWidth"] = w


_AUDIO_EXT = (".wav", ".mp3", ".flac", ".m4a", ".ogg", ".aac")
_VIDEO_EXT = (".mp4", ".mov", ".webm", ".mkv")


def _node_medium(node: dict[str, Any]) -> str | None:
    """'audio' / 'video' / 'image' for an upload-style image node, from its file; None otherwise."""
    if node.get("type") != "image":
        return None
    data = node.get("data") or {}
    kind = str(data.get("mediaType") or "").lower()
    if kind in ("audio", "video", "image"):
        return kind
    url = str(data.get("url") or data.get("generatedUrl") or "").split("?", 1)[0].lower()
    if url.endswith(_AUDIO_EXT):
        return "audio"
    if url.endswith(_VIDEO_EXT):
        return "video"
    return "image" if url else None


def _parse_edge(text: str) -> dict[str, str]:
    """"source[.out-x]>target[.in-y]" -- the form get_canvas(summary=True) prints."""
    if text.count(">") != 1:
        raise ValueError(f"Edge {text!r} is not source[.handle]>target[.handle].")

    def side(part: str, prefix: str) -> tuple[str, str | None]:
        node, dot, handle = part.strip().rpartition(".")
        return (node, handle) if dot and handle.startswith(prefix) else (part.strip(), None)

    (source, source_handle), (target, target_handle) = (side(p, x) for p, x in zip(text.split(">"), ("out-", "in-")))
    out = {"source": source, "target": target}
    if source_handle:
        out["source_handle"] = source_handle
    if target_handle:
        out["target_handle"] = target_handle
    return out


def _expand_operations(operations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """{op:add_edges, edges:["a>b.in-ref-image", ...]} is several add_edge ops, in order."""
    out: list[dict[str, Any]] = []
    for operation in operations:
        if operation.get("op") == "add_edges":
            out += [{"op": "add_edge", "edge": e} for e in operation.get("edges") or []]
        else:
            out.append(operation)
    return out


def _apply_operation(canvas: dict[str, Any], operation: dict[str, Any]) -> dict[str, Any]:
    kind = operation.get("op")
    nodes = canvas["nodes"]
    edges = canvas["edges"]

    if kind == "add_node":
        node_type = operation.get("type")
        if node_type not in NODE_CATALOG:
            raise ValueError(f"Unknown node type {node_type!r}. Call get_node_catalog first.")
        if NODE_CATALOG[node_type].get("retired"):
            raise ValueError(f"Node type {node_type!r} is retired: {NODE_CATALOG[node_type]['retired']}")
        node_id = operation.get("id") or f"{node_type}-mcp-{int(time.time() * 1000)}-{uuid.uuid4().hex[:5]}"
        if any(node.get("id") == node_id for node in nodes):
            raise ValueError(f"Node id already exists: {node_id}")
        data = deepcopy(NODE_CATALOG[node_type]["defaults"])
        data.update(operation.get("data") or {})
        if operation.get("prompt_file"):
            data["prompt"] = _read_text_file(str(operation["prompt_file"]))
            data["promptFile"] = str(operation["prompt_file"])
        if operation.get("text_file"):
            data["text"] = _read_text_file(str(operation["text_file"]))
        node = {
            "id": node_id,
            "type": node_type,
            "position": operation.get("position") or {"x": 0, "y": 0},
            "data": data,
        }
        # React Flow v12 sizes a node from top-level width/height, not style.
        _apply_size(node, operation)
        if operation.get("style"):
            node["style"] = operation["style"]
        nodes.append(node)
        return {"op": kind, "id": node_id}

    if kind == "update_node":
        node = _find_node(nodes, str(operation.get("id", "")))
        if "data" in operation:
            node.setdefault("data", {}).update(operation["data"] or {})
        if operation.get("prompt_file"):
            data = node.setdefault("data", {})
            data["prompt"] = _read_text_file(str(operation["prompt_file"]))
            data["promptFile"] = str(operation["prompt_file"])
        if operation.get("text_file"):
            node.setdefault("data", {})["text"] = _read_text_file(str(operation["text_file"]))
        if "position" in operation:
            node["position"] = operation["position"]
        if "style" in operation:
            node["style"] = operation["style"]
        _apply_size(node, operation)
        return {"op": kind, "id": node["id"]}

    if kind == "replace_in_node_text":
        node = _find_node(nodes, str(operation.get("id", "")))
        field = str(operation.get("field") or "prompt")
        old_text = operation.get("old")
        new_text = operation.get("new")
        if not isinstance(old_text, str) or not isinstance(new_text, str):
            raise ValueError("replace_in_node_text needs string 'old' and 'new'.")
        data = node.setdefault("data", {})
        current = data.get(field)
        if not isinstance(current, str):
            raise ValueError(f"Node {node['id']} has no text in data.{field}.")
        count = current.count(old_text)
        # A prompt runs to hundreds of words; passing the whole thing back through
        # update_node to change one clause costs a full re-transcription and risks
        # a typo in the part that was meant to stay. Refuse a non-unique match
        # rather than guess which occurrence was meant.
        if count == 0:
            raise ValueError(f"'old' does not appear in data.{field} of {node['id']}.")
        if count > 1:
            raise ValueError(f"'old' appears {count} times in data.{field}; make it unique.")
        data[field] = current.replace(old_text, new_text)
        return {"op": kind, "id": node["id"], "field": field,
                "chars_before": len(current), "chars_after": len(data[field])}

    if kind == "add_still":
        # A frame of a node's clip as a new image node: the environment board,
        # guide frame or first frame that the next shot is built from. The file
        # lands in uploads/, named after the clip and the moment it was cut at.
        source_node = _find_node(nodes, str(operation.get("source", "")))
        url = _node_url(source_node)
        if not url:
            raise ValueError(f"Node {source_node['id']} has no clip to cut a still from.")
        at = operation.get("seconds", "last")
        still_url = _cut_still(url, at)
        node_id = operation.get("id") or f"still-{source_node['id']}-{uuid.uuid4().hex[:5]}"
        if any(node.get("id") == node_id for node in nodes):
            raise ValueError(f"Node id already exists: {node_id}")
        sw = (source_node.get("data") or {}).get("width") or DEFAULT_WIDTH
        sh = (source_node.get("data") or {}).get("height") or DEFAULT_HEIGHT
        pos = source_node.get("position") or {"x": 0, "y": 0}
        node = {"id": node_id, "type": "image",
                "position": operation.get("position") or {"x": pos.get("x", 0), "y": pos.get("y", 0) + 360},
                "data": {"url": still_url, "width": sw, "height": sh, "userWidth": 240,
                         "label": operation.get("label") or f"{source_node['id']} @ {at}"}}
        _apply_size(node, {"aspect_ratio": sw / sh})
        nodes.append(node)
        return {"op": kind, "id": node_id, "url": still_url}

    if kind == "remove_node":
        node_id = str(operation.get("id", ""))
        _find_node(nodes, node_id)
        canvas["nodes"] = [node for node in nodes if node.get("id") != node_id]
        canvas["edges"] = [
            edge for edge in edges
            if edge.get("source") != node_id and edge.get("target") != node_id
        ]
        return {"op": kind, "id": node_id}

    if kind == "add_edge":
        if operation.get("edge"):
            operation = {**operation, **_parse_edge(str(operation["edge"]))}
        source = str(operation.get("source", ""))
        target = str(operation.get("target", ""))
        source_node = _find_node(nodes, source)
        target_node = _find_node(nodes, target)
        source_handle = operation.get("source_handle")
        target_handle = operation.get("target_handle")
        source_spec = NODE_CATALOG.get(source_node.get("type"), {})
        target_spec = NODE_CATALOG.get(target_node.get("type"), {})
        # A side with exactly one handle has only one right answer.
        if not source_handle and len(source_spec.get("outputs") or []) == 1:
            source_handle = source_spec["outputs"][0]
        if not target_handle and len(target_spec.get("inputs") or []) == 1:
            target_handle = target_spec["inputs"][0]
        # Several outputs (an image node has out-image/out-video/out-audio): the
        # target handle names the medium it takes, so take the output of that medium.
        if not source_handle and target_handle:
            medium = next((m for m in ("image", "video", "audio", "prompt") if m in target_handle), None)
            matches = [o for o in source_spec.get("outputs") or [] if medium and o.endswith(medium)]
            if len(matches) == 1:
                source_handle = matches[0]
        if source_handle and source_handle not in source_spec.get("outputs", []):
            raise ValueError(f"Invalid source handle {source_handle!r} for {source_node.get('type')}")
        # The medium a node carries has to match the port on both ends. A voice clip
        # on an image node wired out-image into an audio port showed in the studio as
        # a broken reference picture, made the character sheet a "first frame" and
        # reset the node to the sheet's size (2026-09-24).
        media = _node_medium(source_node)
        if media and target_handle:
            wants = next((m for m in ("audio", "video", "image") if m in target_handle), None)
            if wants and wants != media and not (wants == "image" and media == "image"):
                raise ValueError(
                    f"Edge {source}>{target}.{target_handle}: {source} carries {media}, "
                    f"but {target_handle} takes {wants}.")
            if source_handle and wants and not source_handle.endswith(wants):
                raise ValueError(
                    f"Edge {source}.{source_handle}>{target}.{target_handle}: the source handle "
                    f"must be out-{wants} for a {wants} port.")
        if target_handle and target_handle not in target_spec.get("inputs", []):
            raise ValueError(f"Invalid target handle {target_handle!r} for {target_node.get('type')}")
        edge_id = operation.get("id") or f"e-mcp-{uuid.uuid4().hex[:12]}"
        edge = {
            "id": edge_id,
            "source": source,
            "target": target,
            "sourceHandle": source_handle,
            "targetHandle": target_handle,
            "animated": False,
            "style": {"stroke": "rgba(255,255,255,0.22)", "strokeWidth": 1.5},
        }
        duplicate = next((item for item in edges if item.get("source") == source
                          and item.get("target") == target
                          and item.get("sourceHandle") == source_handle
                          and item.get("targetHandle") == target_handle), None)
        if duplicate:
            return {"op": kind, "id": duplicate.get("id"), "unchanged": True}
        edges.append(edge)
        return {"op": kind, "id": edge_id}

    if kind == "remove_edge":
        edge_id = str(operation.get("id", ""))
        if not edge_id:
            # By endpoints, as the summary lists edges: source, target, and the
            # handles when two edges share both ends.
            keys = {"source": "source", "target": "target",
                    "source_handle": "sourceHandle", "target_handle": "targetHandle"}
            hits = [e for e in edges
                    if all(e.get(field) == operation[key] for key, field in keys.items() if operation.get(key))]
            if len(hits) != 1 or not operation.get("source") or not operation.get("target"):
                raise ValueError(f"remove_edge matched {len(hits)} edges; give id, or source+target "
                                 f"(+source_handle/target_handle) that match exactly one.")
            edge_id = hits[0]["id"]
        if not any(edge.get("id") == edge_id for edge in edges):
            raise ValueError(f"Canvas edge not found: {edge_id}")
        canvas["edges"] = [edge for edge in edges if edge.get("id") != edge_id]
        return {"op": kind, "id": edge_id}

    raise ValueError(f"Unsupported canvas operation: {kind!r}")


def _incoming_nodes(canvas: dict[str, Any], node_id: str, handle: str) -> list[dict[str, Any]]:
    by_id = {node.get("id"): node for node in canvas["nodes"]}
    return [
        by_id[edge["source"]]
        for edge in canvas["edges"]
        if edge.get("target") == node_id
        and edge.get("targetHandle") == handle
        and edge.get("source") in by_id
    ]


# Mirrors frontend/lib/h3/takeSwitch.ts: what a take records so the node can be
# switched back to it, and so a version's missing inputs can be reported.
TAKE_PARAM_KEYS = (
    "prompt", "seed", "seedMode", "width", "height", "length", "steps",
    "motionPreset", "accelLora", "styleLoras", "styleLoraStrengths",
    "shiftVideo", "shiftAudio", "motionContextLength", "motionContextAudio",
    "refImageOrder", "useFirstFrame", "promptSource", "directorSpec",
    "audioLocks", "audioLockFeather",
)
TAKE_OUTPUT_KEYS = ("latentFilename", "untrimmedUrl", "contextFrames", "compiledPrompt", "compiledPromptMode", "promptWasModified",
                    "submittedResources", "generatedSteps")


def _take_submit_snapshot(canvas: dict[str, Any], node_id: str, data: dict[str, Any]) -> dict[str, Any]:
    """Parameters and wired inputs (edge order) at submit time."""
    by_id = {n.get("id"): n for n in canvas["nodes"]}
    inputs = []
    for edge in canvas["edges"]:
        if edge.get("target") != node_id or edge.get("source") not in by_id:
            continue
        src = by_id[edge["source"]].get("data") or {}
        handle = edge.get("targetHandle") or ""
        url = (src.get("latentFilename") or src.get("generatedUrl") or src.get("url"))             if handle == "in-motion-context" else (src.get("url") or src.get("generatedUrl"))
        inputs.append({"source": edge["source"], "targetHandle": handle, "url": url or None})
    return {"params": {k: data[k] for k in TAKE_PARAM_KEYS if data.get(k) is not None},
            "inputs": inputs}


def _node_url(node: dict[str, Any]) -> str | None:
    data = node.get("data") or {}
    return data.get("url") or data.get("generatedUrl")


def _audio_lock_entries(canvas: dict[str, Any], data: dict[str, Any]) -> list[dict[str, Any]]:
    """data.audioLocks -> the backend's audio_locks.

    Each entry: {"node": <canvas audio node id> or "url": ..., "at": seconds on the
    DELIVERED clip, "strength": 0..1 (default 1 = kept exactly), "text": the words,
    optional "from"/"to": lock only that stretch of the recording (it is still mixed
    in whole from "at"). A video node works as the recording: use an earlier
    unlocked render of the same shot as the ambience under a line.}.
    A recording is kept as recorded while the rest of the sound is generated around
    it; see backend/audio_lock.py for what was measured and what it refuses.
    """
    nodes = {n.get("id"): n for n in canvas.get("nodes", [])}
    out = []
    for i, e in enumerate(data.get("audioLocks") or []):
        if not isinstance(e, dict):
            raise ValueError(f"audioLocks[{i}] must be an object like "
                             '{"node": "va-...", "at": 5.0, "strength": 1, "text": "Yeah."}')
        url = e.get("url")
        if not url and e.get("node"):
            src = nodes.get(e["node"])
            if src is None:
                raise ValueError(f"audioLocks[{i}] names node {e['node']}, which is not on the canvas")
            url = _node_url(src)
            if not url:
                raise ValueError(f"audioLocks[{i}]: node {e['node']} has no audio yet")
        if not url:
            raise ValueError(f"audioLocks[{i}] needs a \"node\" (canvas audio node id) or a \"url\"")
        if e.get("at") is None:
            raise ValueError(f"audioLocks[{i}] needs \"at\": the second of the delivered clip it starts on")
        out.append({"url": url, "at": float(e["at"]), "strength": float(e.get("strength", 1.0)),
                    "text": str(e.get("text") or ""),
                    **({"from": float(e["from"])} if e.get("from") is not None else {}),
                    **({"to": float(e["to"])} if e.get("to") is not None else {})})
    return out


#: The handle a clip's predecessor hangs on. One edge, one predecessor: a chain
#: is a line of clips, and two of them feeding one continuation has no meaning
#: for the Motion Context node, which takes a single latent.
CHAIN_HANDLE = "in-motion-context"


def _chain_size(canvas: dict[str, Any], node_id: str) -> tuple[int, int]:
    """(width, height) of the finished clip wired into node_id's motion context; (0, 0) if none."""
    for e in canvas.get("edges") or []:
        if e.get("target") == node_id and e.get("targetHandle") == CHAIN_HANDLE:
            src = next((n for n in canvas.get("nodes") or [] if n.get("id") == e.get("source")), None)
            d = (src or {}).get("data") or {}
            if d.get("generatedUrl") and d.get("width") and d.get("height"):
                return int(d["width"]), int(d["height"])
    return 0, 0


def _chain_parent(canvas: dict[str, Any], node_id: str) -> dict[str, Any] | None:
    sources = _incoming_nodes(canvas, node_id, CHAIN_HANDLE)
    if not sources:
        return None
    if len(sources) > 1:
        raise ValueError(
            f"Node {node_id} continues from {len(sources)} clips; a chain takes one.")
    return sources[0]


def _chain_end_frame(canvas: dict[str, Any], node_id: str) -> int:
    """data.motionContextAtFrame -> the number of source frames to continue from (0 = its end).

    A shot cut in between (a cutaway, an insert) makes the end of the previous clip
    the wrong place to carry on from; the point to carry on from is somewhere in it.
    N means "carry on from frame N": the first N frames of the delivered clip are read
    and the context window is the last frames of those (frames N-22 .. N-1), the same
    N a trim node's end frame takes. A latent only holds the end of its clip, so a
    point is read from the clip's pictures.
    """
    node = next((n for n in canvas.get("nodes", []) if n.get("id") == node_id), None)
    at = ((node or {}).get("data") or {}).get("motionContextAtFrame")
    if at in (None, "", 0):
        return 0
    frame = int(at)
    if frame <= 0:
        raise ValueError(f"Node {node_id}: motionContextAtFrame must be above 0 (got {at}); leave it out to continue from the end.")
    return frame


def _chain_carry(canvas: dict[str, Any], node_id: str) -> tuple[str, str]:
    """What this node continues from: (latent filename, video url).

    A rendered clip carries a saved latent and that is the cheapest thing to
    continue from. Anything else -- an uploaded clip, a trimmed tail, an edit --
    has only pictures, and MiniMaxH3MotionContext accepts decoded frames and
    audio in place of a latent, so those chain too. Cutting the last N frames
    off a chunk and carrying on from there is then an ordinary operation and
    not a re-render of the chunk.
    """
    parent = _chain_parent(canvas, node_id)
    if parent is None:
        return "", ""
    data = parent.get("data") or {}
    latent = (data.get("latentFilename") or "").strip()
    if latent and not _chain_end_frame(canvas, node_id):
        return latent, ""
    video = (data.get("generatedUrl") or data.get("url") or "").strip()
    if video and os.path.splitext(video.split("?")[0])[1].lower() in (
            ".mp4", ".mov", ".webm", ".mkv", ".m4v"):
        return "", video
    raise ValueError(
        f"Node {node_id} continues from {parent.get('id')}, which has neither a saved latent nor "
        f"a video to read frames from; render that clip first, or point the chain at a clip file.")


class _hold_lock:
    """Hold the project lock around a read-modify-write of the canvas.

    The studio pauses its auto-save while the lock is set, and the backend
    refuses PUTs from anyone else, so the canvas cannot move between our read
    and our write. Re-entrant for the same agent (a second acquire just extends
    the expiry); refuses to proceed if another agent holds it, because writing
    over their work is exactly what the lock exists to stop.
    """

    def __init__(self, project_id: str, seconds: int = 60, reason: str = ""):
        self.project_id, self.seconds, self.reason = project_id, seconds, reason
        self.owned = False

    def __enter__(self):
        before = _request("GET", f"/projects/{self.project_id}/lock", params=_scene_params()).get("lock")
        self.owned = not (before and before.get("agent") == AGENT)   # release only what we took
        _request("POST", f"/projects/{self.project_id}/lock", params=_scene_params(),
                 json={"agent": AGENT, "seconds": self.seconds, "reason": self.reason})
        return self

    def __exit__(self, *exc):
        if self.owned:
            try:
                _request("DELETE", f"/projects/{self.project_id}/lock", params={"agent": AGENT, **_scene_params()})
            except Exception:
                pass  # it expires on its own
        return False


def _read_text_file(path_text: str) -> str:
    """A prompt file, resolved against the repository root when relative.

    Prompts live in files under version control (backend/previs/*_clean_prompt.txt);
    the file is the thing that gets linted and diffed, so the canvas should be
    filled from it rather than from a copy pasted through a tool argument.
    """
    path = Path(path_text)
    if not path.is_absolute():
        path = _BACKEND_DIR.parent / path
    if not path.is_file():
        raise ValueError(f"prompt_file not found: {path}")
    return path.read_text(encoding="utf-8")


def _write_prompt_file(path_text: str, text: str) -> str:
    """Write a node's prompt back to its promptFile and record it in the content archive.

    An agent that is not on this machine (a cloud session) can edit a node but not
    the file behind it; before this, the next run re-read the untouched file and
    silently threw the edit away (2026-09-26, C23b). Returns "" or a warning."""
    path = Path(path_text)
    if not path.is_absolute():
        path = _BACKEND_DIR.parent / path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text if text.endswith("\n") else text + "\n", encoding="utf-8")
    try:
        rel = path.resolve().relative_to(_BACKEND_DIR.parent.resolve()).as_posix()
        tools_dir = str(_BACKEND_DIR.parent / "tools")
        if tools_dir not in sys.path:
            sys.path.insert(0, tools_dir)
        import content_archive
        content_archive.record_text(rel)
    except Exception as error:  # the file is written; archiving is best effort
        return f"{path_text} written but not archived: {error}"
    return ""


#: Node/data fields that only the studio's renderer uses; a summary drops them.
_RENDER_ONLY = {"position", "measured", "selected", "dragging", "resizing", "style", "width", "height",
                "zIndex", "positionAbsolute", "draggable", "selectable"}
_RENDER_ONLY_DATA = {"userWidth", "userHeight", "refFrom", "submittedResources", "directorSpec",
                     "compiledPromptMode", "promptWasModified", "jobId", "error",
                     "promptBeforeSync", "submittedFingerprint"}
#: What a take is identified by; its prompt is the node's compiledPrompt history.
_TAKE_KEYS = ("id", "url", "seed", "steps", "length", "createdAt", "adopted", "accepted")


def _compact_node(node: dict[str, Any]) -> dict[str, Any]:
    """A node read by id: every field in full, except the take history's prompt copies
    and a compiledPrompt that is identical to the prompt."""
    data = dict(node.get("data") or {})
    if isinstance(data.get("takes"), list):
        data["takes"] = [{k: t.get(k) for k in _TAKE_KEYS if isinstance(t, dict) and t.get(k) is not None}
                         for t in data["takes"]]
    # Compared stripped: a trailing newline on one side sent a 9k-char prompt twice.
    if data.get("compiledPrompt") and str(data["compiledPrompt"]).strip() == str(data.get("prompt") or "").strip():
        data["compiledPrompt"] = "(same as prompt)"
    if isinstance(data.get("promptBeforeSync"), str):
        data["promptBeforeSync"] = f"({len(data['promptBeforeSync'])} chars)"
    return {**{k: v for k, v in node.items() if k not in _RENDER_ONLY or k in ("width", "height")}, "data": data}


#: What a summary shows by default: enough to know what a node is, whether it has
#: run and what it shows. Anything else is asked for with get_canvas(fields=...).
_SUMMARY_DATA = ("label", "status", "url", "generatedUrl", "promptFile", "prompt", "text",
                 "bibleId", "error")


def _summary_line(node: dict[str, Any], fields: list[str] | None = None) -> str:
    """One node as one line:  id type [status] | label | output | prompt | extra k=v.

    Lines, not objects: across 90 nodes the repeated JSON keys and braces cost as
    much as the labels themselves."""
    data = dict(_summarise_node(node, fields)["data"])
    head = " ".join(str(x) for x in (node.get("id"), node.get("type"), data.pop("status", None)) if x)
    label = data.pop("label", None)
    output = data.pop("generatedUrl", None) or data.pop("url", None)
    data.pop("url", None)
    prompt_file = data.pop("promptFile", None)
    prompt = data.pop("prompt", None)
    if prompt_file:
        words = f" {prompt[prompt.rfind('('):]}" if isinstance(prompt, str) and prompt.endswith(")") else ""
        prompt = f"{prompt_file}{words}"
    parts = [head, label, output, f"prompt: {prompt}" if prompt else None]
    parts += [f"{k}={v if isinstance(v, str) else json.dumps(v, ensure_ascii=False, separators=(',', ':'))}"
              for k, v in data.items() if v not in (None, "", [], {})]
    return " | ".join(str(x) for x in parts if x)


def _summarise_node(node: dict[str, Any], fields: list[str] | None = None) -> dict[str, Any]:
    out = {k: v for k, v in node.items() if k != "data" and k not in _RENDER_ONLY}
    raw = node.get("data") or {}
    if fields and "*" in fields:
        data = {k: v for k, v in raw.items() if k not in _RENDER_ONLY_DATA}
    else:
        keep = set(_SUMMARY_DATA) | set(fields or ())
        data = {k: v for k, v in raw.items() if k in keep and (k not in _RENDER_ONLY_DATA or k in (fields or ()))}
    if node.get("data", {}).get("status") == "error" and node["data"].get("error"):
        data["error"] = str(node["data"]["error"])[:SUMMARY_TEXT_CHARS]
    for field in LONG_TEXT_FIELDS:
        value = data.get(field)
        if isinstance(value, str) and len(value) > SUMMARY_TEXT_CHARS:
            # A prompt kept in a file opens with the same subject_definitions boilerplate
            # on every node; the file name says which prompt it is.
            head = "" if field == "prompt" and data.get("promptFile") else f"{value[:SUMMARY_TEXT_CHARS]}… "
            data[field] = f"{head}({len(value.split())} words, {len(value)} chars)"
    if isinstance(data.get("takes"), list):
        data["takes"] = f"{len(data['takes'])} takes"
    out["data"] = data
    return out


def _save_node_data(project_id: str, node_id: str, update: dict[str, Any],
                    canvas: dict[str, Any] | None = None, attempts: int = 4) -> int:
    """Write one node's data fields, merging onto the live canvas.

    The studio in the browser and other agents save the canvas too, so a
    revision read a few seconds ago is often stale by the time a job's status
    comes back; a plain PUT then fails with 409 and a finished render never
    lands on its node. This re-reads the canvas and re-applies the same field
    update, so only these fields are written and other people's edits survive.
    """
    for attempt in range(attempts):
        live = canvas if (canvas is not None and attempt == 0) else _canvas(project_id)
        node = _find_node(live["nodes"], node_id)
        node.setdefault("data", {}).update(update)
        try:
            return _save_canvas(project_id, live)
        except ValueError as error:
            if "409" not in str(error) or attempt == attempts - 1:
                raise
            time.sleep(0.5 * (attempt + 1))
    raise RuntimeError("unreachable")


def _save_canvas(project_id: str, canvas: dict[str, Any]) -> int:
    saved = _request(
        "PUT",
        f"/projects/{project_id}/canvas",
        params={"workspace": WORKSPACE, **_scene_params()},
        json={
            "nodes": canvas["nodes"],
            "edges": canvas["edges"],
            "viewport": canvas.get("viewport"),
            "base_revision": canvas.get("revision", 0),
        },
    )
    canvas["revision"] = saved["revision"]
    return saved["revision"]


@_tool
def list_projects(name_query: str = "") -> dict[str, Any]:
    """List LAZA CINEMA STUDIO projects, optionally filtering by a case-insensitive name fragment."""
    projects = _request("GET", "/projects", params={"workspace": WORKSPACE}).get("projects", [])
    if name_query:
        projects = [p for p in projects if name_query.casefold() in str(p.get("name", "")).casefold()]
    keep = ("id", "name", "node_count", "updated_at")
    return {"projects": [{k: p.get(k) for k in keep} for p in projects]}


@_tool
def list_scenes(project: str) -> dict[str, Any]:
    """List a film project's scenes in order: id, name, status, node count, running time.

    Every canvas tool takes an optional `scene` (id or name); without it the tool
    works on the first scene, which is the project's original canvas.
    """
    resolved = _find_project(project)
    scenes = _request("GET", f"/projects/{resolved['id']}/scenes", params={"workspace": WORKSPACE})
    return {"project_id": resolved["id"], **scenes}


@_tool
def add_scene(project: str, name: str) -> dict[str, Any]:
    """Add an empty scene at the end of a film project and return it."""
    resolved = _find_project(project)
    scene = _request("POST", f"/projects/{resolved['id']}/scenes",
                     params={"workspace": WORKSPACE}, json={"name": name})
    return {"project_id": resolved["id"], "scene": scene}


_BIBLE_FILE_FIELDS = ("url", "mediaType", "width", "height", "duration")


def _bible_entry(project_id: str, entry: str) -> dict[str, Any]:
    entries = _request("GET", f"/projects/{project_id}/bible", params={"workspace": WORKSPACE})["entries"]
    found = next((e for e in entries if e["id"] == entry), None) or next((e for e in entries if e["name"] == entry), None)
    if found is None:
        partial = [e for e in entries if entry.casefold() in e["name"].casefold()]
        if len(partial) != 1:
            names = ", ".join(f"{e['name']} ({e['id']})" for e in entries)
            raise ValueError(f"Bible entry {entry!r} was not found or is ambiguous. Entries: {names}")
        found = partial[0]
    return found


def _file_of_node(project: str, scene: str, node_id: str) -> dict[str, Any]:
    """The file a node shows, as bible fields: an upload's url, or a generator's current output."""
    resolved = _resolve_project(project, scene)
    node = _find_node(_canvas(resolved["id"])["nodes"], node_id)
    data = node.get("data") or {}
    fields = {k: data[k] for k in _BIBLE_FILE_FIELDS if data.get(k) not in (None, "")}
    if not fields.get("url") and data.get("generatedUrl"):
        fields["url"] = data["generatedUrl"]
    if not fields.get("url"):
        raise ValueError(f"Node {node_id!r} shows no file.")
    return {"fields": fields, "label": str(data.get("label") or ""), "scene": resolved["scene"]}


@_tool
def list_bible(project: str) -> dict[str, Any]:
    """List the film's production bible: the shared cast sheets, environment plates, voices and props.

    Each entry has id, kind, name, the file (url, mediaType, width, height, duration),
    replaced versions in `history`, and `usage` (scenes and node count linked to it).
    To use an entry in a scene, add an `image` node whose data carries `bibleId`
    plus the entry's file fields; updating the entry then updates that node too.
    """
    resolved = _find_project(project)
    return {"project_id": resolved["id"],
            **_request("GET", f"/projects/{resolved['id']}/bible", params={"workspace": WORKSPACE})}


@_tool
def add_bible_entry(project: str, name: str, kind: str = "", from_node: str = "", scene: str = "",
                    url: str = "", notes: str = "") -> dict[str, Any]:
    """Add a shared reference to the bible. kind: cast | environment | prop | voice | other.

    Give either `from_node` (a node id in `scene`; that node becomes linked to the
    entry) or `url` (a file already under /uploads or /comfy_output).
    """
    resolved = _find_project(project)
    body: dict[str, Any] = {"name": name, "notes": notes, "kind": kind or None}
    if from_node:
        source = _file_of_node(project, scene, from_node)
        body.update(source["fields"])
        body["link"] = [{"scene": source["scene"], "node_id": from_node}]
    elif url:
        body["url"] = url
    else:
        raise ValueError("Give from_node or url.")
    return _request("POST", f"/projects/{resolved['id']}/bible", params={"workspace": WORKSPACE}, json=body)


@_tool
def update_bible_entry(project: str, entry: str, name: str = "", kind: str = "", notes: str = "",
                       from_node: str = "", scene: str = "", url: str = "") -> dict[str, Any]:
    """Rename/re-file a bible entry, or give it a new version of its file.

    `entry` is an id or name. A new file comes from `from_node` (node id in `scene`)
    or `url`; it replaces the file on every linked node in every scene, and the old
    version goes to the entry's history. Never overwrite the old file in place:
    ComfyUI caches by filename, so a new version must be a new filename.
    """
    resolved = _find_project(project)
    found = _bible_entry(resolved["id"], entry)
    body: dict[str, Any] = {"name": name or None, "kind": kind or None, "notes": notes or None}
    if from_node:
        body.update(_file_of_node(project, scene, from_node)["fields"])
    elif url:
        body["url"] = url
    return _request("PATCH", f"/projects/{resolved['id']}/bible/{found['id']}",
                    params={"workspace": WORKSPACE}, json=body)


@_tool
def cleanup_canvas(project: str, scene: str = "", to_library: list[dict[str, Any]] | None = None,
                   remove: list[str] | None = None) -> dict[str, Any]:
    """Sort the leftovers Qwen repairs leave on a canvas: keep the good ones in the library, drop the rest.

    With no arguments it only lists: the intermediate nodes (Qwen edits, grabbed stills,
    uploads) that nothing depends on -- no edge leads from them to anything still in use,
    no other node names them, they are not linked to the library and are not rendering --
    each with why, what it feeds and what feeds it. Nothing is changed.

    Then, in a second call, give the decisions:
    - to_library: [{"node_id", "name", "kind": cast|environment|prop|voice|other, "notes"?}] --
      the node's file goes into the library (the bible) as an entry, then the node leaves
      the canvas. The file is not deleted either way.
    - remove: [node ids] -- leaves the canvas, no library entry.
    Only nodes in the unused list are accepted; anything else is refused and nothing is
    changed. A removed node takes its edges with it. The canvas keeps its history, so a
    removal can be read back from there.
    """
    import canvas_cleanup
    resolved = _resolve_project(project, scene)
    to_library = to_library or []
    remove = remove or []
    with _hold_lock(resolved["id"], 120, "cleanup_canvas"):
        canvas = _canvas(resolved["id"])
        unused = canvas_cleanup.find_unused(canvas["nodes"], canvas["edges"])
        if not to_library and not remove:
            return {"project_id": resolved["id"], "count": len(unused), "unused": unused,
                    "next": "call again with to_library=[{node_id,name,kind}] and/or remove=[ids]"}
        by_id = {u["id"]: u for u in unused}
        ids = [str(e.get("node_id") or "") for e in to_library] + [str(i) for i in remove]
        refused = sorted({i for i in ids if i not in by_id})
        if refused:
            raise ValueError("Not in the unused list, nothing changed: " + ", ".join(refused))
        if len(set(ids)) != len(ids):
            raise ValueError("A node is named twice (to_library and remove, or twice in one).")
        for e in to_library:
            if not e.get("name") or not e.get("kind"):
                raise ValueError(f"to_library entry for {e.get('node_id')} needs a name and a kind.")
            if not by_id[e["node_id"]].get("url"):
                raise ValueError(f"{e['node_id']} has no file to put in the library.")
        entries = []
        for e in to_library:
            entries.append(_request("POST", f"/projects/{resolved['id']}/bible", params={"workspace": WORKSPACE},
                                    json={"name": e["name"], "notes": e.get("notes") or "", "kind": e["kind"],
                                          "url": by_id[e["node_id"]]["url"]}))
        applied = _apply_locked(resolved, [{"op": "remove_node", "id": i} for i in ids], None)
    return {"project_id": resolved["id"], "to_library": len(to_library), "removed": len(ids),
            "library_entries": [{"id": x.get("id") or (x.get("entry") or {}).get("id"), "name": x.get("name")}
                                for x in entries],
            "revision": applied.get("revision"), "node_count": applied.get("node_count")}


@_tool
def get_node_catalog() -> dict[str, Any]:
    """Return supported node types, defaults, and input/output handle ids."""
    return {"node_types": NODE_CATALOG}


def _export_canvas(resolved: dict[str, Any], canvas: dict[str, Any]) -> dict[str, Any]:
    """Write the full canvas to a temp directory, one file per node, and return its path.

    A full canvas runs to 100+ KB, and a caller almost always wants a few fields of
    a few nodes out of it. On disk it can grep and read just those. One directory
    per revision, so an unchanged canvas is not written twice:

      summary.txt          the summary lines, one node per line
      edges.txt            source[.handle]>target.handle, in canvas order
      nodes/<id>.json      the node exactly as stored
      text/<id>.<field>.txt  each long text field (prompt, compiledPrompt, ...) in full
    """
    safe = lambda text: "".join(c if c.isalnum() or c in "-_." else "_" for c in str(text))
    root = (Path(tempfile.gettempdir()) / "ai-cinema-canvas" / safe(resolved["id"])
            / safe(resolved.get("scene") or "main") / f"rev{canvas.get('revision', 0)}")
    if not (root / "summary.txt").is_file():
        (root / "nodes").mkdir(parents=True, exist_ok=True)
        (root / "text").mkdir(exist_ok=True)
        for node in canvas["nodes"]:
            nid = safe(node.get("id"))
            (root / "nodes" / f"{nid}.json").write_text(json.dumps(node, ensure_ascii=False, indent=1), encoding="utf-8")
            for field in (*LONG_TEXT_FIELDS, "promptBeforeSync"):
                value = (node.get("data") or {}).get(field)
                if isinstance(value, str) and value.strip():
                    (root / "text" / f"{nid}.{field}.txt").write_text(value, encoding="utf-8")
        (root / "edges.txt").write_text(chr(10).join(
            f"{e.get('id')} {e.get('source')}.{e.get('sourceHandle')}>{e.get('target')}.{e.get('targetHandle')}"
            for e in canvas["edges"]), encoding="utf-8")
        (root / "summary.txt").write_text(chr(10).join(_summary_line(n) for n in canvas["nodes"]), encoding="utf-8")
        # Older exports of this canvas are superseded; keep the last three.
        revs = sorted((d for d in root.parent.iterdir() if d.is_dir() and d.name[3:].isdigit()),
                      key=lambda d: int(d.name[3:]))
        for old in revs[:-3]:
            shutil.rmtree(old, ignore_errors=True)
    return {"dir": str(root), "revision": canvas.get("revision"), "nodes": len(canvas["nodes"]),
            "files": "summary.txt, edges.txt (id source.handle>target.handle), nodes/<id>.json, text/<id>.<field>.txt",
            "read": "read_canvas_export(file=..., grep=..., lines=...) from any machine; Read/grep dir when local"}


@_tool
def get_canvas(project: str, summary: bool = False, scene: str = "",
               node_ids: list[str] | None = None, fields: list[str] | None = None,
               include_archived: bool = False, inline: bool = False,
               types: list[str] | None = None, status: list[str] | None = None,
               since_revision: int | None = None) -> dict[str, Any]:
    """Read a canvas by project id, exact name, or an unambiguous name fragment.

    summary=True trims every long text field (prompt, compiledPrompt, text) to
    160 characters plus a word count and collapses take lists, so a 36-node film
    canvas comes back in a few KB instead of 130. Each summary node is one line:
    "id type status | label | output url | prompt: file (words) | k=v"; fields=["seed",
    ...] appends data fields, fields=["*"] all. Edges are "source[.handle]>target.handle"
    in canvas order (= <Picture N> order); remove one by source/target. Nodes folded
    into a collapsed group are left out unless include_archived. types=["video"] and
    status=["done","error"] filter the nodes (edges then only among those shown).

    since_revision=N (a summary's own revision): only what changed since then --
    changed/added node lines, removed node ids, and for every target whose inputs
    changed its full ordered input list. Falls back to the whole summary when that
    revision is no longer remembered (the last 8 summaries per canvas are).

    Without summary or node_ids the full canvas is written to a temp directory (one
    file per node, long texts as .txt) and only the path comes back: grep/read what
    you need there. inline=True returns it in the response instead. node_ids limits the read to those nodes and their
    edges, in full except take history (ids/urls/seeds only) -- use it to read one
    prompt. Start with the summary.
    """
    resolved = _resolve_project(project, scene)
    canvas = _canvas(resolved["id"])
    if node_ids:
        wanted = set(node_ids)
        missing = wanted - {n.get("id") for n in canvas["nodes"]}
        if missing:
            raise ValueError(f"No such node(s): {', '.join(sorted(missing))}")
        canvas = {**canvas,
                  "nodes": [n for n in canvas["nodes"] if n.get("id") in wanted],
                  "edges": [e for e in canvas["edges"] if e.get("source") in wanted or e.get("target") in wanted]}
    if node_ids and not summary:
        return {"revision": canvas.get("revision"),
                "nodes": [_compact_node(n) for n in canvas["nodes"]], "edges": canvas["edges"]}
    if not summary and not inline:
        return _export_canvas(resolved, canvas)
    if not summary:
        return {"project": resolved, **canvas}
    nodes = canvas["nodes"]
    archived = set() if (include_archived or node_ids) else _archived_ids(nodes)
    nodes = [n for n in nodes if n.get("id") not in archived]
    if types:
        nodes = [n for n in nodes if n.get("type") in types]
    if status:
        nodes = [n for n in nodes if ((n.get("data") or {}).get("status") or "") in status]
    shown = {n.get("id") for n in nodes}
    types = {n.get("id"): n.get("type") for n in canvas["nodes"]}

    def end(node_id: str, handle: str | None, side: str) -> str:
        # A node type with a single output needs no handle name to say which.
        if handle and not (side == "outputs" and len(NODE_CATALOG.get(types.get(node_id), {}).get(side) or []) == 1):
            return f"{node_id}.{handle}"
        return node_id

    # "source>target.handle", in canvas order -- which is <Picture N> order.
    edges = [f"{end(e.get('source'), e.get('sourceHandle'), 'outputs')}>{end(e.get('target'), e.get('targetHandle'), 'inputs')}"
             for e in canvas["edges"] if e.get("source") in shown and e.get("target") in shown]
    lines = {n.get("id"): _summary_line(n, fields) for n in nodes}
    revision = canvas.get("revision")
    key = (resolved["id"], resolved.get("scene"), json.dumps([fields, include_archived, types, status, node_ids]))
    history = _SUMMARY_CACHE.setdefault(key, {})
    history[revision] = (lines, edges)
    for old in sorted(history)[:-8]:
        del history[old]

    out: dict[str, Any] = {"project": {k: resolved.get(k) for k in ("id", "name", "scene")},
                           "revision": revision}
    before = history.get(since_revision) if since_revision is not None else None
    if before is not None and since_revision != revision:
        old_lines, old_edges = before

        def inputs(edge_list: list[str]) -> dict[str, list[str]]:
            by: dict[str, list[str]] = {}
            for e in edge_list:
                target, dot, handle = e.split(">", 1)[1].rpartition(".")
                by.setdefault(target if dot and handle.startswith("in-") else e.split(">", 1)[1], []).append(e)
            return by
        new_in, old_in = inputs(edges), inputs(old_edges)
        out["since"] = since_revision
        out["nodes"] = [line for i, line in lines.items() if old_lines.get(i) != line]
        out["removed"] = [i for i in old_lines if i not in lines]
        out["inputs"] = {t: new_in.get(t, []) for t in set(new_in) | set(old_in) if new_in.get(t) != old_in.get(t)}
        return out
    if before is not None:
        out["unchanged"] = True
        return out
    out["nodes"] = list(lines.values())
    out["edges"] = edges
    if archived:
        out["archived_hidden"] = len(archived)
    return out


#: Recent summaries per (canvas, read options), by revision, for since_revision.
_SUMMARY_CACHE: dict[tuple, dict[int, tuple[dict[str, str], list[str]]]] = {}

#: Most lines read_canvas_export returns in one call.
_EXPORT_MAX_LINES = 200


@_tool
def read_canvas_export(project: str, file: str = "summary.txt", grep: str = "", lines: str = "",
                       context: int = 0, scene: str = "") -> dict[str, Any]:
    """Read part of the canvas export (see get_canvas) on the server, so only what
    matches comes back -- works from another machine, where the export dir is not visible.

    file: summary.txt | edges.txt | nodes/<id>.json | text/<id>.<field>.txt, or a glob
      such as text/*.prompt.txt to search every prompt.
    grep: case-insensitive regex; returns matching lines ("file:line: text") with
      `context` lines around each.
    lines: "40-80" returns that range of a single file.
    Neither: the whole file, up to 200 lines.
    """
    resolved = _resolve_project(project, scene)
    root = Path(_export_canvas(resolved, _canvas(resolved["id"]))["dir"]).resolve()
    paths = sorted(p for p in root.glob(file) if p.is_file() and p.resolve().is_relative_to(root))
    if not paths:
        raise ValueError(f"No export file matches {file!r}. Files: summary.txt, edges.txt, "
                         f"nodes/<id>.json, text/<id>.<field>.txt")
    out: list[str] = []
    if grep:
        pattern = re.compile(grep, re.IGNORECASE)
        for path in paths:
            text = path.read_text(encoding="utf-8").splitlines()
            name = path.relative_to(root).as_posix()
            shown: set[int] = set()
            for i, line in enumerate(text):
                if pattern.search(line):
                    for j in range(max(0, i - context), min(len(text), i + context + 1)):
                        if j not in shown:
                            shown.add(j)
                            out.append(f"{name}:{j + 1}: {text[j]}")
    else:
        if len(paths) > 1:
            return {"files": [p.relative_to(root).as_posix() for p in paths]}
        text = paths[0].read_text(encoding="utf-8").splitlines()
        start, end = 1, len(text)
        if lines:
            a, _, b = lines.partition("-")
            start, end = max(1, int(a)), min(len(text), int(b or a))
        out = [f"{i}: {text[i - 1]}" for i in range(start, end + 1)]
    more = len(out) - _EXPORT_MAX_LINES
    result: dict[str, Any] = {"revision": root.name[3:], "lines": out[:_EXPORT_MAX_LINES]}
    if more > 0:
        result["truncated"] = f"{more} more lines; narrow grep or lines"
    return result


@_tool
def apply_canvas_operations(
    project: str,
    operations: list[dict[str, Any]],
    expected_revision: int | None = None,
    scene: str = "",
) -> dict[str, Any]:
    """Atomically add/update/remove nodes and edges without running generation.

    Operations use one of these shapes:
    - {op:add_node, type, id?, position?:{x,y}, data?, prompt_file?, style?, width?, height?, aspect_ratio?}
      Leave position out (or {0,0}) and the node is placed for you from its wiring: right of
      what feeds it, left of what it feeds, stacked with its siblings, never overlapping;
      unwired nodes go in a row below everything. keep_position:true keeps a real {0,0}.
    - {op:update_node, id, data?, prompt_file?, position?, style?, width?, height?, aspect_ratio?}
    - {op:replace_in_node_text, id, field?, old, new}  (field defaults to "prompt")

    prompt_file reads data.prompt from a file on this machine (relative paths are
    against the repository root, e.g. backend/previs/shot_prompt.txt) and
    records the path in data.promptFile. The file is what gets linted and
    committed, so the canvas is filled from it rather than from a pasted copy.

    replace_in_node_text edits one clause of a long text field in place. Sending a
    700-word prompt back through update_node to change one sentence means
    re-transcribing the whole thing; this changes only the span you name, and
    refuses when 'old' is missing or appears more than once.

    Node size is React Flow's top-level width/height, not style. Nodes made here
    never pass through the canvas's ResizeObserver, so pass width/height (or
    aspect_ratio = picture width / height) or the node renders with no size at
    all. Width defaults to 240, which is what the canvas uses everywhere.
    - {op:remove_node, id}
    - {op:add_still, source, seconds?:"last"|"first"|number, id?, label?, position?}
      cuts a full-size frame of source's clip into uploads/ as a new image node.
    - {op:add_edge, source, target, source_handle?, target_handle?, id?} or {op:add_edge, edge:"a>b.in-ref-image"}
    - {op:add_edges, edges:["a>b.in-ref-image", "c>b.in-ref-image"]}  (in order = <Picture N> order)
      A handle may be left out where that side has only one.
    - text_file on add_node/update_node fills a prompt node's data.text from a file.
    - replace_in_node_text works on any text field, e.g. field:"label" to change part of a label.
    The result lists only generated ids and ops with extra information; "applied" counts the rest.
    - {op:remove_edge, id} or {op:remove_edge, source, target, source_handle?, target_handle?}
    Read the canvas first and pass its revision as expected_revision.
    """
    if not operations:
        raise ValueError("At least one canvas operation is required.")
    resolved = _resolve_project(project, scene)
    with _hold_lock(resolved["id"], 60, "apply_canvas_operations"):
        return _apply_locked(resolved, operations, expected_revision)


def _wants_auto_position(operation: dict[str, Any]) -> bool:
    """add_node / add_still with no position, "auto", or the {0,0} placeholder get placed for you."""
    pos = operation.get("position")
    if pos is None or pos == "auto":
        return True
    return (isinstance(pos, dict) and float(pos.get("x") or 0) == 0 and float(pos.get("y") or 0) == 0
            and not operation.get("keep_position"))


def _apply_locked(resolved: dict[str, Any], operations: list[dict[str, Any]],
                  expected_revision: int | None) -> dict[str, Any]:
    canvas = _canvas(resolved["id"])
    revision = int(canvas.get("revision", 0))
    if expected_revision is not None and expected_revision != revision:
        raise ValueError(
            f"Canvas revision conflict: expected {expected_revision}, current revision is {revision}. "
            "Read the canvas again before editing."
        )
    updated = deepcopy(canvas)
    operations = _expand_operations(operations)
    results = [_apply_operation(updated, operation) for operation in operations]
    # New nodes given no position (or the {0,0} placeholder) are put where they belong
    # by their wiring, clear of everything else (node_placement.py).
    auto = [r["id"] for op, r in zip(operations, results)
            if op.get("op") in ("add_node", "add_still") and _wants_auto_position(op)]
    if auto:
        import node_placement
        for node_id, pos in node_placement.place_nodes(
                updated["nodes"], updated["edges"], auto,
                lambda n: _bounds(n)).items():
            _find_node(updated["nodes"], node_id)["position"] = pos
    # A prompt edited on a node that is bound to a file goes back into that file,
    # so the file stays the source of truth and the next run finds nothing to
    # reconcile. Ops that read the file (prompt_file) leave the two equal.
    before = {n.get("id"): (n.get("data") or {}).get("prompt") for n in canvas["nodes"]}
    write_back = [
        (str(n["data"]["promptFile"]).strip(), n["data"]["prompt"])
        for n in updated["nodes"]
        if str((n.get("data") or {}).get("promptFile") or "").strip()
        and isinstance(n["data"].get("prompt"), str)
        and n["data"]["prompt"] != before.get(n.get("id"))
    ]
    saved = _request(
        "PUT",
        f"/projects/{resolved['id']}/canvas",
        params={"workspace": WORKSPACE, **_scene_params()},
        json={
            "nodes": updated["nodes"],
            "edges": updated["edges"],
            "viewport": updated.get("viewport"),
            "base_revision": revision,
        },
    )
    files_written, file_warnings = [], []
    for prompt_file, text in write_back:
        warning = _write_prompt_file(prompt_file, text)
        files_written.append(prompt_file)
        if warning:
            file_warnings.append(warning)
    # Success of each op is implied by the call succeeding; keep only results that
    # carry something new: a generated id, a duplicate skipped, a text length change.
    def news(op: dict[str, Any], result: dict[str, Any]) -> bool:
        if set(result) - {"op", "id"}:
            return True
        return result.get("op") == "add_node" and not op.get("id")
    return {
        "project_id": resolved["id"],
        "project_name": resolved["name"],
        "revision": saved["revision"],
        "results": [r for op, r in zip(operations, results) if news(op, r)],
        "applied": len(results),
        "prompt_files_written": files_written,
        "warnings": file_warnings,
        "node_count": len(updated["nodes"]),
        "edge_count": len(updated["edges"]),
    }


@_tool
def run_canvas_node(project: str, node_id: str, scene: str = "",
                    prompt_source: str = "") -> dict[str, Any]:
    """Start one visible canvas generation node and persist its queued job id.

    Supports H3 video, videoEdit, videoUpscale, charswap, videoReangle, qwenImage, gaussian and audioGen nodes. Inputs are
    resolved strictly from the node's incoming canvas edges, matching the
    studio UI. This starts the node
    but does not wait; call refresh_canvas_node until it reaches done or error.

    A node bound to a promptFile refuses to run when its prompt and the file
    differ: prompt_source="node" writes the node's text to the file first,
    prompt_source="file" runs the file (the node's text is kept in promptBeforeSync).
    """
    if prompt_source not in ("", "file", "node"):
        raise ValueError('prompt_source is "", "file" or "node".')
    resolved = _resolve_project(project, scene)
    with _hold_lock(resolved["id"], 60, f"run {node_id}"):
        result = _run_locked(resolved, node_id, prompt_source)
    job_id = result.get("job_id") if isinstance(result, dict) else None
    if job_id:
        # also when the node was already generating: the watcher that started it may be gone (this
        # process restarted); _watch_job is a no-op for a job that already has one
        _watch_job(resolved["id"], node_id, job_id, scene)
    return result


@_tool
def redo_audio(project: str, node_id: str, mode: str = "polish", scene: str = "",
               steps: int = 0, denoise: float = 0.0, seed: int = -1) -> dict[str, Any]:
    """Redo only the sound of a finished video node, keeping its picture. One run, not a setting.

    Loads the latent the node's last take saved, freezes the picture, re-noises the audio
    and denoises it again against that picture (ComfyUI-H3-AudioRefine), then saves the
    result as the node's new take (the old take stays in takes). The picture is the same
    to within encoding noise; the node's seed, prompt, references and audioLocks are used
    as they stand.

    mode "polish": 4 steps at denoise 0.5 (about 170 s for 12 s, no cache): the same
    sound, cleaned. Measured: lines and positions kept, level 2-5 dB lower.
    mode "reroll": 8 steps at denoise 1.0 (about 250 s): a new soundtrack against the same
    picture. A spoken line can come back as a whisper, so lock lines with audioLocks first.
    Another reroll needs another `seed`. steps / denoise override the mode's numbers.

    The picture stays frozen, so the lips keep following the sound of the render that
    was redone: a line whose timing or length changes in the redo can drift out of sync
    with the mouth. Keep lines you care about locked (audioLocks) or inside a carrier.

    Clips that continue from this one keep its old sound tail until they are re-run:
    the result lists them as downstream_not_updated.
    """
    import audio_redo
    cfg = audio_redo.resolve(mode, steps or None, denoise or None)
    resolved = _resolve_project(project, scene)
    with _hold_lock(resolved["id"], 60, f"redo audio {node_id}"):
        canvas = _canvas(resolved["id"])
        node = _find_node(canvas["nodes"], node_id)
        if node.get("type") != "video":
            raise ValueError(f"redo_audio works on H3 video nodes, {node_id} is {node.get('type')}.")
        result = _run_locked(resolved, node_id, "", audio_redo=cfg, seed=None if seed < 0 else seed)
        downstream = [e["target"] for e in canvas.get("edges", [])
                      if e.get("source") == node_id and e.get("targetHandle") == CHAIN_HANDLE]
    job_id = result.get("job_id") if isinstance(result, dict) else None
    if job_id and result.get("status") != "already_generating":
        _watch_job(resolved["id"], node_id, job_id, scene)
    return {**result, "audio_redo": cfg, "downstream_not_updated": downstream,
            "note": "relabel the node: sound redone (%s %d steps @%g) from its previous take; "
                    "downstream clips continue from the old sound tail until re-run"
                    % (cfg["mode"], cfg["steps"], cfg["denoise"])}


_TERMINAL_JOB = {"done", "error", "cancelled"}
_WATCH_INTERVAL_S = 5.0
_WATCH_MAX_S = 4 * 3600
_watched: set[str] = set()


def _watch_job(project_id: str, node_id: str, job_id: str, scene: str) -> None:
    """Finalise a job started from here once it is terminal, without a manual refresh.

    Only refresh_canvas_node wrote the take for an MCP-started job, so a clip that
    finished while nobody called it left the node spinning (or idle with a dangling
    pendingTake) until the next refresh. One daemon thread per job polls the backend
    and hands the terminal state to refresh_canvas_node, which is idempotent: if the
    studio consumed the result first, it finds no jobId and adds at most the missing take.
    A job the backend no longer knows about clears the node's spinner as an error.
    """
    if job_id in _watched:
        return
    _watched.add(job_id)

    def loop() -> None:
        deadline = time.time() + _WATCH_MAX_S
        try:
            while time.time() < deadline:
                time.sleep(_WATCH_INTERVAL_S)
                try:
                    job = _request("GET", f"/job/{job_id}")
                except ValueError as error:      # backend answered: unknown job (404)
                    if "(404)" not in str(error):
                        continue
                    job = {"status": "error", "error": "任务记录已丢失（后端可能已重启或清理了历史记录），请重新生成"}
                except RuntimeError:             # backend unreachable: keep waiting
                    continue
                if job.get("status") not in _TERMINAL_JOB:
                    continue
                try:
                    resolved = _resolve_project(project_id, scene)
                    with _hold_lock(resolved["id"], 30, f"finish {node_id}"):
                        canvas = _canvas(resolved["id"])
                        data = _find_node(canvas["nodes"], node_id).get("data", {})
                        if data.get("jobId") == job_id:
                            _finish_locked(resolved, node_id, job_id, job)
                        elif data.get("worldJobId") == job_id:
                            refresh_canvas_node(project_id, node_id, scene)
                    return
                except Exception as error:       # lock busy / canvas conflict: try again
                    print(f"watch {job_id}: {error}", file=sys.stderr, flush=True)
        finally:
            _watched.discard(job_id)

    threading.Thread(target=loop, name=f"watch-{job_id}", daemon=True).start()


def _local_media(url: str) -> Path | None:
    """The file on this machine behind a canvas media url, or None."""
    path_part = url.split("?", 1)[0]
    if path_part.startswith("/uploads/"):
        local = _BACKEND_DIR / "uploads" / path_part[len("/uploads/"):]
    elif path_part.startswith("/comfy_output/"):
        out_dir = Path(os.environ.get("COMFYUI_OUTPUT_DIR", r"D:\ComfyUI-sage3\ComfyUI\output"))
        local = out_dir / path_part[len("/comfy_output/"):]
    else:
        return None
    return local if local.is_file() else None


def _clip_on_disk(url: str, tmp: str) -> Path:
    """A canvas clip as a local file: read in place, or fetched from the backend."""
    local = _local_media(url)
    if local is not None:
        return local
    target = Path(tmp) / ("clip" + (Path(url.split("?", 1)[0]).suffix or ".mp4"))
    with _HTTP.stream("GET", f"{BACKEND_URL}{url}", timeout=120) as response:
        response.raise_for_status()
        with open(target, "wb") as fh:
            for chunk in response.iter_bytes():
                fh.write(chunk)
    return target


def _attention_for_preset(preset: str, accel: str) -> str:
    """The attention patch a node's accel really gets, as the backend decides it (GET /h3-attention):
    which patches a preset may use depends on the checkpoint that loads, and only the backend knows
    that (Sol deforms faces on w4a8 builds, 2026-10-04). If the backend cannot be asked, the same rule
    is applied here from the machine profile, so the submitted payload still says what will run."""
    try:
        response = httpx.get(f"{BACKEND_URL}/h3-attention", params={"preset": preset}, timeout=5.0)
        response.raise_for_status()
        policy = response.json()
        blocked = set(policy.get("blocked") or {})
        swapped = []
        for part in (p.strip() for p in accel.split(",")):
            name = "sol" if part == "solpv" else part
            swapped.append(policy["default"] if name in blocked else part)
        return ",".join(dict.fromkeys(p for p in swapped if p))
    except Exception:
        effective = (_MACHINE_PROFILE.get("preset_substitutes") or {}).get(preset, preset)
        return accel_for_unet(effective, accel)


def _extract_frame(source: Path, at: Any, target: Path, vf: list[str] | None = None) -> str:
    """Write one frame of source at `at` (seconds or "last") to target; returns a note.

    A time within the last frame or so can land past the end of the video stream
    (the container runs to the end of the audio): ffmpeg then decodes nothing and
    fails with EINVAL, which is what get_frames at 12.2 s of a 12.33 s clip did
    (2026-09-26). Such a time falls back to the true last frame, and says so."""
    def run(seek: list[str]) -> str:
        if target.exists():
            target.unlink()
        done = subprocess.run(["ffmpeg", "-y", "-v", "error", *seek, *(vf or []), str(target)],
                              capture_output=True)
        return "" if done.returncode == 0 and target.is_file() and target.stat().st_size \
            else (done.stderr.decode(errors="replace").strip()[-300:] or f"exit {done.returncode}")
    last = ["-sseof", "-1", "-i", str(source), "-update", "1"]
    if at != "last":
        error = run(["-ss", f"{float(at):.3f}", "-i", str(source), "-frames:v", "1"])
        if not error:
            return ""
    error = run(last)
    if error:
        raise ValueError(f"No frame at {at} in {source.name}: {error}")
    return "" if at == "last" else "past the end of the video stream; last frame instead"


def _cut_still(url: str, at: Any) -> str:
    """Save one full-size frame of a clip under uploads/ and return its url.

    at: seconds, "first" or "last". "last" decodes the final second and keeps the
    last frame, which is the true last frame whatever the clip's length."""
    stem = Path(url.split("?", 1)[0]).stem
    if at == "first":
        at = 0.0
    tag = "last" if at == "last" else f"{float(at):.3f}s"
    name = f"still_{stem}_{tag}.png"
    target = _BACKEND_DIR / "uploads" / name
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        source = _clip_on_disk(url, tmp)
        _extract_frame(source, at, target)
    return f"/uploads/{name}"


def _grab_frames(project: str, node_id: str, seconds: list[float], scene: str,
                 width: int) -> list[tuple[bytes, str]]:
    resolved = _resolve_project(project, scene)
    node = _find_node(_canvas(resolved["id"])["nodes"], node_id)
    url = _node_url(node)
    if not url:
        raise ValueError(f"Node {node_id} has no clip to read frames from.")
    if not seconds:
        raise ValueError("Pass seconds=[...], e.g. one per shot.")
    if len(seconds) > 8:
        raise ValueError("At most 8 frames per call.")
    with tempfile.TemporaryDirectory() as tmp:
        source = _clip_on_disk(url, tmp)
        out = []
        for i, t in enumerate(seconds):
            still = Path(tmp) / f"f{i}.jpg"
            note = _extract_frame(source, t, still,
                                  ["-vf", f"scale={int(width)}:-2", "-q:v", "4"])
            out.append((still.read_bytes(), note))
        return out


@mcp.tool(structured_output=False)
async def get_frames(project: str, node_id: str, seconds: list[float], scene: str = "",
                     width: int = 640) -> list:
    """Stills from a node's clip at the given seconds, as images.

    For checking a render without downloading it: one frame per shot (just after
    each cut) or at the beat that was changed. width defaults to 640 px, which is
    enough to judge staging and costs far less than a full-size frame.
    """
    blobs = await anyio.to_thread.run_sync(
        functools.partial(_grab_frames, project, node_id, seconds, scene, width))
    items: list = []
    for t, (blob, note) in zip(seconds, blobs):
        items.append(f"{node_id} @ {float(t):.2f}s" + (f" ({note})" if note else ""))
        items.append(Image(data=blob, format="jpeg"))
    return items


def _media_transcription(job_id: str, wait_seconds: float) -> dict[str, Any]:
    deadline = time.monotonic() + max(0.0, wait_seconds)
    while True:
        job = _request("GET", f"/media/transcribe/{job_id}")
        if job.get("status") in ("completed", "failed") or time.monotonic() >= deadline:
            break
        time.sleep(3)
    out = {k: job.get(k) for k in ("job_id", "status", "progress", "stage", "language", "error")}
    out["job_id"] = job_id
    if job.get("status") == "completed":
        out["segments"] = [
            {k: seg.get(k) for k in ("start", "end", "speaker", "text") if seg.get(k) is not None}
            for seg in job.get("segments", [])
        ]
    return out


@_tool
def transcribe_media(file: str, start: float = 0.0, end: float = 0.0, language: str = "",
                     wait_seconds: float = 45) -> dict[str, Any]:
    """Whisper the lines of a media file on the backend machine, with their times.

    file is a bare file name in uploads/ or the ComfyUI output folder (e.g. the
    source film, which is too large to move). Transcribe a window, not the whole
    film: start/end in seconds of the file (end 0 = to the end). Segment times
    come back in seconds of the file, so they feed extract_audio directly.
    language e.g. "en" skips detection. If the job outlives wait_seconds, the
    result carries job_id; call get_media_transcription(job_id) later -- do not
    call transcribe_media again for the same window. Transcriptions run one at a
    time on the backend, so a job may sit in stage "waiting" first.
    """
    body: dict[str, Any] = {"name": file, "start": float(start)}
    if end:
        body["end"] = float(end)
    if language:
        body["language"] = language
    job = _request("POST", "/media/transcribe", json=body)
    return _media_transcription(job["job_id"], wait_seconds)


@_tool
def get_media_transcription(job_id: str, wait_seconds: float = 0) -> dict[str, Any]:
    """The state or result of a transcribe_media job that was still running."""
    return _media_transcription(job_id, wait_seconds)


@_tool
def extract_audio(file: str, start: float = 0.0, end: float = 0.0, out_name: str = "",
                  normalize: bool = True, project: str = "", scene: str = "", node_id: str = "",
                  label: str = "", segments: list[list[float]] | None = None,
                  gap: float = 0.3) -> dict[str, Any]:
    """Cut [start, end) seconds of a media file's sound into uploads/ as a wav.

    segments=[[s1, e1], [s2, e2], ...] instead joins several lines of the same
    speaker in order (gap seconds of silence between them) into one reference,
    leaving out whoever speaks in between.

    For a voice reference: find the line's times with transcribe_media first,
    then cut just that line (a little padding either side, no other voice in
    it). normalize applies loudness normalisation (-16 LUFS). With project, the
    clip is also added to that scene's canvas as an audio node (node_id, label)
    ready to wire into a shot's in-ref-audio.
    """
    body = {"name": file, "start": float(start), "end": float(end), "normalize": bool(normalize),
            "gap": float(gap)}
    if segments:
        body["segments"] = [[float(s), float(e)] for s, e in segments]
    if out_name:
        body["out_name"] = out_name
    result = _request("POST", "/media/extract-audio", json=body)
    if project:
        added = apply_canvas_operations(project, [{
            "op": "add_node", "type": "image", **({"id": node_id} if node_id else {}),
            "position": {"x": 0, "y": 0}, "width": 510, "height": 96,
            "data": {"url": result["url"], "mediaType": "audio", "duration": result["duration"],
                     "label": label or f"{file} {result['start']:.2f}–{result['end']:.2f}"},
        }], scene=scene)
        result["node_id"] = node_id or next(
            (r.get("id") for r in added.get("results", []) if r.get("id")), None)
    return result


def _media_frames(file: str, seconds: list[float], width: int) -> list[tuple[bytes, str]]:
    if not seconds:
        raise ValueError("Pass seconds=[...].")
    if len(seconds) > 8:
        raise ValueError("At most 8 frames per call.")
    out = []
    for t in seconds:
        try:
            response = _HTTP.get(f"{BACKEND_URL}/media/frame", headers={"X-Agent": AGENT},
                                 params={"name": file, "t": float(t), "width": int(width)}, timeout=60)
        except httpx.HTTPError as error:
            raise RuntimeError(f"Cannot reach LAZA CINEMA STUDIO backend at {BACKEND_URL}: {error}") from error
        if response.status_code != 200:
            try:
                detail = response.json().get("detail", response.text)
            except ValueError:
                detail = response.text
            raise ValueError(f"Backend refused the frame at {t}s ({response.status_code}): {detail}")
        out.append((response.content, ""))
    return out


@mcp.tool(structured_output=False)
async def get_media_frames(file: str, seconds: list[float], width: int = 640) -> list:
    """Stills from a media file on the backend machine (e.g. the source film), as images.

    file is a bare file name in uploads/ or the ComfyUI output folder; seconds are
    in the file (up to 8 per call). For finding the moment a reference comes from;
    to keep one as an image node, use add_media_still.
    """
    blobs = await anyio.to_thread.run_sync(functools.partial(_media_frames, file, seconds, width))
    items: list = []
    for t, (blob, _) in zip(seconds, blobs):
        items.append(f"{file} @ {float(t):.2f}s")
        items.append(Image(data=blob, format="jpeg"))
    return items


@_tool
def add_media_still(file: str, seconds: float, project: str = "", scene: str = "",
                    node_id: str = "", label: str = "", out_name: str = "") -> dict[str, Any]:
    """Save a full-size frame of a media file into uploads/ as a png; with project,
    also add it to that scene's canvas as an image node (a guide or reference board)."""
    body: dict[str, Any] = {"name": file, "t": float(seconds)}
    if out_name:
        body["out_name"] = out_name
    result = _request("POST", "/media/still", json=body)
    if project:
        w, h = result.get("width") or DEFAULT_WIDTH, result.get("height") or DEFAULT_HEIGHT
        added = apply_canvas_operations(project, [{
            "op": "add_node", "type": "image", **({"id": node_id} if node_id else {}),
            "position": {"x": 0, "y": 0}, "aspect_ratio": w / h,
            "data": {"url": result["url"], "width": w, "height": h, "userWidth": 240,
                     "label": label or f"{file} @ {float(seconds):.2f}s"},
        }], scene=scene)
        result["node_id"] = node_id or next(
            (r.get("id") for r in added.get("results", []) if r.get("id")), None)
    return result


@_tool
def render_gaussian_view(project: str, node_id: str, x: float = 0.0, y: float = 0.0,
                         z: float = 0.0, yaw: float = 0.0, pitch: float = 0.0,
                         vfov: float = 45.0, scene: str = "", new_node_id: str = "",
                         label: str = "") -> dict[str, Any]:
    """Render a still of a gaussian node's splat from a placed camera and add it to the
    canvas as an image node -- the MCP's version of the viewer's 截取当前视角.

    The frame is the source picture's camera: x right, y down (a negative y raises
    the camera), z forward, metres; yaw turns right, pitch tilts up (degrees). Stay
    near where the splat was generated -- a FlashWorld "ring" holds within a metre
    or two of the picture's position; beyond that, and behind anything it never saw,
    the render tears. Wire the result as <image 2> of a qwenImage node with anyAngle
    (the original picture as <image 1>) to bring it back to full quality.
    """
    resolved = _resolve_project(project, scene)
    canvas = _canvas(resolved["id"])
    node = _find_node(canvas["nodes"], node_id)
    ply = (node.get("data") or {}).get("plyUrl")
    if node.get("type") not in ("gaussian", "gaussianViewer") or not ply:
        raise ValueError(f"{node_id} is not a gaussian node with a finished ply.")
    width = int((node.get("data") or {}).get("width") or DEFAULT_WIDTH)
    height = int((node.get("data") or {}).get("height") or DEFAULT_HEIGHT)
    result = _request("POST", "/gaussian/render-view", json={
        "ply_url": ply, "x": x, "y": y, "z": z, "yaw": yaw, "pitch": pitch, "vfov": vfov,
        "width": width, "height": height})
    pose = f"x{x:+.2f} y{y:+.2f} z{z:+.2f} yaw{yaw:+.0f} pitch{pitch:+.0f}"
    added = apply_canvas_operations(project, [{
        "op": "add_node", "type": "image", **({"id": new_node_id} if new_node_id else {}),
        "position": {"x": 0, "y": 0}, "aspect_ratio": width / height,
        "data": {"url": result["url"], "width": width, "height": height, "userWidth": 240,
                 "label": label or f"{node_id} 高斯视角 · {pose}"},
    }], scene=scene)
    result["node_id"] = new_node_id or next(
        (r.get("id") for r in added.get("results", []) if r.get("id")), None)
    result["pose"] = pose
    return result


EDIT_TYPE_MODES = {"videoReshot": "temporal_reshot", "videoBridge": "av_bridge",
                   "videoContinue": "continuation", "videoFrames": "fl2va"}
EDIT_TYPES = {"videoEdit", *EDIT_TYPE_MODES}


def _run_video_edit_locked(resolved: dict[str, Any], canvas: dict[str, Any],
                           node: dict[str, Any]) -> dict[str, Any]:
    """Start a videoEdit node: re-render an existing clip under a new prompt.

    This exists because a plate can need two different weights at once. `fused`
    gives furniture its real form and `singularity` renders the light a room
    actually has, and 2026-09-07 showed you cannot have both from one pass. So
    the fused master is generated first and then edited under singularity, which
    is what this call is for.

    The shape follows the studio's own edit request exactly: source clip on
    "in-video" into ref_video_urls, POST /generate-video-edit. Unlike the studio
    it passes motion_preset through, so which weight does the edit is a property
    of the node rather than of whatever the backend defaults to that week.
    """
    node_id = node["id"]
    data = node.setdefault("data", {})
    mode = EDIT_TYPE_MODES.get(node.get("type")) or data.get("editMode") or "edit"
    if mode in ("recast", "motion_transfer"):   # retired modes; the backend no longer has them
        mode = "edit"
    if data.get("status") == "generating" and data.get("jobId"):
        return {"project_id": resolved["id"], "node_id": node_id,
                "job_id": data["jobId"], "status": "already_generating"}

    def urls(handle: str) -> list[str]:
        sources = _incoming_nodes(canvas, node_id, handle)
        missing = [source.get("id") for source in sources if not _node_url(source)]
        if missing:
            raise ValueError(f"Node {node_id} has unfinished inputs on {handle}: "
                             f"{', '.join(missing)}")
        return [_node_url(source) for source in sources]

    prompt_nodes = _incoming_nodes(canvas, node_id, "in-prompt")
    prompt = " ".join(
        str((source.get("data") or {}).get("text", "")).strip()
        for source in prompt_nodes
        if str((source.get("data") or {}).get("text", "")).strip()
    ) or str(data.get("prompt", "")).strip()
    # 去水印 / 去字幕: the backend writes the prompt from the two flags.
    cleanup = mode == "edit" and bool(data.get("cleanupRemoveWatermark") or data.get("cleanupRemoveSubtitles"))
    if not prompt and not cleanup:
        raise ValueError(f"videoEdit node {node_id} has no prompt input.")

    source_videos = urls("in-video")
    if not source_videos and mode != "fl2va":
        raise ValueError(f"{node.get('type')} node {node_id} has no clip on in-video; an edit "
                         f"needs the clip it is editing.")
    first_frames = urls("in-first-frame")
    last_frames = urls("in-last-frame")

    # 去水印 / 去字幕 on the whole clip: size, length and audio follow the source,
    # data.prompt is ignored (the backend builds it), no edit window.
    if cleanup:
        body = {
            "source_url": source_videos[0],
            "remove_watermark": bool(data.get("cleanupRemoveWatermark")),
            "remove_subtitles": bool(data.get("cleanupRemoveSubtitles")),
            "watermark_hint": str(data.get("cleanupWatermarkHint") or ""),
            "scene_hint": str(data.get("cleanupSceneHint") or ""),
            "seed": int(data.get("seed") if data.get("seed") is not None else 81000),
            "steps": int(data.get("steps") or 8),
            "motion_preset": data.get("motionPreset") or "singularity",
        }
        submitted = _request("POST", "/generate-video-cleanup", json=body,
                             project_id=resolved["id"])
        revision = _save_node_data(resolved["id"], node_id, {
            "status": "generating", "jobId": submitted["job_id"], "error": None,
            "compiledPrompt": None, "submittedResources": None,
        }, canvas)
        return {"project_id": resolved["id"], "project_name": resolved["name"],
                "node_id": node_id, "job_id": submitted["job_id"],
                "status": submitted.get("status", "queued"), "revision": revision,
                "mode": "video_cleanup", "remove_watermark": body["remove_watermark"],
                "remove_subtitles": body["remove_subtitles"],
                "input_counts": {"source_video": len(source_videos)}}

    # av_bridge: freeze both ends of the window and regenerate only the middle.
    # Same two fields as the reshot above for the window, plus how much to freeze;
    # the backend snaps everything onto H3's grids (preserved runs of
    # 39/90/141/192, targets of 5+17k) and refuses a window that has too little
    # untouched material on either side, so the snapped plan comes back here.
    #
    # This path takes NO reference images or audio: the two frozen ends are the
    # only anchor, so anything the repair has to look like belongs in the prompt.
    if mode == "av_bridge":
        start = max(0, int(round(float(data.get("reshotStartSeconds") or 0) * 24)))
        count = max(1, int(round(float(data.get("reshotDurationSeconds") or 3) * 24)))
        bridge = {
            "video_url": source_videos[0],
            "prompt": prompt,
            "start_frame": start,
            "frame_count": count,
            "context_frames": int(data.get("bridgeContextFrames") or 39),
            "steps": int(data.get("steps") or 20),
            "seed": int(data.get("seed") if data.get("seed") is not None else -1),
        }
        plan = _request("POST", "/plan-av-bridge", json=bridge, project_id=resolved["id"])
        if not plan.get("ok"):
            raise ValueError(f"videoEdit node {node_id}: {plan.get('error')}")
        submitted = _request("POST", "/generate-av-bridge", json=bridge,
                             project_id=resolved["id"])
        revision = _save_node_data(resolved["id"], node_id, {
            "status": "generating", "jobId": submitted["job_id"], "error": None,
            "compiledPrompt": None, "submittedResources": None,
        }, canvas)
        return {"project_id": resolved["id"], "project_name": resolved["name"],
                "node_id": node_id, "job_id": submitted["job_id"],
                "status": submitted.get("status", "queued"), "revision": revision,
                "mode": "av_bridge", "start_frame": start, "frame_count": count,
                "plan": {k: plan[k] for k in ("preserve", "target", "middle",
                                              "head_end", "tail_start") if k in plan},
                "input_counts": {"source_video": len(source_videos)}}

    # temporal_reshot: re-generate only a frame range of the source clip and keep
    # the rest (and its audio). The studio's VideoEditNode drives this through
    # POST /generate-video-reshot with the same fields; the node's data holds the
    # range in seconds (reshotStartSeconds / reshotDurationSeconds), as the UI does.
    if mode == "temporal_reshot":
        start = max(0, int(round(float(data.get("reshotStartSeconds") or 0) * 24)))
        count = max(1, int(round(float(data.get("reshotDurationSeconds") or 3) * 24)))
        reshot = {
            "video_url": source_videos[0],
            "prompt": prompt,
            "start_frame": start,
            "frame_count": count,
            "context_before": int(data.get("reshotContextBefore") if data.get("reshotContextBefore") is not None else 39),
            "context_after": int(data.get("reshotContextAfter") if data.get("reshotContextAfter") is not None else 39),
            "edge_blend_frames": int(data.get("reshotEdgeBlendFrames") or 0),
            "ref_image_urls": urls("in-character"),
            "steps": int(data.get("steps") or 20),
            "seed": int(data.get("seed") if data.get("seed") is not None else -1),
            # Lets the reshot hear the source audio, so mouths in the new window
            # follow the dialogue already on the track. Off by default in the
            # backend because the plugin occasionally hits a one-token audio shape
            # mismatch; rerun with it off if that happens.
            "condition_source_audio": str(data.get("reshotConditionAudio") or "").lower() in ("1", "true", "yes", "on"),
        }
        submitted = _request("POST", "/generate-video-reshot", json=reshot,
                             project_id=resolved["id"])
        revision = _save_node_data(resolved["id"], node_id, {
            "status": "generating", "jobId": submitted["job_id"], "error": None,
            "compiledPrompt": None, "submittedResources": None,
        }, canvas)
        return {"project_id": resolved["id"], "project_name": resolved["name"],
                "node_id": node_id, "job_id": submitted["job_id"],
                "status": submitted.get("status", "queued"), "revision": revision,
                "mode": "temporal_reshot", "start_frame": start, "frame_count": count,
                "input_counts": {"source_video": len(source_videos),
                                 "images": len(reshot["ref_image_urls"])}}

    payload = {
        "prompt": prompt,
        "mode": mode,
        "image_url": first_frames[0] if first_frames else None,
        "last_frame_url": last_frames[0] if last_frames else None,
        "ref_video_urls": source_videos,
        "ref_image_urls": urls("in-character"),
        "ref_audio_urls": urls("in-audio"),
        # Edit-window guide frames: indexes are frames of the SOURCE clip; the
        # backend moves them into the padded piece and drops any outside the window.
        "guide_frames": [{"url": u, "frame_index": int((data.get("guideFrameIndexes") or [])[i])
                          if i < len(data.get("guideFrameIndexes") or []) else -1}
                         for i, u in enumerate(urls("in-guide-frame"))],
        "audio_strategy": data.get("audioStrategy") or "copy_source",
        "width": int(data.get("width") or DEFAULT_WIDTH),
        "height": int(data.get("height") or DEFAULT_HEIGHT),
        "steps": int(data.get("steps") or DEFAULT_H3_STEPS),
        "length": int(data.get("length") or 124),
        "seed": int(data.get("seed") if data.get("seed") is not None else 81000),
        # Edits default to the checkpoint the segments render with, so an edit
        # queued between segments does not swap 20 GB of weights both ways
        # (2026-09-22).
        "motion_preset": data.get("motionPreset") or "singularity",
        # The speed LoRA of the edit, like a segment's: 'turbo8' (the backend default), 'taomate3' or 'none';
        # the backend sets the steps from it, so the node's "steps" does not choose it.
        **({"accel_lora": data["accelLora"]} if data.get("accelLora") else {}),
        # A per-frame depth clip of the source (a depthVideo node's result) drives the geometry of every frame through
        # the Fun ControlNet, beside the source as <Video 1>: the pose follows the clip, the look comes from the pictures.
        **({"control_video_url": data["controlVideoUrl"],
            "control_strength": float(data.get("controlStrength") or 1.0)} if data.get("controlVideoUrl") else {}),
        # Send the prompt exactly as written: a plain instruction ("Replace only ... in <Video 1> with ... <Picture 1>"),
        # which a LoRA trained on such prompts needs, is otherwise wrapped into the structured template.
        **({"raw_prompt": True} if data.get("rawPrompt") else {}),
        # Style LoRAs of the edit (the node's multi-select, stacked in order), strength per LoRA from styleLoraStrengths.
        **({"style_loras": [{"name": n, "strength": float((data.get("styleLoraStrengths") or {}).get(n, 1.0))}
                            for n in data["styleLoras"] if isinstance(n, str)]} if data.get("styleLoras") else {}),
        "fps": 24,
    }
    # editWindowEnabled: edit only reshotStartSeconds..+reshotDurationSeconds of the
    # source. The window is edited from its own frames (a padded piece of the source
    # goes through the ordinary edit) and spliced back over the original, whose
    # audio is kept -- unlike temporal_reshot, which redraws the window from noise.
    endpoint = "/generate-video-edit"
    edit_window = None
    if mode == "edit" and str(data.get("editWindowEnabled") or "").lower() in ("1", "true", "yes", "on"):
        edit_window = {
            "start_frame": max(0, int(round(float(data.get("reshotStartSeconds") or 0) * 24))),
            "frame_count": max(1, int(round(float(data.get("reshotDurationSeconds") or 3) * 24))),
        }
        # A window that crosses a cut rewrites the next shot too. The backend pads a
        # short window to an H3 length by itself, so the window should end at the cut;
        # editWindowAllowCut overrides when the edit is meant to span it.
        if source_videos and str(data.get("editWindowAllowCut") or "").lower() not in ("1", "true", "yes", "on"):
            cuts = _cuts_in_window(source_videos[0], edit_window["start_frame"], edit_window["frame_count"])
            if cuts:
                first = cuts[0]
                raise ValueError(
                    f"edit window frames {edit_window['start_frame']}..{edit_window['start_frame'] + edit_window['frame_count']} "
                    f"crosses a shot cut at frame {first}; frames after it would be rewritten. "
                    f"Set reshotDurationSeconds to {(first - edit_window['start_frame']) / 24:.3f} "
                    f"({first - edit_window['start_frame']} frames) -- the backend pads short windows itself -- "
                    f"or set editWindowAllowCut=true if the edit is meant to span the cut.")
        payload.update(edit_window)
        endpoint = "/generate-video-edit-window"
    # A continuation sends only the tail of its source (the last shot, or
    # continueTailSeconds from the end) unless continueFullSource is set: the
    # whole clip as <Video 1> is what made continuations slow.
    continue_tail = None
    if mode == "continuation" and str(data.get("continueFullSource") or "").lower() not in ("1", "true", "yes", "on"):
        continue_tail = {"tail_frames": max(0, int(round(float(data.get("continueTailSeconds") or 0) * 24)))}
        payload.update(continue_tail)
        endpoint = "/generate-video-continue-tail"
    submitted = _request("POST", endpoint, json=payload,
                         project_id=resolved["id"])
    revision = _save_node_data(resolved["id"], node_id, {
        "status": "generating",
        "jobId": submitted["job_id"],
        "error": None,
        "compiledPrompt": None,
        "submittedResources": None,
    }, canvas)
    return {
        "project_id": resolved["id"],
        "project_name": resolved["name"],
        "node_id": node_id,
        "job_id": submitted["job_id"],
        "status": submitted.get("status", "queued"),
        "revision": revision,
        "mode": payload["mode"],
        "edit_window": edit_window,
        "continue_tail": continue_tail,
        "motion_preset": payload["motion_preset"],
        "input_counts": {
            "source_video": len(source_videos),
            "first_frame": 1 if payload["image_url"] else 0,
            "last_frame": 1 if payload["last_frame_url"] else 0,
            "images": len(payload["ref_image_urls"]),
            "audios": len(payload["ref_audio_urls"]),
        },
    }


def _run_locked(resolved: dict[str, Any], node_id: str, prompt_source: str = "",
                audio_redo: dict[str, Any] | None = None, seed: int | None = None) -> dict[str, Any]:
    canvas = _canvas(resolved["id"])
    node = _find_node(canvas["nodes"], node_id)
    if node.get("type") == "videoUpscale":
        return _run_upscale_locked(resolved, canvas, node)
    if node.get("type") == "videoTrim":
        return _run_trim_locked(resolved, canvas, node)
    if node.get("type") == "depthVideo":
        return _run_depth_video_locked(resolved, canvas, node)
    if node.get("type") == "charswap":
        return _run_charswap_locked(resolved, canvas, node)
    if node.get("type") == "videoReangle":
        return _run_reangle_locked(resolved, canvas, node)
    if node.get("type") == "audioRefine":
        return _run_audio_refine_locked(resolved, canvas, node)
    if node.get("type") == "characterSheet":
        return _run_character_sheet_locked(resolved, canvas, node)
    if node.get("type") == "qwenImage":
        return _run_qwen_image_locked(resolved, canvas, node)
    if node.get("type") == "gaussian":
        return _run_gaussian_locked(resolved, canvas, node)
    if node.get("type") in EDIT_TYPES:
        return _run_video_edit_locked(resolved, canvas, node)
    if node.get("type") == "audioGen":
        return _run_audio_gen_locked(resolved, canvas, node)
    if node.get("type") != "video":
        raise ValueError("run_canvas_node supports video, the edit nodes, videoUpscale, videoTrim, depthVideo, charswap, videoReangle, audioRefine, characterSheet, qwenImage, gaussian and audioGen "
                         f"nodes, got {node.get('type')!r}.")
    data = node.setdefault("data", {})
    if data.get("status") == "generating" and data.get("jobId"):
        return {"project_id": resolved["id"], "node_id": node_id,
                "job_id": data["jobId"], "status": "already_generating"}

    # A node bound to a prompt file must run what the file says, or ComfyUI sees
    # the previous graph and hands back the previous clip (2026-09-09). Edits made
    # through apply_canvas_operations are written back to the file, so the two
    # differ only when one side was edited behind the other's back: the file on
    # this machine, or the node from the studio. Neither may silently win -- the
    # sync used to overwrite the node, which threw away a cloud session's edit
    # (2026-09-26) -- so the run stops and asks: prompt_source="file" runs the
    # file (the node's text kept in promptBeforeSync), "node" writes the node's
    # text to the file and runs that.
    prompt_synced = None
    prompt_file = str(data.get("promptFile") or "").strip()
    if prompt_file:
        try:
            on_disk = _read_text_file(prompt_file).strip()
        except ValueError:
            on_disk = ""                # the file moved; run with what the node holds
        held = str(data.get("prompt", "")).strip()
        if on_disk and on_disk != held:
            if prompt_source == "file":
                data["prompt"] = on_disk
                data["promptBeforeSync"] = held
                _save_node_data(resolved["id"], node_id,
                                {"prompt": on_disk, "promptBeforeSync": held}, canvas)
                prompt_synced = prompt_file
            elif prompt_source == "node":
                warning = _write_prompt_file(prompt_file, held)
                prompt_synced = f"{prompt_file} <- node" + (f" ({warning})" if warning else "")
            else:
                raise ValueError(
                    f"Node {node_id}'s prompt ({len(held)} chars) differs from its file {prompt_file} "
                    f"({len(on_disk)} chars). Run again with prompt_source=\"node\" to write the "
                    f"node's text to the file and run it, or prompt_source=\"file\" to run the file.")

    prompt_nodes = _incoming_nodes(canvas, node_id, "in-prompt")
    prompt = " ".join(
        str((source.get("data") or {}).get("text", "")).strip()
        for source in prompt_nodes
        if str((source.get("data") or {}).get("text", "")).strip()
    ) or str(data.get("prompt", "")).strip()
    if not prompt:
        raise ValueError(f"Video node {node_id} has no prompt input.")

    def urls(handle: str) -> list[str]:
        values = [_node_url(source) for source in _incoming_nodes(canvas, node_id, handle)]
        missing = [source.get("id") for source in _incoming_nodes(canvas, node_id, handle)
                   if not _node_url(source)]
        if missing:
            raise ValueError(f"Node {node_id} has unfinished inputs on {handle}: {', '.join(missing)}")
        return [value for value in values if value]

    # The canvas feeds a first frame on "in-image"; without it the backend falls
    # back to t2va and the frame is silently dropped, which looks exactly like a
    # first-frame anchor that failed to take.
    first_frames = urls("in-image")
    # Every image on "in-last-frame" is a guide frame, pinned through its own
    # MiniMaxH3AddGuide. data.guideFrameIndexes[i] is the pixel frame for the
    # i-th wired image (edge order); missing entries fall back to the older
    # single data.guideFrameIndex, then to -1 (the clip's last frame).
    guide_urls = urls("in-last-frame")
    guide_indexes = list(data.get("guideFrameIndexes") or [])
    fallback_index = int(data.get("guideFrameIndex", -1))
    guide_frames = [{"url": u, "frame_index": int(guide_indexes[i]) if i < len(guide_indexes)
                     and guide_indexes[i] is not None else fallback_index}
                    for i, u in enumerate(guide_urls)]
    payload = {
        "prompt": prompt,
        # Optional explicit route override for controlled A/B tests.  The backend
        # otherwise infers ref2va whenever reference assets are wired, which
        # makes it impossible to test a T2VA prompt that still names Picture
        # references.  Keep inference as the default for every existing node.
        "mode": data.get("generationMode") or None,
        "image_url": first_frames[0] if first_frames else None,
        "guide_frames": guide_frames,
        "guide_frames_delivered": bool(data.get("guideFramesDelivered")),
        # 钉住末帧: re-run on the ending the next chain already continues from.
        "pin_last_frame_of": _pinned_frame_source(data),
        "ref_image_urls": urls("in-ref-image"),
        "ref_audio_urls": urls("in-ref-audio"),
        # With useRefVideoAsControl the clip on in-ref-video drives the camera
        # through Fun ControlNet instead of being read as a soft reference, and
        # it must not also be mounted as one: that is the same grey box in two
        # roles at two fidelities, which is the failure the one-authority rule
        # is about.
        "ref_video_urls": ([] if data.get("useRefVideoAsControl")
                           or data.get("useRefVideoAsGuide")
                           else urls("in-ref-video")),
        # A chained segment renders at the size of the clip it continues: the latent
        # cannot be resized, and a node's own size has been overwritten from a wired
        # reference image's pixels (1248x832 from a character sheet, 2026-09-24).
        "width": _chain_size(canvas, node_id)[0] or int(data.get("width") or DEFAULT_WIDTH),
        "height": _chain_size(canvas, node_id)[1] or int(data.get("height") or DEFAULT_HEIGHT),
        # 4 is the preview tier; a node that never had steps set renders at the
        # production default, not at preview.
        "steps": int(data.get("steps") or DEFAULT_H3_STEPS),
        "length": int(data.get("length") or 124),
        "seed": int(data.get("seed") if data.get("seed") is not None else 81000),
        "motion_preset": data.get("motionPreset") or DEFAULT_MOTION_PRESET,
        # 'turbo8' (backend default) 8 steps, 'taomate3' 3, 'none' 20; overrides "steps".
        **({"accel_lora": data["accelLora"]} if data.get("accelLora") else {}),
        "shift_video": float(data.get("shiftVideo") or 12.0),
        # Style LoRAs (not the turbo one): the node's multi-select, stacked in
        # order; none unless the node lists some.
        # Strength per LoRA from data.styleLoraStrengths (name -> strength), 1.0 if unset.
        "style_loras": [({"name": s, "strength": float((data.get("styleLoraStrengths") or {}).get(s, 1.0))}
                         if isinstance(s, str) else s)
                        for s in (data.get("styleLoras") or []) if s],
        "ref_image_size": data.get("refImageSize") or "match",
        # Continuation: the clip this one carries on from. Wiring that clip's
        # node into "in-motion-context" is the canvas way to say it -- the chain
        # is then visible as a line and re-rendering the earlier clip feeds the
        # later one its new latent by itself. data.motionContextLatent stays as
        # the manual override for a latent that has no node.
        "motion_context_latent": (data.get("motionContextLatent")
                                  or _chain_carry(canvas, node_id)[0] or ""),
        "motion_context_video": (data.get("motionContextVideo")
                                 or _chain_carry(canvas, node_id)[1] or ""),
        "motion_context_end_frame": _chain_end_frame(canvas, node_id),
        "motion_context_length": int(data.get("motionContextLength") or 22),
        "motion_context_audio": int(data.get("motionContextAudio") or 24),
        # A node that sets chunkFrames renders long in short pieces, chained.
        "chunk_frames": int(data.get("chunkFrames") or 0),
        # The grey box on "in-control-video" drives the camera frame for frame.
        "control_video_url": (urls("in-ref-video")[0] if data.get("useRefVideoAsControl") else None),
        "guide_video_url": (urls("in-ref-video")[0] if data.get("useRefVideoAsGuide") else None),
        "control_strength": float(data.get("controlStrength") or 1.0),
        # Core BlockSparseAttention (sol-attn) before the guider; off unless the
        # node sets data.blockSparse. Bedroom c12, 313 f: 322 s -> 256 s, same
        # composition, small props re-rolled (2026-09-23).
        "block_sparse": bool(data.get("blockSparse")),
        # Audio locks ride in the payload only when the node has some, so the
        # fingerprint of every other node is unchanged by this field existing.
        **({"audio_locks": _audio_lock_entries(canvas, data),
            "audio_lock_feather": float(data.get("audioLockFeather") or 0.0)}
           if data.get("audioLocks") else {}),
    }
    # Attention patch: "sol" (default, fastest here) or "kjsage" (the
    # memory-efficient SageAttention patch, lower peak VRAM, slower). Set
    # data.accel on the node to choose; unset keeps the backend default.
    if data.get("accel"):
        payload["sage"] = _attention_for_preset(payload["motion_preset"], str(data["accel"]))
    # What the previous run of this node submitted. If this run submits the same
    # prompt with the same seed, ComfyUI hands back the cached clip in seconds
    # and the node looks re-rendered when nothing was re-sampled; say so at
    # submit time rather than letting it pass as a result (2026-09-09).
    # Compare the whole submission, not just the prompt: a run with the same text
    # but a new length, seed or reference is a real re-sample (2026-09-14 the
    # prompt-only check warned on a 241 -> 193 frame change).
    prompt_stripped: list[str] = []
    if payload.get("audio_locks"):
        # A locked line the prompt also has the model speak comes out twice
        # (2026-10-01). The backend checks again; refusing here saves the queue wait.
        import audio_lock
        if audio_redo:
            # Redoing the sound keeps the picture, so the prompt only conditions the new sound:
            # use the node's own lock-pass prompt when it names one, else cut the clauses that
            # speak a locked line out of the prompt (and say what was cut).
            lock_file = str(data.get("lockPassPromptFile") or "").strip()
            if lock_file:
                prompt = _read_text_file(lock_file).strip()
            else:
                prompt, prompt_stripped = audio_lock.strip_locked_lines(
                    prompt, [audio_lock.LockSpec(path=Path(e["url"]), at=e["at"], text=e["text"])
                             for e in payload["audio_locks"]])
            payload["prompt"] = prompt
        doubled = audio_lock.locked_lines_in_prompt(
            prompt, [audio_lock.LockSpec(path=Path(e["url"]), at=e["at"], text=e["text"])
                     for e in payload["audio_locks"]])
        if doubled:
            raise ValueError(
                f"Node {node_id}: the prompt has these locked lines as <d>: {'; '.join(doubled)}. "
                "The model would say them again outside the lock. Take them out of the prompt.")
    if audio_redo:
        # Redo only the sound of this node's last take: its saved latent, picture frozen
        # (see backend/audio_redo.py). The latent only fits the take that saved it.
        latent = data.get("latentFilename")
        if not latent:
            raise ValueError(
                f"Node {node_id} has no saved latent to redo the sound of. A clip that was edited, trimmed "
                "or adopted from disk has none; render the node first.")
        if payload.get("chunk_frames"):
            raise ValueError(f"Node {node_id}: redoing audio is not supported with chunkFrames.")
        took = ((data.get("takes") or [{}])[0] or {}).get("length")
        if took and int(took) != int(payload["length"]):
            raise ValueError(
                f"Node {node_id}: length is {payload['length']} but its last take was {took} frames, "
                "and the saved latent only fits that take.")
        payload["audio_redo"] = audio_redo
        payload["refine_latent"] = latent
        if seed is not None:
            payload["seed"] = int(seed)
    fingerprint = hashlib.sha1(json.dumps(payload, sort_keys=True, default=str).encode("utf-8")).hexdigest()
    previous = data.get("compiledPrompt") or (
        (data.get("takes") or [{}])[0].get("prompt") if data.get("takes") else None)
    cache_warning = None
    if data.get("generatedUrl"):
        if data.get("submittedFingerprint"):
            if data["submittedFingerprint"] == fingerprint:
                cache_warning = ("identical submission to this node's last clip (prompt, seed, length, "
                                 "references and settings): ComfyUI will return the cached result")
        elif previous and str(previous).strip() == prompt.strip():
            cache_warning = ("same prompt as this node's last clip; its other inputs were not recorded, "
                             "so a cached result is possible if nothing else changed")
    submitted = _request("POST", "/generate-video", json=payload, project_id=resolved["id"])
    revision = _save_node_data(resolved["id"], node_id, {
        "status": "generating",
        "jobId": submitted["job_id"],
        "error": None,
        "compiledPrompt": None,
        "submittedResources": None,
        "submittedFingerprint": fingerprint,
        "pendingTake": _take_submit_snapshot(canvas, node_id, data),
    }, canvas)
    return {
        "project_id": resolved["id"],
        "project_name": resolved["name"],
        "node_id": node_id,
        "job_id": submitted["job_id"],
        "status": submitted.get("status", "queued"),
        "revision": revision,
        **({"prompt_synced_from": prompt_synced} if prompt_synced else {}),
        **({"cache_warning": cache_warning} if cache_warning else {}),
        "motion_preset": payload["motion_preset"],
        "generation_mode": payload.get("mode") or "auto",
        "shift_video": payload["shift_video"],
        "input_counts": {
            "first_frame": 1 if payload.get("image_url") else 0,
            "images": len(payload["ref_image_urls"]),
            "videos": len(payload["ref_video_urls"]),
            "audios": len(payload["ref_audio_urls"]),
            "guide_frames": len(payload["guide_frames"]),
        },
        # The pinned images in edge order with the frame each is pinned to (generation
        # frames, i.e. including the context overlap), so a run can be checked against
        # what was meant instead of inferred from a count.
        "guide_frames": [{"image": g["url"], "frame_index": g["frame_index"]}
                         for g in payload["guide_frames"]],
        **({"guide_warning": f"{len(payload['guide_frames'])} guide images wired but "
                             f"guideFrameIndexes has {len(guide_indexes)} entries; the rest use "
                             f"guideFrameIndex ({fallback_index})"}
           if len(payload["guide_frames"]) > len(guide_indexes) else {}),
        **({"prompt_stripped": prompt_stripped} if prompt_stripped else {}),
    }


def _run_character_sheet_locked(resolved: dict[str, Any], canvas: dict[str, Any],
                                node: dict[str, Any]) -> dict[str, Any]:
    """Start a 定妆照 node: POST /generate-character-sheet from its fields and wiring."""
    node_id = node["id"]
    data = node.setdefault("data", {})
    if data.get("status") == "generating" and data.get("jobId"):
        return {"project_id": resolved["id"], "node_id": node_id,
                "job_id": data["jobId"], "status": "already_generating"}
    identity = str(data.get("identity") or "").strip()
    costume = str(data.get("costume") or "").strip()
    if not identity or not costume:
        raise ValueError(f"characterSheet node {node_id} needs both identity and costume.")
    faces = _incoming_nodes(canvas, node_id, "in-face")
    descriptions = data.get("propDescriptions") or {}
    props = []
    for source in _incoming_nodes(canvas, node_id, "in-prop"):
        url = _node_url(source)
        text = str(descriptions.get(source.get("id")) or "").strip()
        if not url or not text:
            raise ValueError(f"characterSheet node {node_id}: prop {source.get('id')} needs a file "
                             "and a line in data.propDescriptions keyed by its node id.")
        props.append({"image_url": url, "description": text})
    payload = {
        "identity": identity,
        "costume": costume,
        "subject_noun": data.get("subjectNoun") or "person",
        "face_image_url": _node_url(faces[0]) if faces else None,
        "props": props,
        "width": int(data.get("width") or 768),
        "height": int(data.get("height") or 1376),
        "steps": int(data.get("steps") or 4),
        "seed": int(data.get("seed") if data.get("seed") is not None else 81000),
        # Qwen-Image-2.1 by default: full front / full back / waist-up front.
        "engine": data.get("engine") or "qwen",
        # A derived sheet starts from the approved one on in-base (Qwen route).
        "base_sheet_url": (_node_url(bases[0]) if (bases := _incoming_nodes(canvas, node_id, "in-base")) else None),
        "qwen_steps": int(data.get("qwenSteps") or 25),
    }
    submitted = _request("POST", "/generate-character-sheet", json=payload, project_id=resolved["id"])
    revision = _save_node_data(resolved["id"], node_id, {
        "status": "generating", "jobId": submitted["job_id"], "error": None,
    }, canvas)
    return {"project_id": resolved["id"], "project_name": resolved["name"], "node_id": node_id,
            "job_id": submitted["job_id"], "status": submitted.get("status", "queued"),
            "revision": revision, "input_counts": {"face": len(faces), "props": len(props)}}


def _run_qwen_image_locked(resolved: dict[str, Any], canvas: dict[str, Any],
                           node: dict[str, Any]) -> dict[str, Any]:
    """Start a 生成图片 node: POST /generate-qwen-image from its fields and wiring.

    The references go over in **canvas edge order**, because that order is what the
    prompt means by `<image 1>`, `<image 2>` ... Check `input_counts` after calling:
    a reference that never arrived is a prompt pointing at nothing.
    """
    node_id = node["id"]
    data = node.setdefault("data", {})
    if data.get("status") == "generating" and data.get("jobId"):
        return {"project_id": resolved["id"], "node_id": node_id,
                "job_id": data["jobId"], "status": "already_generating"}

    # Same rule as the video runner: a committed prompt file is the record, so it
    # is re-read here rather than trusting the copy the node took when it was written.
    prompt_synced = None
    prompt_file = str(data.get("promptFile") or "").strip()
    if prompt_file:
        try:
            on_disk = _read_text_file(prompt_file).strip()
        except ValueError:
            on_disk = ""
        if on_disk and on_disk != str(data.get("prompt", "")).strip():
            before = data.get("prompt")
            data["prompt"] = on_disk
            _save_node_data(resolved["id"], node_id,
                            {"prompt": on_disk, "promptBeforeSync": before}, canvas)
            prompt_synced = prompt_file

    prompt = str(data.get("prompt", "")).strip()
    if not prompt:
        raise ValueError(f"qwenImage node {node_id} has no prompt.")

    sources = _incoming_nodes(canvas, node_id, "in-ref")
    refs = []
    for source in sources:
        url = _node_url(source)
        if not url:
            raise ValueError(f"qwenImage node {node_id}: reference {source.get('id')} "
                             "has no file yet.")
        refs.append(url)
    if len(refs) > 10:
        raise ValueError(f"qwenImage node {node_id} has {len(refs)} references; the model takes 10.")

    payload = {
        "prompt": prompt,
        "reference_urls": refs,
        "negative_prompt": str(data.get("negativePrompt") or ""),
        "width": int(data.get("width") or 1376),
        "height": int(data.get("height") or 768),
        "steps": int(data.get("steps") or 25),
        "cfg": float(data.get("cfg") if data.get("cfg") is not None else 1.0),
        "seed": int(data.get("seed") if data.get("seed") is not None else 81000),
        "base_model": str(data.get("baseModel") or "qwen21"),
        # references are worked at about refResolution^2 pixels; 0 keeps the first one at its own size
        "ref_resolution": int(data.get("refResolution") if data.get("refResolution") is not None else 1024),
        # "turbo" (default): the Viggle distilled LoRA, 7 steps; "base": the 25-step graph at steps/cfg.
        # The backend runs base by itself for anyAngle and noctAnime and when ComfyUI lacks the nodes.
        "speed": "base" if data.get("speed") == "base" else "turbo",
    }
    if payload["base_model"] == "noctAnime":
        payload["cfg"] = 3.0  # the checkpoint's own workflow; same as QwenImageNode.tsx
    if data.get("anyAngle"):
        # Same as the studio's 换机位 switch (QwenImageNode.tsx): LoRA 1.0, cfg 3.
        if len(refs) != 2:
            raise ValueError(f"qwenImage node {node_id} is set to anyAngle and needs exactly two "
                             f"references (<image 1> the original, <image 2> the new view); "
                             f"it has {len(refs)}.")
        payload.update({"lora_name": ANY_ANGLE_LORA, "lora_strength": 1.0, "cfg": 3.0})
    submitted = _request("POST", "/generate-qwen-image", json=payload, project_id=resolved["id"])
    revision = _save_node_data(resolved["id"], node_id, {
        "status": "generating", "jobId": submitted["job_id"], "error": None,
    }, canvas)
    turbo_planned = (payload["speed"] == "turbo" and payload["base_model"] == "qwen21"
                     and not payload.get("lora_name"))
    result = {"project_id": resolved["id"], "project_name": resolved["name"], "node_id": node_id,
              "job_id": submitted["job_id"], "status": submitted.get("status", "queued"),
              "revision": revision, "input_counts": {"references": len(refs)},
              "route": "any_angle" if data.get("anyAngle") else "edit" if refs else "text_to_image",
              # what was asked for; the finished job's `speed` is what actually ran
              "speed_requested": "turbo (7 steps, no cfg/negative)" if turbo_planned else "base (25 steps)"}
    if prompt_synced:
        result["prompt_synced_from"] = prompt_synced
    return result


ANY_ANGLE_LORA = "QI2.1_AnyAngle.safetensors"

# How many versions a node keeps. Twelve pushed the director's accepted take out of the list
# after a day of iterating (2026-09-30, s2-c5); the studio's own cap is the same number.
MAX_TAKES = 200


def _run_gaussian_locked(resolved: dict[str, Any], canvas: dict[str, Any],
                         node: dict[str, Any]) -> dict[str, Any]:
    """Start a 高斯模型 node from the picture on its in-image edge.

    engine "flashworld" queues POST /generate-world-gaussian and keeps the job in
    data.worldJobId (refresh_canvas_node moves the finished ply into plyUrl);
    engine "sharp" runs POST /generate-gaussian-model, which answers directly.
    """
    node_id = node["id"]
    data = node.setdefault("data", {})
    if data.get("worldJobId"):
        return {"project_id": resolved["id"], "node_id": node_id,
                "job_id": data["worldJobId"], "status": "already_generating"}
    sources = _incoming_nodes(canvas, node_id, "in-image")
    if not sources or not _node_url(sources[0]):
        raise ValueError(f"gaussian node {node_id} needs a finished picture on in-image.")
    image_url = _node_url(sources[0])
    if (data.get("engine") or "sharp") == "flashworld":
        trajectory = data.get("worldTrajectory") or "ring"
        submitted = _request("POST", "/generate-world-gaussian", json={
            "image_url": image_url, "prompt": str(data.get("worldPrompt") or ""),
            "trajectory": trajectory}, project_id=resolved["id"])
        revision = _save_node_data(resolved["id"], node_id, {
            "status": "loading", "worldJobId": submitted["job_id"], "error": None,
            "sourceImageUrl": image_url, "plyUrl": None, "generatedUrl": None}, canvas)
        return {"project_id": resolved["id"], "node_id": node_id, "job_id": submitted["job_id"],
                "status": submitted.get("status", "queued"), "revision": revision,
                "route": f"flashworld:{trajectory}"}
    result = _request("POST", "/generate-gaussian-model", json={"image_url": image_url},
                      project_id=resolved["id"])
    revision = _save_node_data(resolved["id"], node_id, {
        "status": "loading", "plyUrl": result["url"], "plyFilename": result["filename"],
        "plyOriginalName": result.get("original_name"), "sourceImageUrl": image_url,
        "error": None}, canvas)
    return {"project_id": resolved["id"], "node_id": node_id, "status": "done",
            "url": result["url"], "revision": revision, "route": "sharp"}


def _charswap_inputs(canvas: dict[str, Any], node_id: str, handle: str, what: str) -> list[str]:
    """The file URLs wired into one of a charswap node's ports, in edge order (at least one)."""
    sources = _incoming_nodes(canvas, node_id, handle)
    if not sources:
        raise ValueError(f"Charswap node {node_id} needs a {what} on {handle}, has none.")
    urls = []
    for source in sources:
        url = _node_url(source)
        if not url:
            raise ValueError(f"Charswap node {node_id}: {what} {source.get('id')} has no file yet.")
        urls.append(url)
    return urls


def _charswap_input(canvas: dict[str, Any], node_id: str, handle: str, what: str) -> str:
    """The file URL wired into one of a charswap node's ports, which must hold exactly one."""
    urls = _charswap_inputs(canvas, node_id, handle, what)
    if len(urls) != 1:
        raise ValueError(f"Charswap node {node_id} needs exactly one {what} on "
                         f"{handle}, has {len(urls)}.")
    return urls[0]


def _charswap_targets(data: dict[str, Any], photos: list[str]) -> list[dict[str, Any]]:
    """The people a person-mode swap replaces: point i of the node (swapTargets, 0-1 on the frame at
    faceFrameSeconds) with photo i, in the order the photos are wired. Several photos with no points
    have no way to say who is who, so that is refused; more photos than points leaves the extras out."""
    points = [p for p in (data.get("swapTargets") or [])
              if isinstance(p, dict) and all(isinstance(p.get(k), (int, float)) and 0 <= p[k] <= 1 for k in ("x", "y"))][:4]
    if not points:
        if len(photos) > 1:
            raise ValueError(f"{len(photos)} photos are wired in but no person is pointed at: set swapTargets "
                             "(points on the frame at faceFrameSeconds, one per photo) or wire one photo.")
        return []
    return [{"x": float(p["x"]), "y": float(p["y"]), "image_url": photos[i]}
            for i, p in enumerate(points[:len(photos)])]


@_tool
def inspect_charswap_inputs(project: str, node_id: str, scene: str = "") -> dict[str, Any]:
    """Look at a 换人 · Viggle node's two inputs before running it (about 10 s, no GPU render).

    Returns where the clip's best face frame is (best_frame_seconds: largest and most frontal
    face, what face mode repaints when no time is set), how big the face in the photo is, and
    `warnings` for what is likely to go wrong: a clip that opens on the back of a head, no face
    at all, a face too small, a photo face that will be cropped, a clip longer than one pass.
    `survey` has the per-frame face size and head turn. It cannot say whether the swap will
    succeed; it only reports what can be measured. swapMode is person (换人: the whole person,
    clothes included) or head (换头: the face, hair colour and bangs; the clip's hair length and
    clothes stay). There is no face-only mode, see docs/CHARSWAP.md. Leave facePrompt and
    faceFrameSeconds empty and the backend picks the frame and has a vision model write the
    prompt (the one used is saved on the node as facePromptUsed). To control it yourself, read
    the frame (get_media_frames) and the photo and write facePrompt: who is in the frame, what
    they wear and where, what must stay, what the new hair is and that its length matches the
    clip's. docs/CHARSWAP.md has the measured recipe.
    """
    resolved = _resolve_project(project, scene)
    canvas = _canvas(resolved["id"])
    node = _find_node(canvas["nodes"], node_id)
    if node.get("type") != "charswap":
        raise ValueError(f"{node_id} is a {node.get('type')} node, not a charswap node.")
    report = _request("POST", "/charswap/inspect", json={
        "video_url": _charswap_input(canvas, node_id, "in-video", "driving clip"),
        "character_image_url": _charswap_inputs(canvas, node_id, "in-character", "reference still")[0],
    }, project_id=resolved["id"])
    return {"project_id": resolved["id"], "node_id": node_id,
            "mode": (node.get("data") or {}).get("swapMode") or "person", **report}


def _run_charswap_locked(resolved: dict[str, Any], canvas: dict[str, Any],
                         node: dict[str, Any]) -> dict[str, Any]:
    """Start a 换人 · Viggle node the way the studio does.

    Two inputs, no prompt: `in-video` is the driving clip (blocking, camera, set, everyone
    else) and `in-character` the still that decides who. There is nothing to read off a
    prompt node here -- the route's text encoder is a frozen embedding -- so unlike the
    video runner this one never looks for one.
    """
    node_id = node["id"]
    data = node.setdefault("data", {})
    if data.get("status") == "generating" and data.get("jobId"):
        return {"project_id": resolved["id"], "node_id": node_id,
                "job_id": data["jobId"], "status": "already_generating"}

    photos = _charswap_inputs(canvas, node_id, "in-character", "reference still")
    mode = data.get("swapMode") if data.get("swapMode") in ("head", "reference") else "person"
    targets = _charswap_targets(data, photos) if mode == "person" else []
    if mode != "person" and len(photos) > 1:
        raise ValueError(f"Charswap node {node_id}: {mode} mode takes exactly one picture on in-character, "
                         f"has {len(photos)}.")
    frame_seconds = float(data.get("faceFrameSeconds") if data.get("faceFrameSeconds") is not None else -1)
    h3 = data.get("swapEngine") == "h3"
    if h3:
        # MiniMax-H3's own edit instead of Viggle (with the Character-Swap LoRA): the whole person; the standard 8-step
        # speed LoRA at the clip's own size unless the node says otherwise (TaoMate adds people that are not in the clip
        # when the swap LoRA is on; docs/CHARSWAP.md has the timings).
        accel, size = data.get("h3Accel") or "turbo8", data.get("h3Size") or "source"
        if mode != "person":
            raise ValueError(f"Charswap node {node_id}: the H3 engine swaps the whole person: swapMode person.")
        pose = data.get("swapPose") or "auto"
        if pose not in ("auto", "follow", "upright"):
            raise ValueError(f"Charswap node {node_id}: swapPose is auto, follow or upright, got {pose!r}.")
        if accel not in ("taomate3", "turbo8") or size not in ("source", "small"):
            raise ValueError(f"Charswap node {node_id}: h3Accel is taomate3 or turbo8 and h3Size source or small, "
                             f"got {accel!r} and {size!r}.")

    payload = {
        "video_url": _charswap_input(canvas, node_id, "in-video", "driving clip"),
        "character_image_url": photos[0],
        # 0 lets the backend read the clip's own frame count; a cap above it mosaics.
        "length": int(data.get("length") or 0),
        "seed": int(data.get("seed") if data.get("seed") is not None else 95051),
        "megapixels": float(data.get("megapixels") or 0.8),
        # person and head repaint one frame of the clip with the photo's person and use that as the
        # reference (negative seconds = the clip's most frontal face); reference sends the picture
        # to Viggle as it is. With targets the frame is the one the points were made on.
        "mode": mode,
        "face_prompt": str(data.get("facePrompt") or ""),
        "face_frame_seconds": max(frame_seconds, 0.0) if targets else frame_seconds,
        **({"targets": targets} if targets else {}),
        **({"engine": "h3", "h3_accel": accel, "h3_size": size, "pose": pose} if h3 else {}),
    }
    submitted = _request("POST", "/charswap", json=payload, project_id=resolved["id"])
    revision = _save_node_data(resolved["id"], node_id, {
        "status": "generating", "jobId": submitted["job_id"], "error": None,
    }, canvas)
    return {
        "project_id": resolved["id"], "project_name": resolved["name"], "node_id": node_id,
        "job_id": submitted["job_id"], "status": submitted.get("status", "queued"),
        "revision": revision, "megapixels": payload["megapixels"], "seed": payload["seed"],
        "mode": payload["mode"], "engine": payload.get("engine", "viggle"),
    }


def _run_reangle_locked(resolved: dict[str, Any], canvas: dict[str, Any],
                        node: dict[str, Any]) -> dict[str, Any]:
    """Start a 换机位 · CrossView node (POST /reangle).

    `in-video` is the accepted clip to re-angle; `in-ref-image` edges, in canvas
    order, are optional appearance references for what the new camera reveals.
    """
    node_id = node["id"]
    data = node.setdefault("data", {})
    if data.get("status") == "generating" and data.get("jobId"):
        return {"project_id": resolved["id"], "node_id": node_id,
                "job_id": data["jobId"], "status": "already_generating"}
    sources = _incoming_nodes(canvas, node_id, "in-video")
    if len(sources) != 1:
        raise ValueError(f"videoReangle node {node_id} needs exactly one clip on in-video, has {len(sources)}.")
    video_url = _node_url(sources[0])
    if not video_url:
        raise ValueError(f"videoReangle node {node_id}: clip {sources[0].get('id')} has no file yet.")
    refs = []
    for src in _incoming_nodes(canvas, node_id, "in-ref-image"):
        url = _node_url(src)
        if not url:
            raise ValueError(f"videoReangle node {node_id}: reference {src.get('id')} has no file yet.")
        refs.append(url)
    keyframes = data.get("keyframes") or []
    if isinstance(keyframes, str):
        keyframes = json.loads(keyframes) if keyframes.strip() else []
    payload = {
        "video_url": video_url,
        "start_frame": int(data.get("startFrame") or 0),
        "length": int(data.get("length") or 0),
        "azimuth": float(data.get("azimuth") if data.get("azimuth") is not None else 30.0),
        "elevation": float(data.get("elevation") or 0.0),
        "distance": float(data.get("distance") or 1.0),
        "keyframes": keyframes,
        "ref_image_urls": refs,
        "prompt": data.get("prompt") or "crossview",
        "lora_strength": float(data.get("loraStrength") or 0.8),
        "megapixels": float(data.get("megapixels") or 0.5),
        "steps": int(data.get("steps") or 8),
        "seed": int(data.get("seed") if data.get("seed") is not None else 81000),
        "keep_source_audio": data.get("keepSourceAudio") is not False,
        # data.pivotZ set = an explicit rotation centre (metres ahead); unset = automatic.
        "pivot": ({"x": float(data.get("pivotX") or 0.0), "y": float(data.get("pivotY") or 0.0),
                   "z": float(data["pivotZ"])} if data.get("pivotZ") not in (None, "") else None),
        "smooth_depth": bool(data.get("smoothDepth")),
        "keep_source_aim": data.get("keepSourceAim") is not False,
    }
    submitted = _request("POST", "/reangle", json=payload, project_id=resolved["id"])
    revision = _save_node_data(resolved["id"], node_id, {
        "status": "generating", "jobId": submitted["job_id"], "error": None,
        # What this run asked for, so the take records the camera, not just the seed.
        "pendingTake": {"params": {k: payload[k] for k in (
            "start_frame", "length", "azimuth", "elevation", "distance", "keyframes",
            "prompt", "lora_strength", "megapixels", "steps", "seed")},
            "inputs": [video_url, *refs]},
    }, canvas)
    return {
        "project_id": resolved["id"], "project_name": resolved["name"], "node_id": node_id,
        "job_id": submitted["job_id"], "status": submitted.get("status", "queued"),
        "revision": revision, "seed": payload["seed"], "input_counts": {"in-video": 1, "in-ref-image": len(refs)},
    }


def _h3_source_of(canvas: dict[str, Any], node: dict[str, Any]) -> dict[str, Any] | None:
    """The H3 video node that made the clip `node` shows, found by walking in-video edges upstream
    through edits, trims, upscales and other refines (the reverse of _hd_source), or None."""
    by_id = {n.get("id"): n for n in canvas.get("nodes", [])}
    seen: set[str] = set()
    cur = node
    while cur is not None and cur.get("id") not in seen:
        if cur.get("type") == "video":
            return cur
        seen.add(cur.get("id"))
        cur = next((by_id[e["source"]] for e in canvas.get("edges", [])
                    if e.get("target") == cur.get("id") and e.get("targetHandle") == "in-video"
                    and e.get("source") in by_id), None)
    return None


def _run_audio_refine_locked(resolved: dict[str, Any], canvas: dict[str, Any],
                             node: dict[str, Any]) -> dict[str, Any]:
    """Start a 声音精修 node (POST /audio-refine): the sound of the clip on in-video, redone.

    Conditioning comes from the H3 node upstream unless this node has a prompt of its own; see the
    catalog entry. What the new sound is made against is the prompt and references that made the
    clip -- `compiledPrompt` and `submittedResources`, not the node's next prompt.
    """
    import audio_lock
    node_id = node["id"]
    data = node.setdefault("data", {})
    if data.get("status") == "generating" and data.get("jobId"):
        return {"project_id": resolved["id"], "node_id": node_id,
                "job_id": data["jobId"], "status": "already_generating"}
    sources = _incoming_nodes(canvas, node_id, "in-video")
    if len(sources) != 1:
        raise ValueError(f"audioRefine node {node_id} needs exactly one clip on in-video, has {len(sources)}.")
    video_url = _node_url(sources[0])
    if not video_url:
        raise ValueError(f"audioRefine node {node_id}: clip {sources[0].get('id')} has no file yet.")

    def wired(handle: str) -> list[str]:
        out = []
        for src in _incoming_nodes(canvas, node_id, handle):
            url = _node_url(src)
            if not url:
                raise ValueError(f"audioRefine node {node_id}: {src.get('id')} on {handle} has no file yet.")
            out.append(url)
        return out

    # 含重叠帧: a chained shot is worked from its untrimmed render, so the sound of the overlap with the
    # previous shot is redone too; the node shows the shot alone and keeps the full file as untrimmedUrl.
    src_data = sources[0].get("data") or {}
    overlap = int(src_data.get("contextFrames") or 0)
    untrimmed = src_data.get("untrimmedUrl")
    if overlap > 0 and untrimmed and _take_tag(untrimmed) == _take_tag(video_url):
        video_url = untrimmed
    else:
        overlap = 0

    h3 = _h3_source_of(canvas, sources[0])
    h3d = (h3 or {}).get("data") or {}
    own_prompt = str(data.get("prompt") or "").strip()
    lock_source = data if data.get("audioLocks") else (h3d if not own_prompt else data)
    locks = _audio_lock_entries(canvas, lock_source) if lock_source.get("audioLocks") else []
    feather = float(lock_source.get("audioLockFeather") or 0.0)
    if own_prompt:
        prompt, images, audios, inherited = own_prompt, wired("in-ref-image"), wired("in-ref-audio"), None
    else:
        if h3 is None:
            raise ValueError(f"audioRefine node {node_id} has no H3 video node upstream to take the prompt from; "
                             "write the sound's prompt on this node.")
        prompt = str(h3d.get("compiledPrompt") or "").strip()
        if not prompt or prompt == "(same as prompt)":
            prompt = str(h3d.get("prompt") or "").strip()
        if not prompt:
            raise ValueError(f"audioRefine node {node_id}: {h3.get('id')} has no prompt on record.")
        resources = h3d.get("submittedResources") or {}
        images = [r.get("url") for r in resources.get("reference_images") or [] if isinstance(r, dict) and r.get("url")]
        audios = [r.get("url") for r in resources.get("reference_audios") or [] if isinstance(r, dict) and r.get("url")]
        images += wired("in-ref-image")
        audios += wired("in-ref-audio")
        inherited = h3.get("id")
    stripped: list[str] = []
    if locks:
        specs = [audio_lock.LockSpec(path=Path(e["url"]), at=e["at"], text=e["text"]) for e in locks]
        lock_file = str(data.get("lockPassPromptFile") or "").strip()
        if lock_file:
            prompt = _read_text_file(lock_file).strip()
        else:
            prompt, stripped = audio_lock.strip_locked_lines(prompt, specs)
        doubled = audio_lock.locked_lines_in_prompt(prompt, specs)
        if doubled:
            raise ValueError(f"audioRefine node {node_id}: the prompt has these locked lines as <d>: "
                             f"{'; '.join(doubled)}. Take them out of the prompt.")
    mode = str(data.get("mode") or "polish")
    seed = int(data.get("seed") if data.get("seed") is not None else 81000)
    payload = {
        "video_url": video_url, "prompt": prompt, "ref_image_urls": images, "ref_audio_urls": audios,
        "audio_locks": locks, "audio_lock_feather": feather, "mode": mode,
        "steps": int(data.get("steps") or 0) or None, "denoise": float(data.get("denoise") or 0) or None,
        "seed": seed, "overlap_frames": overlap,
    }
    submitted = _request("POST", "/audio-refine", json=payload, project_id=resolved["id"])
    revision = _save_node_data(resolved["id"], node_id, {
        "status": "generating", "jobId": submitted["job_id"], "error": None,
        "pendingOverlapFrames": overlap,
        "refineInfo": {"inheritedFrom": inherited, "overlapFrames": overlap, "overridden": bool(own_prompt),
                       "images": len(images), "audios": len(audios), "locks": len(locks),
                       "promptStripped": stripped},
        "pendingTake": {"params": {"mode": mode, "steps": payload["steps"], "denoise": payload["denoise"],
                                   "seed": seed}, "inputs": [video_url, *images, *audios]},
    }, canvas)
    downstream = [e["target"] for e in canvas.get("edges", [])
                  if h3 is not None and e.get("source") == h3.get("id") and e.get("targetHandle") == CHAIN_HANDLE]
    return {
        "project_id": resolved["id"], "project_name": resolved["name"], "node_id": node_id,
        "job_id": submitted["job_id"], "status": submitted.get("status", "queued"),
        "revision": revision, "seed": seed, "mode": mode, "inherited_from": inherited,
        "input_counts": {"in-video": 1, "in-ref-image": len(images), "in-ref-audio": len(audios),
                         "audio_locks": len(locks)},
        **({"prompt_stripped": stripped} if stripped else {}),
        # a chained clip carries on from the OLD sound tail of its predecessor until it is re-run
        **({"downstream_not_updated": downstream} if downstream else {}),
    }


def _pinned_frame_source(data: dict[str, Any]) -> str | None:
    """The clip whose last frame a re-run is pinned to (钉末帧), or None when the pin is off.

    The pin records the version it was set on (pinLastFrameOf), so showing another
    version does not move it. A pin saved before that follows the shown version.
    Mirror of frontend/lib/pinnedFrame.ts.
    """
    if not data.get("pinLastFrame"):
        return None
    return data.get("pinLastFrameOf") or data.get("generatedUrl") or None


def _run_audio_gen_locked(resolved: dict[str, Any], canvas: dict[str, Any],
                          node: dict[str, Any]) -> dict[str, Any]:
    """Start a 配音 / 换音色 node the way the studio does (POST /generate-speech)."""
    node_id = node["id"]
    data = node.setdefault("data", {})
    if data.get("status") == "generating" and data.get("jobId"):
        return {"project_id": resolved["id"], "node_id": node_id,
                "job_id": data["jobId"], "status": "already_generating"}

    def one(handle: str) -> str | None:
        sources = _incoming_nodes(canvas, node_id, handle)
        if len(sources) > 1:
            raise ValueError(f"audioGen node {node_id} takes one input on {handle}, has {len(sources)}.")
        if not sources:
            return None
        url = _node_url(sources[0])
        if not url:
            raise ValueError(f"audioGen node {node_id}: {sources[0].get('id')} on {handle} has no file yet.")
        return url

    payload = {
        "mode": data.get("mode") or "speak",
        "text": str(data.get("text") or ""),
        "voice_description": str(data.get("voiceDescription") or ""),
        "delivery": str(data.get("delivery") or ""),
        "ref_audio_url": one("in-ref-audio"),
        "source_audio_url": one("in-source-audio"),
        "length": int(data.get("length") or 0),
        "seed": int(data.get("seed") if data.get("seed") is not None else 81000),
        "trim_silence": bool(data.get("trimSilence", True)),
        "diffusion_steps": int(data.get("diffusionSteps") or 30),
        "semitone_shift": int(data.get("semitoneShift") or 0),
    }
    submitted = _request("POST", "/generate-speech", json=payload, project_id=resolved["id"])
    revision = _save_node_data(resolved["id"], node_id, {
        "status": "generating", "jobId": submitted["job_id"], "error": None,
        "compiledPrompt": None,
    }, canvas)
    return {"project_id": resolved["id"], "project_name": resolved["name"], "node_id": node_id,
            "job_id": submitted["job_id"], "status": submitted.get("status", "queued"),
            "revision": revision, "mode": payload["mode"],
            "input_counts": {"ref_audio": int(bool(payload["ref_audio_url"])),
                             "source_audio": int(bool(payload["source_audio_url"]))}}


_TAKE_TAG = re.compile(r"H3_(?:Video|Chunk|Full|Latent)_([0-9a-f]{8})")


def _take_tag(url: Any) -> str:
    """The 8-hex tag shared by a take's clip, untrimmed file and latent."""
    m = _TAKE_TAG.search(str(url or ""))
    return m.group(1) if m else ""


def _chained_from_tag(data: dict) -> str:
    """Which take of the previous chain the shown take of this node was chained from."""
    shown = data.get("generatedUrl")
    for take in data.get("takes") or []:
        if take.get("url") != shown:
            continue
        for inp in take.get("inputs") or []:
            if inp.get("targetHandle") == "in-motion-context":
                return _take_tag(inp.get("url"))
    return ""


def _run_upscale_locked(resolved: dict[str, Any], canvas: dict[str, Any], node: dict[str, Any]) -> dict[str, Any]:
    """Start a 视频增强 node the way the studio does.

    A reference plate is only as sharp as the frame cut from it, and the
    reference-plate skill makes the latent upscale mandatory before extracting
    stills (2026-09-06, the watch plate). Until now the MCP could not start one,
    which pushed the step back to a direct ComfyUI post -- off the record.

    Same rule as the studio's VideoUpscaleNode: the H3 latent refiner (scaleBy 1.0
    is the same-size LMS sharpening); the output size is the
    source size times data.scaleBy (default 2.0, the factor the 3D latent
    upscaler was trained for).
    """
    node_id = node["id"]
    data = node.setdefault("data", {})
    if data.get("status") == "generating" and data.get("jobId"):
        return {"project_id": resolved["id"], "node_id": node_id,
                "job_id": data["jobId"], "status": "already_generating"}
    sources = _incoming_nodes(canvas, node_id, "in-video")
    if len(sources) != 1:
        raise ValueError(f"Upscale node {node_id} needs exactly one in-video source, has {len(sources)}.")
    source = sources[0]
    src_data = source.get("data") or {}
    video_url = _node_url(source)
    if not video_url:
        raise ValueError(f"Upscale node {node_id}: source {source.get('id')} has no clip yet.")
    latent = src_data.get("latentFilename")
    # 含重叠帧: work from the chained shot's untrimmed render, overlap included.
    overlap = int(src_data.get("contextFrames") or 0)
    untrimmed = src_data.get("untrimmedUrl")
    if not overlap and latent:
        # A chained clip from before the untrimmed file existed: its latent still
        # carries the overlap; the backend counts it (same rule as the studio node).
        try:
            overlap = int(_request("GET", "/check-latent", params={
                "video_url": video_url, "latent_filename": latent}).get("context_frames") or 0)
        except Exception:
            overlap = 0
    # Always on for a chained shot (2026-09-29: shown, not a choice).
    # Without the untrimmed file only the latent refine can keep the overlap.
    with_overlap = bool(overlap > 0 and (untrimmed or latent))
    if with_overlap and untrimmed:
        video_url = untrimmed
    scale_by = float(data.get("scaleBy") or 2.0)
    # A clip with no saved latent (a trim, an edit, an import) is refined the
    # same way: the backend encodes the clip itself (2026-09-29).
    method = "lms" if abs(scale_by - 1.0) < 0.01 else "h3_latent"
    # A shot the latent refine cannot handle (a near-black one grows fixed pink blotches) is enlarged
    # without H3 at all: data.upscaleMethod = "esrgan" (RealESRGAN, deterministic, adds no detail).
    if str(data.get("upscaleMethod") or "").strip().lower() == "esrgan":
        method = "esrgan"
    src_w = int(src_data.get("width") or 1376)
    src_h = int(src_data.get("height") or 768)
    # LMS is a same-size enhancement even when stale dimensions remain on an
    # older node that previously ran at 2x.
    width = src_w if method == "lms" else int(data.get("width") or round(src_w * scale_by))
    height = src_h if method == "lms" else int(data.get("height") or round(src_h * scale_by))
    payload = {
        "video_url": video_url,
        "keep_context": with_overlap,
        # served cut, with the full file as untrimmedUrl (see main._serve_without_overlap)
        "overlap_frames": overlap if with_overlap else 0,
        "width": width,
        "height": height,
        "steps": 8 if method == "lms" else int(data.get("steps") or 4),
        "denoise_strength": float(data.get("denoiseStrength") or (0.38 if method == "h3_latent" else 0.25)),
        "seed": int(data.get("seed") if data.get("seed") is not None else 81000),
        "target_fps": float(data.get("targetFps") or 0.0),
        "length": int(data.get("length") or 0),
        "method": method,
        "latent_filename": latent if method == "h3_latent" else None,
        "scale_by": scale_by,
        # Whole clip in one span unless the node asks for chunking (data.chunkFrames,
        # a multiple of 17). The refine is not batched over time (2026-09-06).
        "temporal_chunk": int(data.get("chunkFrames") or 0),
        # Verbatim sigma list for the refine pass ("0.6, 0" is the default: one step). A very dark shot may
        # need a lower start or more steps; blank keeps the default.
        "manual_sigmas": str(data.get("manualSigmas") or "").strip() or None,
        # Attention patch of the refine pass ("sol" default, "kjsage", or "none"); blank keeps the default.
        "sage": str(data.get("upscaleAccel") or "").strip() or None,
        "spatial_tile": int(data.get("spatialTile") or 0),
    }
    # A chained clip refined on its own invents its own fine detail, so the join to
    # the previous chain's upscale shows (2026-09-16: chain 3 -> 4). An image
    # wired to in-first-frame -- the previous upscale's frame that this clip's latent
    # frame 0 continues from -- is mounted as the frame-0 guide.
    anchors = _incoming_nodes(canvas, node_id, "in-first-frame")
    if method == "h3_latent" and anchors:
        anchor_url = _node_url(anchors[0])
        if anchor_url:
            # the backend takes a ComfyUI input filename; the frame is copied there when extracted
            payload["first_frame"] = Path(anchor_url).name
    # References for the refine pass, which reads them at ref_image_size "max" --
    # for texture, not composition. By default the clip's OWN references come
    # along, read back from what was actually submitted for it, so a refine sees
    # the same character sheets, plates and prop boards the generation saw and
    # sharpens toward them instead of inventing its own detail (2026-09-20:
    # visibly better on a phone screen full of small text).
    #
    # They are not free: "max" means a 2048px short edge each, so three boards add
    # millions of conditioning pixels to a single refine step. data.upscaleRefs
    # picks the trade-off:
    #   "inherit" (default) the source clip's references as it is wired NOW
    #                      (2026-09-29: a board fixed and rewired after the
    #                      render must reach the refine); only a source with
    #                      nothing wired falls back to what it was submitted with
    #   "wired"            only the images wired to in-ref-image
    #   "none"             no references, the fastest
    # Wiring images to in-ref-image implies "wired" unless upscaleRefs says otherwise.
    wired = [Path(u).name for u in (_node_url(n) for n in _incoming_nodes(canvas, node_id, "in-ref-image")) if u]
    inherited = [Path(u).name for u in (_node_url(n) for n in _incoming_nodes(canvas, source.get("id"), "in-ref-image")) if u]
    if not inherited:
        inherited = [n for n in (str(r.get("comfy_filename") or Path(str(r.get("url") or "")).name)
                                 for r in ((src_data.get("submittedResources") or {}).get("reference_images") or [])) if n]
    mode = str(data.get("upscaleRefs") or ("wired" if wired else "inherit")).strip().lower()
    refs = {"none": [], "wired": wired, "inherit": inherited}.get(mode, inherited)
    if method == "h3_latent" and refs:
        payload["reference_images"] = refs

    # A chained shot is enhanced on the previous chain's HD: that file's last
    # `overlap` frames are this latent's context window at HD, mounted over it so
    # both HD shots agree across the seam. Hence chains are enhanced in order.
    anchor_from, anchor_note = None, None
    if method == "h3_latent" and overlap > 0:
        prev = next(iter(_incoming_nodes(canvas, source.get("id"), "in-motion-context")), None)
        if prev is not None:
            ups = [n for n in canvas.get("nodes", []) if n.get("type") == "videoUpscale"
                   and any(e.get("source") == prev.get("id") and e.get("target") == n.get("id")
                           for e in canvas.get("edges", []))]
            done = [n for n in ups if (n.get("data") or {}).get("status") == "done"
                    and (n.get("data") or {}).get("generatedUrl")]
            # The HD must be of the very take this shot was chained from: C17b was
            # chained from C17a 3412ff67 while C17a's HD was of a later take,
            # whose tail is not this shot's overlap (2026-09-29).
            chained_tag = _chained_from_tag(src_data)
            match = [n for n in done if not chained_tag
                     or _take_tag(n["data"].get("compareUrl")) == chained_tag]
            if match:
                anchor_from = match[-1]
                payload["prev_hd_url"] = anchor_from["data"]["generatedUrl"]
                payload["anchor_frames"] = overlap
                # A shot that carries on from frame N of the previous clip (not its end)
                # has a context window of frames N-overlap..N-1, so the anchor is cut
                # there, not from the HD's tail. An HD made with the overlap leads with
                # its own overlap frames; the clip's frame N sits that far into the file.
                at = _chain_end_frame(canvas, source.get("id"))
                if at:
                    payload["anchor_end_frame"] = at + int(anchor_from["data"].get("overlapFrames") or 0)
                if not chained_tag:
                    anchor_note = "chained take unrecorded; anchored without checking the previous HD's take"
            elif done:
                anchor_note = (f"previous chain {prev.get('id')}'s HD is of take "
                               f"{_take_tag(done[-1]['data'].get('compareUrl'))}, this shot was chained from "
                               f"{chained_tag}; enhance that take first for a matching seam")
            else:
                anchor_note = (f"previous chain {prev.get('id')} has no finished 视频增强 yet; "
                               "enhanced without its HD, the seam may not match")

    # data.prompt, when set, replaces the built-in refine text. The built-in one
    # is deliberately short ("segment video ... sharp focus, clear details"),
    # because a full scene description measured 0.13 dB and invites the pass to
    # repaint what it should only be sharpening. Set this to name something the
    # refine must get right -- the strings on a screen, a label -- not to
    # re-describe the shot.
    refine_prompt = str(data.get("prompt") or "").strip()
    if method == "h3_latent" and refine_prompt:
        payload["prompt"] = refine_prompt

    submitted = _request("POST", "/upscale-video", json=payload, project_id=resolved["id"])
    revision = _save_node_data(resolved["id"], node_id, {
        "status": "generating", "jobId": submitted["job_id"], "error": None,
        "method": method, "width": width, "height": height, "scaleBy": scale_by,
        # the studio's run button records the clip it enhanced; the compare view's
        # before side and its divider come from it
        "compareUrl": video_url,
        "pendingOverlapFrames": overlap if with_overlap else 0,
        # which HD the seam was anchored on, or why it was not
        "anchorFrom": anchor_from.get("id") if anchor_from else None,
        "anchorNote": anchor_note,
    }, canvas)
    return {
        "project_id": resolved["id"], "project_name": resolved["name"], "node_id": node_id,
        "job_id": submitted["job_id"], "status": submitted.get("status", "queued"),
        "revision": revision, "method": method, "source": source.get("id"),
        "size": f"{width}x{height}", "latent": latent,
        "reference_images": payload.get("reference_images") or [],
        "reference_source": mode,
        "refine_prompt": bool(payload.get("prompt")),
        "anchor_from": anchor_from.get("id") if anchor_from else None,
        "anchor_note": anchor_note,
    }


# ---- One click HD for a whole chain ---------------------------------------------
# 2026-10-01: making HD meant creating and starting a 视频增强 node per shot. The
# order matters (each shot is enhanced on the previous shot's HD, mounted over its
# overlap) and the job queue is not first-in-first-out, so submitting every shot at
# once would anchor most of them on nothing. This submits one shot, waits until its
# result is written to the node, then the next.

def _chain_hd_order(canvas: dict[str, Any], node_id: str) -> list[dict[str, Any]]:
    """The shots of node_id's chain, head first, branches in edge order.

    Walks back to the head through in-motion-context edges (a trim or edit node in
    between ends the walk: it is not a shot), then forward depth first.
    """
    by_id = {n.get("id"): n for n in canvas.get("nodes", [])}
    cur = by_id.get(node_id)
    if cur is None or cur.get("type") != "video":
        raise ValueError(f"{node_id} is not an H3 video node.")
    seen = {node_id}
    while True:
        parents = [p for p in _incoming_nodes(canvas, cur["id"], CHAIN_HANDLE) if p.get("type") == "video"]
        if not parents or parents[0]["id"] in seen:
            break
        cur = parents[0]
        seen.add(cur["id"])
    order: list[dict[str, Any]] = []
    visited: set[str] = set()

    def walk(node: dict[str, Any]) -> None:
        if node["id"] in visited:
            return
        visited.add(node["id"])
        order.append(node)
        for e in canvas.get("edges", []):
            if e.get("source") == node["id"] and e.get("targetHandle") == CHAIN_HANDLE:
                child = by_id.get(e.get("target"))
                if child is not None and child.get("type") == "video":
                    walk(child)

    walk(cur)
    return order


_PASS_THROUGH = ("videoTrim", "videoEdit")


def _continues(canvas: dict[str, Any], node_id: str, seen: set[str] | None = None) -> bool:
    """Something carries on from this node: a shot takes it as its motion context, directly or
    through further cuts."""
    seen = seen if seen is not None else set()
    if node_id in seen:
        return False
    seen.add(node_id)
    by_id = {n.get("id"): n for n in canvas.get("nodes", [])}
    for e in canvas.get("edges", []):
        if e.get("source") != node_id or e.get("target") not in by_id:
            continue
        if e.get("targetHandle") == CHAIN_HANDLE:
            return True
        if (by_id[e["target"]].get("type") in _PASS_THROUGH and e.get("targetHandle") in ("in-video", None)
                and _continues(canvas, e["target"], seen)):
            return True
    return False


def _cut_is_used(canvas: dict[str, Any], parent_id: str, cut: dict[str, Any]) -> bool:
    """Is this trim / edit the clip the film uses from `parent_id`?

    Yes when something continues from it. An end-of-chain trim has nothing to continue into, so a
    trim counts there when the parent itself is not continued from (a cut is how the film uses such
    a shot); a dead-end edit never does.
    """
    if _continues(canvas, cut["id"]):
        return True
    if cut.get("type") != "videoTrim":
        return False
    return not any(e.get("source") == parent_id and e.get("targetHandle") == CHAIN_HANDLE
                   for e in canvas.get("edges", []))


def _hd_source(canvas: dict[str, Any], shot_id: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """The node whose clip is this shot as the film uses it, and the cuts between.

    A shot is often cut (a trim at its quiet point) before the next shot carries on from
    it, and it is the cut clip that gets enhanced (C10: C10 -> trim -> HD). Follows
    trim / edit nodes from the shot toward whatever continues it; with none, the shot.

    Only a cut the film really goes on from counts (`_cut_is_used`). An edit that nothing
    continues from is a try, not the shot as used: C22a's side-street edit was waiting for
    review, yet its HD was taken for C22a's own (2026-10-03), so 全部高清 found the shot done
    and never enhanced the clip the film uses.
    """
    by_id = {n.get("id"): n for n in canvas.get("nodes", [])}
    via: list[dict[str, Any]] = []
    cur = shot_id
    seen = {cur}
    while True:
        nxt = next((by_id[e["target"]] for e in canvas.get("edges", [])
                    if e.get("source") == cur and e.get("target") in by_id
                    and by_id[e["target"]].get("type") in _PASS_THROUGH
                    and e.get("targetHandle") in ("in-video", None)
                    and e["target"] not in seen
                    and _cut_is_used(canvas, cur, by_id[e["target"]])), None)
        if nxt is None:
            break
        via.append(nxt)
        cur = nxt["id"]
        seen.add(cur)
    return by_id[cur], via


def _hd_nodes_of(canvas: dict[str, Any], shot_id: str) -> list[dict[str, Any]]:
    """视频增强 nodes fed by the shot's served clip (the cut one when it is cut)."""
    source, _ = _hd_source(canvas, shot_id)
    by_id = {n.get("id"): n for n in canvas.get("nodes", [])}
    return [by_id[e["target"]] for e in canvas.get("edges", [])
            if e.get("source") == source["id"] and e.get("targetHandle") == "in-video"
            and by_id.get(e.get("target"), {}).get("type") == "videoUpscale"]


def _hd_is_current(shot: dict[str, Any], hd: dict[str, Any], canvas: dict[str, Any] | None = None) -> bool:
    """An HD counts only when it was made from the take the shot shows now.

    Done is not enough: a shot re-rendered after its HD has an HD of an older take
    (most of scene 3 on 2026-10-01). A node with no recorded source take is treated
    as stale rather than guessed at. When the shot is cut before it is enhanced, the
    cut must be of the shown take (its sourceUrl) and the HD of that cut's file.
    """
    d = hd.get("data") or {}
    if d.get("status") != "done" or not d.get("generatedUrl"):
        return False
    return _hd_made_from_shown(shot, hd, canvas)


def _hd_in_flight(shot: dict[str, Any], hd: dict[str, Any], canvas: dict[str, Any] | None = None) -> bool:
    """An HD of the shown take that is rendering right now.

    The chain run must wait for it, not start a second one: when the run was lost (MCP
    restart) or started while one HD was already going, the node still says generating
    with its job, and only a done HD used to count, so the shot was enhanced twice.
    """
    d = hd.get("data") or {}
    return d.get("status") == "generating" and bool(d.get("jobId")) and _hd_made_from_shown(shot, hd, canvas)


def _hd_made_from_shown(shot: dict[str, Any], hd: dict[str, Any], canvas: dict[str, Any] | None = None) -> bool:
    d = hd.get("data") or {}
    shown = _take_tag((shot.get("data") or {}).get("generatedUrl"))
    if not shown:
        return False
    source, via = _hd_source(canvas, shot["id"]) if canvas is not None else (shot, [])
    if not via:
        return _take_tag(d.get("compareUrl")) == shown
    # shot -> cut(s) -> HD: the first cut was made from the shown take, the last cut is
    # the file the HD was made from
    first = (via[0].get("data") or {})
    plan = first.get("trimPlan") or {}
    cut_from = _take_tag(first.get("sourceUrl") or plan.get("source_url"))
    last_file = (source.get("data") or {}).get("generatedUrl")
    # An edit-window node records no source take at all (only its guide frames and window),
    # so the check above could never pass and its shot was never "current" nor "in flight":
    # every chain run added another HD node (c22a, 2026-10-02: hd-...-hospital and -2, both
    # rendering). Its input edge is the shot itself, so for an edit node with nothing
    # recorded the HD is judged by the edit's file alone.
    unrecorded_edit = via[0].get("type") == "videoEdit" and not cut_from
    return (cut_from == shown or unrecorded_edit) and bool(last_file) and d.get("compareUrl") == last_file


_CHAIN_HD_RUNS: dict[str, dict[str, Any]] = {}
_CHAIN_HD_WAIT_S = 3 * 3600
# The runs that were in progress, so a restart of this process (a deploy, a crash) picks them up again
# instead of leaving the shots after the current one undone. A resumed run re-reads the canvas and
# skips every shot whose HD is current or already rendering, so starting it again is safe.
_CHAIN_HD_FILE = Path(os.environ.get("AI_CINEMA_CHAIN_HD_FILE") or (_BACKEND_DIR.parent / ".runtime" / "chain_hd_runs.json"))


def _save_chain_runs() -> None:
    try:
        live = {pid: {"project": pid, "scene": st.get("scene") or "", "node_id": (st.get("chain") or [""])[0],
                      "scale_by": st.get("scale_by") or 2.0, "shot_ids": st.get("chain") or []}
                for pid, st in _CHAIN_HD_RUNS.items() if st.get("status") == "running"}
        _CHAIN_HD_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = _CHAIN_HD_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(live), encoding="utf-8")
        os.replace(tmp, _CHAIN_HD_FILE)
    except OSError as error:
        print(f"chain hd: could not record the running chains: {error}", file=sys.stderr, flush=True)


def _load_chain_runs() -> list[dict[str, Any]]:
    try:
        return list(json.loads(_CHAIN_HD_FILE.read_text(encoding="utf-8")).values())
    except (OSError, ValueError):
        return []


def _chain_hd_loop(resolved: dict[str, Any], scene: str, shot_ids: list[str], scale_by: float,
                   state: dict[str, Any]) -> None:
    pid = resolved["id"]
    _SCENE.set(resolved.get("scene", "main"))   # a new thread starts without the caller's scene

    def stop(status: str, error: str | None = None) -> None:
        state.update(status=status, error=error, current=None, updated=time.time())
        _save_chain_runs()

    try:
        for index, shot_id in enumerate(shot_ids):
            if state.get("cancel"):
                return stop("cancelled")
            state.update(index=index, current=shot_id, updated=time.time())
            canvas = _canvas(pid)
            shot = _find_node(canvas["nodes"], shot_id)
            if not (shot.get("data") or {}).get("generatedUrl"):
                return stop("error", f"{shot_id} has no clip yet; render it first.")
            hds = _hd_nodes_of(canvas, shot_id)
            if any(_hd_is_current(shot, hd, canvas) for hd in hds):
                state["skipped"].append(shot_id)
                continue
            src_node, _via = _hd_source(canvas, shot_id)
            if not (src_node.get("data") or {}).get("generatedUrl"):
                return stop("error", f"{src_node['id']} (the cut of {shot_id}) has no clip yet; run it first.")
            running = [h for h in hds if _hd_in_flight(shot, h, canvas)]
            usable = running or [h for h in hds if (h.get("data") or {}).get("status") != "generating"]
            if usable:
                hd_id = usable[-1]["id"]
            else:
                hd_id = f"hd-{shot_id}"
                n = 2
                while any(x.get("id") == hd_id for x in canvas["nodes"]):
                    hd_id, n = f"hd-{shot_id}-{n}", n + 1
                sd = shot.get("data") or {}
                w, h = int(sd.get("width") or 1376), int(sd.get("height") or 768)
                with _hold_lock(pid, 60, f"add {hd_id}"):
                    apply_canvas_operations(pid, [
                        {"op": "add_node", "type": "videoUpscale", "id": hd_id, "width": 280,
                         "data": {"scaleBy": scale_by, "width": round(w * scale_by / 16) * 16,
                                  "height": round(h * scale_by / 16) * 16, "status": "idle",
                                  "label": f"HD · {(sd.get('label') or shot_id)[:40]}"}},
                        {"op": "add_edge", "source": src_node["id"], "target": hd_id,
                         "source_handle": "out-video", "target_handle": "in-video"}], scene=scene)
            with _hold_lock(pid, 60, f"run {hd_id}"):
                result = _run_locked(resolved, hd_id, "")
            job_id = result.get("job_id") if isinstance(result, dict) else None
            if not job_id:
                return stop("error", f"{hd_id} did not start: {result}")
            state["job_id"] = job_id
            # always: a run that finds the HD already rendering (this process restarted since) is the
            # only thing left that can write its result into the node
            _watch_job(pid, hd_id, job_id, scene)
            deadline = time.time() + _CHAIN_HD_WAIT_S
            while True:
                time.sleep(_WATCH_INTERVAL_S)
                canvas = _canvas(pid)
                data = _find_node(canvas["nodes"], hd_id).get("data") or {}
                if data.get("status") == "done" and not data.get("jobId") and data.get("generatedUrl"):
                    state["done"].append(shot_id)
                    break
                if data.get("status") == "error":
                    return stop("error", f"{shot_id} -> {hd_id}: {data.get('error') or 'failed'}")
                if data.get("status") in ("idle", "cancelled") and not data.get("jobId"):
                    # cancelled from the studio (or never started): do not wait for it
                    return stop("cancelled", f"{shot_id} -> {hd_id} was cancelled")
                if time.time() > deadline:
                    return stop("error", f"{shot_id} -> {hd_id}: gave up waiting")
            if state.get("cancel"):
                return stop("cancelled")
        stop("done")
    except Exception as error:  # noqa: BLE001 -- surfaced in the run's state
        print(f"chain hd {pid}: {error}", file=sys.stderr, flush=True)
        stop("error", str(error))


def start_chain_hd(project: str, node_id: str, scene: str = "", scale_by: float = 2.0,
                   shot_ids: list[str] | None = None) -> dict[str, Any]:
    resolved = _resolve_project(project, scene)
    pid = resolved["id"]
    live = _CHAIN_HD_RUNS.get(pid)
    if live and live.get("status") == "running":
        return {**live, "already_running": True}
    canvas = _canvas(pid)
    if shot_ids:
        # the studio's chain list (it runs through trim and edit nodes, which this
        # server's own walk stops at): the shots in the order it shows them
        shots = [_find_node(canvas["nodes"], sid) for sid in shot_ids]
        bad = [n["id"] for n in shots if n.get("type") != "video"]
        if bad:
            raise ValueError(f"Not H3 video nodes: {', '.join(bad)}")
    else:
        shots = _chain_hd_order(canvas, node_id)
    order = [n["id"] for n in shots]
    pending = [n["id"] for n in shots
               if not any(_hd_is_current(n, hd, canvas) for hd in _hd_nodes_of(canvas, n["id"]))]
    state = {"project_id": pid, "scene": scene, "chain": order, "pending": pending, "scale_by": scale_by,
             "status": "running" if pending else "done", "index": 0, "current": None,
             "done": [], "skipped": [], "error": None, "cancel": False, "started": time.time(),
             "updated": time.time(), "job_id": None}
    _CHAIN_HD_RUNS[pid] = state
    _save_chain_runs()
    if pending:
        threading.Thread(target=_chain_hd_loop, args=(resolved, scene, order, float(scale_by), state),
                         name=f"chain-hd-{pid}", daemon=True).start()
    return dict(state)


def chain_hd_status(project: str, scene: str = "") -> dict[str, Any]:
    resolved = _resolve_project(project, scene)
    state = _CHAIN_HD_RUNS.get(resolved["id"])
    return dict(state) if state else {"project_id": resolved["id"], "status": "none"}


def cancel_chain_hd(project: str, scene: str = "") -> dict[str, Any]:
    resolved = _resolve_project(project, scene)
    state = _CHAIN_HD_RUNS.get(resolved["id"])
    if state and state.get("status") == "running":
        state["cancel"] = True
    return dict(state) if state else {"project_id": resolved["id"], "status": "none"}


@_tool
def upscale_chain(project: str, node_id: str, scene: str = "", scale_by: float = 2.0) -> dict[str, Any]:
    """Enhance every shot of node_id's chain to HD, one after another, in chain order.

    Finds the chain's head from any shot in it, then for each shot without an HD of
    its current take: creates the 视频增强 node if there is none, starts it, waits
    until its result is written, and only then starts the next shot (each one is
    anchored on the previous shot's HD, which the job queue cannot guarantee if they
    are all submitted at once). Shots whose HD is of the take they show now are
    skipped; a shot not rendered yet, or a failed job, stops the run and names it.
    Returns at once; poll upscale_chain_status. One run per project.
    """
    return start_chain_hd(project, node_id, scene, scale_by)


@_tool
def upscale_chain_status(project: str, scene: str = "") -> dict[str, Any]:
    """Progress of the one-click chain HD run in this project: status, current shot, done, skipped, error."""
    return chain_hd_status(project, scene)


@_tool
def cancel_upscale_chain(project: str, scene: str = "") -> dict[str, Any]:
    """Stop the chain HD run after the shot it is working on finishes."""
    return cancel_chain_hd(project, scene)


def _run_trim_locked(resolved: dict[str, Any], canvas: dict[str, Any], node: dict[str, Any]) -> dict[str, Any]:
    """Cut the in-video clip to data.trimStartSeconds..trimEndSeconds (end unset = to the end).

    A cut that starts at the clip's head and ends on the latent's 17n+5 grid (counting the
    chain context at its head) also gets a cut latent, and a chain continuing from it uses
    that; any other cut has none and the chain reads its frames instead (see _chain_carry).
    """
    node_id = node["id"]
    data = node.setdefault("data", {})
    if data.get("status") == "generating" and data.get("jobId"):
        return {"project_id": resolved["id"], "node_id": node_id,
                "job_id": data["jobId"], "status": "already_generating"}
    sources = _incoming_nodes(canvas, node_id, "in-video")
    if len(sources) != 1:
        raise ValueError(f"Trim node {node_id} needs exactly one in-video source, has {len(sources)}.")
    video_url = _node_url(sources[0])
    if not video_url:
        raise ValueError(f"Trim node {node_id}: source {sources[0].get('id')} has no clip yet.")
    start = float(data.get("trimStartSeconds") or 0.0)
    end = data.get("trimEndSeconds")
    end = float(end) if end not in (None, "") else None
    submitted = _request("POST", "/generate-video-trim", project_id=resolved["id"], json={
        "video_url": video_url, "start_seconds": start, "end_seconds": end,
        "keep_audio": not data.get("trimMuteAudio"), "depth": bool(data.get("trimDepth")),
        # lets the backend also cut the source's latent when the cut lands on its grid
        "latent_filename": (sources[0].get("data") or {}).get("latentFilename") or None,
        "context_frames": int((sources[0].get("data") or {}).get("contextFrames") or 0)})
    revision = _save_node_data(resolved["id"], node_id, {
        "status": "generating", "jobId": submitted["job_id"], "error": None,
        "sourceUrl": video_url,
    }, canvas)
    return {"project_id": resolved["id"], "project_name": resolved["name"], "node_id": node_id,
            "job_id": submitted["job_id"], "status": submitted.get("status", "queued"),
            "revision": revision, "source": sources[0].get("id"),
            "range_seconds": [start, end]}


def _run_depth_video_locked(resolved: dict[str, Any], canvas: dict[str, Any], node: dict[str, Any]) -> dict[str, Any]:
    """The in-video clip as a silent per-frame depth video (POST /generate-video-depth)."""
    node_id = node["id"]
    data = node.setdefault("data", {})
    if data.get("status") == "generating" and data.get("jobId"):
        return {"project_id": resolved["id"], "node_id": node_id,
                "job_id": data["jobId"], "status": "already_generating"}
    sources = _incoming_nodes(canvas, node_id, "in-video")
    if len(sources) != 1:
        raise ValueError(f"Depth node {node_id} needs exactly one in-video source, has {len(sources)}.")
    video_url = _node_url(sources[0])
    if not video_url:
        raise ValueError(f"Depth node {node_id}: source {sources[0].get('id')} has no clip yet.")
    submitted = _request("POST", "/generate-video-depth", project_id=resolved["id"], json={
        "video_url": video_url, "resolution": int(data.get("resolution") or 518)})
    revision = _save_node_data(resolved["id"], node_id, {
        "status": "generating", "jobId": submitted["job_id"], "error": None, "sourceUrl": video_url,
    }, canvas)
    return {"project_id": resolved["id"], "project_name": resolved["name"], "node_id": node_id,
            "job_id": submitted["job_id"], "status": submitted.get("status", "queued"),
            "revision": revision, "source": sources[0].get("id")}


@_tool
def adopt_render(
    project: str,
    node_id: str,
    url: str,
    label: str | None = None,
    set_prompt: bool = False,
    keep_url: bool = False,
    scene: str = "",
) -> dict[str, Any]:
    """Attach a clip that was rendered outside the canvas to a video node, with the
    clip's own provenance.

    ComfyUI embeds the executed graph in every mp4 it writes, so the clip knows
    its prompt, seed, steps, size, length, reference files and model even when
    no canvas job ever existed for it. The backend reads that record from the
    file (GET /media/adopt-record, so this works from any machine on the
    tailnet), and this writes it onto the node:

      generatedUrl        the clip (unless keep_url, which keeps e.g. a 2x upscale
                          as the displayed clip and stores the source in sourceUrl)
      compiledPrompt      the prompt that actually reached the model
      submittedResources  the reference images/videos/audios in mount order --
                          the same order that numbers <Picture N>
      steps/seed/width/height/length, latentFilename, model, loras
      takes[0]            a take record, marked adopted
      status              done

    The node's own data.prompt is left alone unless set_prompt=True: a node
    usually carries the *next* prompt to run, while compiledPrompt carries what
    produced the clip on display, and the studio UI shows both. The result reports
    whether the two differ and whether the node's incoming reference edges match
    the files the clip was rendered from, because a mismatch there is exactly the
    silent drift this tool exists to expose.
    """
    resolved = _resolve_project(project, scene)
    with _hold_lock(resolved["id"], 60, f"adopt {node_id}"):
        return _adopt_locked(resolved, node_id, url, label, set_prompt, keep_url)


def _adopt_locked(resolved: dict[str, Any], node_id: str, url: str, label: str | None,
                  set_prompt: bool, keep_url: bool) -> dict[str, Any]:
    canvas = _canvas(resolved["id"])
    node = _find_node(canvas["nodes"], node_id)
    if node.get("type") not in {"video", *EDIT_TYPES, "charswap", "videoReangle"}:
        raise ValueError(f"adopt_render needs a video-type node, got {node.get('type')!r}.")

    # The backend reads the file: it is on the backend's disk, and this MCP may be
    # running on another machine.
    found = _request("GET", "/media/adopt-record", resolved["id"], params={"url": url})
    if not found.get("found"):
        raise ValueError(f"{found.get('name') or url} carries no embedded ComfyUI graph; nothing to adopt. "
                         f"Hand-uploaded or re-encoded clips lose it -- adopt the original.")
    record = found["record"]
    file_name = found["name"]
    served_url = found["served_url"]
    reference_urls = found.get("reference_urls") or {}

    def _url_for_reference(n: str) -> str:
        return reference_urls.get(n, n)

    def mounts(names: list[str]) -> list[dict[str, str]]:
        return [{"url": _url_for_reference(n), "comfy_filename": n} for n in names]

    submitted = {
        "first_frame": ({"url": _url_for_reference(record["first_frame"]),
                         "comfy_filename": record["first_frame"]} if record.get("first_frame") else None),
        "last_frame": ({"url": _url_for_reference(record["last_frame"]),
                        "comfy_filename": record["last_frame"]} if record.get("last_frame") else None),
        "reference_images": mounts(record.get("reference_images") or []),
        "reference_videos": mounts(record.get("reference_videos") or []),
        "reference_audios": mounts(record.get("reference_audios") or []),
    }
    mode = ("ref2va" if submitted["reference_images"] or submitted["reference_videos"] or submitted["reference_audios"]
            else "fl2va" if submitted["first_frame"] and submitted["last_frame"]
            else "i2va" if submitted["first_frame"] else "t2va")

    data = node.setdefault("data", {})
    prompt = record.get("prompt") or ""
    take = {
        "id": f"adopt-{uuid.uuid4().hex[:8]}",
        "createdAt": found["mtime_ms"],
        "spec": None,
        "prompt": prompt,
        "seed": record.get("seed"),
        "width": record.get("width"),
        "height": record.get("height"),
        "length": record.get("length"),
        "steps": record.get("steps"),
        "motionPreset": data.get("motionPreset") or DEFAULT_MOTION_PRESET,
        "url": served_url,
        "adopted": True,
    }
    takes = [take] + [t for t in (data.get("takes") or []) if isinstance(t, dict) and t.get("url") != served_url]
    update: dict[str, Any] = {
        "status": "done",
        "jobId": None,
        "error": None,
        "compiledPrompt": prompt,
        "compiledPromptMode": mode,
        "promptWasModified": False,
        "submittedResources": submitted,
        "latentFilename": found.get("latent_filename"),
        "model": record.get("model"),
        "loras": record.get("loras"),
        "takes": takes[:MAX_TAKES],
        "adoptedFrom": file_name,
        "adoptedAt": int(time.time() * 1000),
    }
    for key in ("seed", "width", "height", "length", "steps"):
        if record.get(key) is not None:
            update[key] = record[key]
    if keep_url:
        update["sourceUrl"] = served_url
    else:
        update["generatedUrl"] = served_url
    if set_prompt or not str(data.get("prompt") or "").strip():
        update["prompt"] = prompt
    if label:
        update["label"] = label
    data.update(update)

    # Does the wiring on the canvas describe the same reference order the clip
    # was rendered from? Edge order is <Picture N> order, so this is the check.
    wired = [Path(_node_url(s) or "").name for s in _incoming_nodes(canvas, node_id, "in-ref-image")]
    rendered = record.get("reference_images") or []
    revision = _save_node_data(resolved["id"], node_id, update, canvas)
    return {
        "project_id": resolved["id"],
        "node_id": node_id,
        "adopted": file_name,
        "url": served_url,
        "steps": record.get("steps"),
        "seed": record.get("seed"),
        "length": record.get("length"),
        "reference_images": rendered,
        "latent_filename": update["latentFilename"],
        "prompt_matches_node": (str(data.get("prompt") or "").strip() == prompt.strip()),
        "wiring_matches_render": wired == rendered,
        "wired_reference_images": wired,
        "revision": revision,
    }


# --------------------------------------------------------------------------- layout
#
# Twin of frontend/lib/stageLayout.ts. Keep the two rules identical: columns by
# role (decided from node type and wiring, never label text), rows by the
# segment lanes a node reaches downstream. The rule was approved on 2026-09-05
# ("按你的画布排序规则做"); the studio's tidy button runs the TS copy, agents run
# this one after they add nodes.

#: A group frame has no role in the pipeline, so it is never staged; it is
#: refitted around its members afterwards. Mirrors GROUP_TYPE / GROUP_HEADER_H /
#: GROUP_PADDING in frontend/lib/canvasGroups.ts.
_GROUP_TYPE = "group"
_GROUP_HEADER_H = 34
_GROUP_PADDING = 32

_GENERATOR_TYPES = {"video", "videoEdit", "videoReshot", "videoBridge", "videoContinue", "videoFrames",
                    "charswap", "videoReangle"}
_IMAGE_TYPES = {"image"}
_NOTE_TYPES = {"prompt"}
STAGE_NAMES = ("notes", "inputs", "plates", "frames", "references", "segments", "dock")
# placement constants -- twins of frontend/lib/stageLayout.ts
_SHARED_MIN_LANES = 3   # a node reaching this many segments goes to the shared band
_LEFT_COLS = 3          # private references beside a segment wrap after this many
_RIGHT_COLS = 2         # derivatives beside their source wrap after this many
_MIN_BAND_WIDTH = 1600  # bands never wrap narrower than this
_TARGET_ASPECT = 1.6    # segment rows wrap into side-by-side blocks nearest this width/height
from node_sizing import DEFAULT_DIMS as _DEFAULT_DIMS  # one table with the studio: frontend/lib/nodeFloors.json


def _group_members(group: dict[str, Any], nodes: list[dict[str, Any]]) -> list[str]:
    """Ids whose centre falls inside the frame's body (the frame minus its title
    bar). A collapsed frame answers from the ids recorded when it was folded."""
    data = group.get("data") or {}
    kept = data.get("collapsedMemberIds")
    if data.get("collapsed") and isinstance(kept, list):
        return [i for i in kept if isinstance(i, str)]
    pos = group.get("position") or {}
    gx, gy = float(pos.get("x", 0)), float(pos.get("y", 0)) + _GROUP_HEADER_H
    gw = float(group.get("width") or 220)
    gh = max(float(group.get("height") or 114) - _GROUP_HEADER_H, 0.0)
    out = []
    for n in nodes:
        if n["id"] == group["id"]:
            continue
        p = n.get("position") or {}
        w, h = _bounds(n)
        cx = float(p.get("x", 0)) + w / 2
        cy = float(p.get("y", 0)) + h / 2
        if gx <= cx <= gx + gw and gy <= cy <= gy + gh:
            out.append(n["id"])
    return out


def _transitive_members(group: dict[str, Any], nodes: list[dict[str, Any]]) -> list[str]:
    by_id = {n["id"]: n for n in nodes}
    seen = {group["id"]}
    out: list[str] = []
    queue = [group]
    while queue:
        current = queue.pop(0)
        for node_id in _group_members(current, nodes):
            if node_id in seen:
                continue
            seen.add(node_id)
            out.append(node_id)
            child = by_id.get(node_id)
            if child and child.get("type") == _GROUP_TYPE:
                queue.append(child)
    return out


def _frame_around(nodes: list[dict[str, Any]]) -> tuple[int, int, int, int]:
    """(x, y, width, height) of a frame holding `nodes`, with room for the title
    bar. Twin of frameAround in frontend/lib/canvasGroups.ts."""
    xs, ys, x2s, y2s = [], [], [], []
    for n in nodes:
        p = n.get("position") or {}
        w, h = _bounds(n)
        xs.append(float(p.get("x", 0)))
        ys.append(float(p.get("y", 0)))
        x2s.append(float(p.get("x", 0)) + w)
        y2s.append(float(p.get("y", 0)) + h)
    min_x, min_y, max_x, max_y = min(xs), min(ys), max(x2s), max(y2s)
    return (
        int(min_x - _GROUP_PADDING),
        int(min_y - _GROUP_PADDING - _GROUP_HEADER_H),
        int(max(max_x - min_x + _GROUP_PADDING * 2, 220)),
        int(max(max_y - min_y + _GROUP_PADDING * 2 + _GROUP_HEADER_H, _GROUP_HEADER_H + 80)),
    )


def _archived_ids(nodes: list[dict[str, Any]]) -> set[str]:
    """Ids folded away inside a collapsed frame. Tidy leaves them where they are:
    folding a stretch of work away is how it gets archived, and scattering it
    across the columns would undo that the moment anyone expanded the frame."""
    hidden: set[str] = set()
    for n in nodes:
        if n.get("type") != _GROUP_TYPE:
            continue
        if not (n.get("data") or {}).get("collapsed"):
            continue
        hidden.update(_transitive_members(n, nodes))
    return hidden


def _chain_order(ordered: list[dict[str, Any]], edges: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Segments in motion-context chain order (twin of chainOrder in stageLayout.ts).

    Ids alone put a studio-made node ("video-1789...") after every "s2-c*" one
    although it sits mid-chain. Each chain runs from its root, a segment right
    after the one it continues; of several continuations the side branches come
    first and the one carrying the chain furthest comes last. `ordered` is the
    natural-key order, used for roots and ties.
    """
    ids = {n["id"] for n in ordered}
    rank = {n["id"]: i for i, n in enumerate(ordered)}
    parent: dict[str, str] = {}
    children: dict[str, list[str]] = {}
    for e in edges:
        s, t = e.get("source"), e.get("target")
        if e.get("targetHandle") != "in-motion-context" or s not in ids or t not in ids or t in parent:
            continue
        parent[t] = s
        children.setdefault(s, []).append(t)
    depth: dict[str, int] = {}

    def reach(i: str, seen: frozenset = frozenset()) -> int:
        if i in depth:
            return depth[i]
        if i in seen:
            return 0
        d = 1 + max([reach(c, seen | {i}) for c in children.get(i, [])], default=0)
        depth[i] = d
        return d

    by_id = {n["id"]: n for n in ordered}
    result: list[dict[str, Any]] = []
    placed: set[str] = set()

    def walk(i: str) -> None:
        if i in placed:
            return
        placed.add(i)
        result.append(by_id[i])
        for c in sorted(children.get(i, []), key=lambda c: (reach(c), rank[c])):
            walk(c)

    for n in ordered:
        if n["id"] not in parent:
            walk(n["id"])
    for n in ordered:  # cycles
        walk(n["id"])
    return result


def _natural_key(text: str) -> list:
    import re
    return [int(p) if p.isdigit() else p for p in re.split(r"(\d+)", text.lower()) if p]


def _bounds(node: dict[str, Any]) -> tuple[int, int]:
    dw, dh = _DEFAULT_DIMS.get(node.get("type") or "", (320, 260))
    measured = node.get("measured") or {}
    w = measured.get("width") or node.get("width") or dw
    h = measured.get("height") or node.get("height") or dh
    return max(int(w), 160), max(int(h), 80)


def assign_stages(nodes: list[dict[str, Any]], edges: list[dict[str, Any]]) -> dict[str, int]:
    by_id = {n["id"]: n for n in nodes}
    out: dict[str, list[str]] = {n["id"]: [] for n in nodes}
    inn: dict[str, list[str]] = {n["id"]: [] for n in nodes}
    for e in edges:
        if e.get("source") in by_id and e.get("target") in by_id:
            out[e["source"]].append(e["target"])
            inn[e["target"]].append(e["source"])
    type_of = lambda i: by_id[i].get("type") or ""  # noqa: E731
    stage: dict[str, int] = {}
    for n in nodes:  # pass 1: plate generators feed an image node
        if type_of(n["id"]) in _GENERATOR_TYPES and any(type_of(t) in _IMAGE_TYPES for t in out[n["id"]]):
            stage[n["id"]] = 2
    for n in nodes:  # pass 2
        i = n["id"]
        if i in stage:
            continue
        t = type_of(i)
        if t in _NOTE_TYPES:
            stage[i] = 0
        elif t in _IMAGE_TYPES:
            if any(type_of(s) in _GENERATOR_TYPES for s in inn[i]):
                stage[i] = 3
            elif out[i] and all(stage.get(o) == 2 for o in out[i]):
                stage[i] = 1
            elif out[i]:
                stage[i] = 4
            else:
                stage[i] = 6
        elif t in _GENERATOR_TYPES:
            stage[i] = 5 if inn[i] else 6
        else:
            stage[i] = 6
    return stage


def stage_layout(nodes: list[dict[str, Any]], edges: list[dict[str, Any]],
                 col_gap: int = 120, row_gap: int = 60, start_x: int = 80, start_y: int = 80
                 ) -> dict[str, dict[str, int]]:
    """New positions for every node, keyed by id. Pure; writes nothing."""
    by_id = {n["id"]: n for n in nodes}
    out: dict[str, list[str]] = {n["id"]: [] for n in nodes}
    for e in edges:
        if e.get("source") in by_id and e.get("target") in by_id:
            out[e["source"]].append(e["target"])
    stage = assign_stages(nodes, edges)

    segments = _chain_order(
        sorted((n for n in nodes if stage[n["id"]] == 5),
               key=lambda n: (_natural_key(n["id"]), _natural_key(str((n.get("data") or {}).get("label") or "")))),
        edges)
    lane = {n["id"]: i for i, n in enumerate(segments)}
    seg_ids = list(lane)

    inn: dict[str, list[str]] = {n["id"]: [] for n in nodes}
    for e in edges:
        if e.get("source") in by_id and e.get("target") in by_id:
            inn[e["target"]].append(e["source"])

    def reached_lanes(i: str) -> list[int]:
        seen, frontier, lanes = {i}, [i], []
        for _ in range(4):
            nxt = []
            for cur in frontier:
                for t in out[cur]:
                    if t in seen:
                        continue
                    seen.add(t)
                    (lanes.append(lane[t]) if t in lane else nxt.append(t))
            frontier = nxt
            if not frontier:
                break
        return lanes

    def lane_key(i: str) -> float | None:
        lanes = reached_lanes(i)
        return sum(lanes) / len(lanes) if lanes else None

    def seg_prefix(i: str) -> str | None:
        hits = [s for s in seg_ids if i == s or i.startswith(s + "-") or i.startswith(s + "_")]
        return max(hits, key=len) if hits else None

    def sort_key(n: dict[str, Any]):
        i, s = n["id"], stage[n["id"]]
        y0 = float((n.get("position") or {}).get("y") or 0)
        if s == 5:
            return (lane[i], 0, _natural_key(i))
        if s == 6:
            p = seg_prefix(i)
            if p:
                return (lane[p], 1, _natural_key(i))
            k = lane_key(i)
            return (1e6 + y0 if k is None else k, 2, _natural_key(i))
        k = lane_key(i)
        return (1e6 + y0 if k is None else k, 0, _natural_key(i))

    # Every node gets a home: one segment's row, the shared band on top (used by
    # _SHARED_MIN_LANES or more segments), or the loose band at the bottom.
    notes: list[dict[str, Any]] = []
    shared: list[dict[str, Any]] = []
    loose: list[dict[str, Any]] = []
    home: dict[str, int] = {}
    derivative: set[str] = set()

    def place_by_reach(n: dict[str, Any]) -> None:
        uniq = set(reached_lanes(n["id"]))
        if not uniq:
            loose.append(n)
        elif len(uniq) >= _SHARED_MIN_LANES:
            shared.append(n)
        else:
            home[n["id"]] = min(uniq)

    for n in nodes:
        s = stage[n["id"]]
        if s == 0:
            notes.append(n)
        elif 1 <= s <= 4:
            place_by_reach(n)
    for n in nodes:
        if stage[n["id"]] != 6:
            continue
        p = seg_prefix(n["id"])
        ln = lane[p] if p else None
        if ln is None:
            for src in inn[n["id"]]:
                cand = lane.get(src, home.get(src))
                if cand is not None:
                    ln = cand
                    break
        if ln is not None:
            home[n["id"]] = ln
            derivative.add(n["id"])
        else:
            place_by_reach(n)

    left: list[list[dict[str, Any]]] = [[] for _ in segments]
    right: list[list[dict[str, Any]]] = [[] for _ in segments]
    for n in nodes:
        if n["id"] in home:
            (right if n["id"] in derivative else left)[home[n["id"]]].append(n)
    for items in left:
        items.sort(key=lambda n: (stage[n["id"]], sort_key(n)))
    for items in right:
        items.sort(key=sort_key)
    shared.sort(key=sort_key)
    loose.sort(key=sort_key)

    pos: dict[str, dict[str, int]] = {}
    cell_gap = col_gap / 2

    def grid_width(items: list[dict[str, Any]], cols: int) -> float:
        if not items:
            return 0
        cell_w = max(_bounds(n)[0] for n in items)
        used = min(cols, len(items))
        return used * cell_w + (used - 1) * cell_gap

    def grid(items: list[dict[str, Any]], x0: float, y0: float, cols: int) -> float:
        if not items:
            return 0
        cell_w = max(_bounds(n)[0] for n in items)
        y, row_h = y0, 0
        for k, n in enumerate(items):
            if k % cols == 0 and k > 0:
                y += row_h + row_gap
                row_h = 0
            pos[n["id"]] = {"x": round(x0 + (k % cols) * (cell_w + cell_gap)), "y": round(y)}
            row_h = max(row_h, _bounds(n)[1])
        return y + row_h - y0

    def band(items: list[dict[str, Any]], y0: float, max_w: float) -> float:
        if not items:
            return 0
        x, y, row_h = start_x, y0, 0
        for n in items:
            w, h = _bounds(n)
            if x > start_x and x + w > start_x + max_w:
                x, y, row_h = start_x, y + row_h + row_gap, 0
            pos[n["id"]] = {"x": round(x), "y": round(y)}
            x += w + cell_gap
            row_h = max(row_h, h)
        return y + row_h - y0

    # column x positions shared by every segment row
    left_w = max([0] + [grid_width(items, _LEFT_COLS) for items in left])
    seg_w = max([0] + [_bounds(n)[0] for n in segments])
    right_w = max([0] + [grid_width(items, _RIGHT_COLS) for items in right])
    seg_x = start_x + (left_w + col_gap if left_w > 0 else 0)
    right_x = seg_x + seg_w + col_gap
    row_w = right_x + right_w - start_x

    # lay every segment row out at y = 0; it is shifted into place below
    rows = []
    for k, seg in enumerate(segments):
        # private references sit right-aligned against their segment
        lh = grid(left[k], seg_x - col_gap - grid_width(left[k], _LEFT_COLS), 0, _LEFT_COLS)
        pos[seg["id"]] = {"x": round(seg_x), "y": 0}
        rh = grid(right[k], right_x, 0, _RIGHT_COLS)
        rows.append((left[k] + [seg] + right[k], max(lh, _bounds(seg)[1], rh)))

    # Wrap the rows into k side-by-side blocks, in lane order down each block,
    # choosing the k whose overall shape is nearest _TARGET_ASPECT.
    import math
    block_gap = col_gap * 3

    def pack(k: int) -> tuple[int, float, float]:
        per = math.ceil(len(rows) / k)
        heights = []
        for c in range(k):
            block = rows[c * per:(c + 1) * per]
            if block:
                heights.append(sum(h for _, h in block) + (len(block) - 1) * row_gap * 2)
        return per, len(heights) * row_w + (len(heights) - 1) * block_gap, max([0] + heights)

    def off(p: tuple[int, float, float]) -> float:
        return abs(math.log(p[1] / max(p[2], 1) / _TARGET_ASPECT))

    packed = pack(1) if rows else (1, 0, 0)
    for k in range(2, len(rows) + 1):
        p = pack(k)
        if off(p) < off(packed):
            packed = p
    per = packed[0]
    total_w = max(_MIN_BAND_WIDTH, packed[1])

    y = start_y
    notes_h = band(notes, y, total_w)
    if notes_h > 0:
        y += notes_h + row_gap * 2
    shared_h = band(shared, y, total_w)
    if shared_h > 0:
        y += shared_h + row_gap * 3

    col_y: dict[int, float] = {}
    bottom = y
    for k, (members, h) in enumerate(rows):
        c = k // per
        row_y = col_y.get(c, y)
        dx = c * (row_w + block_gap)
        for n in members:
            p = pos[n["id"]]
            pos[n["id"]] = {"x": round(p["x"] + dx), "y": round(p["y"] + row_y)}
        col_y[c] = row_y + h + row_gap * 2
        bottom = max(bottom, col_y[c])
    band(loose, bottom + row_gap, total_w)
    return pos


@_tool
def arrange_canvas(project: str, dry_run: bool = False, scene: str = "") -> dict[str, Any]:
    """Tidy the whole canvas by production stage -- the same rule as the studio's
    整理 button (frontend/lib/stageLayout.ts).

    One row per segment: its own references in a grid on the left, the segment,
    its derivatives (upscale...) on the right. Nodes used by 3+ segments (cast
    sheets, voices) sit in a shared band on top; nodes reaching no segment in a
    loose band at the bottom. Roles come from node type and wiring only, so a
    node added over this MCP and wired up sorts itself. Run it after adding
    nodes; dry_run reports the stage of every node without moving anything.

    Group frames are not staged -- they are refitted around their members once
    those have moved -- and the contents of a COLLAPSED frame are not moved at
    all, so an archived stretch of work stays as it was left.
    """
    resolved = _resolve_project(project, scene)
    with _hold_lock(resolved["id"], 60, "arrange_canvas"):
        return _arrange_locked(resolved, dry_run)


def _arrange_locked(resolved: dict[str, Any], dry_run: bool) -> dict[str, Any]:
    canvas = _canvas(resolved["id"])
    all_nodes = canvas["nodes"]

    # Group frames are not staged (they have no pipeline role) and the contents
    # of a collapsed frame are not moved (folding is how work gets archived).
    # Same two rules as calculateStageLayout in frontend/lib/stageLayout.ts.
    frames = [n for n in all_nodes if n.get("type") == _GROUP_TYPE]
    members_before = {g["id"]: _transitive_members(g, all_nodes) for g in frames}
    archived = _archived_ids(all_nodes)
    staged = [n for n in all_nodes
              if n.get("type") != _GROUP_TYPE and n["id"] not in archived]

    stage = assign_stages(staged, canvas["edges"])
    by_stage = {name: sorted(i for i, s in stage.items() if s == k)
                for k, name in enumerate(STAGE_NAMES)}
    if dry_run:
        return {"project_id": resolved["id"], "stages": by_stage,
                "groups": [g["id"] for g in frames], "archived": sorted(archived), "moved": 0}

    pos = stage_layout(staged, canvas["edges"])
    moved = 0
    for n in staged:
        new = pos.get(n["id"])
        if new and (n.get("position") or {}) != new:
            n["position"] = new
            moved += 1

    placed = {n["id"]: n for n in staged}
    for frame in frames:
        members = [placed[i] for i in members_before.get(frame["id"], []) if i in placed]
        if not members:
            continue
        rect = _frame_around(members)
        if (frame.get("position") or {}) != {"x": rect[0], "y": rect[1]}:
            moved += 1
        frame["position"] = {"x": rect[0], "y": rect[1]}
        frame["width"], frame["height"] = rect[2], rect[3]

    revision = _save_canvas(resolved["id"], canvas)
    return {"project_id": resolved["id"], "stages": {k: len(v) for k, v in by_stage.items() if v},
            "groups": [g["id"] for g in frames], "archived": sorted(archived),
            "moved": moved, "revision": revision}


@_tool
def lock_project(project: str, seconds: int = 300, reason: str = "", scene: str = "") -> dict[str, Any]:
    """Hold the project's save-lock for a longer stretch of work (max 900 s).

    Every write tool already takes the lock for its own duration; use this when a
    sequence of edits must not be interleaved with the studio's auto-save or with
    the other agent. The studio shows who holds it and pauses saving. Release with
    unlock_project; it also expires on its own.
    """
    resolved = _resolve_project(project, scene)
    lock = _request("POST", f"/projects/{resolved['id']}/lock", params=_scene_params(),
                    json={"agent": AGENT, "seconds": int(seconds), "reason": reason}).get("lock")
    return {"project_id": resolved["id"], "lock": lock}


@_tool
def unlock_project(project: str, scene: str = "") -> dict[str, Any]:
    """Release this agent's save-lock on the project."""
    resolved = _resolve_project(project, scene)
    _request("DELETE", f"/projects/{resolved['id']}/lock", params={"agent": AGENT, **_scene_params()})
    return {"project_id": resolved["id"], "lock": None}


@_tool
def cancel_canvas_node(project: str, node_id: str, scene: str = "") -> dict[str, Any]:
    """Cancel a running canvas node and persist its cancelled state."""
    resolved = _resolve_project(project, scene)
    canvas = _canvas(resolved["id"])
    node = _find_node(canvas["nodes"], node_id)
    data = node.setdefault("data", {})
    job_id = data.get("jobId")
    if not job_id:
        return {"project_id": resolved["id"], "node_id": node_id,
                "status": data.get("status", "idle"), "cancelled": False}
    try:
        state = _request("GET", f"/job/{job_id}")
    except ValueError:
        state = {"status": "error", "error": "Job record no longer exists on the backend"}
    if state.get("status") in _TERMINAL_JOB:
        # Finished before the cancel arrived: keep its result instead of answering
        # not_found / cancelled=false and leaving the node spinning.
        with _hold_lock(resolved["id"], 30, f"cancel {node_id}"):
            finished = _finish_locked(resolved, node_id, job_id, state)
        return {**finished, "cancelled": False, "already_finished": True}
    outcome = _request("POST", f"/cancel-job/{job_id}")
    revision = _save_node_data(resolved["id"], node_id,
                               {"status": "cancelled", "error": "Job cancelled by user", "jobId": None}, canvas)
    return {"project_id": resolved["id"], "node_id": node_id,
            "job_id": job_id, "status": outcome.get("status", "cancelled"),
            "cancelled": True, "revision": revision}


@_tool
def refresh_canvas_node(project: str, node_id: str, scene: str = "") -> dict[str, Any]:
    """Refresh a running canvas node from its backend job and persist completion data."""
    resolved = _resolve_project(project, scene)
    canvas = _canvas(resolved["id"])
    node = _find_node(canvas["nodes"], node_id)
    data = node.setdefault("data", {})
    if node.get("type") == "gaussian" and data.get("worldJobId"):
        world_id = data["worldJobId"]
        job = _request("GET", f"/job/{world_id}")
        status = job.get("status")
        if status == "done":
            ply = (job.get("result") or {}).get("url")
            with _hold_lock(resolved["id"], 30, f"refresh {node_id}"):
                revision = _save_node_data(resolved["id"], node_id, {
                    "plyUrl": ply, "plyFilename": (ply or "").rsplit("/", 1)[-1] or None,
                    "plyOriginalName": f"FlashWorld · {data.get('worldTrajectory') or 'ring'}",
                    "worldVideoUrl": (job.get("result") or {}).get("video_url"),
                    "status": "loading", "worldJobId": None, "error": None}, canvas)
            return {"project_id": resolved["id"], "node_id": node_id, "status": "done",
                    "ply_url": ply, "revision": revision}
        if status in {"error", "cancelled"}:
            with _hold_lock(resolved["id"], 30, f"refresh {node_id}"):
                revision = _save_node_data(resolved["id"], node_id, {
                    "status": "error", "worldJobId": None,
                    "error": job.get("error") or f"Job {status}"}, canvas)
            return {"project_id": resolved["id"], "node_id": node_id, "status": status,
                    "error": job.get("error"), "revision": revision}
        return {"project_id": resolved["id"], "node_id": node_id, "job_id": world_id,
                "status": status, "progress": job.get("progress")}
    job_id = data.get("jobId")
    if not job_id:
        # The studio UI may have consumed the job result already (it clears jobId
        # and sets generatedUrl, but writes no take when the run was started from
        # here). If the clip on display has no take record, make one from the
        # node's own fields so takes[0] never lags the displayed clip.
        url = data.get("generatedUrl")
        takes = [t for t in (data.get("takes") or []) if isinstance(t, dict)]
        if url and data.get("status") == "done" and all(t.get("url") != url for t in takes):
            take = {
                "id": f"refresh-{uuid.uuid4().hex[:8]}",
                "createdAt": int(time.time() * 1000),
                "spec": None,
                "prompt": data.get("compiledPrompt") or data.get("prompt"),
                "seed": data.get("seed"),
                "width": data.get("width"),
                "height": data.get("height"),
                "length": data.get("length"),
                "steps": data.get("steps"),
                "motionPreset": data.get("motionPreset") or DEFAULT_MOTION_PRESET,
                "url": url,
            }
            # What was submitted from here (parameters, wired inputs in edge
            # order), so the version badge can check the wiring against it.
            pending = data.get("pendingTake") or {}
            if pending.get("inputs") is not None:
                take["inputs"] = pending["inputs"]
            if pending.get("params"):
                take["params"] = pending["params"]
            with _hold_lock(resolved["id"], 30, f"refresh {node_id}"):
                revision = _save_node_data(resolved["id"], node_id,
                                           {"takes": ([take] + takes)[:MAX_TAKES], "pendingTake": None}, canvas)
            return {"project_id": resolved["id"], "node_id": node_id, "status": "done",
                    "url": url, "revision": revision, "take_added": True}
        return {"project_id": resolved["id"], "node_id": node_id,
                "status": data.get("status", "idle"), "url": url}
    job = _request("GET", f"/job/{job_id}")
    status = job.get("status")
    if status in {"done", "error", "cancelled"}:
        with _hold_lock(resolved["id"], 30, f"refresh {node_id}"):
            return _finish_locked(resolved, node_id, job_id, job)
    return {"project_id": resolved["id"], "node_id": node_id, "job_id": job_id,
            "status": status, "progress": job.get("progress")}


@_tool
def canvas_progress(project: str, scene: str = "", node_ids: list[str] | None = None) -> dict[str, Any]:
    """Progress of the renders running on a canvas, read only: nothing is written, nothing is
    finished (refresh_canvas_node does that). One row per node that has a job: its status,
    progress 0-1, ETA and position in the queue, whether it is pinned, and what is ahead of it."""
    resolved = _resolve_project(project, scene)
    canvas = _canvas(resolved["id"])
    wanted = set(node_ids or [])
    jobs: dict[str, str] = {}
    for node in canvas["nodes"]:
        data = node.get("data") or {}
        if wanted and node.get("id") not in wanted:
            continue
        for key in ("jobId", "worldJobId"):
            if data.get(key):
                jobs[str(data[key])] = node["id"]
    queue = _request("GET", "/queue").get("pending") or []
    waiting = [q for q in queue if q.get("status") == "queued"]
    rows = []
    for job_id, node_id in jobs.items():
        entry = next((q for q in queue if q.get("id") == job_id), None)
        row: dict[str, Any] = {"node_id": node_id, "job_id": job_id}
        if entry is None:
            job = _request("GET", f"/job/{job_id}")
            row.update(status=job.get("status"), progress=job.get("progress"))
        else:
            row.update(
                status=entry.get("status"),
                progress=entry.get("progress"),
                eta_seconds=entry.get("sched_eta"),
                remaining_seconds=entry.get("sched_remaining"),
                pinned=bool(entry.get("pinned")),
                queue_position=queue.index(entry) + 1,
            )
        rows.append(row)
    return {"project_id": resolved["id"], "jobs": rows,
            "queue": {"running": len(queue) - len(waiting), "queued": len(waiting)}}


def _finish_locked(resolved: dict[str, Any], node_id: str, job_id: str, job: dict[str, Any]) -> dict[str, Any]:
    canvas = _canvas(resolved["id"])
    node = _find_node(canvas["nodes"], node_id)
    data = node.setdefault("data", {})
    status = job.get("status")
    if status == "done":
        result = job.get("result") or {}
        # The take record is what the studio shows as "what produced this clip";
        # the UI only writes one when it watched the job itself, so runs started
        # here used to leave takes[0] pointing at some earlier clip's prompt.
        served_url = result.get("url")
        # A qwenImage turbo run took 7 steps whatever the node's `steps` field says (it only
        # applies to the 25-step path); the take must record what produced the picture.
        ran_steps = 7 if result.get("speed") == "turbo" else data.get("steps")
        take = {
            "id": job_id,
            "createdAt": int(time.time() * 1000),
            "spec": None,
            "prompt": result.get("compiled_prompt") or data.get("prompt"),
            "seed": data.get("seed"),
            "width": data.get("width"),
            "height": data.get("height"),
            "length": data.get("length"),
            "steps": ran_steps,
            "motionPreset": data.get("motionPreset") or DEFAULT_MOTION_PRESET,
            "url": served_url,
        }
        pending = data.get("pendingTake") or {}
        if pending.get("params") is not None:
            take["params"] = pending["params"]
            take["inputs"] = pending.get("inputs") or []
        outputs = {
            "latentFilename": result.get("latent_filename"),
            "untrimmedUrl": result.get("untrimmed_url"),
            "contextFrames": result.get("context_frames"),
            "compiledPrompt": result.get("compiled_prompt"),
            "compiledPromptMode": result.get("mode"),
            "promptWasModified": result.get("prompt_was_modified"),
            "submittedResources": result.get("submitted_resources"),
            "generatedSteps": ran_steps,
            "speed": result.get("speed"),
        }
        take["outputs"] = {k: v for k, v in outputs.items() if v is not None}
        takes = [take] + [t for t in (data.get("takes") or [])
                          if isinstance(t, dict) and t.get("url") != served_url]
        revision = _save_node_data(resolved["id"], node_id, {
            "status": "done",
            "generatedUrl": served_url,
            "jobId": None,
            "error": None,
            # an HD pass made 含重叠帧 leads with the overlap; the cut room hides it
            **({"overlapFrames": int(data.get("pendingOverlapFrames") or 0)}
               if "pendingOverlapFrames" in data else {}),
            "compiledPrompt": result.get("compiled_prompt"),
            "compiledPromptMode": result.get("mode"),
            "promptWasModified": result.get("prompt_was_modified"),
            "submittedResources": result.get("submitted_resources"),
            "latentFilename": result.get("latent_filename"),
            "untrimmedUrl": result.get("untrimmed_url"),
            "contextFrames": result.get("context_frames"),
            # set by local repairs, whose latent covers only the regenerated span
            "latentSpan": result.get("latent_span"),
            # set by an edit window: the frames spliced back and the jump at each seam
            "editWindowPlan": result.get("edit_window"),
            "editSeams": result.get("seams"),
            # set by a tail continuation: which frames of the source it saw
            "continueTail": result.get("continue_tail"),
            # set by a trim: which frames of the source were kept
            **({"trimPlan": result["trim"]} if result.get("trim") else {}),
            # qwenImage: which graph ran ("turbo" 7 steps / "base" 25 steps)
            **({"speedUsed": result["speed"]} if result.get("speed") else {}),
            "takes": takes[:MAX_TAKES],
            "pendingTake": None,
        }, canvas)
        return {"project_id": resolved["id"], "node_id": node_id, "job_id": job_id,
                "status": "done", "url": result.get("url"),
                **({"speed": result["speed"]} if result.get("speed") else {}),
                **({"edit_window": result["edit_window"], "seams": result.get("seams")}
                   if result.get("edit_window") else {}),
                **({"continue_tail": result["continue_tail"]} if result.get("continue_tail") else {}),
                "revision": revision}
    if status in {"error", "cancelled"}:
        data.update({"status": "error", "jobId": None,
                     "error": job.get("error") or f"Job {status}"})
        revision = _save_node_data(resolved["id"], node_id,
                                   {"status": "error", "jobId": None, "error": data["error"]}, canvas)
        return {"project_id": resolved["id"], "node_id": node_id, "job_id": job_id,
                "status": status, "error": data["error"], "revision": revision}
    return {"project_id": resolved["id"], "node_id": node_id, "job_id": job_id,
            "status": status, "progress": job.get("progress")}


# The studio's "全部高清" button reaches the chain HD run through the backend, which forwards
# here (the run lives in this process, next to the code that writes node results).
from starlette.requests import Request as _Request  # noqa: E402
from starlette.responses import JSONResponse as _JSONResponse  # noqa: E402


async def _chain_hd_route(request: _Request, action: str) -> _JSONResponse:
    try:
        if request.method == "POST":
            body = await request.json()
        else:
            body = dict(request.query_params)
        project, scene = str(body.get("project") or ""), str(body.get("scene") or "")
        if action == "start":
            out = await anyio.to_thread.run_sync(
                start_chain_hd, project, str(body.get("node_id") or ""), scene, float(body.get("scale_by") or 2.0),
                [str(x) for x in body.get("shot_ids") or []] or None)
        elif action == "cancel":
            out = await anyio.to_thread.run_sync(cancel_chain_hd, project, scene)
        else:
            out = await anyio.to_thread.run_sync(chain_hd_status, project, scene)
        return _JSONResponse(json.loads(json.dumps(_slim(out), default=str)))
    except Exception as error:  # noqa: BLE001
        return _JSONResponse({"error": str(error)}, status_code=400)


@mcp.custom_route("/chain-hd/start", methods=["POST"])
async def _chain_hd_start(request: _Request) -> _JSONResponse:
    return await _chain_hd_route(request, "start")


@mcp.custom_route("/chain-hd/status", methods=["GET"])
async def _chain_hd_status(request: _Request) -> _JSONResponse:
    return await _chain_hd_route(request, "status")


@mcp.custom_route("/redo-audio/start", methods=["POST"])
async def _redo_audio_start(request: _Request) -> _JSONResponse:
    """The studio's 只重做声音 button: the same call as the redo_audio tool."""
    try:
        body = await request.json()
        out = await anyio.to_thread.run_sync(functools.partial(
            redo_audio, str(body.get("project") or ""), str(body.get("node_id") or ""),
            str(body.get("mode") or "polish"), str(body.get("scene") or ""),
            int(body.get("steps") or 0), float(body.get("denoise") or 0.0),
            int(body.get("seed") if body.get("seed") is not None else -1)))
        return _JSONResponse(json.loads(json.dumps(_slim(out), default=str)))
    except Exception as error:  # noqa: BLE001
        return _JSONResponse({"error": str(error)}, status_code=400)


@mcp.custom_route("/audio-refine/start", methods=["POST"])
async def _audio_refine_start(request: _Request) -> _JSONResponse:
    """The studio's 声音精修 node: the same call as run_canvas_node on it."""
    try:
        body = await request.json()
        out = await anyio.to_thread.run_sync(functools.partial(
            run_canvas_node, str(body.get("project") or ""), str(body.get("node_id") or ""),
            str(body.get("scene") or "")))
        return _JSONResponse(json.loads(json.dumps(_slim(out), default=str)))
    except Exception as error:  # noqa: BLE001
        return _JSONResponse({"error": str(error)}, status_code=400)


@mcp.custom_route("/chain-hd/cancel", methods=["POST"])
async def _chain_hd_cancel(request: _Request) -> _JSONResponse:
    return await _chain_hd_route(request, "cancel")


def _generating_jobs(canvas: dict[str, Any]) -> list[tuple[str, str]]:
    """(node id, job id) of every node on this canvas that is waiting for a backend job."""
    out = []
    for node in canvas.get("nodes") or []:
        data = node.get("data") or {}
        if data.get("status") == "generating" and data.get("jobId"):
            out.append((node["id"], data["jobId"]))
        elif data.get("worldJobId"):
            out.append((node["id"], data["worldJobId"]))
    return out


def _resume_after_restart(max_age_days: float = 3.0, wait_s: float = 5.0) -> dict[str, int]:
    """Pick up what the previous process of this server was doing.

    Writing a finished job into its node was done by a thread in this process, so a restart left
    every running node waiting for nobody (c22 HD, 2026-10-02: the job finished, the node never
    changed). Every node still `generating` in a recently used project gets its watcher again (a job
    that already finished is written on the first poll), and the chain HD runs that were in progress
    are started again.
    """
    time.sleep(wait_s)
    watched = resumed = 0
    projects: list[dict[str, Any]] = []
    for attempt in range(30):          # the backend may still be starting
        try:
            projects = _request("GET", "/projects", params={"workspace": WORKSPACE}).get("projects", [])
            break
        except Exception:  # noqa: BLE001
            time.sleep(10)
    cutoff = time.time() - max_age_days * 86400
    for project in projects:
        updated = str(project.get("updated_at") or "")
        try:
            if updated and datetime.fromisoformat(updated.replace("Z", "+00:00")).timestamp() < cutoff:
                continue
        except ValueError:
            pass
        pid = project["id"]
        try:
            scenes = _request("GET", f"/projects/{pid}/scenes", params={"workspace": WORKSPACE}).get("scenes") or []
            for scene_id in [s.get("id") for s in scenes] or ["main"]:
                _SCENE.set(scene_id or "main")
                for node_id, job_id in _generating_jobs(_canvas(pid)):
                    _watch_job(pid, node_id, job_id, scene_id or "")
                    watched += 1
        except Exception as error:  # noqa: BLE001 -- one project that cannot be read must not stop the rest
            print(f"resume: {pid}: {error}", file=sys.stderr, flush=True)
    for run in _load_chain_runs():
        try:
            start_chain_hd(run["project"], run["node_id"], run.get("scene") or "", float(run.get("scale_by") or 2.0),
                           run.get("shot_ids") or None)
            resumed += 1
        except Exception as error:  # noqa: BLE001
            print(f"resume: chain {run.get('project')}: {error}", file=sys.stderr, flush=True)
    print(f"resume: watching {watched} running node(s), resumed {resumed} chain run(s)", file=sys.stderr, flush=True)
    return {"watched": watched, "chains": resumed}


if __name__ == "__main__":
    # --http [port]: one shared server for every machine on the tailnet
    #   claude mcp add --transport http ai-cinema-canvas http://<this machine>:8004/mcp
    # Without it: a stdio child of one client, as before.
    if "--http" in sys.argv:
        from mcp.server.transport_security import TransportSecuritySettings
        rest = sys.argv[sys.argv.index("--http") + 1:]
        mcp.settings.host = os.environ.get("AI_CINEMA_MCP_HOST", "0.0.0.0")
        mcp.settings.port = int(rest[0]) if rest and rest[0].isdigit() else 8004
        # Reached by Tailscale IP or machine name, not only localhost; the tailnet is
        # the access boundary, as it is for the backend on :8003.
        mcp.settings.transport_security = TransportSecuritySettings(enable_dns_rebinding_protection=False)
        # No tool pushes anything to the client, so no sessions and no standalone SSE
        # stream: each call is a plain request/response. A stateful server logged
        # ClosedResourceError from that stream whenever a client dropped (2026-09-18).
        mcp.settings.stateless_http = True
        mcp.settings.json_response = True
        threading.Thread(target=_resume_after_restart, name="resume-after-restart", daemon=True).start()
        # A client that gives up before the proactor finishes accepting leaves
        # WinError 64 ("network name no longer available") in asyncio's log with a
        # full traceback, twice per drop. Only that connection is affected, so it
        # goes out as a one-line warning (2026-09-19).
        import logging

        class _DroppedClient(logging.Filter):
            def filter(self, record: logging.LogRecord) -> bool:
                exc = record.exc_info[1] if record.exc_info else None
                if isinstance(exc, OSError) and getattr(exc, "winerror", None) == 64:
                    record.levelno, record.levelname = logging.WARNING, "WARNING"
                    record.msg, record.args, record.exc_info, record.exc_text = (
                        "client dropped the connection before it was accepted (WinError 64)",
                        (), None, None)
                return True

        logging.getLogger("asyncio").addFilter(_DroppedClient())
        # AI_CINEMA_MCP_TOKEN set: every request must carry "Authorization: Bearer <token>",
        # loopback included -- a tunnel (Tailscale Funnel, cloudflared) delivers public
        # traffic from 127.0.0.1, so exempting localhost would exempt the internet.
        # Unset: the tailnet stays the only boundary, as before.
        token = env_value("AI_CINEMA_MCP_TOKEN")
        if token:
            import hmac
            import uvicorn

            inner = mcp.streamable_http_app()
            expected = f"Bearer {token}".encode()

            async def app(scope, receive, send):
                if scope["type"] == "http":
                    got = dict(scope.get("headers") or []).get(b"authorization", b"")
                    if not hmac.compare_digest(got, expected):
                        await send({"type": "http.response.start", "status": 401,
                                    "headers": [(b"content-type", b"text/plain"),
                                                (b"www-authenticate", b"Bearer")]})
                        await send({"type": "http.response.body", "body": b"unauthorized"})
                        return
                await inner(scope, receive, send)

            uvicorn.run(app, host=mcp.settings.host, port=mcp.settings.port,
                        log_level=mcp.settings.log_level.lower())
        else:
            mcp.run(transport="streamable-http")
    else:
        mcp.run(transport="stdio")
