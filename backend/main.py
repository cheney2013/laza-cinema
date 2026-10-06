"""
LAZA CINEMA STUDIO backend — an infinite canvas for film shots, driving local ComfyUI models.
Models: FLUX.1-Kontext-dev (character consistency) / FLUX.2-dev (general)

Configuration (environment variables):
  BACKEND_PORT        port for this FastAPI server          (default 8003)
  COMFYUI_URL         ComfyUI base URL                      (default http://127.0.0.1:8188)
  GENERATION_ENABLED  set to "0" to block all generation    (default enabled)
"""

import os
import sys
import re
import tempfile
import json
import math
import uuid
import random
import asyncio
import logging
from logging.handlers import TimedRotatingFileHandler
import shutil
import subprocess
import time
import hashlib
import ctypes
from pathlib import Path
from collections import deque
from contextlib import asynccontextmanager
from contextvars import ContextVar
from typing import Optional, Callable, Awaitable, Literal
from datetime import datetime, timezone
from urllib.parse import urlparse

import httpx
from comfyui_client import _http as comfyui_client_http
from envfile import env_value
import version_info
from fastapi import FastAPI, UploadFile, File, HTTPException, Request
from fastapi import Header as _Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse, HTMLResponse, Response, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from comfyui_client import ComfyUIClient, ComfyUIError, COMFYUI_OUTPUT_DIR, COMFYUI_INPUT_DIR
from workflow_builders import DEFAULT_H3_ACCEL as _BUILDER_H3_ACCEL, DEFAULT_H3_STEPS, accel_for_unet
from machine_profile import PROFILE as MACHINE_PROFILE, public_profile, require_node, require_preset, require_upscale_method, substitute_preset, substitute_unet

# The attention patch a request gets when it names none: H3_ACCEL (environment or .env), else this machine's
# profile ("kjsage" on a 16 GB card, where "sol" smeared faces), else the builders' default.
DEFAULT_H3_ACCEL = env_value("H3_ACCEL") or MACHINE_PROFILE.get("h3_accel") or _BUILDER_H3_ACCEL
from h3_prompt_builder import build_smart_fallback_h3_prompt
import accounts
import artifact_pruner
import face_crop
import face_prompt
import subtitle_translate
from node_sizing import enforce_node_floors
import take_history
import bible
import speech
import project_assets
import asset_origin
import asset_dims
import job_scheduler as sched
import provenance
import audio_lock
import audio_redo
import win_accept_patch

# A client dropping mid-accept must not close the :8003 listener (see the module).
win_accept_patch.install()

# ── Logging ────────────────────────────────────────────────────────────────────
# Console + a rotating file, because start.ps1 launches uvicorn in a throwaway
# PowerShell window: without a FileHandler every request log dies with that window.
# Rotates at midnight and keeps 7 days (backend.log, backend.log.2026-08-30, ...).
LOG_DIR = Path(__file__).parent / "logs"
LOG_DIR.mkdir(exist_ok=True)

_log_format = logging.Formatter(
    "%(asctime)s %(levelname)s %(name)s: %(message)s"
)
_file_handler = TimedRotatingFileHandler(
    LOG_DIR / "backend.log", when="midnight", backupCount=7, encoding="utf-8"
)
_file_handler.setFormatter(_log_format)
_file_handler.suffix = "%Y-%m-%d"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    handlers=[logging.StreamHandler(), _file_handler],
)
# uvicorn installs its own handlers with propagate=False, so its access/error
# lines never reach the root logger -- attach the file handler to them directly.
for _name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
    logging.getLogger(_name).addHandler(_file_handler)

logger = logging.getLogger("ai_cinema")

# ── Configuration ──────────────────────────────────────────────────────────────
BACKEND_PORT = int(os.environ.get("BACKEND_PORT", "8003"))
# Safety guard: set GENERATION_ENABLED=0 to block ALL generation even if ComfyUI is reachable
GENERATION_ENABLED = os.environ.get("GENERATION_ENABLED", "1") != "0"

_BACKEND_DIR = Path(__file__).parent
UPLOAD_DIR = _BACKEND_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)
asset_dims.configure(_BACKEND_DIR / "asset_dims.json")
VRAM_FOOTPRINTS_FILE = UPLOAD_DIR / "vram_footprints.json"
sched.load_learned(VRAM_FOOTPRINTS_FILE)
PROJECTS_DIR = _BACKEND_DIR / "projects"
PROJECTS_DIR.mkdir(exist_ok=True)

STATE_FILE = UPLOAD_DIR / "state.json"

comfyui = ComfyUIClient()

# ── Job queue (single worker — jobs run strictly one at a time) ────────────────
JobRunner = Callable[[dict], Awaitable[dict]]
_pending: list[dict] = []        # queued + currently running jobs (in order)
_history: list[dict] = []        # last HISTORY_LIMIT completed jobs
_active_job: Optional[dict] = None
# Runners of queued jobs by id. The worker takes the first queued job in
# _pending order, so reordering _pending (pin to top) reorders execution.
_runners: dict[str, JobRunner] = {}
_queue_wake: asyncio.Event = asyncio.Event()
# Model family last run on ComfyUI (job_scheduler.describe), None when unknown.
# Decides whether the next job pays an unload, and how the planner groups jobs.
_resident_family: Optional[str] = None
# A chained render that stepped aside at a chunk boundary for a short job; it is
# still "running" but not _active_job until the short job ends.
_suspended: list[dict] = []
_yield_depth = 0

# Completed jobs are kept so a canvas node that was mid-generation when the page
# (or the backend) went away can still find its verdict when it comes back. 50
# scrolled out within one batch run; a node whose job had scrolled out could
# never leave "generating".
HISTORY_LIMIT = 200
# Every finished job's duration record (job_scheduler.timing_record), kept
# beyond HISTORY_LIMIT so estimates keep improving as renders accumulate.
TIMING_FILE = UPLOAD_DIR / "timing.jsonl"
TIMING_KEEP = 2000
_timing_records: list[dict] = []
SHUTDOWN_ERROR = "Backend restarted while the job was running; please generate again."

def save_state():
    try:
        STATE_FILE.write_text(json.dumps({
            "queue": _pending,
            "history": _history,
            "active_job": _active_job,
        }))
    except Exception:
        logger.warning("Failed to persist job state", exc_info=True)


def load_state():
    global _pending, _history, _active_job
    if not STATE_FILE.exists():
        return
    try:
        data = json.loads(STATE_FILE.read_text())
        _history = data.get("history", [])
        _active_job = data.get("active_job")
        _pending = data.get("queue", [])
    except Exception:
        logger.warning("Failed to load job state", exc_info=True)
    _load_timing()


def _load_timing():
    """Read timing.jsonl; seed it from the job history the first time."""
    global _timing_records
    records = []
    if TIMING_FILE.exists():
        for line in TIMING_FILE.read_text(encoding="utf-8").splitlines():
            try:
                records.append(json.loads(line))
            except ValueError:
                continue
    else:
        records = [r for r in (sched.timing_record(j) for j in _history) if r]
        try:
            TIMING_FILE.write_text("".join(json.dumps(r) + "\n" for r in records),
                                   encoding="utf-8")
        except OSError:
            logger.warning("Could not seed %s", TIMING_FILE, exc_info=True)
    _timing_records = records[-TIMING_KEEP:]


def _record_timing(job: dict, prompts: list[dict]) -> None:
    rec = sched.timing_record(job, prompts)
    if not rec:
        return
    rec["job_id"] = job.get("id")
    job["timing"] = {k: rec[k] for k in ("span", "paged", "step_med", "pre", "post")
                     if k in rec}
    _timing_records.append(rec)
    del _timing_records[:-TIMING_KEEP]
    try:
        with TIMING_FILE.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec) + "\n")
    except OSError:
        logger.warning("Could not append to %s", TIMING_FILE, exc_info=True)


def _estimator() -> sched.Estimator:
    return sched.Estimator(_history, _timing_records)


# ── Background job worker ──────────────────────────────────────────────────────

async def _job_worker_supervisor():
    """Keep exactly one _job_worker alive.

    There is a single worker and nothing used to restart it, so any escape from
    its loop stranded every queued job with no visible cause -- the UI just stopped
    advancing. Cancellation (shutdown) still propagates; anything else restarts.
    """
    while True:
        try:
            await _job_worker()
            logger.info("Job worker returned; supervisor exiting")
            return
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.error("Job worker crashed, restarting in 1s: %s", e, exc_info=True)
            await asyncio.sleep(1)


async def _job_worker():
    """Single worker loop: takes the next job the scheduler picks and runs it."""
    while True:
        job, runner = await _next_job()
        await _execute_job(job, runner)


def _job_sched(job: dict) -> dict:
    """The job's family/units; jobs saved before the scheduler existed get them now."""
    if not job.get("sched"):
        job["sched"] = sched.describe(job.get("type", ""), job.get("request"))
    return job["sched"]


LOST_CONTACT_MARK = "ComfyUI server disconnected or unreachable"
LOST_CONTACT_WAIT_S = 2 * 3600


async def _after_lost_contact(job: dict, runner: JobRunner, error: ComfyUIError) -> dict:
    """The backend lost contact with ComfyUI mid-render: ComfyUI very likely finished it anyway.

    Four history polls in a row timing out (ComfyUI busy decoding an upscale) used to fail the
    job while the prompt went on rendering and wrote its file, so the finished HD belonged to no
    node and the next chain run rendered the shot again (c17b, 2026-10-02: error 11:29, file
    written 11:35, rendered a third time by the chain). Wait here until ComfyUI says the prompt is
    settled, then run the job once more: the identical graph is answered from ComfyUI's cache, so
    the result is collected, not computed again. Gives the original error back when contact does
    not return or the job cannot be run again.
    """
    prompt_id = job.get("prompt_id")
    if not prompt_id or job.get("request") is None or LOST_CONTACT_MARK not in str(error):
        raise error
    job["phase"] = "和 ComfyUI 断了联系，等它做完这次生成再收结果…"
    save_state()
    deadline = time.time() + LOST_CONTACT_WAIT_S
    while True:
        if job.get("status") == "cancelled":
            raise error
        state, _ = await comfyui.prompt_state(prompt_id)
        if state not in ("running", "pending", "unreachable"):
            break
        if time.time() > deadline:
            raise error
        await asyncio.sleep(RECOVERY_POLL_S)
    logger.info("Job %s: ComfyUI prompt %s settled (%s) after lost contact; collecting the result",
                job["id"], prompt_id, state)
    job.pop("phase", None)
    collected = await _collect_finished(job)
    if collected is not None:
        return collected
    return await runner(job)


async def _execute_job(job: dict, runner: JobRunner) -> None:
    """Run one job with full bookkeeping. Also used for a job that cuts in between
    two chunks of a chain (_yield_between_chunks)."""
    global _active_job, _resident_family
    family = _job_sched(job)["family"]
    stats = await comfyui.get_system_stats()
    # What this process remembers, else what ComfyUI last ran: a model already in VRAM must not be
    # unloaded for "lack of room" that is really its own weights.
    resident = _resident_family or await comfyui.last_family()
    freed = False
    if sched.should_free(resident, family, stats):
        # What is loaded would not leave room for this family: its weights beside the others' page RAM
        # and slow every step (Qwen next to H3: 36 s/step). /free applies between prompts. When the
        # numbers say it fits, nothing is unloaded.
        try:
            freed = await comfyui.free_memory(unload_models=True, free_memory=True)
            logger.info("Unloaded before %s job %s (resident %s, free %s)", family, job["id"],
                        resident, comfyui.describe_room(stats))
        except Exception:  # noqa: BLE001 -- never block a render on the unload
            logger.warning("free_memory before job %s failed", job["id"], exc_info=True)
    # None without the aicinema_vram node. /free only takes effect when the next prompt starts, so after
    # one the weights this job ends with are all its own: measured from zero, not from what is still shown.
    loaded_before = 0 if freed else await comfyui.loaded_vram_bytes()
    _active_job = job
    keep_for_restart = False
    job["status"] = "running"
    job["started_at"] = datetime.now(timezone.utc).isoformat()
    timing_seq = comfyui.timing_seq + 1
    save_state()

    try:
        logger.info("Starting job %s (%s)", job["id"], job["type"])
        try:
            result = await runner(job)
        except ComfyUIError as lost:
            if job.get("status") == "cancelled":
                raise
            result = await _after_lost_contact(job, runner, lost)
        # cancel_job() marks the job and interrupts ComfyUI, but the runner may
        # still return normally if the work finished first. Don't advertise a
        # cancelled job as done.
        if job.get("status") == "cancelled":
            logger.info("Job %s finished but was cancelled; keeping cancelled",
                        job["id"])
        else:
            job["status"] = "done"
            job["result"] = result
            # The one moment a generated file's origin is knowable: the
            # request that asked for it named a project, and the result
            # names the files. Nobody records this afterwards.
            asset_origin.record(
                job.get("project_id"),
                asset_origin.harvest_urls(result),
                job_type=job["type"], job_id=job["id"],
            )
            logger.info("Finished job %s (%s)", job["id"], job["type"])
    except asyncio.CancelledError:
        # The worker task is only ever cancelled by lifespan shutdown (a user
        # cancel goes through cancel_job(), which interrupts ComfyUI instead).
        # Record it as an error with an explicit cause: the UI used to get a
        # bare "cancelled" here and, having no handler for that status, left
        # the node spinning on "initialising" forever after every restart.
        if job.get("status") != "cancelled":
            if job.get("request") is not None or (job.get("prompt_id") and _is_recoverable(job)):
                # The next start picks it up: from ComfyUI, or by running it again.
                keep_for_restart = True
            else:
                job["status"] = "error"
                job["error"] = SHUTDOWN_ERROR
        logger.info("Job %s interrupted by backend shutdown", job["id"])
        # Re-raise so shutdown still stops the loop. Previously this used
        # `break`, which killed the single worker permanently -- every later
        # job then sat in the queue forever and the UI never advanced.
        raise
    except ComfyUIError as e:
        # A user cancel surfaces here as "Execution interrupted"; keep the
        # cancelled status rather than downgrading it to a generic error.
        if job.get("status") == "cancelled":
            job["error"] = "Job cancelled by user"
            logger.info("Job %s ended via cancel: %s", job["id"], e)
        else:
            job["status"] = "error"
            job["error"] = str(e)
            logger.error("ComfyUI error for job %s: %s", job["id"], e)
    except Exception as e:
        job["status"] = "error"
        job["error"] = str(e)
        logger.error("Unexpected error for job %s: %s", job["id"], e, exc_info=True)
    finally:
        # Only a job that reached ComfyUI changed what is loaded there. The
        # charswap runner unloads Viggle itself when it ends.
        if sched.is_heavy(family) and job.get("prompt_id"):
            _resident_family = None if family == "viggle" else family
            if loaded_before is not None:
                after = await comfyui.loaded_vram_bytes()
                if after is not None and sched.note_loaded(family, loaded_before, after):
                    sched.save_learned(VRAM_FOOTPRINTS_FILE)
        if not keep_for_restart:
            job["completed_at"] = datetime.now(timezone.utc).isoformat()
            # A job that cut in took its own prompts first, so these are ours.
            _record_timing(job, comfyui.take_timings(timing_seq))
            if job in _pending:
                _pending.remove(job)
            _history.append(job)
            del _history[:-HISTORY_LIMIT]
        _active_job = None
        save_state()


# Job type -> (request model name, runner name). Names, not objects: most are
# defined further down this module, and are looked up when a job is replayed.
_REPLAYABLE: dict[str, tuple[str, str]] = {
    "video": ("VideoRequest", "_run_video_job"),
    "video_edit": ("VideoRequest", "_run_video_job"),
    "video_edit_window": ("EditWindowRequest", "_run_edit_window_job"),
    "audio_refine": ("AudioRefineRequest", "_run_audio_refine_job"),
    "video_cleanup": ("VideoCleanupRequest", "_run_video_cleanup_job"),
    "video_continue_tail": ("ContinueTailRequest", "_run_continue_tail_job"),
    "video_trim": ("VideoTrimRequest", "_run_video_trim_job"),
    "video_depth": ("VideoDepthRequest", "_run_video_depth_job"),
    "wardrobe_swap_h3": ("WardrobeSwapRequest", "_run_wardrobe_swap_job"),
    "character_sheet": ("CharacterSheetRequest", "_run_character_sheet_job"),
    "video_reshot": ("TemporalReshotRequest", "_run_temporal_reshot_job"),
    "av_bridge": ("AVBridgeRequest", "_run_av_bridge_job"),
    "music": ("MusicRequest", "_run_music_job"),
    "ambience": ("AmbienceRequest", "_run_ambience_job"),
    "speech": ("SpeechRequest", "_run_speech_job"),
    "inpaint": ("InpaintRequest", "_run_inpaint_job"),
    "qwen_image": ("QwenImageRequest", "_run_qwen_image_job"),
    "image_upscale": ("ImageUpscaleRequest", "_run_image_upscale_job"),
    "world_gaussian": ("WorldGaussianRequest", "_run_world_gaussian_job"),
    "route_gaussian": ("RouteGaussianRequest", "_run_route_gaussian_job"),
    "gaussian_model": ("GaussianModelRequest", "_run_gaussian_model_job"),
    "interpolate": ("VideoInterpolateRequest", "_run_video_interpolate_job"),
    "upscale": ("VideoUpscaleRequest", "_run_video_upscale_job"),
    "charswap": ("CharswapRequest", "_run_charswap_job"),
    "reangle": ("ReangleRequest", "_run_reangle_split_job"),
    "orbit": ("OrbitRequest", "_run_orbit_job"),
}


def _enqueue(job: dict, runner: JobRunner) -> None:
    _runners[job["id"]] = runner
    _queue_wake.set()


def _runnable() -> list[dict]:
    return [j for j in _pending if j.get("status") == "queued" and j.get("id") in _runners]


def _remaining_seconds(job: Optional[dict], est: sched.Estimator) -> float:
    """Seconds left for a started job.

    Before the sampler moves: the learned total minus time elapsed. Once it has
    stepped twice in a single-stage job, the live step rate takes over:
    (steps left x seconds per step) + the learned decode/save tail. A step rate
    PAGED_STEP_RATIO times the predicted one marks the job as paging, which is
    shown in the queue; the live figure is used either way.
    """
    if not job:
        return 0.0
    started = sched._ts(job.get("started_at")) or sched.now_ts()
    planned = max(0.0, est.seconds(job) - (sched.now_ts() - started))
    pid = job.get("prompt_id")
    if job is not _active_job or not pid:
        return planned
    prog = comfyui.get_progress(pid)
    step, total, speed = prog.get("step") or 0, prog.get("max") or 0, prog.get("speed")
    if not speed or step < 2 or not total or "sampler" not in (prog.get("node_type") or "").lower():
        return planned
    expected = est.step_seconds(job)
    job["sched_paged"] = bool(expected and speed > sched.PAGED_STEP_RATIO * expected)
    if _job_sched(job).get("stages", 1) > 1:
        return max(planned, (total - step) * speed)
    return (total - step) * speed + est.post_seconds(job)


def _replan() -> list[dict]:
    """Order _pending the way the scheduler will run it and stamp each queued job
    with its expected start (sched_eta, seconds from now) and why it moved
    (sched_reason). _pending order is what the UI shows as place in line."""
    est = _estimator()
    queued = [j for j in _pending if j.get("status") == "queued"]
    for j in queued:
        _job_sched(j)
    start_in = _remaining_seconds(_active_job, est) + sum(
        _remaining_seconds(j, est) for j in _suspended)
    order = sched.plan(queued, _resident_family, sched.now_ts(), start_in, est)
    for entry in order:
        entry["job"]["sched_eta"] = round(entry["eta"])
        entry["job"]["sched_reason"] = entry["reason"]
    for entry in order:
        rng = est.interval(entry["job"])
        entry["job"]["sched_range"] = [round(rng[0]), round(rng[1])] if rng else None
        entry["job"]["sched_source"] = est.source(entry["job"])
    if _active_job is not None:
        _active_job["sched_remaining"] = round(_remaining_seconds(_active_job, est))
        _active_job["sched_source"] = est.source(_active_job)
    others = [j for j in _pending if j.get("status") != "queued"]
    _pending[:] = others + [e["job"] for e in order]
    return [e["job"] for e in order]


async def _next_job() -> tuple[dict, JobRunner]:
    """Wait for, and take, the queued job the scheduler puts first."""
    while True:
        if _runnable():
            runnable = {j["id"] for j in _runnable()}
            for job in _replan():
                if job["id"] in runnable:
                    return job, _runners.pop(job["id"])
        _queue_wake.clear()
        await _queue_wake.wait()


async def _yield_between_chunks(parent: dict) -> None:
    """Between two chunks of a chain, let short queued jobs run.

    Only the top-level job does this (a job that cut in never yields again), at
    most three jobs per boundary. Same-family short jobs go straight in;
    other families only once they have waited long, since they cost two model
    switches (see job_scheduler.cut_in). The running chunk is never interrupted.
    """
    global _active_job, _yield_depth, _resident_family
    if _yield_depth or parent is not _active_job:
        return
    family = _job_sched(parent)["family"]
    phase = parent.get("phase")
    for _ in range(3):
        pick = sched.cut_in(_runnable(), family, sched.now_ts(), _estimator())
        if pick is None:
            break
        runner = _runners.pop(pick["id"])
        logger.info("Job %s cuts in between chunks of %s", pick["id"], parent["id"])
        parent["phase"] = f"{phase or ''}（让路给短任务）"
        pick["sched_reason"] = "在长链分段间插入"
        _suspended.append(parent)
        _yield_depth += 1
        stepped_aside = time.time()
        try:
            await _execute_job(pick, runner)
        finally:
            parent["sched_suspended"] = (float(parent.get("sched_suspended") or 0.0)
                                         + time.time() - stepped_aside)
            _yield_depth -= 1
            _suspended.remove(parent)
            _active_job = parent
            parent["phase"] = phase
            save_state()
        if sched.should_free(_resident_family or await comfyui.last_family(), family,
                             await comfyui.get_system_stats()):
            await comfyui.free_memory(unload_models=True, free_memory=True)
            _resident_family = family  # the chain's next chunk loads it again
        if parent.get("status") == "cancelled":
            raise ComfyUIError("Job cancelled by user")


def pin_job(job_id: str) -> bool:
    """Put a queued job ahead of every unpinned one. False if not queued."""
    for job in _pending:
        if job.get("id") == job_id and job.get("status") == "queued":
            job["pinned"] = time.time()
            _replan()
            save_state()
            return True
    return False


def _replay_runner(job: dict) -> Optional[JobRunner]:
    """Rebuild a job's runner from the request it was submitted with, or None."""
    entry = _REPLAYABLE.get(job.get("type"))
    if not entry or not isinstance(job.get("request"), dict):
        return None
    model_name, runner_name = entry
    try:
        req = globals()[model_name].model_validate(job["request"])
        fn = globals()[runner_name]
    except Exception:  # noqa: BLE001 -- a request this code no longer accepts is not replayable
        logger.warning("Cannot replay job %s (%s)", job.get("id"), job.get("type"), exc_info=True)
        return None
    return lambda j: fn(j, req)


async def submit_job(job_type: str, runner: JobRunner, request: Optional[BaseModel] = None,
                     **metadata) -> dict:
    """Create a job entry, enqueue it, and return immediately with the job ID.

    `request` is kept in state.json so a job the backend had not finished when it
    restarted can be queued again (see _replay_runner).
    """
    if not GENERATION_ENABLED:
        raise HTTPException(
            status_code=503,
            detail="Generation is disabled. Set GENERATION_ENABLED=1 to enable."
        )

    job_id = str(uuid.uuid4())
    job = {
        "id": job_id,
        "type": job_type,
        "status": "queued",
        "progress": 0.0,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "started_at": None,
        "completed_at": None,
        "result": None,
        "error": None,
        # Captured here, in the request's context; the worker runs in its own
        # task and can no longer see the header by the time the job starts.
        "project_id": current_project_id(),
        **metadata,
    }
    req_dump = request.model_dump(mode="json") if request is not None else None
    if req_dump is not None and job_type in _REPLAYABLE:
        job["request"] = req_dump
    job["sched"] = sched.describe(job_type, req_dump)
    _pending.append(job)
    save_state()
    _enqueue(job, runner)
    logger.info("Queued job %s (%s), queue length: %d", job_id, job_type, len(_pending))
    return {"job_id": job_id, "status": "queued"}


# ── Recovering jobs across a backend restart ──────────────────────────────────
#
# A restart used to fail every running job before asking ComfyUI anything, and
# then interrupt the render. But ComfyUI keeps rendering on its own, and its
# /history says what came out. For jobs whose result is the ComfyUI file as is,
# the verdict is taken from there: a finished render lands on its node, a render
# still in progress is watched to the end.

# Job types whose runner returns ComfyUI's output file unchanged, from one prompt.
# Anything that post-processes (joins chunks, extracts a still, re-encodes) is not
# here: the file ComfyUI saved is not what the node expects.
RECOVERABLE_JOB_TYPES = {"video", "video_reshot", "av_bridge", "music", "ambience"}
RECOVERY_POLL_S = 5.0
_recovery_tasks: set = set()


def _is_recoverable(job: dict) -> bool:
    return bool(job.get("prompt_id")) and job.get("type") in RECOVERABLE_JOB_TYPES


def _finish_recovered(job: dict, status: str, *, result: Optional[dict] = None, error: Optional[str] = None) -> None:
    job["status"] = status
    job["result"] = result
    job["error"] = error
    job["recovery_checked"] = True
    job["completed_at"] = datetime.now(timezone.utc).isoformat()
    job.pop("phase", None)
    if result:
        asset_origin.record(job.get("project_id"), asset_origin.harvest_urls(result),
                            job_type=job["type"], job_id=job["id"])
    save_state()


def _apply_prompt_state(job: dict, state: str, outputs: dict) -> bool:
    """Settle `job` from its prompt's state. False while the render is still going."""
    if state in ("running", "pending"):
        return False
    if state == "success":
        files, latent = comfyui.output_files(outputs)
        if not files:
            _finish_recovered(job, "error", error="ComfyUI 显示已完成，但没有输出文件")
            return True
        item = files[0]
        if item["filename"].startswith("H3_Chunk_"):
            # The job's prompt id is only its last chunk and the runner's own
            # post-processing never ran. Run the job again: ComfyUI still holds
            # this prompt's outputs in its cache, so an identical graph comes back
            # at once instead of rendering again.
            runner = _replay_runner(job)
            if runner is not None:
                job.update(status="queued", progress=0.0, started_at=None, prompt_id=None,
                           error=None, requeued_after_restart=True, recovery_checked=True)
                job.pop("phase", None)
                if job in _history:
                    _history.remove(job)
                _pending.append(job)
                save_state()
                _enqueue(job, runner)
                logger.info("Re-ran chunked job %s after restart (expecting a ComfyUI cache hit)", job["id"])
                return True
            _finish_recovered(job, "error", error=(
                "后端重启时这条分段生成还没拼接，只找回了最后一段 "
                f"{item['filename']}（comfy_output 里有各段），请重新生成或手动收回"))
            return True
        sub = f"{item['subfolder']}/" if item.get("subfolder") else ""
        result = {
            "url": f"/comfy_output/{sub}{item['filename']}",
            "filename": item["filename"],
            "comfy_filename": item["filename"],
            **(job.get("recovery_extras") or {}),
            "recovered": True,
        }
        if latent:
            result["latent_filename"] = latent
            result["latent_url"] = f"/comfy_output/{latent}"
        _finish_recovered(job, "done", result=result)
        logger.info("Recovered job %s (%s) from ComfyUI history: %s", job["id"], job["type"], result["url"])
        return True
    if state == "unreachable":
        # Cannot tell; the next restart asks again.
        job["status"], job["error"] = "error", SHUTDOWN_ERROR
        job["completed_at"] = datetime.now(timezone.utc).isoformat()
        save_state()
        return True
    message = {"error": "ComfyUI 执行出错（后端重启期间）",
               "interrupted": "ComfyUI 的这次生成被中断了"}.get(state, SHUTDOWN_ERROR)
    _finish_recovered(job, "error", error=message)
    return True


async def _watch_recovered(job: dict) -> None:
    try:
        while True:
            state, outputs = await comfyui.prompt_state(job["prompt_id"])
            if _apply_prompt_state(job, state, outputs):
                return
            await asyncio.sleep(RECOVERY_POLL_S)
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001
        logger.warning("Watching recovered job %s failed", job.get("id"), exc_info=True)


async def _recover_job(job: dict) -> bool:
    """Try to settle a job from a previous process. True if it was taken over (done or watched)."""
    if not _is_recoverable(job):
        return False
    state, outputs = await comfyui.prompt_state(job["prompt_id"])
    if state in ("running", "pending"):
        job["status"] = "running"
        job["error"] = None
        job["phase"] = "后端重启过，正在等 ComfyUI 完成这次生成…"
        save_state()
        task = asyncio.create_task(_watch_recovered(job))
        _recovery_tasks.add(task)
        task.add_done_callback(_recovery_tasks.discard)
        logger.info("Watching job %s across restart (ComfyUI prompt %s is %s)", job["id"], job["prompt_id"], state)
        return True
    _apply_prompt_state(job, state, outputs)
    return job["status"] == "done"


def _after_prompt(prompt_id: str, runner: JobRunner) -> JobRunner:
    """Wrap `runner` so it starts only once ComfyUI prompt `prompt_id` has settled."""
    async def run(job: dict):
        job["phase"] = "后端重启过：等 ComfyUI 做完原来那次，再交一遍会直接命中缓存…"
        while True:
            state, _ = await comfyui.prompt_state(prompt_id)
            if state not in ("running", "pending"):
                break
            await asyncio.sleep(RECOVERY_POLL_S)
        job.pop("phase", None)
        job["prompt_id"] = prompt_id   # a requeued job's own id was cleared; this is the render to collect
        collected = await _collect_finished(job)
        if collected is not None:
            return collected
        job["prompt_id"] = None
        return await runner(job)
    return run


# ── App lifecycle ──────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _active_job
    load_state()

    # Pre-flight check: verify ComfyUI is reachable
    comfy_ok = await comfyui.health_check()
    if not comfy_ok:
        logger.warning(
            "⚠️  ComfyUI is NOT reachable at %s. Generation will fail until ComfyUI is running.",
            comfyui.base_url
        )
    else:
        logger.info("✓ Connected to ComfyUI at %s", comfyui.base_url)

    if not GENERATION_ENABLED:
        logger.warning("GENERATION DISABLED — safety guard is active. Set GENERATION_ENABLED=1 to enable.")

    # Jobs from a previous process can't be resumed (request payloads aren't
    # persisted). Mark them failed, and stop the ComfyUI prompts they queued:
    # a render nobody will ever collect would otherwise hold the GPU and make the
    # next job sit at "queued" for its whole duration.
    stale_jobs = list(_pending)
    if _active_job and all(j.get("id") != _active_job.get("id") for j in stale_jobs):
        stale_jobs.insert(0, _active_job)
    _active_job = None
    _pending.clear()
    replay: list[tuple[dict, JobRunner]] = []
    for stale in stale_jobs:
        if stale.get("status") == "cancelled":
            # Cancelled but its runner had not wound down when the process stopped
            # (2026-09-29: a cancelled whole-span upscale was re-queued, reattached to
            # its still-running prompt and started again). Stop the prompt once more
            # and file the job as cancelled.
            if stale.get("prompt_id"):
                await comfyui.cancel_prompt(stale["prompt_id"])
            stale["completed_at"] = stale.get("completed_at") or datetime.now(timezone.utc).isoformat()
            _history.append(stale)
            continue
        # A render ComfyUI already holds is collected from ComfyUI, not run twice.
        runner = None if (stale.get("prompt_id") and _is_recoverable(stale)) else _replay_runner(stale)
        if runner is not None:
            if stale.get("prompt_id"):
                # Started a render whose result cannot be taken from ComfyUI as is
                # (the runner post-processes it). Leave that render running, wait
                # for it, then run the job again: the identical graph is answered
                # from ComfyUI's cache, so the restart costs nothing. (It used to be
                # interrupted here and rendered again from the first step.)
                runner = _after_prompt(stale["prompt_id"], runner)
            stale.update(status="queued", progress=0.0, started_at=None, prompt_id=None,
                         error=None, requeued_after_restart=True)
            stale.pop("phase", None)
            _pending.append(stale)
            replay.append((stale, runner))
            continue
        stale["status"] = "error"
        stale["error"] = SHUTDOWN_ERROR
        stale["completed_at"] = datetime.now(timezone.utc).isoformat()
        _history.append(stale)
    del _history[:-HISTORY_LIMIT]
    save_state()
    for job, runner in replay:
        _enqueue(job, runner)
    if replay:
        logger.info("Re-queued %d job(s) the previous backend process had not finished", len(replay))
    # Before giving up on a job, ask ComfyUI: it may have finished the render
    # while the backend was down, or still be on it. Jobs a previous restart
    # already failed this way (or was still watching) get the same question.
    stale_ids = {j.get("id") for j in stale_jobs}
    for job in list(_history):
        earlier = job.get("id") not in stale_ids and not job.get("recovery_checked") and (
            job.get("status") == "running" or job.get("error") == SHUTDOWN_ERROR)
        if job.get("id") in stale_ids or earlier:
            if await _recover_job(job):
                continue
            if job.get("id") in stale_ids and job.get("prompt_id") and not _is_recoverable(job) \
                    and job.get("status") == "error":
                await comfyui.abandon_prompt(job["prompt_id"])

    worker = asyncio.create_task(_job_worker_supervisor())
    vram_sampler = asyncio.create_task(_vram_sampler())
    try:
        yield
    finally:
        interrupted = _active_job
        vram_sampler.cancel()
        worker.cancel()
        # Let the worker's except/finally run to completion so the job's verdict
        # is written to state.json before the process exits, rather than relying
        # on asyncio.run()'s best-effort task cleanup.
        try:
            await asyncio.wait_for(asyncio.gather(worker, return_exceptions=True), timeout=5)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            logger.warning("Job worker did not finish shutting down in time")
        for task in list(_recovery_tasks):
            task.cancel()
        # The interrupted job's ComfyUI render is left running on purpose: the
        # next start waits for it and reruns the job against ComfyUI's cache.


app = FastAPI(title=version_info.NAME, version=version_info.version(), lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Accounts ──────────────────────────────────────────────────────────────────
# Identity only: these endpoints tell the client who it is, they do not gate the
# rest of the API (the canvas MCP server and tools/*.py call it without a token).
# See accounts.py for why registration is open.

class AuthRequest(BaseModel):
    username: str
    password: str


class PasswordChangeRequest(BaseModel):
    old_password: str
    new_password: str


def _bearer(authorization: Optional[str]) -> Optional[str]:
    if not authorization:
        return None
    parts = authorization.split(None, 1)
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1].strip()
    return authorization.strip()


def _auth_http(exc: accounts.AuthError) -> HTTPException:
    return HTTPException(status_code=exc.status, detail=exc.message)


@app.post("/auth/register")
async def auth_register(req: AuthRequest):
    try:
        return accounts.register(req.username, req.password)
    except accounts.AuthError as exc:
        raise _auth_http(exc)


@app.post("/auth/login")
async def auth_login(req: AuthRequest):
    try:
        return accounts.login(req.username, req.password)
    except accounts.AuthError as exc:
        raise _auth_http(exc)


# Passwordless sign-in for the one test account agents use to check the studio
# in a browser (2026-09-19). Allowed only for a request made on this
# machine directly: tailscaled serves :8443 by forwarding to localhost, so a
# loopback address alone is not proof -- any forwarding header refuses it.
# A page on another site cannot use it from a local browser either: its Origin
# must be the studio's own. The account is not an admin (accounts refuses one).
TEST_LOGIN_USER = os.environ.get("AI_CINEMA_TEST_LOGIN_USER", "claude-test")
_LOOPBACK = {"127.0.0.1", "::1", "localhost"}
_FORWARD_HEADERS = ("x-forwarded-for", "x-forwarded-host", "x-real-ip", "forwarded",
                    "tailscale-user-login", "tailscale-user-name")


@app.post("/auth/test-login")
async def auth_test_login(request: Request):
    host = request.client.host if request.client else ""
    forwarded = [h for h in _FORWARD_HEADERS if h in request.headers]
    origin = request.headers.get("origin", "")
    origin_host = urlparse(origin).hostname if origin else ""
    if not TEST_LOGIN_USER or host not in _LOOPBACK or forwarded             or (origin and origin_host not in _LOOPBACK):
        raise HTTPException(status_code=403, detail="免密登录只接受本机直接发起的请求")
    try:
        return accounts.login_without_password(TEST_LOGIN_USER)
    except accounts.AuthError as exc:
        raise _auth_http(exc)


@app.get("/auth/me")
async def auth_me(authorization: Optional[str] = _Header(None)):
    """Who this token belongs to. `user: null` means the client should log in
    again -- that is how a stale localStorage token gets cleared."""
    return {"user": accounts.resolve(_bearer(authorization))}


@app.post("/auth/logout")
async def auth_logout(authorization: Optional[str] = _Header(None)):
    return {"ok": accounts.logout(_bearer(authorization))}


@app.post("/auth/password")
async def auth_change_password(req: PasswordChangeRequest,
                               authorization: Optional[str] = _Header(None)):
    try:
        accounts.change_password(_bearer(authorization), req.old_password, req.new_password)
    except accounts.AuthError as exc:
        raise _auth_http(exc)
    return {"ok": True}


# ── Which project a request speaks for ────────────────────────────────────────
# Every generation and upload endpoint needs this and none of them should have to
# carry it: the project id is context, not an argument, and threading it through
# a dozen unrelated request models would be a dozen places to forget it. The
# client states it once per request in a header; anything that creates a file
# reads it from here.

_REQUEST_PROJECT: ContextVar[Optional[str]] = ContextVar("request_project", default=None)


def current_project_id() -> Optional[str]:
    """The project this request was made from, or None when the client said nothing."""
    return _REQUEST_PROJECT.get()


# Endpoints that make a file synchronously are spread across the whole module and
# there are dozens of them; asking each to remember to record what it made is a
# rule that would hold for a week. Everything they make comes back as a URL in a
# JSON body, so the origin is read off the way out instead — once, here.
_ORIGIN_BODY_LIMIT = 256 * 1024


@app.middleware("http")
async def _capture_project_header(request, call_next):
    project_id = request.headers.get("x-project-id") or None
    token = _REQUEST_PROJECT.set(project_id)
    try:
        response = await call_next(request)
        if project_id and request.method in ("POST", "PUT") and response.status_code < 300                 and response.headers.get("content-type", "").startswith("application/json"):
            body = b"".join([chunk async for chunk in response.body_iterator])
            if len(body) <= _ORIGIN_BODY_LIMIT:
                try:
                    asset_origin.record(
                        project_id,
                        asset_origin.harvest_urls(json.loads(body)),
                        job_type=f"{request.method} {request.url.path}",
                    )
                except (json.JSONDecodeError, UnicodeDecodeError):
                    pass
            response = Response(
                content=body, status_code=response.status_code,
                headers=dict(response.headers), media_type=response.media_type,
            )
        return response
    finally:
        _REQUEST_PROJECT.reset(token)


class _RevalidatingStaticFiles(StaticFiles):
    """Static files that the browser must re-check before reusing.

    Files under uploads/ are rewritten in place under the same name (a
    re-cut voice clip, a re-exported cut). Without a Cache-Control header
    Chrome keeps the old bytes by heuristic and keeps playing the old file
    after the disk has changed (2026-09-06). ETag/Last-Modified revalidation
    is one cheap 304 per load; a stale media file cost an hour.
    """

    def file_response(self, *args, **kwargs):  # type: ignore[override]
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response


app.mount("/uploads", CORSMiddleware(_RevalidatingStaticFiles(directory=str(UPLOAD_DIR)), allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]), name="uploads")

if COMFYUI_OUTPUT_DIR:
    _comfy_output_path = Path(COMFYUI_OUTPUT_DIR)
    _comfy_output_path.mkdir(parents=True, exist_ok=True)
    app.mount("/comfy_output", CORSMiddleware(_RevalidatingStaticFiles(directory=str(_comfy_output_path)), allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]), name="comfy_output")

# Gaussian Splatting static assets (gsplat-bundle.js, precise_orbit_controls.js)
app.mount("/gaussian/js", CORSMiddleware(StaticFiles(directory=str(_BACKEND_DIR)), allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]), name="gaussian_js")


# ── Local file resolution ──────────────────────────────────────────────────────

def _is_own_url(url: str) -> bool:
    """True if the URL points at this backend (its files live in UPLOAD_DIR or COMFYUI_OUTPUT_DIR)."""
    if not url.startswith("http"):
        return True  # relative URL like /uploads/xxx.png or /comfy_output/xxx.mp4
    parsed = urlparse(url)
    return parsed.hostname in ("127.0.0.1", "localhost") and (parsed.port or 80) == BACKEND_PORT


async def resolve_upload(url_or_name: str) -> Path:
    """
    Resolve an /uploads/ or /comfy_output/ URL (relative or absolute) or bare filename to a local path.
    Our own URLs are read directly from disk; genuinely external URLs are downloaded.
    """
    # 0. Inline data URI (e.g. a canvas screenshot node) — decode and persist it.
    #    urlparse() would otherwise shove the whole base64 payload into .path and
    #    Path(...).name would slice it at the last "/" inside the base64 alphabet.
    if url_or_name.startswith("data:"):
        import base64
        header, _, encoded = url_or_name.partition(",")
        if not encoded:
            raise FileNotFoundError("Malformed data URI: no payload")
        mime = header[5:].split(";")[0]
        ext = {
            "image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg",
            "image/webp": ".webp", "video/mp4": ".mp4",
        }.get(mime, ".png")
        try:
            payload = base64.b64decode(encoded)
        except Exception as exc:
            raise FileNotFoundError(f"Malformed data URI: {exc}") from exc
        inline_path = UPLOAD_DIR / f"inline_{hashlib.sha1(payload).hexdigest()[:16]}{ext}"
        if not inline_path.exists():
            inline_path.write_bytes(payload)
        return inline_path

    parsed_path = urlparse(url_or_name).path
    name = Path(parsed_path).name

    # 1. Check UPLOAD_DIR
    local_path = UPLOAD_DIR / name
    if local_path.exists() and local_path.is_file():
        return local_path

    # 1b. A file in a subdirectory of uploads (voice_refs/<project>/x.wav). Only the
    #     basename was tried above, so nested assets were "not found" and the cut
    #     room's prepare-asset call died with a 500 (2026-09-06). Stay inside
    #     UPLOAD_DIR: a "../" in the URL must not walk out of it.
    rel = parsed_path.lstrip("/")
    if rel.startswith("uploads/"):
        nested = (UPLOAD_DIR / rel[len("uploads/"):]).resolve()
        try:
            nested.relative_to(UPLOAD_DIR.resolve())
        except ValueError:
            nested = None
        if nested is not None and nested.is_file():
            return nested

    # 2. Check COMFYUI_OUTPUT_DIR
    if COMFYUI_OUTPUT_DIR:
        clean_rel = parsed_path.lstrip("/")
        for prefix in ("comfy_output/", "uploads/"):
            if clean_rel.startswith(prefix):
                clean_rel = clean_rel[len(prefix):]
        comfy_file = Path(COMFYUI_OUTPUT_DIR) / clean_rel
        if comfy_file.exists() and comfy_file.is_file():
            return comfy_file
        comfy_name = Path(COMFYUI_OUTPUT_DIR) / name
        if comfy_name.exists() and comfy_name.is_file():
            return comfy_name

    # 3. Check COMFYUI_INPUT_DIR
    if COMFYUI_INPUT_DIR:
        comfy_in = Path(COMFYUI_INPUT_DIR) / name
        if comfy_in.exists() and comfy_in.is_file():
            return comfy_in

    # 4. External URL
    if url_or_name.startswith("http") and not _is_own_url(url_or_name):
        async with comfyui_client_http(timeout=60) as client:
            r = await client.get(url_or_name)
            r.raise_for_status()
            local_path.write_bytes(r.content)
        return local_path

    raise FileNotFoundError(f"File not found in uploads or ComfyUI output: {name}")


def resolve_seed(seed: int) -> int:
    return seed if seed != -1 else random.randint(0, 2**32 - 1)


# ── Health ─────────────────────────────────────────────────────────────────────

@app.get("/version")
async def get_version():
    """The studio's name, version (the VERSION file) and the commit this backend runs from."""
    return version_info.info()


@app.get("/health")
async def health():
    comfy_ok = await comfyui.health_check()
    return {
        "status": "ok",
        "comfyui": comfy_ok,
        "generation_enabled": GENERATION_ENABLED and comfy_ok,
        "safety_guard": "active" if not GENERATION_ENABLED else "inactive",
    }


# nvidia-smi is a process spawn that can take up to its 1.5s timeout while the
# GPU is busy. Two components poll /system-stats every 5s, so without this the
# event loop was being frozen repeatedly and every other request queued behind
# it -- which is what made clicking anything in the UI feel unresponsive.
_NVML_CACHE: dict = {"at": 0.0, "value": []}
_NVML_TTL = 2.0


async def get_nvml_vram_async() -> list[dict]:
    """Cached, off-the-event-loop wrapper around get_nvml_vram()."""
    loop = asyncio.get_running_loop()
    now = loop.time()
    if _NVML_CACHE["value"] and now - _NVML_CACHE["at"] < _NVML_TTL:
        return _NVML_CACHE["value"]
    value = await asyncio.to_thread(get_nvml_vram)
    _NVML_CACHE["at"] = now
    _NVML_CACHE["value"] = value
    return value


def get_nvml_vram() -> list[dict]:
    """Query nvidia-smi for accurate WDDM physical VRAM usage (Task Manager level)."""
    try:
        res = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu", "--format=csv,nounits,noheader"],
            capture_output=True, text=True, check=True, timeout=1.5
        )
        gpus = []
        for line in res.stdout.strip().split("\n"):
            if not line.strip():
                continue
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 3:
                total_mib, used_mib, free_mib = (float(p) for p in parts[:3])

                def number(i):
                    try:
                        return float(parts[i])
                    except (IndexError, ValueError):  # "[N/A]" on some drivers
                        return None
                gpus.append({
                    "total": int(total_mib * 1024 * 1024),
                    "used": int(used_mib * 1024 * 1024),
                    "free": int(free_mib * 1024 * 1024),
                    "util": number(3),
                    "temp": number(4),
                })
        return gpus
    except Exception:
        return []


# VRAM history for the header's click-through: a sample every 5 s, kept for an
# hour, taken by the backend itself so the numbers do not depend on a page being
# open. The peak is the highest sample, so a spike shorter than 5 s can be missed.
VRAM_SAMPLE_S = 5.0
VRAM_WINDOW_S = 3600.0
_vram_samples: deque = deque(maxlen=int(VRAM_WINDOW_S / VRAM_SAMPLE_S) + 60)


async def _comfy_running_prompt(client: httpx.AsyncClient) -> tuple[Optional[bool], Optional[str]]:
    """(generating, prompt_id) of what ComfyUI is executing; (None, None) when it cannot be asked."""
    try:
        r = await client.get(f"{comfyui.base_url}/queue", timeout=2.0)
        if r.status_code != 200:
            return None, None
        running = r.json().get("queue_running") or []
        return bool(running), (running[0][1] if running and len(running[0]) > 1 else None)
    except Exception:
        return None, None


def _job_for_prompt(prompt_id: Optional[str]) -> Optional[dict]:
    """The job that submitted ComfyUI prompt `prompt_id`. The backend's active job
    can already be the next one while ComfyUI still runs the previous prompt."""
    if not prompt_id:
        return None
    for j in ([_active_job] if _active_job else []) + list(_pending) + list(reversed(_history)):
        if j and j.get("prompt_id") == prompt_id:
            return j
    return None


async def _vram_sampler() -> None:
    # Each sample is (time, used, total, generating). The average is taken over
    # generating samples only (idle VRAM is not what the number is for);
    # the peak over every sample.
    async with comfyui_client_http() as client:
        while True:
            try:
                gpus = await get_nvml_vram_async()
                if gpus:
                    busy, prompt_id = await _comfy_running_prompt(client)
                    job = _job_for_prompt(prompt_id)
                    tag = {"prompt_id": prompt_id} if prompt_id else None
                    if job:
                        req = job.get("request") or {}
                        tag = {"id": job.get("id"), "prompt_id": prompt_id, "type": job.get("type"),
                               "family": (job.get("sched") or {}).get("family"),
                               "length": req.get("length") if isinstance(req, dict) else None}
                    _vram_samples.append((time.time(), gpus[0]["used"], gpus[0]["total"], bool(busy), tag))
            except Exception:
                logger.debug("VRAM sample failed", exc_info=True)
            await asyncio.sleep(VRAM_SAMPLE_S)


@app.get("/system-stats/vram-history")
async def vram_history_endpoint(raw: bool = False):
    """VRAM use (GPU 0) over the last hour: average while generating, peak overall.

    raw=true also returns every sample with the job that was running, and a
    per-job summary, so one render's footprint can be told from another's.
    """
    cutoff = time.time() - VRAM_WINDOW_S
    window = [s for s in _vram_samples if s[0] >= cutoff]
    if not window:
        return {"samples": 0, "window_s": VRAM_WINDOW_S, "sample_s": VRAM_SAMPLE_S}
    peak = max(window, key=lambda s: s[1])
    busy = [s for s in window if s[3]]
    extra = {}
    if raw:
        rows, per_job = [], {}
        for s in window:
            tag = s[4] if len(s) > 4 else None
            rows.append({"at": datetime.fromtimestamp(s[0], timezone.utc).isoformat(),
                         "used": s[1], "generating": s[3], "job": tag})
            if tag and s[3]:
                j = per_job.setdefault(tag.get("id") or tag.get("prompt_id"), {**tag, "samples": 0, "sum": 0, "peak": 0,
                                                   "first": rows[-1]["at"]})
                j["samples"] += 1
                j["sum"] += s[1]
                j["peak"] = max(j["peak"], s[1])
                j["last"] = rows[-1]["at"]
        extra = {"rows": rows, "jobs": [
            {k: v for k, v in {**j, "avg": j["sum"] // j["samples"]}.items() if k != "sum"}
            for j in per_job.values()]}
    return {
        **extra,
        "samples": len(window),
        "window_s": VRAM_WINDOW_S,
        "sample_s": VRAM_SAMPLE_S,
        "covered_s": round(window[-1][0] - window[0][0], 1),
        "vram_total": window[-1][2],
        "generating_s": round(len(busy) * VRAM_SAMPLE_S, 1),
        "avg_used": int(sum(s[1] for s in busy) / len(busy)) if busy else None,
        "peak_used": peak[1],
        "peak_at": datetime.fromtimestamp(peak[0], timezone.utc).isoformat(),
    }


# Who holds the GPU. nvidia-smi cannot say on Windows (WDDM reports every
# process as [N/A]), but the OS's own "GPU Process Memory" counters can: per
# process, what sits in dedicated VRAM and what has spilled to shared (system)
# memory. The spill is what makes a render crawl, and it is usually caused by
# some other program holding VRAM at the same time -- which is exactly what
# this is for (2026-09-29: a FlashWorld run held 15 GB and pushed 27 GB of an
# H3 render into shared memory).
_VRAM_PROCS_PS = r"""
$ErrorActionPreference = 'SilentlyContinue'
$rows = @{}
foreach ($s in (Get-Counter '\GPU Process Memory(*)\Dedicated Usage','\GPU Process Memory(*)\Shared Usage').CounterSamples) {
  if ($s.InstanceName -notmatch 'pid_(\d+)') { continue }
  $p = [int]$matches[1]
  if (-not $rows.ContainsKey($p)) { $rows[$p] = @{ pid = $p; dedicated = [double]0; shared = [double]0 } }
  if ($s.Path -match 'dedicated') { $rows[$p].dedicated += $s.CookedValue } else { $rows[$p].shared += $s.CookedValue }
}
$out = foreach ($r in $rows.Values) {
  if ($r.dedicated + $r.shared -lt 200MB) { continue }
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($r.pid)"
  $parent = if ($proc) { Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.ParentProcessId)" }
  [pscustomobject]@{ pid = $r.pid; dedicated = [int64]$r.dedicated; shared = [int64]$r.shared;
    name = "$($proc.Name)"; cmd = "$($proc.CommandLine)"; parent_cmd = "$($parent.CommandLine)";
    started = if ($proc.CreationDate) { $proc.CreationDate.ToString('o') } else { '' } }
}
ConvertTo-Json -Compress -InputObject @($out)
"""
_VRAM_PROCS_CACHE: dict = {"at": 0.0, "value": None}


def _vram_process_label(row: dict) -> str:
    """A name a person recognises: ComfyUI, the project folder a script runs from, else the exe."""
    text = f"{row.get('cmd', '')} {row.get('parent_cmd', '')}"
    if "comfyui" in text.lower() and "main.py" in text:
        return "ComfyUI"
    project = re.search(r"[\\/]Projects[\\/]([^\\/\s\"]+)", text, re.I)
    if project:
        return project.group(1)
    return re.sub(r"\.exe$", "", row.get("name") or "?", flags=re.I)


def get_vram_processes() -> dict:
    if sys.platform != "win32":
        return {"supported": False, "processes": []}
    res = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", _VRAM_PROCS_PS],
                         capture_output=True, text=True, timeout=15)
    rows = json.loads(res.stdout or "[]") or []
    if isinstance(rows, dict):
        rows = [rows]
    gpus = get_nvml_vram()
    total = gpus[0]["total"] if gpus else None
    out = []
    for row in rows:
        # The compositor's counter reports its whole shared surface pool as
        # "dedicated" (106 GB on a 32 GB card); that is not VRAM it holds.
        if (row.get("name") or "").lower() == "dwm.exe" or (total and row.get("dedicated", 0) > total):
            continue
        cmd = " ".join((row.get("cmd") or "").split())
        out.append({"pid": row["pid"], "label": _vram_process_label(row), "name": row.get("name"),
                    "dedicated": row.get("dedicated", 0), "shared": row.get("shared", 0),
                    "cmd": cmd[:300], "started": row.get("started") or None})
    out.sort(key=lambda r: r["dedicated"] + r["shared"], reverse=True)
    return {"supported": True, "processes": out, "vram_total": total}


@app.get("/system-stats/vram-processes")
async def vram_processes_endpoint():
    """Per-process dedicated VRAM and shared-memory spill (Windows performance counters)."""
    loop = asyncio.get_running_loop()
    now = loop.time()
    cached = _VRAM_PROCS_CACHE
    if cached["value"] is not None and now - cached["at"] < 3.0:
        return cached["value"]
    try:
        value = await asyncio.to_thread(get_vram_processes)
    except Exception as exc:
        raise HTTPException(500, f"could not read GPU process counters: {exc}")
    cached["at"], cached["value"] = now, value
    return value


@app.get("/machine-profile")
async def machine_profile_endpoint():
    """Per-machine H3 defaults (H3_MACHINE_PROFILE), for the studio's new nodes."""
    return public_profile()


@app.get("/system-stats")
async def get_system_stats_endpoint():
    try:
        stats = await comfyui.get_system_stats()
    except Exception:
        stats = {}

    # Prefer driver-level physical VRAM (matches Task Manager) over ComfyUI's view
    nv_vram = await get_nvml_vram_async()

    vram_stats = []
    if "devices" in stats:
        for idx, device in enumerate(stats["devices"]):
            if idx < len(nv_vram):
                vram_total = nv_vram[idx]["total"]
                vram_used = nv_vram[idx]["used"]
                vram_free = nv_vram[idx]["free"]
            else:
                vram_total = device.get("vram_total", 0)
                vram_free = device.get("vram_free", 0)
                vram_used = vram_total - vram_free

            vram_pct = (vram_used / vram_total * 100) if vram_total > 0 else 0

            # Clean up name: "cuda:0 NVIDIA GeForce RTX 5090 : cudaMallocAsync" -> "NVIDIA GeForce RTX 5090"
            raw_name = device.get("name", "Unknown GPU")
            name = raw_name
            if "NVIDIA" in raw_name:
                parts = raw_name.split("NVIDIA")
                if len(parts) > 1:
                    name = "NVIDIA " + parts[1].split(":")[0].strip()

            nv = nv_vram[idx] if idx < len(nv_vram) else {}
            vram_stats.append({
                "name": name,
                "gpu_util": nv.get("util"),
                "gpu_temp": nv.get("temp"),
                "vram_total": vram_total,
                "vram_free": vram_free,
                "vram_used": vram_used,
                "vram_pct": round(vram_pct, 1),
            })

    ram_stats = {}
    if "system" in stats:
        sys = stats["system"]
        ram_total = sys.get("ram_total", 0)
        ram_free = sys.get("ram_free", 0)
        ram_used = ram_total - ram_free
        ram_pct = (ram_used / ram_total * 100) if ram_total > 0 else 0
        ram_stats = {
            "ram_total": ram_total,
            "ram_free": ram_free,
            "ram_used": ram_used,
            "ram_pct": round(ram_pct, 1),
        }

    return {
        "comfyui_connected": bool(stats),
        "vram": vram_stats,
        "ram": ram_stats,
    }


# ── Queue ──────────────────────────────────────────────────────────────────────

def _active_job_view() -> Optional[dict]:
    """The active job plus live progress, with a phase for every stage.

    comfyui.get_progress only knows about a prompt between queue_prompt and
    wait_for_result returning. Before that (uploading inputs, extracting poses,
    building the graph) and after it (fetching and saving outputs) it reports no
    phase, and the UI fell back to a made-up "loading weights" line.
    """
    if not _active_job:
        return None
    prompt_id = _active_job.get("prompt_id")
    progress = comfyui.get_progress(prompt_id)
    if not progress.get("phase"):
        progress["phase"] = ("正在准备素材与构建工作流…" if not prompt_id
                             else "正在回收输出并保存结果…")
    return {**_active_job, "progress": progress}


def _find_job(job_id: str) -> Optional[dict]:
    """Look up a job by id across active, queued and completed jobs."""
    if _active_job and _active_job.get("id") == job_id:
        return _active_job_view()
    for j in _pending:
        if j.get("id") == job_id:
            return j
    for j in reversed(_history):
        if j.get("id") == job_id:
            return j
    return None


# What a queued job carries that a queue poll never reads: the whole request body (prompts and reference lists)
# and the compiled prompt. 200 queued jobs made /queue 1.8 MB, of which 1.6 MB was these, and every open
# studio polls it every few seconds. `?full=1` gives them back; /job/{id} and `tracked` always do.
_QUEUE_ROW_DROP = ("request", "prompt", "recovery_extras", "result")


def _queue_row(job: dict) -> dict:
    return {k: v for k, v in job.items() if k not in _QUEUE_ROW_DROP}


@app.get("/queue")
async def get_queue(ids: Optional[str] = None, full: bool = False):
    """Return queue state + live step progress for the active job.

    `ids` (comma-separated job ids) makes the answer definitive for those jobs:
    each comes back under `tracked` whatever its state, or is listed in
    `missing` when this process has no record of it. The 20-entry `history`
    window alone could not tell "still running" from "scrolled out of view",
    and a client waiting on the latter waited forever.
    """
    tracked: dict[str, dict] = {}
    missing: list[str] = []
    for job_id in (ids or "").split(","):
        job_id = job_id.strip()
        if not job_id:
            continue
        job = _find_job(job_id)
        if job is None:
            missing.append(job_id)
        else:
            tracked[job_id] = job
    _replan()
    return {
        "pending": _pending if full else [_queue_row(j) for j in _pending],
        "active": _active_job_view(),
        "history": [{k: v for k, v in j.items() if k != "recovery_extras"} for j in _history[-20:]],
        "tracked": tracked,
        "missing": missing,
    }


@app.get("/job/{job_id}")
async def get_job(job_id: str):
    """
    Look up a single job by id — works for queued, active and completed jobs.
    Batch/scripted productions need this: /queue only exposes the last 20 history
    entries, so results scroll out of view long before a multi-shot film finishes.
    """
    job = _find_job(job_id)
    if job is None:
        raise HTTPException(404, f"No job with id {job_id}")
    return job


@app.get("/job/{job_id}/live-preview")
async def job_live_preview(job_id: str):
    """Redirect to the newest live-preview clip of a running job.

    The live-preview plugin writes a new file per sampler step and deletes the
    previous one, so any URL copied from a progress poll goes stale within a step.
    This stable address always forwards to the current file. The redirect itself
    must not be cached, or it would pin a deleted step. 404 when the job has no
    preview (not started, or finished: previews are removed with the job).
    """
    job = _find_job(job_id)
    if job is None:
        raise HTTPException(404, f"No job with id {job_id}")
    prompt_id = job.get("prompt_id")
    preview = (comfyui.get_progress(prompt_id) or {}).get("preview") if prompt_id else None
    url = (preview or {}).get("url")
    if not url:
        raise HTTPException(404, "No live preview for this job right now")
    return RedirectResponse(url, status_code=307, headers={"Cache-Control": "no-store"})


@app.post("/queue/pin/{job_id}")
async def pin_queued_job(job_id: str):
    """Move a queued job to the front of the queue (runs after the active job)."""
    if not pin_job(job_id):
        raise HTTPException(404, f"No queued job with id {job_id}")
    return {"status": "pinned", "pending": [j.get("id") for j in _pending]}


@app.post("/cancel-job/{job_id}")
async def cancel_job(job_id: str):
    """Cancel a pending or active job and interrupt ComfyUI execution."""
    if _active_job and _active_job.get("id") == job_id:
        prompt_id = _active_job.get("prompt_id")
        _active_job["status"] = "cancelled"
        _active_job["error"] = "Job cancelled by user"
        save_state()
        await comfyui.cancel_prompt(prompt_id)
        logger.info("Cancelled active job %s (prompt_id=%s)", job_id, prompt_id)
        return {"status": "cancelling"}

    for j in _suspended:
        # A chain stepped aside for a short job; it stops at its next boundary.
        if j.get("id") == job_id:
            j["status"] = "cancelled"
            j["error"] = "Job cancelled by user"
            save_state()
            return {"status": "cancelling"}

    for j in _pending:
        if j.get("id") == job_id:
            prompt_id = j.get("prompt_id")
            j["status"] = "cancelled"
            j["error"] = "Job cancelled by user"
            _pending.remove(j)
            _runners.pop(job_id, None)
            _history.append(j)
            save_state()
            if prompt_id:
                await comfyui.cancel_prompt(prompt_id)
            logger.info("Cancelled pending job %s (prompt_id=%s)", job_id, prompt_id)
            return {"status": "cancelled"}

    return {"status": "not_found"}


# ── Artifact cleanup ───────────────────────────────────────────────────────────

_last_prune_at = 0.0
PRUNE_MIN_INTERVAL_S = 300      # frequent reloads / extra tabs must not rescan


@app.post("/prune-artifacts")
async def prune_artifacts(force: bool = False, dry_run: bool = False):
    """Drop generated files no canvas references. Manual only.

    Nothing calls this on its own any more — the asset library owns cleanup, and
    an automatic pass that deletes a file the user has not seen listed is exactly
    what it replaced. This endpoint stays for the CLI in tools/prune_artifacts.py
    and for scripted batches. Scanning is blocking file IO, so it runs in a
    thread -- doing it inline would stall every other request behind it.
    """
    global _last_prune_at
    now = time.monotonic()
    if not force and now - _last_prune_at < PRUNE_MIN_INTERVAL_S:
        return {"status": "skipped",
                "reason": f"ran {int(now - _last_prune_at)}s ago",
                "retry_after_s": int(PRUNE_MIN_INTERVAL_S - (now - _last_prune_at))}
    _last_prune_at = now

    workspaces = _BACKEND_DIR / "workspaces"
    targets = [UPLOAD_DIR]
    if COMFYUI_OUTPUT_DIR:
        targets.append(Path(COMFYUI_OUTPUT_DIR))
    try:
        res = await asyncio.to_thread(
            artifact_pruner.prune, workspaces, targets,
            artifact_pruner.DEFAULT_MIN_AGE_MINUTES, not dry_run)
    except Exception as e:
        # An unreadable canvas aborts the pass rather than risk deleting live files.
        logger.warning("prune-artifacts aborted: %s", e)
        return {"status": "error", "error": str(e)}

    if res["deleted"] or res["doomed"]:
        logger.info("prune-artifacts: %s %d files (%.2f GiB), left %d foreign files alone",
                    "would delete" if dry_run else "deleted",
                    len(res["doomed"]) if dry_run else res["deleted"],
                    res["bytes"] / 2**30, res["left_alone"])
    return {
        "status": "ok",
        "dry_run": dry_run,
        "deleted": res["deleted"],
        "candidates": len(res["doomed"]),
        "freed_bytes": res["bytes"],
        "left_alone": res["left_alone"],
        "too_new": res["too_new"],
        "referenced": res["referenced"],
    }


@app.post("/free-memory")
async def free_memory():
    """Trigger ComfyUI /free to unload cached models and clear GPU VRAM cache."""
    ok = await comfyui.free_memory(unload_models=True, free_memory=True)
    return {"status": "ok" if ok else "error"}


# ── ComfyUI inputs ────────────────────────────────────────────────────────────

async def ensure_comfyui_uploaded(filename_or_url: str) -> str:
    """
    Ensure a reference file is available in ComfyUI.
    If the file already resides in ComfyUI's input or output directory, zero copy is needed.
    """
    if not filename_or_url:
        return ""
    name = Path(urlparse(filename_or_url).path).name
    try:
        local_path = await resolve_upload(filename_or_url)
    except Exception as e:
        logger.warning("Could not resolve reference %s: %s", filename_or_url, e)
        return name

    # Check if already in ComfyUI input directory
    if COMFYUI_INPUT_DIR and (Path(COMFYUI_INPUT_DIR) / name).is_file():
        return name

    # Check if in ComfyUI output directory - copy to input directory locally in 0ms
    if COMFYUI_OUTPUT_DIR and COMFYUI_INPUT_DIR:
        src = Path(COMFYUI_OUTPUT_DIR) / name
        dst = Path(COMFYUI_INPUT_DIR) / name
        if src.is_file() and not dst.is_file():
            try:
                import shutil
                shutil.copy2(src, dst)
                return name
            except Exception:
                pass

    try:
        if name.lower().endswith((".m4a", ".mp3", ".wav", ".flac", ".ogg", ".aac")):
            await comfyui.upload_audio(local_path.read_bytes(), name)
        elif name.lower().endswith((".mp4", ".avi", ".mov", ".mkv")):
            await comfyui.upload_video(local_path.read_bytes(), name)
        else:
            await comfyui.upload_image(local_path.read_bytes(), name)
    except Exception as e:
        logger.warning("Failed to upload %s to ComfyUI: %s", name, e)
    return name


# ── Video generation & Editing (MiniMax H3 Native Video + Audio) ──────────────

class VideoRequest(BaseModel):
    prompt: str
    mode: Optional[str] = None              # 't2va' | 'i2va' | 'fl2va' | 'l2va' | 'ref2va' | 'edit' | 'continuation'
    image_url: Optional[str] = None         # first frame (I2VA / FL2VA start)
    last_frame_url: Optional[str] = None    # last frame (FL2VA end / L2VA)
    # Pixel frame the last_frame_url image is pinned at (MiniMaxH3AddGuide);
    # -1 is the last frame, any other value anchors it mid-clip.
    last_frame_index: int = -1
    # Any number of images pinned at pixel frames through chained MiniMaxH3AddGuide
    # nodes: [{"url": ..., "frame_index": 36}, {"url": ..., "frame_index": -1}].
    guide_frames: list[dict] = []
    # True: guide frame numbers count frames of the clip as delivered, and the motion-context
    # overlap is added here. False (older nodes): the numbers already include the overlap.
    guide_frames_delivered: bool = False
    # 钉住末帧: the clip this node showed before the re-run. Its last frame is cut
    # out and pinned at the new take's last frame, so the next chain -- which
    # continues from that ending -- does not have to be re-run (2026-09-29).
    pin_last_frame_of: Optional[str] = None
    ref_image_urls: list[str] = []          # maps to <Picture 1>, <Picture 2>, ...
    ref_audio_urls: list[str] = []          # maps to <Audio 1>, <Audio 2>, ...
    ref_video_urls: list[str] = []          # maps to <Video 1>, <Video 2>, ...
    audio_strategy: Optional[str] = "auto"  # 'copy_source' | 'revoice' | 'reference' | 'new'
    width: int = MACHINE_PROFILE["width"]
    height: int = MACHINE_PROFILE["height"]
    # None follows the machine profile (tiled on 16 GB cards).
    tiled_vae_decode: Optional[bool] = None
    # False for a job whose product is only its sound (配音): no latent file and no live-preview clips.
    save_latent: bool = True
    live_preview: bool = True
    steps: int = DEFAULT_H3_STEPS           # 4 (preview) / 8 (final) / 20 (base)
    seed: int = -1
    length: int = 124                       # 17k+5 grid: 124, 175, 226, 311, 430
    duration: Optional[float] = None
    fps: float = 24.0
    scheduler: str = "simple"
    ref_image_size: str = "match"   # 'match' | 'max' (2048px short edge)
    # The default checkpoint has the turbo LoRA merged in, so nothing is stacked
    # live. Set this (with a base unet) only to go back to the LoRA path.
    lora_name: str = ""
    lora_strength: float = 1.0
    # None by default (2026-09-09). From 2026-08-29 to 09-09 this
    # defaulted to AfterMidnight ref2va rank64 v1.2 and every render stacked
    # it unasked -- the accepted takes of that stretch carry it.
    style_lora_name: str = ""
    style_lora_strength: float = 1.0
    # Several style LoRAs, stacked in order: [{"name": ..., "strength": ...}]
    style_loras: list = []
    sage: str = DEFAULT_H3_ACCEL
    shift_video: float = 12.0
    shift_audio: float = 3.0
    # The default fused checkpoint has Mystic 0.7 motion merged in and cannot be
    # dialled back. A shot that needs restrained motion names the hybrid base
    # here and brings its own turbo LoRA (see workflow_builders.build_h3_video_workflow).
    unet_name: Optional[str] = None
    # 'fused'  — the fused checkpoint: most motion, most detail, 4/8 NFE.
    # 'hybrid' — hybrid base + live turbo LoRA on the beta scheduler.
    #
    # Measured on a 39-frame car-chase shot, as peak-to-peak pitch of the car
    # body: mystic 42.4 degrees, restrained 34.7. Neither removes the pitch; H3
    # draws a fast car as a car working its springs whatever it is told. Pick
    # 'hybrid' when a shot needs the body to sit still, and expect to
    # stabilise the rest in post.
    motion_preset: Optional[str] = None
    # Speed LoRA for presets that stack one live (every preset but 'fused'):
    # 'turbo8' (default) -- the preset's own 8-step turbo LoRA, steps locked to 8.
    # 'taomate3' -- TaoMate-H3 3-step distill, steps locked to 3. Chain 7 v11 same
    #   seed: whole job 103-108 s vs 203-222 s for turbo8, per-step time unchanged;
    #   cooler grade, hotter lamp. Chain 11 back to back (2026-09-16): weaker prompt
    #   adherence and audio, so it is opt-in.
    # 'none' -- no speed LoRA, 20 steps (the official r2v template).
    # 'fused' is always 8. The request's steps only apply with an explicit lora_name.
    accel_lora: Optional[str] = None
    # Chunked continuation. A master that is one unbroken camera move is
    # generated 5 seconds at a time and each chunk continues the last: name the
    # latent the previous chunk saved (H3_Latent_<tag>_00001_.safetensors) and
    # its tail is pinned as never-denoised rows, then trimmed off the front of
    # this chunk's picture so the pieces butt together (2026-09-07).
    motion_context_latent: Optional[str] = None
    # Continue from a video file instead of a latent, for clips nothing saved
    # a latent for: a trimmed chunk, an edit, an upload.
    motion_context_video: Optional[str] = None
    # With motion_context_video: carry its tail as an exact preserved AV prefix of
    # this many frames (39/90/141/...) instead of MotionContext rows. 0 = off.
    existing_context_length: int = 0
    # With motion_context_video: continue from the first N frames of it (the point N/24 s
    # into the clip) instead of its last frame, for a chain that skips a cutaway. 0 = off.
    motion_context_end_frame: int = 0
    motion_context_length: int = 22          # 5 | 22 | 39 | 56 -- the only whole latent steps
    motion_context_audio: int = 24
    # Build a long clip as a chain of chunks inside one workflow instead of one
    # long sample. 0 is off; 124 is 5.17 s and the size a 15 s master fits in.
    chunk_frames: int = 0
    # A grey-box animation that drives the camera frame for frame. Unlike a
    # reference video it is read frame-aligned, so it must be as long as the
    # clip; in a chunked run each chunk reads its own window.
    control_video_url: Optional[str] = None
    # Source clip aligned to target frame 0 through MiniMaxH3AddGuide. This is
    # separate from both a soft reference video and Fun ControlNet.
    guide_video_url: Optional[str] = None
    # CrossView re-angle (set by /reangle, see ReangleRequest): the warp spec with
    # "source" as an uploads URL, the sparse-attention patch, and a sampler override.
    crossview_warp: Optional[dict] = None
    block_sparse: bool = False
    # Audio locks: recordings put on a second of the DELIVERED clip and kept as
    # recorded while the rest of the sound is generated around them. Each entry:
    # {"url": recording, "at": seconds, "strength": 0..1 (default 1), "text": words}
    # (see backend/audio_lock.py for what was measured and why some placements are refused).
    audio_locks: list = []
    audio_lock_feather: float = 0.0
    # Redo only the sound of a finished render (backend/audio_redo.py): {"mode", "steps",
    # "denoise"} and the saved latent of the take it redoes (a name in ComfyUI's output).
    audio_redo: Optional[dict] = None
    refine_latent: str = ""
    # ...or a plain video prepared for encoding (main._prepare_upscale_source_video): an absolute path.
    refine_video_path: str = ""
    sampler: str = ""
    # Send the prompt to the model as written, without the structured-prompt
    # fallback. A LoRA trained on a bare trigger word (CrossView: "crossview")
    # was never shown the six-section form the fallback would wrap it in.
    raw_prompt: bool = False
    control_strength: float = 1.0
    control_skip_frames: int = 0
    chunk_index: int = -1


def _make_on_queued(job: dict):
    def on_queued(prompt_id):
        job["prompt_id"] = prompt_id
        save_state()
        # A cancel that lands while the job is still preparing finds no prompt_id to
        # interrupt, and the prompt went on to render as a ghost the queue showed as
        # "cancelled" while the next job sat "queued" behind it (2026-09-24).
        if job.get("status") == "cancelled":
            logger.info("Job %s was cancelled before its prompt %s was queued; abandoning it",
                        job.get("id"), prompt_id)
            asyncio.get_event_loop().create_task(comfyui.abandon_prompt(prompt_id))
    return on_queued


#: The preset a shot gets when it names none: singularity on the workstation again
#: since 2026-10-02; it was fused from 2026-09-18 (it got the C3 door pull right).
#: Singularity was the default from 2026-09-07:
#: across four Last-of-Us shots (segments A, C, H, K, same prompt/refs/seed/8
#: steps) it renders the light the set actually has, so an unlit corner comes
#: back unlit instead of being filled. That is taken as correct and it is the
#: look this production is graded for. Costs nothing in time -- measured 305 vs
#: 308 s, 353 vs 362 s, 345 vs 350 s against "fused". Reach for "fused" when a
#: shot needs the wider expression range, or for anything that needs
#: adaln_basis / adaln_mean (Fun ControlNet's curve-form basis), which the
#: Singularity checkpoint does not carry.
#: machine_profile picks it per box: "singularity" on the workstation,
#: "pruned_w4a8" on a 16 GB card that cannot hold the int8 checkpoint.
DEFAULT_H3_MOTION_PRESET = MACHINE_PROFILE["motion_preset"]

H3_MOTION_PRESETS: dict[str, dict] = {
    # Turbo and Mystic 0.7 already merged into the base, so nothing is stacked at
    # load time and the sampler runs at 4 or 8 NFE. Widest expression range of the
    # three, and the only one carrying adaln_basis / adaln_mean.
    "fused": {},
    # The restrained pair named in build_h3_video_workflow's docstring. The
    # hybrid base has no turbo merged in, so the LoRA has to come with it, and
    # beta is the scheduler that pair was measured on.
    "hybrid": {
        "unet_name": "minimax_h3_hybrid_b25-49_int8.safetensors",
        "lora_name": "h3/minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors",
        "lora_strength": 1.0,
        "scheduler": "beta",
    },
    # WarmBloodAban/Minimax-h3_Singularity ref2va v1.3 (pruned int8), a third-party
    # fine-tune of the ref2va base claiming better mid/long-shot faces, skin tone and
    # action range from an HDR dataset. No turbo is merged in, so it needs the base
    # release's ref2v 8-step LoRA -- which lives at the loras root here, not under h3/.
    # The speed LoRA on top of it is chosen per request (accel_lora, below).
    "singularity": {
        "unet_name": "Minimax-h3_Singularity_ref2va_Pruned_v1.3_int8.safetensors",
        "lora_name": "minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors",
        "lora_strength": 1.0,
        "scheduler": "simple",
    },
    # The official ref2va, pruned to int8 (19.5 GB): MiniMax's own weights with
    # nothing merged in and nothing fine-tuned on top, the neutral reference the
    # third-party bases are judged against. Same size class as Singularity, half
    # the VRAM of the unpruned file, so it is the one to A/B with day to day.
    # Like every pruned build it has no time_embedder and no adaln_basis /
    # adaln_mean, so HyperFlow and depth control still need their own presets.
    # The FL2VA (first + last frame) pruned base, the one the community 360-orbit LoRA is trained on
    # (pablodawson/MiniMax-H3-360-Orbit-LoRA, run with accel_lora 'none'); the 8-step turbo is the
    # fl2v one the hybrid preset already uses.
    "fl2va": {
        "unet_name": "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
        "lora_name": "h3/minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors",
        "lora_strength": 1.0,
        "scheduler": "simple",
        "none_steps": 28,
    },
    "ref2va": {
        "unet_name": "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
        "lora_name": "minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors",
        "lora_strength": 1.0,
        "scheduler": "simple",
    },
    # The unpruned official ref2va (34 GB int8): the only local checkpoint that
    # still has time_embedder, which HyperFlow's two-time conditioning needs
    # (pruned/fused files bake it into adaln curves). "ref2va_full" is the same
    # base with the ref2v turbo8 LoRA, the base-matched A/B for "hyperflow".
    "ref2va_full": {
        "unet_name": "minimax_h3_ref2va_int8_convrot.safetensors",
        "lora_name": "minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors",
        "lora_strength": 1.0,
        "scheduler": "simple",
    },
    "hyperflow": {
        "unet_name": "minimax_h3_ref2va_int8_convrot.safetensors",
        "hyperflow_lora": "minimax_h3_hyperflow_8step_v1.0_comfyui.safetensors",
    },
    # WarmBloodAban ref2va pruned w4a8 (11.8 GB): asym_w4a8_int8 blocks (int4 +
    # Lloyd-Max codebook, convrot), int8_tensorwise token_refiner. Stock
    # UNETLoader on a ComfyUI that registers asym_w4a8_int8; int8 compute, so
    # not tied to sm_120. The 16 GB profile's base: with turbo8 at seed 81000 it
    # matched Singularity's quality where NVFP4 + any turbo LoRA came out hazy.
    # The CrossView-Warp LoRA's own stack (2026-09-21): the official pruned ref2va
    # it was trained on plus the DMD ref2va 8-step LoRA, res_multistep, as its
    # released workflow runs. Singularity + ref2v turbo8 tore on some frames of the
    # same test where this base had none. Used by /reangle, not a shot default.
    "crossview": {
        "unet_name": "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
        "lora_name": "h3/minimax_h3_dmd_ref2va_8step_turbo_pruned.safetensors",
        "lora_strength": 1.0,
        "scheduler": "simple",
        "sampler": "res_multistep",
    },
    # Singularity's own w4a8 build (WarmBloodAban/Minimax-h3_Singularity, 11.8 GB): what the 16 GB profile runs
    # for "singularity". Checked 2026-10-04 at 864x480 on two seeds: dense and kjsage clean, sol deformed the face.
    "singularity_w4a8": {
        "unet_name": "Minimax-h3_Singularity_ref2va_v1.3_Pruned_w4a8.safetensors",
        "lora_name": "minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors",
        "lora_strength": 1.0,
        "scheduler": "simple",
    },
    "pruned_w4a8": {
        "unet_name": "minimax_h3_ref2va_pruned_w4a8_mixed.safetensors",
        "lora_name": "minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors",
        "lora_strength": 1.0,
        "scheduler": "simple",
    },
}


TAOMATE_3STEP_LORA = "h3\\TaoMate-H3-3step-ComfyUI.safetensors"
DEFAULT_H3_ACCEL_LORA = "turbo8"


def h3_attention_policy(preset: str = "", unet_name: str = "") -> dict:
    """Which attention patches a render may use, decided here and nowhere else.

    The studio's video node and the canvas MCP ask this instead of working out for themselves which
    presets load a w4a8 checkpoint. `preset` is what a node names (the machine profile may swap it);
    `unet_name` names a checkpoint directly and wins over the preset's.
    """
    named = substitute_preset((preset or "").strip() or DEFAULT_H3_MOTION_PRESET)
    unet = (unet_name or "").strip() or substitute_unet(H3_MOTION_PRESETS.get(named, {}).get("unet_name", ""))
    options = ("sol", "kjsage", "none")
    allowed = [a for a in options if accel_for_unet(unet, a) == a]
    blocked = {a: "Sol deforms faces on a w4a8 checkpoint" for a in options if a not in allowed}
    return {"preset": named, "unet": unet, "allowed": allowed, "blocked": blocked,
            "default": accel_for_unet(unet, DEFAULT_H3_ACCEL)}


@app.get("/h3-attention")
async def h3_attention(preset: str = "", unet_name: str = ""):
    """The attention patches allowed for a preset / checkpoint on this machine, and the default."""
    return h3_attention_policy(preset, unet_name)


def _h3_motion_preset(req: VideoRequest) -> dict:
    """Resolve motion_preset into checkpoint/LoRA/scheduler overrides.

    A request that names no preset gets DEFAULT_H3_MOTION_PRESET, so the studio,
    the canvas MCP and a bare HTTP call all render the same look. An explicitly
    named unet_name, lora_name or scheduler still wins, so a caller can start
    from a preset and hand-tune one field.
    """
    named = substitute_preset((req.motion_preset or "").strip() or DEFAULT_H3_MOTION_PRESET)
    require_preset(named)
    preset = dict(H3_MOTION_PRESETS.get(named, {}))
    if preset.get("unet_name"):
        # A preset's own checkpoint may not fit this machine (crossview names the 21 GB int8 file).
        preset["unet_name"] = substitute_unet(preset["unet_name"])
    if req.unet_name:
        preset["unet_name"] = req.unet_name
    # Steps follow the speed LoRA and override the request. An explicit
    # req.lora_name opts out and keeps req.steps.
    accel = (req.accel_lora or "").strip() or DEFAULT_H3_ACCEL_LORA
    none_steps = int(preset.pop("none_steps", 20))      # a preset's own step count for accel 'none'
    if not req.lora_name:
        if not preset.get("lora_name"):
            # fused: turbo merged into the weights, nothing to swap
            preset["steps"] = 8
        elif accel == "taomate3":
            preset["lora_name"] = TAOMATE_3STEP_LORA
            preset["lora_strength"] = 1.0
            preset["steps"] = 3
        elif accel == "none":
            # The official r2v template: no LoRA, res_multistep, simple, 20 steps. A preset can name its
            # own count (the 360-orbit LoRA's official run is 28).
            preset["lora_name"] = ""
            preset["steps"] = none_steps
        else:
            preset["steps"] = 8
    if req.lora_name:
        preset["lora_name"] = req.lora_name
        preset["lora_strength"] = req.lora_strength
    if req.scheduler and req.scheduler != "simple":
        preset["scheduler"] = req.scheduler
    preset.setdefault("unet_name", "")
    preset.setdefault("scheduler", req.scheduler or "simple")
    preset.setdefault("lora_name", req.lora_name or "")
    preset.setdefault("lora_strength", req.lora_strength)
    return preset




async def _slice_ref_video(url: str, start: int, count: int) -> str:
    """Cut `count` frames from `url` starting at `start`, and serve the piece.

    A chunked generation with a reference video must not mount the whole
    reference on every chunk: chunk c only covers its own stretch of the move,
    and handing it all 15 seconds makes it encode fourteen of them for nothing
    -- four times over. This is what makes motion context worth having with a
    video attached at all (2026-09-07).
    """
    import subprocess

    src = await resolve_upload(url)
    name = f"{src.stem}__f{start:04d}_{count}.mp4"
    dst = UPLOAD_DIR / name
    if not dst.exists():
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
             "-vf", f"trim=start_frame={start}:end_frame={start + count},setpts=N/FRAME_RATE/TB",
             "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", str(dst)],
            check=True, capture_output=True)
    return f"/uploads/{name}"


def _probe_frame_count(path) -> int:
    """Frame count of a local video, or 0 if ffprobe cannot say."""
    import subprocess
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v",
             "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", str(path)],
            check=True, capture_output=True, text=True).stdout.strip()
        return int(out.splitlines()[0])
    except Exception:
        return 0

async def _join_h3_chunks(filenames: list[str], length: int) -> str:
    """Concatenate the chunk mp4s and cut the result to `length` frames.

    Each chunk after the first was already trimmed of its context window by
    MiniMaxH3MotionContextTrim inside its own workflow, so the pieces butt
    together and the only thing left to do is join them and drop the tail the
    last chunk overshot by. A falsy `length` keeps every frame, which is what a
    chain of separate canvas clips wants: each one is already the length its
    own node asked for.
    """
    import subprocess
    import uuid

    out_dir = Path(COMFYUI_OUTPUT_DIR)
    listing = out_dir / f"h3_join_{uuid.uuid4().hex[:8]}.txt"
    listing.write_text(
        "".join(f"file '{(out_dir / f).as_posix()}'\n" for f in filenames),
        encoding="utf-8")
    joined = f"H3_Video_joined_{uuid.uuid4().hex[:8]}.mp4"
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
             "-i", str(listing)]
            + (["-frames:v", str(length)] if length else [])
            + ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16",
               "-c:a", "aac", str(out_dir / joined)],
            check=True, capture_output=True)
    finally:
        listing.unlink(missing_ok=True)
    return joined


class JoinVideosRequest(BaseModel):
    """Clips to butt together, in order, as one file."""
    filenames: list[str] = []
    length: int = 0


@app.post("/join-videos")
async def join_videos(req: JoinVideosRequest):
    """Concatenate finished clips from the ComfyUI output directory.

    This is what turns a motion-context chain of separate canvas nodes into one
    segment: every clip after the first already had its pinned head trimmed in
    its own workflow, so a plain butt join is the whole job (the Motion Context
    node's own note says to join with no crossfade).
    """
    out_dir = Path(COMFYUI_OUTPUT_DIR)
    names = [Path(f).name for f in req.filenames if f]
    if len(names) < 2:
        raise HTTPException(status_code=400, detail="join-videos needs at least two clips")
    missing = [n for n in names if not (out_dir / n).exists()]
    if missing:
        raise HTTPException(status_code=404, detail=f"not in the output directory: {missing}")
    joined = await _join_h3_chunks(names, req.length)
    return {"url": f"/comfy_output/{joined}", "filename": joined, "parts": names}

async def _prepare_audio_locks(req, frame_len: int, motion_context_video: str,
                               compiled_prompt: str, submitted_resources: dict):
    """Turn req.audio_locks into a mixed track in ComfyUI's input dir and lock ranges.

    Raises audio_lock.AudioLockError (a ValueError) for placements that cannot be
    honoured, and for a locked line the prompt also has the model speak.
    """
    specs = []
    for entry in req.audio_locks:
        url = (entry or {}).get("url")
        if not url:
            raise audio_lock.AudioLockError("an audio lock has no recording")
        path = await resolve_upload(url)
        specs.append(audio_lock.LockSpec(
            path=Path(path), at=float(entry.get("at", 0.0)),
            strength=float(entry.get("strength", 1.0)), text=str(entry.get("text") or ""),
            lock_from=(float(entry["from"]) if entry.get("from") is not None else None),
            lock_to=(float(entry["to"]) if entry.get("to") is not None else None),
            duration=await asyncio.to_thread(audio_lock.probe_duration, Path(path))))
    doubled = audio_lock.locked_lines_in_prompt(compiled_prompt, specs)
    if doubled:
        raise audio_lock.AudioLockError(
            "the prompt also has these locked lines spoken as <d>: " + "; ".join(doubled) +
            ". The model says them again outside the lock (tested: Ben's line repeated 0.1 s after "
            "it). Remove them from the prompt, or leave the lines that are not locked.")
    context = audio_lock.context_frames(
        motion_context_latent=req.motion_context_latent or "", motion_context_video=motion_context_video,
        motion_context_length=req.motion_context_length,
        existing_context_length=req.existing_context_length)
    plan = audio_lock.plan_locks(specs, length_frames=frame_len, context=context)
    track = await asyncio.to_thread(audio_lock.build_track, plan, Path(COMFYUI_INPUT_DIR))
    submitted_resources["audio_locks"] = {
        "track": track, "ranges": plan.ranges, "offset_seconds": round(plan.offset, 4),
        "feather_seconds": float(req.audio_lock_feather or 0.0),
        "locks": [{"url": e.get("url"), "at": e.get("at"), "strength": e.get("strength", 1.0),
                   "from": e.get("from"), "to": e.get("to"), "text": e.get("text") or ""}
                  for e in req.audio_locks],
    }
    return track, plan.ranges


async def _run_video_job(job: dict, req: VideoRequest) -> dict:
    first_frame_filename = None
    if req.image_url:
        first_frame_path = await resolve_upload(req.image_url)
        first_frame_filename = await ensure_comfyui_uploaded(req.image_url)

    last_frame_filename = None
    if req.last_frame_url:
        last_frame_path = await resolve_upload(req.last_frame_url)
        last_frame_filename = await ensure_comfyui_uploaded(req.last_frame_url)

    if req.pin_last_frame_of:
        still = await asyncio.to_thread(_last_frame_still, await resolve_upload(req.pin_last_frame_of))
        # Recorded like any other guide, so the take says what it was pinned on.
        req.guide_frames = [g for g in (req.guide_frames or []) if int((g or {}).get("frame_index", -1)) != -1] \
            + [{"url": still, "frame_index": -1}]

    guide_frames: list[tuple[str, int]] = []
    for g in req.guide_frames or []:
        url = (g or {}).get("url")
        if not url:
            continue
        guide_frames.append((await ensure_comfyui_uploaded(url), int(g.get("frame_index", -1))))
    # A guide's frame number counts frames of the clip as delivered. A chained clip is generated
    # with its motion-context overlap on the front, so the overlap is added here and a change of
    # the overlap never moves a guide off its picture. -1 (the last frame) needs no offset.
    guide_overlap = audio_lock.context_frames(
        motion_context_latent=req.motion_context_latent or "",
        motion_context_video=req.motion_context_video or "",
        motion_context_length=req.motion_context_length,
        existing_context_length=req.existing_context_length)
    if guide_overlap and req.guide_frames_delivered:
        guide_frames = [(fn, idx + guide_overlap if idx >= 0 else idx) for fn, idx in guide_frames]

    IMAGE_EXTS = {'.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tiff'}
    AUDIO_EXTS = {'.m4a', '.mp3', '.wav', '.flac', '.ogg', '.aac'}
    VIDEO_EXTS = {'.mp4', '.avi', '.mov', '.mkv', '.webm'}

    image_refs = []
    for u in req.ref_image_urls:
        if u and Path(u.split('?')[0]).suffix.lower() in IMAGE_EXTS:
            fn = await ensure_comfyui_uploaded(u)
            if fn:
                image_refs.append(fn)

    audio_refs = []
    for u in req.ref_audio_urls:
        if u and Path(u.split('?')[0]).suffix.lower() in AUDIO_EXTS:
            fn = await ensure_comfyui_uploaded(u)
            if fn:
                audio_refs.append(fn)

    video_refs = []
    for u in req.ref_video_urls:
        if u and Path(u.split('?')[0]).suffix.lower() in VIDEO_EXTS:
            fn = await ensure_comfyui_uploaded(u)
            if fn:
                video_refs.append(fn)

    # Calculate frame length (default: 124 frames / 5.1s)
    frame_len = req.length
    if req.duration and (not req.length or req.length == 124):
        n = max(5, round(req.duration * 24))
        frame_len = n + (5 - n % 17) % 17

    effective_duration = (frame_len / 24.0) if frame_len else (req.duration or 5.1)

    detected_mode = req.mode or (
        "fl2va" if (req.image_url and req.last_frame_url)
        else "l2va" if req.last_frame_url
        else "i2va" if req.image_url
        else "ref2va" if (req.ref_image_urls or req.ref_audio_urls or req.ref_video_urls)
        else "t2va"
    )

    # Synthesize smart H3 structured prompt if prompt is empty or raw intent
    compiled_prompt = build_smart_fallback_h3_prompt(
        prompt=req.prompt,
        mode=detected_mode,
        has_first_frame=bool(first_frame_filename),
        has_last_frame=bool(last_frame_filename),
        num_ref_images=len(image_refs),
        num_ref_videos=len(video_refs),
        num_ref_audios=len(audio_refs),
        audio_strategy=req.audio_strategy or "copy_source",
        duration=effective_duration,
    ) if not req.raw_prompt else req.prompt
    logger.info("Running H3 video job [%s mode=%s]: prompt=\n%s", job.get("id"), detected_mode, compiled_prompt)

    submitted_resources = {
        "first_frame": ({"url": req.image_url, "comfy_filename": first_frame_filename}
                        if req.image_url else None),
        "last_frame": ({"url": req.last_frame_url, "comfy_filename": last_frame_filename,
                        "frame_index": req.last_frame_index}
                       if req.last_frame_url else None),
        "guide_frames": [{"url": g.get("url"), "comfy_filename": fn, "frame_index": idx}
                         for g, (fn, idx) in zip([g for g in (req.guide_frames or []) if (g or {}).get("url")],
                                                 guide_frames)],
        "reference_images": [
            {"url": url, "comfy_filename": filename}
            for url, filename in zip([u for u in req.ref_image_urls if u], image_refs)
        ],
        "reference_videos": [
            {"url": url, "comfy_filename": filename}
            for url, filename in zip(
                [u for u in req.ref_video_urls
                 if u and Path(u.split('?')[0]).suffix.lower() in VIDEO_EXTS],
                video_refs,
            )
        ],
        "reference_audios": [
            {"url": url, "comfy_filename": filename}
            for url, filename in zip(
                [u for u in req.ref_audio_urls
                 if u and Path(u.split('?')[0]).suffix.lower() in AUDIO_EXTS],
                audio_refs,
            )
        ],
    }

    # ---- long clips render as a chain of separate chunk jobs ---------------
    #
    # Peak VRAM is what forces this. Building the chain inside one workflow was
    # tried first and measured 31.3 GB of a 32.6 GB card for four 124-frame
    # stages with no reference video mounted, because ComfyUI holds every
    # stage's decoded picture and every intermediate ImageBatch alive for the
    # length of the prompt. Submitting the chunks one at a time keeps the peak
    # at a single chunk's, and the continuity comes from the latent each chunk
    # saves: the next one pins its tail as never-denoised rows.
    if req.chunk_frames and frame_len > req.chunk_frames:
        keep = req.chunk_frames - int(req.motion_context_length)
        if keep < 1:
            raise ValueError(f"chunk_frames {req.chunk_frames} leaves nothing after a "
                             f"{req.motion_context_length}-frame context window")
        stages = 1 + -(-(frame_len - req.chunk_frames) // keep)
        pieces: list[str] = []
        carry = req.motion_context_latent or ""
        # How many frames of the source each chunk's own window covers: chunk 0
        # delivers its whole length, and every chunk after it re-generates the
        # context window at its head, so window c starts at c * keep.
        src_frames = 0
        ctrl_frames = 0
        if req.control_video_url:
            ctrl_frames = _probe_frame_count(await resolve_upload(req.control_video_url))
        if req.ref_video_urls:
            src_frames = _probe_frame_count(await resolve_upload(req.ref_video_urls[0]))
        for c in range(stages):
            sliced = list(req.ref_video_urls)
            if src_frames:
                start = min(c * keep, max(0, src_frames - req.chunk_frames))
                sliced = [await _slice_ref_video(u, start, req.chunk_frames)
                          for u in req.ref_video_urls]
            # The control video needs no cutting: VHS_LoadVideo windows it in
            # the graph, so the chunk just says where its window starts.
            ctrl_skip = min(c * keep, max(0, (ctrl_frames or 0) - req.chunk_frames))
            sub_req = req.model_copy(update={
                "length": req.chunk_frames,
                "chunk_frames": 0,
                "duration": None,
                "ref_video_urls": sliced,
                "motion_context_latent": carry,
                "control_skip_frames": ctrl_skip,
                "chunk_index": c,
                # One seed for the whole chain, as the Motion Context docs do:
                # continuity comes from the carried latent, not from the noise.
                # The earlier `seed + c` here was a guess that was never measured
                # against a same-prompt pair (2026-09-09).
                "seed": int(req.seed),
            })
            job["progress"] = c / stages
            job["phase"] = f"分段生成 {c + 1}/{stages}"
            if c:
                # The carried latent is on disk; a short job can run here.
                await _yield_between_chunks(job)
            part = await _run_video_job(job, sub_req)
            if not isinstance(part, dict) or not part.get("filename"):
                raise RuntimeError(f"chunk {c + 1}/{stages} produced no video")
            pieces.append(part["filename"])
            # A chunk's video is saved as H3_Chunk_<tag> (workflow_builders "61");
            # its latent as H3_Latent_<tag>. Stripping only the H3_Video_ prefix
            # asked for H3_Latent_H3_Chunk_<tag> and every chained run died on
            # FileNotFoundError at the second chunk (2026-09-09).
            tag = re.sub(r"^H3_Video_|^H3_Chunk_|_\d+_\.mp4$", "", part["filename"])
            carry = f"H3_Latent_{tag}_00001_.safetensors"
        joined = await _join_h3_chunks(pieces, frame_len)
        return {
            "url": f"/comfy_output/{joined}",
            "filename": joined,
            "comfy_filename": joined,
            "compiled_prompt": compiled_prompt,
            "prompt_was_modified": compiled_prompt != req.prompt,
            "mode": detected_mode,
            "submitted_resources": submitted_resources,
            "chunks": pieces,
        }

    # A control video is read frame for frame, so it goes to ComfyUI's input
    # directory like any other mounted asset and the graph windows it itself.
    control_video_filename = ""
    if req.control_video_url:
        control_video_filename = await ensure_comfyui_uploaded(req.control_video_url)
    guide_video_filename = ""
    if req.guide_video_url:
        guide_video_filename = await ensure_comfyui_uploaded(req.guide_video_url)
    crossview_warp = None
    if req.crossview_warp:
        crossview_warp = {**req.crossview_warp,
                          "source": await ensure_comfyui_uploaded(req.crossview_warp["source"])}
        if req.crossview_warp.get("depth_source"):
            crossview_warp["depth_source"] = await ensure_comfyui_uploaded(
                req.crossview_warp["depth_source"])

    # A clip carried as motion context is read the same way: its frames and its
    # audio stand in for a saved latent, so the file has to reach ComfyUI's input
    # directory before the graph can open it.
    motion_context_video = ""
    if req.motion_context_video:
        name = await ensure_comfyui_uploaded(req.motion_context_video)
        # VHS_LoadVideoPath validates a filesystem path, not a name in the
        # input directory the way the other loaders do, so hand it the whole
        # path or its validation refuses the node outright.
        if name and COMFYUI_INPUT_DIR:
            p = Path(COMFYUI_INPUT_DIR) / name
            motion_context_video = str(p) if p.is_file() else name
        else:
            motion_context_video = name
        if req.motion_context_end_frame:
            have = _probe_frame_count(motion_context_video) if Path(motion_context_video).is_file() else 0
            if have and req.motion_context_end_frame > have:
                raise HTTPException(
                    status_code=400,
                    detail=f"motion_context_end_frame {req.motion_context_end_frame} is past the end of the "
                           f"source clip ({have} frames, {have / 24:.2f} s); the point to continue from has to be "
                           "inside it.")

    # Everything the result carries besides the file, so a restart mid-render can
    # still give the node its prompt (see _recover_job). Chunks are joined later
    # and are not recoverable on their own.
    if getattr(req, "chunk_index", -1) < 0:
        job["recovery_extras"] = {
            "compiled_prompt": compiled_prompt,
            "prompt_was_modified": compiled_prompt != req.prompt,
            "mode": detected_mode,
            "submitted_resources": submitted_resources,
        }
    lock_track, lock_ranges = "", ""
    if req.audio_locks:
        lock_track, lock_ranges = await _prepare_audio_locks(
            req, frame_len, motion_context_video, compiled_prompt, submitted_resources)
    redo_cfg, redo_latent, redo_video = None, "", ""
    if req.audio_redo:
        redo_cfg = audio_redo.resolve(req.audio_redo.get("mode", "polish"), req.audio_redo.get("steps"),
                                      req.audio_redo.get("denoise"))
        if req.refine_video_path:
            redo_video = req.refine_video_path
            submitted_resources["audio_redo"] = {**redo_cfg, "source_video": Path(redo_video).name, "seed": req.seed}
        else:
            if not req.refine_latent:
                raise audio_redo.AudioRedoError("redoing audio needs the saved latent of the take it redoes")
            redo_latent = Path(req.refine_latent).name
            audio_redo.check_source_latent(Path(COMFYUI_OUTPUT_DIR) / redo_latent, width=req.width,
                                           height=req.height, length_frames=frame_len)
            submitted_resources["audio_redo"] = {**redo_cfg, "source_latent": redo_latent, "seed": req.seed}
    preset = _h3_motion_preset(req)
    if req.sampler:
        preset["sampler"] = req.sampler
    steps = int(preset.pop("steps", req.steps))
    res = await comfyui.generate_h3_video(
        prompt=compiled_prompt,
        first_frame_filename=first_frame_filename,
        last_frame_filename=last_frame_filename,
        last_frame_index=req.last_frame_index,
        guide_frames=guide_frames,
        image_reference_filenames=image_refs,
        audio_reference_filenames=audio_refs,
        video_reference_filenames=video_refs,
        width=req.width,
        height=req.height,
        length=frame_len,
        steps=steps,
        seed=req.seed,
        # scheduler / lora_name / lora_strength come from _h3_motion_preset below,
        # which starts from the preset and lets an explicit request field win.
        ref_image_size=req.ref_image_size,
        style_lora_name=req.style_lora_name,
        style_lora_strength=req.style_lora_strength,
        style_loras=list(req.style_loras or []),
        sage=req.sage,
        shift_video=req.shift_video,
        shift_audio=req.shift_audio,
        motion_context_latent=req.motion_context_latent or "",
        motion_context_video=motion_context_video,
        existing_context_length=req.existing_context_length,
        motion_context_end_frame=req.motion_context_end_frame,
        motion_context_length=req.motion_context_length,
        motion_context_audio=req.motion_context_audio,
        chunk_frames=0,
        control_video_filename=control_video_filename,
        guide_video_filename=guide_video_filename,
        crossview_warp=crossview_warp,
        block_sparse=req.block_sparse,
        audio_lock_track=lock_track,
        audio_lock_ranges=lock_ranges,
        audio_lock_feather=float(req.audio_lock_feather or 0.0),
        audio_redo=redo_cfg,
        refine_latent=redo_latent,
        refine_video=redo_video,
        control_skip_frames=int(getattr(req, 'control_skip_frames', 0) or 0),
        control_strength=req.control_strength,
        chunk_index=getattr(req, 'chunk_index', -1),
        save_latent=req.save_latent,
        live_preview=req.live_preview,
        tiled_vae_decode=(MACHINE_PROFILE["tiled_vae_decode"] if req.tiled_vae_decode is None
                          else req.tiled_vae_decode),
        **preset,
        on_queued=_make_on_queued(job),
        return_info=True,
    )

    if isinstance(res, dict):
        sub = f"{res['subfolder']}/" if res.get("subfolder") else ""
        url = f"/comfy_output/{sub}{res['filename']}"
        result = {
            "url": url,
            "filename": res["filename"],
            "comfy_filename": res["filename"],
            # Return the exact prompt that was submitted with the generated
            # resource.  Recomputing it later from the current canvas can be
            # wrong after the user edits inputs, and made the frontend's
            # "compiled prompt" view appear empty for completed generations.
            "compiled_prompt": compiled_prompt,
            "prompt_was_modified": compiled_prompt != req.prompt,
            "mode": detected_mode,
            "submitted_resources": submitted_resources,
        }
        if res.get("latent_filename"):
            result["latent_filename"] = res["latent_filename"]
            result["latent_url"] = f"/comfy_output/{res['latent_filename']}"
        if res.get("untrimmed_filename"):
            # The continuation with its motion-context overlap still on the front.
            result["untrimmed_url"] = f"/comfy_output/{sub}{res['untrimmed_filename']}"
            result["context_frames"] = int(req.existing_context_length or req.motion_context_length)
        return result
    else:
        video_bytes, meta = res
        out_name = f"video_{job['id']}.mp4"
        (UPLOAD_DIR / out_name).write_bytes(video_bytes)
        result = {
            "url": f"/uploads/{out_name}",
            "compiled_prompt": compiled_prompt,
            "prompt_was_modified": compiled_prompt != req.prompt,
            "mode": detected_mode,
            "submitted_resources": submitted_resources,
        }
        if meta.get("latent_filename"):
            result["latent_filename"] = meta["latent_filename"]
        return result


# ── Audio refine as a node of its own ──────────────────────────────────────────
#
# "Redo only the sound" used to be a button on a render that still had its saved latent. This
# takes any clip (a trim, an edit, an upload; the latent route is the same graph fed from a
# saved latent) and gives back the same file with a new soundtrack: the picture stream is copied,
# not decoded again, so it stays exactly what it was.

AUDIO_REFINE_COND_SIDE = 1376    # the long side the clip is read at; a larger clip is conditioned smaller


class AudioRefineRequest(BaseModel):
    video_url: str
    # What the sound should be: the prompt that made the clip (its dialogue lines and soundscape).
    prompt: str = ""
    ref_image_urls: list[str] = []
    ref_audio_urls: list[str] = []
    audio_locks: list = []
    audio_lock_feather: float = 0.0
    mode: str = "polish"              # polish | reroll (audio_redo.PRESETS)
    steps: Optional[int] = None
    denoise: Optional[float] = None
    seed: int = -1
    # video_url is the chained shot's untrimmed render: this many leading frames are the overlap with
    # the previous shot. The result is served cut to the shot, the full file kept as untrimmed_url.
    overlap_frames: int = 0


async def _finish_audio_refine(job: dict, req: "AudioRefineRequest", res: dict, ctx: dict) -> dict:
    """The new sound laid under the original picture stream (copied), cut to the picture's length."""
    import subprocess

    source = await resolve_upload(req.video_url)
    sub = f"{res['subfolder']}/" if res.get("subfolder") else ""
    produced = Path(COMFYUI_OUTPUT_DIR) / sub / res["filename"]
    frames, fps = await asyncio.to_thread(_decoded_video_frames, source)
    if frames <= 0 or fps <= 0:
        raise ComfyUIError("读不出原视频的帧数，无法把新声音贴回去。")
    seconds = frames / fps
    out_name = f"audiorefine_{job['id']}.mp4"
    out_path = UPLOAD_DIR / out_name
    done = await asyncio.to_thread(lambda: subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(source), "-i", str(produced),
         "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy",
         "-af", f"atrim=end={seconds:.6f},asetpts=PTS-STARTPTS", "-c:a", "aac", "-b:a", "256k",
         "-t", f"{seconds:.6f}", str(out_path)], capture_output=True, text=True))
    if done.returncode != 0:
        out_path.unlink(missing_ok=True)
        raise ComfyUIError(f"把新声音贴回原视频失败：{(done.stderr or '').strip()[-300:]}")
    made, _ = await asyncio.to_thread(_decoded_video_frames, out_path)
    if made != frames:
        out_path.unlink(missing_ok=True)
        raise ComfyUIError(f"贴回声音后帧数变了（{frames} → {made}），已丢弃，原视频没有动。")
    result = {"url": f"/uploads/{out_name}", "filename": out_name, "comfy_filename": res["filename"],
              "method": "audio_refine", "source_frames": frames, "padded_frames": ctx.get("padded_frames"),
              **{k: ctx[k] for k in ("compiled_prompt", "submitted_resources") if ctx.get(k) is not None}}
    return await asyncio.to_thread(_serve_without_overlap, result, out_path,
                                   int(req.overlap_frames or 0), job["id"])


async def _run_audio_refine_job(job: dict, req: AudioRefineRequest) -> dict:
    if not (req.prompt or "").strip():
        raise ValueError("重做声音要有一段描述声音的提示词（台词和环境声）；没有上游 H3 节点可继承时请自己写。")
    cfg = audio_redo.resolve(req.mode, req.steps, req.denoise)
    video_path = await resolve_upload(req.video_url)
    prep = await asyncio.to_thread(_prepare_upscale_source_video, video_path, job["id"], AUDIO_REFINE_COND_SIDE)
    job["refine_ctx"] = {"frames": prep["frames"], "padded_frames": prep["padded_frames"]}
    seed = resolve_seed(req.seed)
    vreq = VideoRequest(
        prompt=req.prompt, width=prep["width"], height=prep["height"], length=prep["padded_frames"],
        seed=seed, audio_redo=cfg, refine_video_path=prep["path"],
        # sent as written: the prompt is what made the clip (or what the user wrote), not an intent to be
        # completed with generic sections (the fallback added "natural ambient room tone" to a probe)
        raw_prompt=True,
        ref_image_urls=req.ref_image_urls, ref_audio_urls=req.ref_audio_urls,
        audio_locks=req.audio_locks, audio_lock_feather=req.audio_lock_feather)
    try:
        result = await _run_video_job(job, vreq)
        job["refine_ctx"].update(compiled_prompt=result.get("compiled_prompt"),
                                 submitted_resources=result.get("submitted_resources"))
        rel = Path(result["url"][len("/comfy_output/"):])
        sub = "" if str(rel.parent) == "." else rel.parent.as_posix()
        return await _finish_audio_refine(job, req, {"filename": rel.name, "subfolder": sub}, job["refine_ctx"])
    finally:
        Path(prep["path"]).unlink(missing_ok=True)


async def _audio_refine_result_from_comfy(job: dict) -> Optional[dict]:
    """The result of an audio refine whose ComfyUI prompt already finished, or None (see
    _upscale_result_from_comfy: a re-run writes its source video anew, so ComfyUI's cache never answers)."""
    if job.get("type") != "audio_refine" or not job.get("prompt_id") or not isinstance(job.get("request"), dict):
        return None
    try:
        req = AudioRefineRequest.model_validate(job["request"])
        ctx = job.get("refine_ctx")
        if not ctx:
            return None
        state, outputs = await comfyui.prompt_state(job["prompt_id"])
        if state != "success":
            return None
        files, _latent = comfyui.output_files(outputs)
        video = next((f for f in files if str(f.get("filename", "")).lower().endswith(".mp4")), None)
        if not video:
            return None
        logger.info("Audio refine job %s: collected the finished ComfyUI render %s instead of running it again",
                    job.get("id"), video["filename"])
        return await _finish_audio_refine(job, req, {"filename": video["filename"],
                                                     "subfolder": video.get("subfolder") or ""}, ctx)
    except Exception:  # noqa: BLE001 -- anything unexpected falls back to running it again
        logger.warning("Could not collect audio refine job %s from ComfyUI", job.get("id"), exc_info=True)
        return None


async def _collect_finished(job: dict) -> Optional[dict]:
    """A result already sitting in ComfyUI for a job that is about to be run again, if the job type has one."""
    if job.get("type") == "audio_refine":
        return await _audio_refine_result_from_comfy(job)
    if job.get("type") == "charswap":
        return await _charswap_result_from_comfy(job)
    return await _upscale_result_from_comfy(job)


@app.post("/audio-refine")
async def audio_refine_endpoint(req: AudioRefineRequest):
    return await submit_job("audio_refine", lambda job: _run_audio_refine_job(job, req), request=req,
                            prompt=req.prompt, video_url=req.video_url)


@app.post("/generate-video")
async def generate_video_endpoint(req: VideoRequest):
    detected_mode = req.mode or (
        "fl2va" if (req.image_url and req.last_frame_url)
        else "l2va" if req.last_frame_url
        else "i2va" if req.image_url
        else "ref2va" if (req.ref_image_urls or req.ref_audio_urls or req.ref_video_urls)
        else "t2va"
    )
    return await submit_job(
        "video", lambda job: _run_video_job(job, req), request=req,
        prompt=req.prompt,
        mode=detected_mode,
    )


class WardrobeSwapRequest(BaseModel):
    """Prompt-free H3 wardrobe transfer that returns a settled still, not the source frame."""
    person_image_url: str
    outfit_image_url: str
    width: int = 1024
    height: int = 1024
    steps: int = DEFAULT_H3_STEPS
    seed: int = 81000
    detail: str = ""
    person_detail: str = ""
    extract_time: float = 1.0


def _extract_video_still(source: Path, target: Path, seconds: float) -> None:
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{seconds:.3f}",
         "-i", str(source), "-frames:v", "1", str(target)],
        check=True,
        capture_output=True,
    )


async def _run_wardrobe_swap_job(job: dict, req: WardrobeSwapRequest) -> dict:
    adjustment = req.detail.strip()
    person_detail = req.person_detail.strip()
    prompt = (
        "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\n"
        "integrated_multimodal_description: [Shot 1] <Picture 1> is the immutable structural master for the entire shot. "
        "Preserve its exact person identity, face, expression, hair, body shape, pose, hands, "
        "accessories, props, background, lighting, camera, framing, composition and visual style. "
        "During the first 0.50 seconds, replace only the clothing worn in <Picture 1> with the "
        "complete outfit from <Picture 2>, transferring garment design, layers, fabric, color, "
        "texture, folds, trim, footwear and clothing accessories. Fit it naturally to the unchanged "
        "body and pose. Do not transfer the person, face, hair, body, pose, background, lighting, "
        "camera or visual style from <Picture 2>. From 0.50 seconds through the final frame, hold "
        "the completed dressed image perfectly still: no camera motion, blinking, breathing, hair "
        "motion, cloth motion, body motion, background motion or morphing."
        + (f" The immutable person and scene are: {person_detail}." if person_detail else "")
        + (f" Wardrobe detail: {adjustment}." if adjustment else "")
        + "\n\noverall_soundscape: N/A\n\nnon_diegetic_music: N/A"
    )
    inner = await _run_video_job(job, VideoRequest(
        prompt=prompt,
        mode="i2va",
        image_url=req.person_image_url,
        ref_image_urls=[req.outfit_image_url],
        width=req.width,
        height=req.height,
        steps=req.steps,
        length=124,
        seed=req.seed,
        ref_image_size="max",
    ))
    video_path = await resolve_upload(inner["url"])
    still_name = f"wardrobe_{job['id']}.png"
    still_path = UPLOAD_DIR / still_name
    # Frame zero is intentionally the untouched I2VA anchor. Sample after the
    # instructed transition and hold, so the public node never exposes it.
    await asyncio.to_thread(
        _extract_video_still, video_path, still_path,
        max(0.6, min(float(req.extract_time), 4.8)),
    )
    return {
        "url": f"/uploads/{still_name}",
        "filename": still_name,
        "source_video_url": inner["url"],
        "compiled_prompt": inner.get("compiled_prompt", prompt),
        "extracted_at": max(0.6, min(float(req.extract_time), 4.8)),
    }


@app.post("/wardrobe-swap-h3")
async def wardrobe_swap_h3_endpoint(req: WardrobeSwapRequest):
    return await submit_job(
        "wardrobe_swap_h3",
        lambda job: _run_wardrobe_swap_job(job, req), request=req,
        prompt="prompt-free wardrobe swap",
        mode="i2va_extract",
    )


class SheetProp(BaseModel):
    """A key prop the costume names, with the reference plate that defines it."""
    image_url: str
    description: str                          # e.g. "the wristwatch worn on his left wrist"


class CharacterSheetRequest(BaseModel):
    """
    A character reference sheet: front full body / back full body / waist-up close.

    `identity` and `costume` are separate on purpose. Painted-on make-up belongs
    to identity or a costume change washes it off; a cloak belongs to costume or
    it survives as a character trait into every later shot. Both are stated in
    the positive — never "not the coat", because a named thing is a thing to draw.
    """
    identity: str                             # who they are, whatever they wear
    costume: str                              # what they wear in this production
    subject_noun: str = "person"
    face_image_url: Optional[str] = None      # optional single identity reference
    props: list[SheetProp] = []               # key props the costume names, with their own plates
    width: int = 1376                         # verified four-panel generation size
    height: int = 768
    sheet_width: int = 1536                   # the house sheet format
    sheet_height: int = 1024
    steps: int = 4
    upscale: bool = True                      # deprecated: 1x enhancement always runs
    seed: int = 12345
    #: "qwen" (default since 2026-09-22): one Qwen-Image-2.1 still at
    #: sheet_width x sheet_height, three views -- full front, full back, waist-up
    #: front. "h3": the older four-panel H3 video route; width/height/steps apply
    #: to it only.
    engine: str = "qwen"
    qwen_steps: int = 25
    #: A derived sheet (add a prop, change one thing) starts from the character's
    #: approved sheet, not from a head crop: from a head crop Qwen redraws the
    #: costume and its details drift (pockets, plaid, cut). Qwen route only.
    base_sheet_url: Optional[str] = None


async def _run_character_sheet_job(job: dict, req: CharacterSheetRequest) -> dict:
    """
    Qwen route: one still with the three house views. H3 route: four synchronized
    views in one sampling, upscaled, one stable frame extracted.
    """
    import character_sheet as cs
    import importlib
    importlib.reload(cs)

    if req.engine == "qwen":
        import workflow_builders as wb
        sheet_req = cs.SheetRequest(
            identity=req.identity, costume=req.costume, subject_noun=req.subject_noun,
            face_image_url=None if req.base_sheet_url else req.face_image_url,
            props=[p.model_dump() for p in req.props], base_sheet_url=req.base_sheet_url,
        )
        prompt = cs.build_qwen_prompt(sheet_req)
        comfy_refs, ref_bytes = [], []
        firsts = [req.base_sheet_url] if req.base_sheet_url else ([req.face_image_url] if req.face_image_url else [])
        for url in firsts + [p.image_url for p in req.props]:
            path = await resolve_upload(url)
            ref_bytes.append(path.read_bytes())
            comfy_refs.append(await comfyui.upload_image(ref_bytes[-1], path.name))
        img_bytes = await comfyui.generate_qwen_image_21(
            prompt=prompt, reference_filenames=comfy_refs, negative_prompt=cs.QWEN_NEGATIVE,
            width=req.sheet_width, height=req.sheet_height, steps=req.qwen_steps, cfg=1.0,
            seed=wb.seed_clear_of_references(resolve_seed(req.seed), ref_bytes), fixed_size=True,
        )
        name = f"sheet_{job['id']}.png"
        (UPLOAD_DIR / name).write_bytes(img_bytes)
        return {"url": f"/uploads/{name}", "filename": name, "compiled_prompt": prompt}

    video_req = VideoRequest(
        prompt=cs.build_prompt(
            cs.SheetRequest(
                identity=req.identity,
                costume=req.costume,
                subject_noun=req.subject_noun,
                face_image_url=req.face_image_url,
                props=[p.model_dump() for p in req.props],
            )
        ),
        # Picture order is the reference order: the face first, then each prop.
        # Deliberately stay on T2VA even with Picture references.  Controlled
        # tests with 0, 1 and 2 references showed that the synchronized-panel
        # prompt works on this route and gives stricter side/rear views than the
        # former Ref2VA turntable.
        mode="t2va",
        ref_image_urls=(
            ([req.face_image_url] if req.face_image_url else [])
            + [p.image_url for p in req.props]
        ),
        width=req.width,
        height=req.height,
        steps=req.steps,
        length=cs.LENGTH_FRAMES,
        seed=req.seed,
        ref_image_size="max",
    )
    inner = await _run_video_job(job, video_req)
    source_url = inner["url"]

    # Always run the same-resolution H3 LMS enhancement before extraction.
    # `upscale` remains accepted only so existing callers do not break.
    up = await _run_video_upscale_job(
        job,
        VideoUpscaleRequest(
            video_url=source_url,
            width=req.width,
            height=req.height,
            method="lms",
            scale_by=1.0,
            steps=8,
            length=cs.LENGTH_FRAMES,
            seed=req.seed,
            prompt=video_req.prompt,
        ),
    )
    source_url = up.get("url", source_url)

    png = cs.compose(await resolve_upload(source_url), req.sheet_width, req.sheet_height)
    name = f"sheet_{job['id']}.png"
    (UPLOAD_DIR / name).write_bytes(png)
    return {
        "url": f"/uploads/{name}",
        "filename": name,
        "turnaround_url": source_url,
        "compiled_prompt": inner.get("compiled_prompt"),
    }


@app.post("/generate-character-sheet")
async def generate_character_sheet_endpoint(req: CharacterSheetRequest):
    return await submit_job(
        "character_sheet", lambda job: _run_character_sheet_job(job, req), request=req,
        prompt=req.identity,
    )


@app.post("/generate-video-edit")
async def generate_video_edit_endpoint(req: VideoRequest):
    """Dedicated endpoint for MiniMax H3 Video Editing & Continuation."""
    # Edits render on the segments' checkpoint unless told otherwise, so edits
    # queued between segments do not swap the 20 GB weights each time.
    if not (req.motion_preset or "").strip():
        req.motion_preset = "singularity"
    return await submit_job(
        "video_edit", lambda job: _run_video_job(job, req), request=req,
        prompt=req.prompt,
        mode=req.mode or "edit",
    )


class EditWindowRequest(VideoRequest):
    """A video edit applied to one frame range of `ref_video_urls[0]` only.

    The rest of the fields are the ordinary edit request; `length` is ignored
    because the piece's length comes from the window (see edit_window.py).
    """
    start_frame: int = 0
    frame_count: int = 72


async def _run_edit_window_job(job: dict, req: EditWindowRequest) -> dict:
    import uuid
    import edit_window as ew

    if not req.ref_video_urls:
        raise ValueError("edit window needs a source video")
    source_url = req.ref_video_urls[0]
    source = await resolve_upload(source_url)
    total = _probe_frame_count(source)
    if total <= 0:
        raise ValueError(f"could not count the frames of {source_url}")
    plan = ew.plan_edit_window(total, req.start_frame, req.frame_count)
    piece_name = f"{source.stem}__editwin_f{plan.start:04d}_{plan.count}_{plan.clip_length}.mp4"
    piece_path = UPLOAD_DIR / piece_name
    await asyncio.to_thread(ew.cut_padded_piece, source, plan, piece_path)
    piece_url = f"/uploads/{piece_name}"

    # Guide frames come in the source clip's frame numbers; the piece starts at
    # plan.clip_start. A guide outside the window would pin a padded (held) frame.
    piece_guides = []
    for g in req.guide_frames or []:
        idx = int((g or {}).get("frame_index", -1))
        if (g or {}).get("url") and plan.start <= idx < plan.start + plan.count:
            piece_guides.append({**g, "frame_index": idx - plan.clip_start})
        elif (g or {}).get("url"):
            logger.warning("edit window %s..%s: guide frame %s is outside it, dropped",
                           plan.start, plan.start + plan.count, idx)
    edit_req = req.model_copy(update={
        "guide_frames": piece_guides,
        "ref_video_urls": [piece_url] + list(req.ref_video_urls[1:]),
        "length": plan.clip_length,
        "duration": None,
        "chunk_frames": 0,
        "mode": req.mode or "edit",
    })
    edited = await _run_video_job(job, edit_req)
    edited_path = await resolve_upload(edited["url"])

    out_name = f"H3_EditWindow_{uuid.uuid4().hex[:8]}.mp4"
    out_path = Path(COMFYUI_OUTPUT_DIR) / out_name
    await asyncio.to_thread(ew.splice_edit, source, edited_path, plan, out_path)
    seams = await asyncio.to_thread(ew.seam_differences, out_path, plan)
    return {
        **edited,
        "url": f"/comfy_output/{out_name}",
        "filename": out_name,
        "edited_piece_url": edited["url"],
        # the edit's latent covers only the padded piece, not this clip
        "latent_filename": None,
        "latent_url": None,
        "edit_window": plan.as_dict(),
        "seams": seams,
    }


@app.post("/generate-video-edit-window")
async def generate_video_edit_window_endpoint(req: EditWindowRequest):
    """Frame-based edit of one stretch of a clip: edit a padded piece, splice the window back."""
    if not (req.motion_preset or "").strip():
        req.motion_preset = "singularity"
    return await submit_job(
        "video_edit_window", lambda job: _run_edit_window_job(job, req), request=req,
        prompt=req.prompt, mode=req.mode or "edit",
    )


class VideoCleanupRequest(VideoRequest):
    """去水印 / 去字幕: an ordinary edit of `source_url` with a generated prompt.

    Size, length and audio come from the source (see video_cleanup.py); `prompt`
    is ignored and rebuilt from the two flags.
    """
    prompt: str = ""
    source_url: str = ""
    remove_watermark: bool = False
    remove_subtitles: bool = False
    # The marks as the user sees them and one line on what the clip shows; generic
    # wording alone never removed a watermark (video_cleanup.build_cleanup_prompt).
    watermark_hint: str = ""
    scene_hint: str = ""
    steps: int = 8


async def _run_video_cleanup_job(job: dict, req: VideoCleanupRequest) -> dict:
    import uuid
    import edit_window as ew
    import video_cleanup as vc

    source_url = req.source_url or (req.ref_video_urls[0] if req.ref_video_urls else "")
    if not source_url:
        raise ValueError("video cleanup needs a source video")
    source = await resolve_upload(source_url)
    total = _probe_frame_count(source)
    if total <= 0:
        raise ValueError(f"could not count the frames of {source_url}")
    src_w, src_h = await asyncio.to_thread(ew._video_size, source)
    fps = await asyncio.to_thread(ew.probe_fps, source)
    width, height = vc.snap_size(src_w, src_h)
    length = ew.h3_length_at_least(total)

    # Both at once removed the subtitles and left every watermark (two runs,
    # 2026-09-24); the hand runs that worked did one kind per pass. So watermark
    # first, then subtitles on its result.
    passes = [(w, s) for w, s in ((True, False), (False, True))
              if (w and req.remove_watermark) or (s and req.remove_subtitles)]
    pass_source = source_url
    edited = None
    for remove_wm, remove_sub in passes:
        edit_req = req.model_copy(update={
            "prompt": vc.build_cleanup_prompt(remove_wm, remove_sub, req.watermark_hint, req.scene_hint),
            "mode": "edit",
            "ref_video_urls": [pass_source],
            "audio_strategy": "copy_source",
            "width": width,
            "height": height,
            "length": length,
            "duration": None,
            "chunk_frames": 0,
        })
        edited = await _run_video_job(job, edit_req)
        pass_source = edited["url"]
    if length == total and (width, height) == (src_w, src_h):
        return {**edited, "cleanup": {"source_frames": total, "length": length}}

    # Padded to an H3 length or rendered at a snapped size: cut back to the
    # source's own frames and size, with its audio.
    edited_path = await resolve_upload(edited["url"])
    out_name = f"H3_Cleanup_{uuid.uuid4().hex[:8]}.mp4"
    out_path = Path(COMFYUI_OUTPUT_DIR) / out_name
    await asyncio.to_thread(vc.fit_to_source, edited_path, source, total, src_w, src_h, fps, out_path)
    return {
        **edited,
        "url": f"/comfy_output/{out_name}",
        "filename": out_name,
        "edited_piece_url": edited["url"],
        # the latent is the padded render, not this clip
        "latent_filename": None,
        "latent_url": None,
        "cleanup": {"source_frames": total, "length": length},
    }


@app.post("/generate-video-cleanup")
async def generate_video_cleanup_endpoint(req: VideoCleanupRequest):
    """去水印 / 去字幕 on a whole clip; the prompt is generated from the flags."""
    import video_cleanup as vc

    if not (req.remove_watermark or req.remove_subtitles):
        raise HTTPException(status_code=400, detail="remove_watermark or remove_subtitles is required")
    if not (req.source_url or req.ref_video_urls):
        raise HTTPException(status_code=400, detail="source_url is required")
    if not (req.motion_preset or "").strip():
        req.motion_preset = "singularity"
    req.mode = "edit"
    req.prompt = vc.build_cleanup_prompt(req.remove_watermark, req.remove_subtitles, req.watermark_hint, req.scene_hint)
    # Size and length up front too, so the scheduler estimates the real render;
    # the runner probes again (a replayed job skips this endpoint).
    try:
        import edit_window as ew
        source = await resolve_upload(req.source_url or req.ref_video_urls[0])
        req.width, req.height = vc.snap_size(*await asyncio.to_thread(ew._video_size, source))
        req.length = ew.h3_length_at_least(_probe_frame_count(source))
    except Exception as e:
        logger.warning("video cleanup: could not probe the source up front: %s", e)
    return await submit_job(
        "video_cleanup", lambda job: _run_video_cleanup_job(job, req), request=req,
        prompt=req.prompt, mode="edit",
    )


class ContinueTailRequest(VideoRequest):
    """A continuation that sees only the end of `ref_video_urls[0]`.

    `tail_frames` 0 takes the source from its last cut; otherwise that many frames
    from the end. Either way the tail is held to 2-15 s (edit_window.plan_tail).
    """
    tail_frames: int = 0


async def _run_continue_tail_job(job: dict, req: ContinueTailRequest) -> dict:
    import edit_window as ew

    if not req.ref_video_urls:
        raise ValueError("continuation needs a source video")
    source_url = req.ref_video_urls[0]
    source = await resolve_upload(source_url)
    total = _probe_frame_count(source)
    if total <= 0:
        raise ValueError(f"could not count the frames of {source_url}")
    cut = 0 if req.tail_frames > 0 else await asyncio.to_thread(ew.last_cut_frame, source)
    start = ew.plan_tail(total, cut, req.tail_frames)
    tail_name = f"{source.stem}__tail_f{start:04d}_{total - start}.mp4"
    tail_path = UPLOAD_DIR / tail_name
    await asyncio.to_thread(ew.cut_tail, source, start, tail_path)

    cont_req = req.model_copy(update={
        "ref_video_urls": [f"/uploads/{tail_name}"] + list(req.ref_video_urls[1:]),
        "mode": "continuation",
    })
    result = await _run_video_job(job, cont_req)
    return {**result, "continue_tail": {"start": start, "frames": total - start,
                                         "source_frames": total, "auto": req.tail_frames <= 0}}


@app.post("/generate-video-continue-tail")
async def generate_video_continue_tail_endpoint(req: ContinueTailRequest):
    """Continuation from the tail of a clip (its last shot by default) instead of all of it."""
    return await submit_job(
        "video_continue_tail", lambda job: _run_continue_tail_job(job, req), request=req,
        prompt=req.prompt, mode="continuation",
    )


class VideoTrimRequest(BaseModel):
    video_url: str
    start_seconds: float = 0.0
    end_seconds: Optional[float] = None
    keep_audio: bool = True
    # Replace the picture with its per-frame depth (silent): a camera-movement
    # reference that carries no faces, costumes or look for H3 to copy.
    depth: bool = False
    # The latent of the clip being cut, and how many frames of the chain context sit at
    # its head (a chained clip's latent holds them; its served clip does not). When the
    # cut starts at the head and ends where the latent can be cut exactly (17n+5 frames
    # counting the context), the trim also gets a cut latent, so a shot that carries on
    # from it chains on the latent instead of re-encoding the pictures.
    latent_filename: Optional[str] = None
    context_frames: int = 0


async def _run_video_trim_job(job: dict, req: VideoTrimRequest) -> dict:
    import hashlib
    import edit_window as ew

    source = await resolve_upload(req.video_url)
    fps = await asyncio.to_thread(ew.probe_fps, source)
    total = await asyncio.to_thread(ew.probe_frame_count_fast, source, fps)
    if total <= 0:
        raise ValueError(f"could not count the frames of {req.video_url}")
    start, end = ew.plan_trim(total, fps, req.start_seconds, req.end_seconds)
    # The cut latent is part of the result, so a trim that now writes one must not land on
    # the name of an earlier trim of the same cut (ComfyUI caches a latent by file name).
    key = (f"{source.name}|{source.stat().st_mtime_ns}|{start}|{end}{'' if req.keep_audio else '|mute'}"
           f"{'|depth' if req.depth else ''}{'|lat2:' + Path(req.latent_filename).name + ':' + str(int(req.context_frames or 0)) if req.latent_filename else ''}").encode()
    out_name = f"H3_Trim_{hashlib.sha1(key).hexdigest()[:8]}.mp4"
    out_path = Path(COMFYUI_OUTPUT_DIR) / out_name
    tmp_path = out_path.with_name(f"tmp_{out_name}")
    await asyncio.to_thread(ew.trim_range, source, start, end, fps, tmp_path,
                            req.keep_audio and not req.depth)
    if req.depth:
        job["batch_info"] = "DEPTH"
        comfy_name = await comfyui.upload_video(tmp_path.read_bytes(), tmp_path.name)
        tmp_path.write_bytes(await comfyui.estimate_video_depth(comfy_name, fps))
    tmp_path.replace(out_path)
    latent_name, latent_note = None, None
    if req.latent_filename and start == 0 and not req.depth:
        try:
            latent_name = await asyncio.to_thread(
                _cut_trim_latent, Path(COMFYUI_OUTPUT_DIR), req.latent_filename, req.context_frames,
                total, end, hashlib.sha1(key).hexdigest()[:8])
        except ValueError as exc:
            latent_note = str(exc)   # not on the grid, or not this clip's latent: pictures only
    return {
        "url": f"/comfy_output/{out_name}",
        "filename": out_name,
        "latent_filename": latent_name,
        "latent_url": f"/comfy_output/{latent_name}" if latent_name else None,
        "latent_note": latent_note,
        "trim": {"start_frame": start, "end_frame": end, "frames": end - start,
                 "fps": fps, "source_frames": total, "source_url": req.video_url},
    }


def _cut_trim_latent(out_dir: Path, latent_filename: str, context: int, source_frames: int,
                     end: int, tag: str) -> str:
    """The source's latent cut to the first `end` frames of the clip (context included).

    Only exact on the 17n+5 grid, and only for the latent of this very clip: its time axis
    must be the context plus the served frames. Raises ValueError (with the reason) when not."""
    import latent_slice
    context = max(0, int(context or 0))
    keep = context + end
    if not latent_slice.on_grid(keep):
        raise ValueError(f"{keep} frames (context {context} + cut {end}) is not on the 17n+5 grid; pictures only")
    src = out_dir / Path(latent_filename).name
    if not src.is_file():
        raise ValueError(f"latent {src.name} not found")
    have = _h3_latent_decoded_frames(src)
    if have != context + source_frames:
        raise ValueError(f"latent {src.name} holds {have} frames, this clip is {context}+{source_frames}; pictures only")
    dst = out_dir / f"H3_Latent_{tag}_00001_.safetensors"
    latent_slice.slice_latent(src, keep, dst)
    return dst.name


@app.post("/generate-video-trim")
async def generate_video_trim_endpoint(req: VideoTrimRequest):
    """Cut a clip to a time range (frame-accurate re-encode, audio kept in sync)."""
    return await submit_job(
        "video_trim", lambda job: _run_video_trim_job(job, req), request=req,
    )


class VideoDepthRequest(BaseModel):
    """A clip's per-frame depth as a silent video (Depth Anything V2): a control video for the Fun ControlNet,
    or a camera reference that carries no faces, costumes or look."""
    video_url: str
    # The model's working size (a multiple of 14); the result is scaled back to the clip's own size.
    resolution: int = Field(518, ge=252, le=1036)


async def _run_video_depth_job(job: dict, req: VideoDepthRequest) -> dict:
    import hashlib
    import edit_window as ew

    source = await resolve_upload(req.video_url)
    fps = await asyncio.to_thread(ew.probe_fps, source)
    key = f"{source.name}|{source.stat().st_mtime_ns}|depth|{req.resolution}".encode()
    out_name = f"H3_Depth_{hashlib.sha1(key).hexdigest()[:8]}.mp4"
    out_path = Path(COMFYUI_OUTPUT_DIR) / out_name
    job["batch_info"] = "DEPTH"
    comfy_name = await comfyui.upload_video(source.read_bytes(), source.name)
    tmp_path = out_path.with_name(f"tmp_{out_name}")
    tmp_path.write_bytes(await comfyui.estimate_video_depth(comfy_name, fps, req.resolution))
    tmp_path.replace(out_path)
    return {"url": f"/comfy_output/{out_name}", "filename": out_name, "fps": fps,
            "source_url": req.video_url}


@app.post("/generate-video-depth")
async def generate_video_depth_endpoint(req: VideoDepthRequest):
    """The whole clip's depth video (cut it with the trim node first to use part of it)."""
    return await submit_job(
        "video_depth", lambda job: _run_video_depth_job(job, req), request=req,
    )


class TemporalReshotRequest(BaseModel):
    video_url: str
    prompt: str
    start_frame: int
    frame_count: int
    context_before: int = 39
    context_after: int = 39
    edge_blend_frames: int = 0
    ref_image_urls: list[str] = []
    steps: int = 20
    seed: int = -1
    # Base 20-step sampling is materially more instruction-faithful for reshots.
    # Callers may explicitly opt into Turbo for quick continuity previews.
    lora_name: str = ""
    lora_strength: float = 1.0
    style_lora_name: str = ""
    style_lora_strength: float = 1.0
    condition_source_audio: bool = False
    sage: str = DEFAULT_H3_ACCEL


def _available_system_memory_bytes() -> Optional[int]:
    """Return immediately available physical memory without a psutil dependency."""
    if os.name == "nt":
        class MEMORYSTATUSEX(ctypes.Structure):
            _fields_ = [
                ("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]
        status = MEMORYSTATUSEX()
        status.dwLength = ctypes.sizeof(status)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            return int(status.ullAvailPhys)
        return None
    try:
        return int(os.sysconf("SC_AVPHYS_PAGES") * os.sysconf("SC_PAGE_SIZE"))
    except (AttributeError, OSError, ValueError):
        return None


def _probe_fps(path: Path) -> Optional[float]:
    """Average frame rate of the first video stream, or None."""
    try:
        out = subprocess.run(
            [os.environ.get("FFPROBE", "ffprobe"), "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=avg_frame_rate", "-of", "csv=p=0", str(path)],
            capture_output=True, text=True, timeout=30, check=True,
        ).stdout.strip()
        num, _, den = out.partition("/")
        fps = float(num) / float(den or 1)
        return fps if fps > 0 else None
    except Exception:
        return None


def _probe_video_geometry(path: Path) -> Optional[tuple[int, int, int]]:
    """Return width, height and decoded frame count using ffprobe."""
    try:
        completed = subprocess.run(
            [os.environ.get("FFPROBE", "ffprobe"), "-v", "error", "-select_streams", "v:0",
             "-count_frames", "-show_entries", "stream=width,height,nb_read_frames,nb_frames",
             "-of", "json", str(path)],
            capture_output=True, text=True, timeout=30, check=True,
        )
        stream = (json.loads(completed.stdout).get("streams") or [])[0]
        width, height = int(stream["width"]), int(stream["height"])
        raw_frames = stream.get("nb_read_frames") or stream.get("nb_frames")
        frames = int(raw_frames)
        if width > 0 and height > 0 and frames > 0:
            return width, height, frames
    except (subprocess.SubprocessError, ValueError, KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
        logger.warning("Could not probe temporal reshot source %s: %s", path, exc)
    return None


def _reshot_required_memory_bytes(
    width: int, height: int, source_frames: int,
    selected_frames: int, context_before: int, context_after: int,
) -> int:
    """Conservative version of FL Temporal Reshot's assembler RAM estimate."""
    # H3 expands the requested work window to its temporal grid. Sixteen frames
    # safely covers the maximum alignment growth without importing the plugin.
    render_frames = min(
        source_frames,
        selected_frames + context_before + context_after + 16,
    )
    decoded_rgb_float = (source_frames + render_frames) * width * height * 3 * 4
    # Keep 2 GiB for Python, ffmpeg, the OS and short-lived assembly allocations.
    return decoded_rgb_float + 2 * 1024 ** 3


async def _run_temporal_reshot_job(job: dict, req: TemporalReshotRequest) -> dict:
    if not req.prompt.strip():
        raise ValueError("Temporal reshot requires a replacement prompt")
    if req.start_frame < 0 or req.frame_count < 1:
        raise ValueError("Invalid temporal reshot frame range")
    if min(req.context_before, req.context_after, req.edge_blend_frames) < 0:
        raise ValueError("Temporal reshot context and blend values cannot be negative")
    if req.edge_blend_frames > req.frame_count:
        raise ValueError("Edge blend cannot exceed the selected frame count")

    source_path = await resolve_upload(req.video_url)
    geometry = _probe_video_geometry(source_path)
    available_memory = _available_system_memory_bytes()
    if geometry and available_memory is not None:
        width, height, source_frames = geometry
        estimated_requirement = _reshot_required_memory_bytes(
            width, height, source_frames, req.frame_count,
            req.context_before, req.context_after,
        )
        # Production guardrails established by the local RTX 5090 / 64-GB RAM
        # benchmark. Larger sources need extra headroom beyond decoded tensors.
        resolution_floor = (
            8 * 1024 ** 3 if width * height > 1280 * 720 else
            6 * 1024 ** 3 if width * height > 1024 * 576 else
            4 * 1024 ** 3
        )
        required_memory = max(estimated_requirement, resolution_floor)
        if available_memory < required_memory:
            logger.info(
                "Temporal reshot has only %.1f GB free (%.1f GB required); unloading ComfyUI caches before retry",
                available_memory / 1024 ** 3, required_memory / 1024 ** 3,
            )
            await comfyui.free_memory(unload_models=True, free_memory=True)
            # CUDA/PyTorch cleanup is asynchronous from the backend's point of
            # view; give ComfyUI a brief chance to return pages to Windows.
            await asyncio.sleep(1)
            available_memory = _available_system_memory_bytes()
            if available_memory is None:
                available_memory = 0
        if available_memory < required_memory:
            available_gb = available_memory / 1024 ** 3
            required_gb = required_memory / 1024 ** 3
            raise MemoryError(
                f"Temporal Reshot 内存预检未通过：源视频 {width}×{height}、{source_frames} 帧，"
                f"已自动卸载 ComfyUI 模型缓存，但仍需要至少 {required_gb:.1f} GB 可用系统内存，"
                f"当前仅 {available_gb:.1f} GB。请缩短源视频或降低分辨率后重试。"
            )
        logger.info(
            "Temporal reshot memory preflight passed: %dx%d/%d frames, %.1f GB required, %.1f GB available",
            width, height, source_frames, required_memory / 1024 ** 3, available_memory / 1024 ** 3,
        )

    source_filename = await ensure_comfyui_uploaded(req.video_url)
    references = [await ensure_comfyui_uploaded(url) for url in req.ref_image_urls if url]
    result = await comfyui.temporal_reshot_h3(
        source_video=source_filename, prompt=req.prompt.strip(),
        start_frame=req.start_frame, frame_count=req.frame_count,
        context_before=req.context_before, context_after=req.context_after,
        edge_blend_frames=req.edge_blend_frames,
        image_reference_filenames=references, steps=req.steps, seed=req.seed,
        lora_name=req.lora_name, lora_strength=req.lora_strength,
        style_lora_name=req.style_lora_name,
        style_lora_strength=req.style_lora_strength,
        condition_source_audio=req.condition_source_audio, sage=req.sage,
        on_queued=_make_on_queued(job), return_info=True,
    )
    subfolder = f"{result['subfolder']}/" if result.get("subfolder") else ""
    return {
        "url": f"/comfy_output/{subfolder}{result['filename']}",
        "filename": result["filename"], "comfy_filename": result["filename"],
        "compiled_prompt": req.prompt.strip(), "mode": "temporal_reshot",
        "submitted_resources": {
            "reference_videos": [{"url": req.video_url, "comfy_filename": source_filename}],
            "reference_images": [
                {"url": url, "comfy_filename": filename}
                for url, filename in zip([url for url in req.ref_image_urls if url], references)
            ],
        },
    }


@app.post("/generate-video-reshot")
async def generate_video_reshot_endpoint(req: TemporalReshotRequest):
    return await submit_job(
        "video_reshot", lambda job: _run_temporal_reshot_job(job, req), request=req,
        prompt=req.prompt, mode="temporal_reshot",
    )


class AVBridgeRequest(BaseModel):
    """Redo one interval of a clip with both of its ends frozen.

    The caller says which seconds to redo and how much context to freeze; the
    frame grids are resolved here rather than in the UI, because getting them
    wrong is a failed render three minutes later: the preserved run has to be
    39/90/141/192 and the target has to be 5+17k AND clear twice the context.
    """
    video_url: str
    prompt: str
    start_frame: int
    frame_count: int
    context_frames: int = 39
    width: int = 1376
    height: int = 768
    steps: int = 20
    seed: int = -1
    sage: str = DEFAULT_H3_ACCEL


def plan_av_bridge(start_frame: int, frame_count: int, context_frames: int,
                   source_frames: Optional[int] = None) -> dict:
    """Resolve a repair window onto H3's grids, or say why it does not fit."""
    import workflow_builders as wb

    if frame_count < 1:
        raise ValueError("重做区间至少 1 帧")
    preserve, target, middle = wb.bridge_plan(frame_count, context_frames)
    head_end = int(start_frame)
    tail_start = int(start_frame) + middle
    if head_end < preserve:
        raise ValueError(
            f"重做区间前面只有 {head_end} 帧，冻住两端需要各 {preserve} 帧"
            f"（{preserve / 24:.2f} 秒）。把区间往后挪，或把上下文降到 39 帧。")
    if source_frames is not None and tail_start + preserve > source_frames:
        raise ValueError(
            f"重做区间后面只剩 {max(0, source_frames - tail_start)} 帧，冻住两端需要各 {preserve} 帧。"
            f"把区间往前挪、缩短它，或把上下文降到 39 帧。")
    return {
        "preserve": preserve, "target": target, "middle": middle,
        "head_end": head_end, "tail_start": tail_start,
        # What the caller asked for is rarely what the grid allows; the UI shows
        # this back so the difference is visible before the render, not after.
        "requested_frames": int(frame_count),
        "middle_seconds": round(middle / 24.0, 3),
        "preserve_seconds": round(preserve / 24.0, 3),
    }


async def _run_av_bridge_job(job: dict, req: AVBridgeRequest) -> dict:
    if not req.prompt.strip():
        raise ValueError("重做中间需要一段提示词，描述这一段要演什么")
    source_path = await resolve_upload(req.video_url)
    geometry = _probe_video_geometry(source_path)
    source_frames = geometry[2] if geometry else None
    plan = plan_av_bridge(req.start_frame, req.frame_count, req.context_frames, source_frames)

    width, height = req.width, req.height
    if geometry:
        # The bridge lays the source back over its own output, so generating at
        # a different size than the source would blend two different pictures.
        width, height = geometry[0], geometry[1]

    source_filename = await ensure_comfyui_uploaded(req.video_url)
    result = await comfyui.av_bridge_h3(
        source_video=source_filename, prompt=req.prompt.strip(),
        head_end=plan["head_end"], tail_start=plan["tail_start"],
        preserve=plan["preserve"], target=plan["target"],
        width=width, height=height, steps=req.steps, seed=req.seed, sage=req.sage,
        on_queued=_make_on_queued(job), return_info=True,
    )
    subfolder = f"{result['subfolder']}/" if result.get("subfolder") else ""
    return {
        "url": f"/comfy_output/{subfolder}{result['filename']}",
        "filename": result["filename"], "comfy_filename": result["filename"],
        "compiled_prompt": req.prompt.strip(), "mode": "av_bridge",
        "bridge_plan": plan,
        "latent_filename": result.get("latent_filename"),
        # Where the latent's frames sit in the assembled clip. Frames outside
        # [latent_output_start, latent_output_start + target) are the source's own,
        # so an HD version takes the source's HD there; the new middle is
        # [head_end, tail_start). Everything in output-frame numbers.
        "latent_span": {
            "source_url": req.video_url,
            "latent_output_start": plan["head_end"] - plan["preserve"],
            "latent_frames": plan["target"],
            "new_from": plan["head_end"],
            "new_to": plan["tail_start"],
            "preserve": plan["preserve"],
        },
        "submitted_resources": {
            "reference_videos": [{"url": req.video_url, "comfy_filename": source_filename}],
        },
    }


@app.post("/plan-av-bridge")
async def plan_av_bridge_endpoint(req: AVBridgeRequest):
    """Dry-run the frame math so the UI can show the real window before rendering."""
    try:
        source_frames = None
        try:
            geometry = _probe_video_geometry(await resolve_upload(req.video_url))
            source_frames = geometry[2] if geometry else None
        except FileNotFoundError:
            pass
        return {"ok": True, **plan_av_bridge(req.start_frame, req.frame_count,
                                             req.context_frames, source_frames)}
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}


@app.post("/generate-av-bridge")
async def generate_av_bridge_endpoint(req: AVBridgeRequest):
    return await submit_job(
        "av_bridge", lambda job: _run_av_bridge_job(job, req), request=req,
        prompt=req.prompt, mode="av_bridge",
    )


@app.post("/preview-video-workflow")
async def preview_video_workflow(req: VideoRequest):
    """
    Dry-run: run the same prompt post-processor that _run_video_job uses and
    return the compiled H3 prompt (plus resolved filenames and params) without
    building or submitting any ComfyUI workflow.  Used by the frontend debug panel.
    """
    from urllib.parse import urlparse as _urlparse
    from comfyui_client import _resolve_seed

    def _url_to_name(url: str) -> str:
        if not url:
            return ""
        return Path(_urlparse(url).path).name or url

    IMAGE_EXTS = {'.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tiff'}

    first_frame_filename = _url_to_name(req.image_url) if req.image_url else None
    last_frame_filename  = _url_to_name(req.last_frame_url) if req.last_frame_url else None

    image_refs = [n for u in req.ref_image_urls
                  if u and (n := _url_to_name(u))]
    audio_refs = [n for u in req.ref_audio_urls
                  if u and Path(_url_to_name(u)).suffix.lower() not in IMAGE_EXTS
                  and (n := _url_to_name(u))]
    video_refs = [n for u in req.ref_video_urls
                  if u and Path(_url_to_name(u)).suffix.lower() not in IMAGE_EXTS
                  and (n := _url_to_name(u))]

    frame_len = req.length
    if req.duration and (not req.length or req.length == 124):
        n = max(5, round(req.duration * 24))
        frame_len = n + (5 - n % 17) % 17

    effective_duration = (frame_len / 24.0) if frame_len else (req.duration or 5.1)

    compiled_prompt = build_smart_fallback_h3_prompt(
        prompt=req.prompt,
        mode=req.mode,
        has_first_frame=bool(first_frame_filename),
        has_last_frame=bool(last_frame_filename),
        num_ref_images=len(image_refs),
        num_ref_videos=len(video_refs),
        num_ref_audios=len(audio_refs),
        audio_strategy=req.audio_strategy or "copy_source",
        duration=effective_duration,
    )

    detected_mode = req.mode or (
        "fl2va" if (req.image_url and req.last_frame_url)
        else "l2va" if req.last_frame_url
        else "i2va" if req.image_url
        else "ref2va" if (req.ref_image_urls or req.ref_audio_urls or req.ref_video_urls)
        else "t2va"
    )

    return {
        "mode": detected_mode,
        "compiled_prompt": compiled_prompt,
        "prompt_was_modified": compiled_prompt != req.prompt,
        "resolved_files": {
            "first_frame": first_frame_filename,
            "last_frame": last_frame_filename,
            "image_refs": image_refs,
            "audio_refs": audio_refs,
            "video_refs": video_refs,
        },
        "params": {
            "width": req.width,
            "height": req.height,
            "steps": req.steps,
            "length": frame_len,
            "seed": _resolve_seed(req.seed),
            "sage": req.sage,
        },
    }


# ── Audio generation (ACE-Step music / Stable Audio Open ambience) ────────────

class MusicRequest(BaseModel):
    tags: str                              # genre / instruments / mood / bpm
    lyrics: str = "[instrumental]"         # structure tags for an instrumental cue
    seconds: float = 60.0
    steps: int = 60
    cfg: float = 5.0
    seed: int = -1
    lyrics_strength: float = 0.99


class AmbienceRequest(BaseModel):
    prompt: str
    seconds: float = 30.0                  # Stable Audio Open caps out near 47s
    steps: int = 50
    cfg: float = 5.0
    seed: int = -1
    negative_prompt: str = ""


async def _run_music_job(job: dict, req: MusicRequest) -> dict:
    res = await comfyui.generate_music(
        tags=req.tags, lyrics=req.lyrics, seconds=req.seconds,
        steps=req.steps, cfg=req.cfg, seed=req.seed,
        lyrics_strength=req.lyrics_strength,
        on_queued=_make_on_queued(job),
        return_info=True,
    )
    if isinstance(res, dict):
        sub = f"{res['subfolder']}/" if res.get("subfolder") else ""
        return {"url": f"/comfy_output/{sub}{res['filename']}", "filename": res["filename"]}
    else:
        out_name = f"music_{job['id']}.flac"
        (UPLOAD_DIR / out_name).write_bytes(res)
        return {"url": f"/uploads/{out_name}"}


@app.post("/generate-music")
async def generate_music_endpoint(req: MusicRequest):
    return await submit_job(
        "music", lambda job: _run_music_job(job, req), request=req,
        prompt=req.tags, seconds=req.seconds,
    )


async def _run_ambience_job(job: dict, req: AmbienceRequest) -> dict:
    res = await comfyui.generate_ambience(
        prompt=req.prompt, seconds=req.seconds, steps=req.steps,
        cfg=req.cfg, seed=req.seed, negative_prompt=req.negative_prompt,
        on_queued=_make_on_queued(job),
        return_info=True,
    )
    if isinstance(res, dict):
        sub = f"{res['subfolder']}/" if res.get("subfolder") else ""
        return {"url": f"/comfy_output/{sub}{res['filename']}", "filename": res["filename"]}
    else:
        out_name = f"ambience_{job['id']}.flac"
        (UPLOAD_DIR / out_name).write_bytes(res)
        return {"url": f"/uploads/{out_name}"}


@app.post("/generate-ambience")
async def generate_ambience_endpoint(req: AmbienceRequest):
    return await submit_job(
        "ambience", lambda job: _run_ambience_job(job, req), request=req,
        prompt=req.prompt, seconds=req.seconds,
    )


# ── Speech: H3 speaks a line / Seed-VC changes a voice ────────────────────────

class SpeechRequest(BaseModel):
    # 'speak': H3 says `text` in the voice described and/or referenced.
    # 'convert': Seed-VC re-voices `source_audio_url` (words and timing kept) with
    #   the timbre of `ref_audio_url`, or of a sample H3 speaks from the description.
    mode: str = "speak"
    text: str = ""
    voice_description: str = ""
    delivery: str = ""
    language: str = ""
    ref_audio_url: Optional[str] = None
    source_audio_url: Optional[str] = None
    # Overrides the built prompt entirely (speak mode and the convert sample).
    prompt: Optional[str] = None
    length: int = 0                         # 0 = estimated from the line
    seed: int = -1
    motion_preset: Optional[str] = None
    trim_silence: bool = True
    diffusion_steps: int = 30
    semitone_shift: int = 0
    auto_f0_adjust: bool = True


async def _speak_with_h3(job: dict, req: SpeechRequest, text: str, out: Path) -> dict:
    has_ref = bool(req.ref_audio_url)
    ref_url = req.ref_audio_url
    if ref_url and Path(ref_url.split("?")[0]).suffix.lower() not in {".wav", ".mp3", ".flac", ".m4a", ".ogg", ".aac"}:
        # A clip wired in as the voice: the H3 job only mounts audio files.
        ref_wav = UPLOAD_DIR / f"speech_ref_{job['id']}.wav"
        await asyncio.to_thread(speech.extract_audio, await resolve_upload(ref_url), ref_wav)
        ref_url = f"/uploads/{ref_wav.name}"
    prompt =(req.prompt or "").strip() or speech.build_speech_prompt(
        text, req.voice_description, req.delivery, req.language, has_ref)
    video_req = VideoRequest(
        prompt=prompt,
        mode="ref2va" if has_ref else "t2va",
        ref_audio_urls=[ref_url] if has_ref else [],
        width=speech.SPEECH_WIDTH, height=speech.SPEECH_HEIGHT,
        length=speech.snap_length(req.length) if req.length else speech.estimate_frames(text),
        seed=req.seed, motion_preset=req.motion_preset,
        save_latent=False, live_preview=False,
    )
    job["batch_info"] = "SPEAKING"
    result = await _run_video_job(job, video_req)
    clip = await resolve_upload(result["url"])
    await asyncio.to_thread(speech.extract_audio, clip, out, 48000, req.trim_silence)
    return {"compiled_prompt": result.get("compiled_prompt") or prompt,
            "clip_url": result["url"], "length": video_req.length,
            "submitted_resources": result.get("submitted_resources")}


async def _run_speech_job(job: dict, req: SpeechRequest) -> dict:
    job_id = job["id"]
    if req.mode == "convert":
        if not req.source_audio_url:
            raise ValueError("convert needs the audio whose voice is changed")
        if not req.ref_audio_url and not req.voice_description.strip():
            raise ValueError("convert needs a reference voice or a voice description")
        if not speech.seed_vc_installed():
            raise RuntimeError(f"Seed-VC is not installed at {speech.SEED_VC_DIR}")
        source = await resolve_upload(req.source_audio_url)
        extra: dict = {}
        if req.ref_audio_url:
            reference = await resolve_upload(req.ref_audio_url)
        else:
            # No reference recording: H3 speaks a sample in the described voice,
            # and that sample is the timbre Seed-VC converts to.
            reference = UPLOAD_DIR / f"speech_sample_{job_id}.wav"
            sample = await _speak_with_h3(
                job, req, req.text.strip() or speech.SAMPLE_LINE_ZH, reference)
            extra = {"sample_url": f"/uploads/{reference.name}", **sample}
        job["batch_info"] = "CONVERTING"
        save_state()
        out_name = f"voice_{job_id}.wav"
        await speech.convert_voice(
            source, reference, UPLOAD_DIR / out_name,
            diffusion_steps=req.diffusion_steps, semitone_shift=req.semitone_shift,
            auto_f0_adjust=req.auto_f0_adjust)
        return {"url": f"/uploads/{out_name}", "mode": "convert", **extra}

    if not req.text.strip():
        raise ValueError("speak needs a line")
    if not req.ref_audio_url and not req.voice_description.strip():
        raise ValueError("speak needs a voice description or a reference voice")
    out_name = f"speech_{job_id}.wav"
    info = await _speak_with_h3(job, req, req.text.strip(), UPLOAD_DIR / out_name)
    return {"url": f"/uploads/{out_name}", "mode": "speak", **info}


@app.post("/generate-speech")
async def generate_speech_endpoint(req: SpeechRequest):
    if req.mode not in ("speak", "convert"):
        raise HTTPException(400, f"unknown speech mode {req.mode!r}")
    return await submit_job(
        "speech", lambda job: _run_speech_job(job, req), request=req,
        prompt=req.text or req.voice_description, mode=req.mode,
    )


# ── Inpainting (FLUX.2 Inpaint) ──────────────────────────────────────────────

class InpaintRequest(BaseModel):
    image_url: str
    mask_url: str
    prompt: str
    steps: int = 20
    cfg: float = 4.0
    seed: int = -1


async def _run_inpaint_job(job: dict, req: InpaintRequest) -> dict:
    base_path = await resolve_upload(req.image_url)
    mask_path = await resolve_upload(req.mask_url)

    from PIL import Image
    with Image.open(base_path) as img:
        base_w, base_h = img.size

    comfy_base = await comfyui.upload_image(base_path.read_bytes(), base_path.name)
    comfy_mask = await comfyui.upload_image(mask_path.read_bytes(), mask_path.name)

    img_bytes = await comfyui.generate_inpaint(
        prompt=req.prompt,
        image_filename=comfy_base,
        mask_filename=comfy_mask,
        width=base_w,
        height=base_h,
        steps=req.steps,
        guidance=req.cfg,
        seed=resolve_seed(req.seed),
    )

    out_name = f"inpaint_{job['id']}.png"
    (UPLOAD_DIR / out_name).write_bytes(img_bytes)
    return {"url": f"/uploads/{out_name}"}


@app.post("/generate-inpaint")
async def generate_inpaint(req: InpaintRequest):
    return await submit_job("inpaint", lambda job: _run_inpaint_job(job, req), request=req)


# ── Qwen-Image-2.1 ───────────────────────────────────────────────────────────

class QwenImageRequest(BaseModel):
    """Text-to-image, or an edit against up to 10 reference images.

    `reference_urls` order is the model's `<image N>` numbering and comes from the
    canvas edge order, the same rule H3 follows for `<Picture N>`. With any
    reference the canvas takes reference 1's aspect ratio and width/height are
    ignored; without one they size an empty latent.
    """
    prompt: str
    reference_urls: list[str] = []
    negative_prompt: str = ""
    width: int = 1376
    height: int = 768
    steps: int = 25
    cfg: float = 1.0
    seed: int = -1
    # A LoRA file under ComfyUI's loras/, e.g. QI2.1_AnyAngle.safetensors.
    lora_name: str = ""
    lora_strength: float = 1.0
    # Key into workflow_builders.QWEN_IMAGE_21_BASE_MODELS: "qwen21" | "noctAnime".
    base_model: str = "qwen21"
    # With references: how big the picture is worked at. The references are resized to about
    # ref_resolution x ref_resolution pixels (1024 = about 1 MP, what the model is tuned for); 0 keeps
    # reference 1 at its own size, so a 2752x1536 source comes out 2752x1536.
    ref_resolution: int = Field(1024, ge=0, le=4096)
    # "turbo": the Viggle distilled LoRA, 7 steps, no CFG, no negative prompt (steps, cfg and
    # negative_prompt are then ignored). "base": the plain graph at `steps` / `cfg`. Turbo only
    # applies to the qwen21 base without another LoRA; anything else runs as "base", and so does a
    # ComfyUI without the turbo nodes. The result says which one ran.
    speed: Literal["turbo", "base"] = "turbo"


async def _run_qwen_image_job(job: dict, req: QwenImageRequest) -> dict:
    import workflow_builders as wb
    wb.qwen_image_21_unet(req.base_model)  # refuse an unknown key before uploading
    if len(req.reference_urls) > 10:
        raise ValueError(
            f"Qwen-Image-2.1 takes at most 10 reference images, got {len(req.reference_urls)}"
        )
    comfy_refs, ref_bytes = [], []
    for url in req.reference_urls:
        path = await resolve_upload(url)
        ref_bytes.append(path.read_bytes())
        comfy_refs.append(await comfyui.upload_image(ref_bytes[-1], path.name))

    seed = wb.seed_clear_of_references(resolve_seed(req.seed), ref_bytes)
    ran: dict = {}
    img_bytes = await comfyui.generate_qwen_image_21(
        prompt=req.prompt,
        reference_filenames=comfy_refs,
        negative_prompt=req.negative_prompt,
        width=req.width,
        height=req.height,
        steps=req.steps,
        cfg=req.cfg,
        seed=seed,
        lora_name=req.lora_name,
        lora_strength=req.lora_strength,
        base_model=req.base_model,
        ref_resolution=req.ref_resolution,
        turbo=req.speed == "turbo",
        info=ran,
        on_queued=_make_on_queued(job),
    )

    out_name = f"qwen21_{job['id']}.png"
    (UPLOAD_DIR / out_name).write_bytes(img_bytes)
    return {"url": f"/uploads/{out_name}", "seed": seed,
            "speed": "turbo" if ran.get("turbo") else "base"}


@app.post("/generate-qwen-image")
async def generate_qwen_image(req: QwenImageRequest):
    return await submit_job(
        "qwen_image", lambda job: _run_qwen_image_job(job, req), request=req,
        prompt=req.prompt,
    )


# ── Image upscale (RealESRGAN) ───────────────────────────────────────────────

IMAGE_UPSCALE_MODELS = {"RealESRGAN_x2.pth", "realesr-animevideov3.pth"}


# Measured 2026-10-04 on a video frame (1376x768, ref_resolution 0): composition, people,
# colours and light unchanged, edge energy about doubled. A looser "enhance this
# photograph" prompt sharpened more but moved more pixels.
DETAIL_PROMPT = (
    "Keep <image 1> exactly as it is: same composition, same people, same pose, same expression, "
    "same clothing, same colors, same lighting. Only restore fine detail and sharpness: skin pores, "
    "hair strands, fabric weave, surface texture, crisp edges. Do not add, remove or move anything."
)
DETAIL_NEGATIVE = (
    "blurry, soft, low resolution, jpeg artifacts, plastic skin, over-smoothed, oversharpened, "
    "changed face, changed composition, extra objects, text, watermark"
)


class ImageUpscaleRequest(BaseModel):
    image_url: str
    # "upscale": RealESRGAN only. "detail": Qwen-Image 2.1 re-renders the picture at its own
    # size with fine detail restored. "both": RealESRGAN first, then Qwen at the larger size.
    mode: str = "upscale"
    model_name: str = "RealESRGAN_x2.pth"
    # Long edge to resample the model's fixed factor to, keeping the aspect ratio;
    # 0 keeps the native upscale. Ignored by "detail".
    target_long_edge: int = Field(0, ge=0, le=8192)
    # Replaces DETAIL_PROMPT when set (modes "detail" and "both").
    prompt: str = ""
    seed: int = -1


async def _run_image_upscale_job(job: dict, req: ImageUpscaleRequest) -> dict:
    import workflow_builders as wb
    if req.mode not in ("upscale", "detail", "both"):
        raise ValueError(f"Unknown mode: {req.mode}")
    if req.model_name not in IMAGE_UPSCALE_MODELS:
        raise ValueError(f"Unknown upscale model: {req.model_name}")
    path = await resolve_upload(req.image_url)
    data = path.read_bytes()
    comfy_name = await comfyui.upload_image(data, path.name)
    result: dict = {}

    if req.mode in ("upscale", "both"):
        target_w = target_h = 0
        if req.target_long_edge > 0:
            from PIL import Image
            with Image.open(path) as img:
                src_w, src_h = img.size
            scale = req.target_long_edge / max(src_w, src_h)
            target_w, target_h = max(1, round(src_w * scale)), max(1, round(src_h * scale))
        data = await comfyui.upscale_image_esrgan(comfy_name, req.model_name, target_w, target_h)
        if req.mode == "both":
            comfy_name = await comfyui.upload_image(data, f"upscale_{job['id']}_step1.png")

    if req.mode in ("detail", "both"):
        seed = wb.seed_clear_of_references(resolve_seed(req.seed), [data])
        data = await comfyui.generate_qwen_image_21(
            prompt=req.prompt.strip() or DETAIL_PROMPT,
            reference_filenames=[comfy_name],
            negative_prompt=DETAIL_NEGATIVE,
            steps=25, cfg=1.0, seed=seed,
            # 0 keeps reference 1 at its own size, so the picture comes out as large as it went in.
            ref_resolution=0,
        )
        result["seed"] = seed

    out_name = f"upscale_{job['id']}.png"
    (UPLOAD_DIR / out_name).write_bytes(data)
    return {"url": f"/uploads/{out_name}", **result}


@app.post("/upscale-image")
async def upscale_image(req: ImageUpscaleRequest):
    return await submit_job(
        "image_upscale", lambda job: _run_image_upscale_job(job, req), request=req,
        prompt=f"{req.mode} {req.image_url.rsplit('/', 1)[-1]}",
    )


class TitleBlockRequest(BaseModel):
    logo_url: str
    line: str = ""
    height: int = Field(1536, ge=256, le=4096)
    margin: int = Field(104, ge=0, le=1024)
    content_width: int = Field(620, ge=16, le=4096)
    # Width of the small line; 0 = as wide as the logo. Wider means bigger text.
    line_width: int = Field(0, ge=0, le=4096)
    line_height_scale: float = Field(1.0, ge=0.5, le=3.0)
    # A clean cover plate to set the block on, at its left or right edge. Without one the answer is the block itself.
    plate_url: str = ""
    side: str = Field("left", pattern="^(left|right)$")


def _build_title_block(path: Path, req: TitleBlockRequest, plate_path: Path | None = None) -> tuple[bytes, dict]:
    import io
    import sys
    from PIL import Image
    tools_dir = str(_BACKEND_DIR.parent / "tools")
    if tools_dir not in sys.path:
        sys.path.insert(0, tools_dir)
    import title_block
    with Image.open(path) as logo:
        block, layout = title_block.build_block(
            logo, req.line, req.height, req.margin, req.content_width,
            line_width=req.line_width or None, line_height_scale=req.line_height_scale,
        )
    if plate_path is not None:
        with Image.open(plate_path) as plate:
            card = title_block.place_block(plate, block, req.side)
        layout["width"], layout["height"] = card.size
        block = card
    out = io.BytesIO()
    block.save(out, "PNG")
    return out.getvalue(), layout


@app.post("/title-block/build")
async def build_title_block(req: TitleBlockRequest):
    """A transparent title block (logo on top, one line of real text at the bottom, equal margins).
    Takes a fraction of a second, so it answers directly instead of going through the job queue."""
    try:
        path = await resolve_upload(req.logo_url)
    except FileNotFoundError as exc:
        raise HTTPException(404, f"Missing media: {req.logo_url}") from exc
    plate_path = None
    if req.plate_url:
        try:
            plate_path = await resolve_upload(req.plate_url)
        except FileNotFoundError as exc:
            raise HTTPException(404, f"Missing media: {req.plate_url}") from exc
    try:
        data, layout = await asyncio.to_thread(_build_title_block, path, req, plate_path)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    key = hashlib.sha1(
        f"{path}:{path.stat().st_mtime_ns}:{plate_path}:{plate_path.stat().st_mtime_ns if plate_path else 0}:"
        f"{req.model_dump_json()}".encode("utf-8")).hexdigest()[:16]
    name = f"titleblock_{key}.png"
    (UPLOAD_DIR / name).write_bytes(data)
    return {"url": f"/uploads/{name}", "width": layout["width"], "height": layout["height"],
            "gap": layout.get("gap")}


# ── Video upscale helpers ──────────────────────────────────────────────────────

def get_video_frame_count(video_path: Path) -> tuple[int, float]:
    """Return (total_frames, fps) using cv2. Falls back to (0, 16.0) on error."""
    try:
        import cv2
        cap = cv2.VideoCapture(str(video_path))
        fps   = cap.get(cv2.CAP_PROP_FPS) or 16.0
        count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        cap.release()
        return count, fps
    except Exception:
        return 0, 16.0


def merge_audio_to_video(video_path: Path, audio_source_path: Path, output_path: Path) -> None:
    """Merge audio from audio_source_path into video_path using FFmpeg."""
    try:
        # We use -map 0:v:0 to get video from the first input (upscaled)
        # and -map 1:a:0? to get audio from the second input (original), optionally
        # -shortest ensures we don't have trailing audio/video if durations differ slightly
        # We re-encode to H.264 (libx264) with yuv420p pixel format to guarantee 100% browser playability
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(video_path), "-i", str(audio_source_path),
             "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "17", "-preset", "fast",
             "-c:a", "aac", "-map", "0:v:0", "-map", "1:a:0?",
             "-shortest", str(output_path)],
            check=True, capture_output=True,
        )
    except Exception as e:
        logger.warning("Audio merge failed: %s", e)
        import shutil
        if video_path != output_path:
            shutil.copy2(video_path, output_path)


# ── Video interpolation & upscale ─────────────────────────────────────────────

class VideoUpscaleRequest(BaseModel):
    video_url: str
    width: int = 896
    height: int = 1664
    steps: int = 4
    denoise_strength: float = 0.25
    seed: int = -1
    target_fps: float = 0.0   # 0 = keep source FPS (no RIFE interpolation)
    repair: bool = False   # deprecated: WanVideo removed, always False
    length: int = 0
    # "h3_latent" — lossless latent 2nd-pass refiner (highest quality, generates new micro-details)
    # "esrgan"    — deterministic: cannot flicker, no batching, ~4x faster, adds no detail
    # "lms"       — same-resolution H3 guide-latent sharpening
    method: str = MACHINE_PROFILE.get("upscale_method", "h3_latent")
    esrgan_model: str = "RealESRGAN_x2.pth"
    latent_filename: Optional[str] = None
    # A chained clip's overlap with the previous shot: keep it in the output
    # (the latent path otherwise trims it so the result matches the trimmed
    # clip). The other methods are simply given the untrimmed file.
    keep_context: bool = False
    # Frames at the head of the result that overlap the previous shot (a chained
    # shot enhanced 含重叠帧). The result is then served cut (url) with the full
    # file beside it (untrimmed_url + context_frames), the way a generated chain
    # clip is: only the cut room reads the overlap.
    overlap_frames: int = 0
    scale_by: float = 1.5
    prompt: Optional[str] = None
    # h3_latent: a file in latent_upscale_models/ to use instead of H3_LATENT_UPSCALER / the default.
    upscale_model: Optional[str] = None
    # ── h3_latent only ─────────────────────────────────────────────────────────
    # Verbatim sigma list for the refinement pass. Defaults to REFINE_SIGMAS
    # ("0.6, 0"), a single step. steps/denoise_strength do not apply to this path.
    manual_sigmas: Optional[str] = None
    # Attention patch of the refine pass: a workflow_builders.H3_ACCEL_PRESETS name ("sol" is the default,
    # "kjsage" SageAttention) or "none" for the model's own attention. Absent = the default.
    sage: Optional[str] = None
    # The source shot's reference images (ComfyUI input filenames). The refine pass
    # re-encodes its conditioning at the upscaled size and reads these for texture.
    reference_images: Optional[list[str]] = None
    # The frames the shot was generated from. An I2V shot has no references at
    # all, so without these its refine pass re-encodes with no image anchoring
    # while the generation was pinned on a first frame.
    first_frame: Optional[str] = None
    last_frame: Optional[str] = None
    # A chained shot's previous chain, already enhanced: its HD file and this
    # shot's overlap in frames. The last anchor_frames of that file are exactly
    # this latent's context window at HD, so they are mounted over it as a clip
    # guide (h3_latent only) and the two HD shots agree across the seam.
    prev_hd_url: Optional[str] = None
    anchor_frames: int = 0
    # A shot that carries on from frame N of the previous clip rather than its end:
    # the overlap is frames N-anchor_frames..N-1 of the previous HD file (0 = its tail).
    anchor_end_frame: int = 0
    # Spatial tile size in px, 0 = sample the whole frame. Only worth setting when a
    # frame will not fit in VRAM: every tile costs a full model re-stage.
    spatial_tile: int = 0
    # Temporal chunk length in frames (multiple of 17), 0 = the whole clip as one
    # span, which is the production setting: the refine is not batched over time
    # (2026-09-06). Set only when a clip will not fit in VRAM.
    temporal_chunk: int = 0


class VideoInterpolateRequest(BaseModel):
    video_url: str
    target_fps: float = 30.0


class MseFragmentRequest(BaseModel):
    """One independently cached playback fragment, never a merged movie."""
    video_url: str
    start: Optional[float] = 0.0
    duration: Optional[float] = 0.0
    width: Optional[int] = 1376
    height: Optional[int] = 768
    fps: Optional[int] = 24


MSE_FRAGMENT_DIR = UPLOAD_DIR / "mse_fragments"
MSE_FRAGMENT_DIR.mkdir(exist_ok=True)


def _has_audio_stream(path: Path) -> bool:
    result = subprocess.run(
        [os.environ.get("FFPROBE", "ffprobe"), "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=index", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True,
    )
    return result.returncode == 0 and bool(result.stdout.strip())


@app.post("/preview/mse-fragment")
async def build_mse_fragment(req: MseFragmentRequest):
    """Return a uniform fragmented MP4 for MSE `sequence` mode.

    Each source clip is cached separately. Nothing is concatenated or adopted as
    a new asset; the browser creates the continuous timeline in memory.
    """
    source = await resolve_upload(req.video_url)
    width = max(32, int(req.width or 1376) // 2 * 2)
    height = max(32, int(req.height or 768) // 2 * 2)
    fps = max(1, min(60, int(req.fps or 24)))
    start = max(0.0, float(req.start or 0.0))
    source_frames, source_fps = get_video_frame_count(source)
    source_duration = source_frames / source_fps if source_frames and source_fps else 0.0
    duration = float(req.duration) if req.duration and req.duration > 0 else max(0.04, source_duration - start)
    if duration <= 0:
        raise HTTPException(400, "MSE fragment has no playable duration")

    fingerprint = f"{source.resolve()}|{source.stat().st_mtime_ns}|{start:.6f}|{duration:.6f}|{width}x{height}|{fps}|v4"
    output = MSE_FRAGMENT_DIR / f"{hashlib.sha256(fingerprint.encode()).hexdigest()[:24]}.mp4"
    if not output.exists():
        vf = (
            f"scale={width}:{height}:force_original_aspect_ratio=decrease:force_divisible_by=2,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:black,fps={fps},format=yuv420p"
        )
        command = ["ffmpeg", "-y", "-v", "error", "-ss", f"{start:.6f}", "-i", str(source)]
        if _has_audio_stream(source):
            # apad: the sound must reach the end of the picture. A clip whose sound
            # stops short leaves a hole in the joined buffer and playback halts there.
            command += ["-map", "0:v:0", "-map", "0:a:0", "-af", "aresample=48000:async=1:first_pts=0,apad"]
        else:
            command += ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-map", "0:v:0", "-map", "1:a:0"]
        command += [
            "-t", f"{duration:.6f}", "-vf", vf,
            "-c:v", "libx264", "-profile:v", "high", "-level:v", "4.1",
            # No B-frames: a fragmented mp4 has no edit list, so B-frame reordering
            # starts the picture at pts 2/fps while the audio starts at 0, and the
            # browser shows every clip two frames late against the timeline.
            "-preset", "veryfast", "-crf", "20", "-bf", "0", "-g", str(fps),
            "-keyint_min", str(fps), "-sc_threshold", "0",
            "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "192k",
            "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
            # Without this the AAC priming delay (1024 samples) is folded into the
            # first video frame: it lasts 63 ms and every later frame sits 21 ms
            # late, so the clip's last frame ends past appendWindowEnd, the browser
            # drops it, and every join jumps a frame (C18a2->C18a3, 2026-09-24).
            "-avoid_negative_ts", "make_non_negative",
            "-frag_duration", "500000", "-f", "mp4", str(output),
        ]
        result = await asyncio.to_thread(subprocess.run, command, capture_output=True, text=True)
        if result.returncode != 0:
            output.unlink(missing_ok=True)
            raise HTTPException(500, f"MSE fragment encode failed: {result.stderr.strip()[-400:]}")
    return Response(
        content=output.read_bytes(), media_type="video/mp4",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


async def _run_video_interpolate_job(job: dict, req: VideoInterpolateRequest) -> dict:
    job_id = job["id"]
    video_path = await resolve_upload(req.video_url)
    local_filename = video_path.name

    _, source_fps = get_video_frame_count(video_path)
    if source_fps <= 0:
        source_fps = 16.0  # Fallback

    rife_multiplier = max(1, round(req.target_fps / source_fps))
    logger.info("Starting video interpolation: %s (multiplier x%d, target_fps=%s)",
                local_filename, rife_multiplier, req.target_fps)

    job["batch_info"] = "INTERPOLATING"
    save_state()

    comfy_filename = await comfyui.upload_video(video_path.read_bytes(), local_filename)

    rife_bytes = await comfyui.interpolate_video(
        video_filename=comfy_filename,
        rife_multiplier=rife_multiplier,
        fps=source_fps,
    )

    temp_out = UPLOAD_DIR / f"temp_interpolate_{job_id}.mp4"
    temp_out.write_bytes(rife_bytes)

    out_name = f"interpolate_{job_id}.mp4"
    out_path = UPLOAD_DIR / out_name

    # Merge original audio back (uses libx264/yuv420p for perfect browser playability!)
    await asyncio.to_thread(merge_audio_to_video, temp_out, video_path, out_path)
    temp_out.unlink(missing_ok=True)

    return {"url": f"/uploads/{out_name}"}


UPSCALE_FROM_VIDEO_MAX_FRAMES = 600


def _decoded_video_frames(path: Path) -> tuple[int, float]:
    """(frames in the first picture stream, its frame rate), counted by decoding
    packets rather than read off the container's duration."""
    import subprocess
    res = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_packets",
         "-show_entries", "stream=nb_read_packets,avg_frame_rate,r_frame_rate",
         "-of", "json", str(path)], capture_output=True, text=True)
    try:
        st = json.loads(res.stdout or "{}")["streams"][0]
    except (KeyError, IndexError, ValueError):
        return 0, 0.0
    def rate(v: str) -> float:
        try:
            n, d = (float(x) for x in str(v).split("/"))
            return n / d if d else 0.0
        except ValueError:
            return 0.0
    return int(st.get("nb_read_packets") or 0), rate(st.get("avg_frame_rate")) or rate(st.get("r_frame_rate"))


def _prepare_upscale_source_video(video_path: Path, job_id: str, fit_long_side: int = 0) -> dict:
    """A plain clip, made ready to be encoded as an H3 AV latent for the refine.

    24 fps, both sides rounded to /32, frames padded by holding the last one to
    the next 51k+39 count (the AV grid MiniMaxH3ExistingVideoMaskedContext snaps
    to), sound padded with silence -- or silence made up when the clip has none,
    since the encoder needs an audio stream. Written to ComfyUI's input folder.
    """
    import math
    import subprocess

    frames, fps = _decoded_video_frames(video_path)
    fps = fps if fps and fps > 0 else 24.0
    # Frames actually in the picture stream, at 24 fps. Not the container's
    # duration: a sound track longer than the picture (8.595 s over 8.5 s) made
    # it 206 frames for a 204-frame clip.
    target = max(5, int(round(frames * 24 / fps))) if frames > 0 else 0
    if target <= 0:
        raise ComfyUIError("读不出这段视频的帧数，无法做潜空间增强。")
    if target > UPSCALE_FROM_VIDEO_MAX_FRAMES:
        raise ComfyUIError(f"没有潜变量的视频一次最多增强 {UPSCALE_FROM_VIDEO_MAX_FRAMES} 帧（25 秒）；请先剪短。")
    padded = 39 + 51 * max(0, math.ceil((target - 39) / 51))
    geometry = _probe_video_geometry(video_path)
    if not geometry or not geometry[0] or not geometry[1]:
        raise ComfyUIError("读不出这段视频的画面尺寸，无法做潜空间增强。")
    src_w, src_h = geometry[:2]
    w = max(32, int(round(src_w / 32)) * 32)
    h = max(32, int(round(src_h / 32)) * 32)
    if fit_long_side and max(src_w, src_h) > fit_long_side:
        # conditioning for an audio-only pass: a 2752x1536 clip is read at 1376x768, because attending
        # over 4x the video tokens would change nothing in a picture that is kept as it is
        k = fit_long_side / max(src_w, src_h)
        w = max(32, int(round(src_w * k / 32)) * 32)
        h = max(32, int(round(src_h * k / 32)) * 32)
    has_audio = bool(subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index",
         "-of", "csv=p=0", str(video_path)], capture_output=True, text=True).stdout.strip())
    # .mov with PCM sound: the encoder checks the sound against the exact
    # timeline (0.55% short was refused), and AAC trims its first and last
    # blocks, so it can never land on the sample.
    out = Path(COMFYUI_INPUT_DIR or UPLOAD_DIR) / f"upscale_src_{job_id}.mov"
    # Picture, sound and mux as three steps. In one command ffmpeg ends the
    # whole output when the picture reaches its frame cap, and the last stretch
    # of sound never got written (9.984 s for 10.125 s). The sound is made to the
    # exact sample count on its own; the mux copies both streams untouched.
    video_tmp = out.with_suffix(".v.mp4")
    audio_tmp = out.with_suffix(".a.wav")
    samples = padded * 2000  # 48000 / 24
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(video_path), "-map", "0:v:0", "-an",
         "-vf", f"setpts=PTS-STARTPTS,fps=24,scale={w}:{h}:flags=lanczos,tpad=stop_mode=clone:stop_duration=60",
         "-frames:v", str(padded), "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", str(video_tmp)],
        check=True, capture_output=True)
    audio_in = (["-i", str(video_path), "-map", "0:a:0"] if has_audio
                else ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"])
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", *audio_in, "-vn",
         "-af", f"asetpts=PTS-STARTPTS,aresample=48000,apad=whole_len={samples},atrim=end_sample={samples}",
         "-ac", "2", "-c:a", "pcm_s16le", str(audio_tmp)],
        check=True, capture_output=True)
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(video_tmp), "-i", str(audio_tmp),
         "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", str(out)],
        check=True, capture_output=True)
    video_tmp.unlink(missing_ok=True)
    audio_tmp.unlink(missing_ok=True)
    # The encoder takes the LAST context_length frames on its 51k+39 grid; a file
    # even one frame short silently becomes a shorter, shifted clip. Refuse instead.
    made, _ = _decoded_video_frames(out)
    if made != padded:
        out.unlink(missing_ok=True)
        raise ComfyUIError(f"准备增强用的视频帧数不对（得到 {made} 帧，需要 {padded} 帧），已停止，没有提交。")
    return {"path": str(out), "frames": target, "padded_frames": padded, "width": w, "height": h,
            "source_width": src_w, "source_height": src_h, "has_audio": has_audio}


def _serve_without_overlap(result: dict, full_path: Path, overlap: int, job_id: str) -> dict:
    """An enhanced chained shot, served the way a generated chain clip is.

    The full file keeps the overlap with the previous shot (the cut room moves
    the seam with it); everything else -- the node, the asset library, frames
    pulled from it, whatever it is wired into -- gets the shot alone.
    """
    import subprocess

    if overlap <= 0 or not full_path.is_file():
        return result
    cut_name = f"hdcut_{job_id}.mp4"
    start = f"{overlap / 24:.6f}"
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(full_path),
         "-vf", f"trim=start_frame={overlap},setpts=PTS-STARTPTS",
         "-af", f"atrim=start={start},asetpts=PTS-STARTPTS",
         "-c:v", "libx264", "-crf", "14", "-preset", "fast", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "256k", str(UPLOAD_DIR / cut_name)],
        check=True, capture_output=True)
    return {**result, "url": f"/uploads/{cut_name}", "untrimmed_url": result["url"], "context_frames": overlap}


def _finish_upscale_from_video(produced: Path, source: Path, prep: dict, job_id: str) -> str:
    """Cut the refined clip back to the source's frame count and give it the
    source's own sound (the padded tail is gone, and the sound was only
    round-tripped through the audio VAE)."""
    import subprocess

    out_name = f"h3up_{job_id}.mp4"
    out_path = UPLOAD_DIR / out_name
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(produced), "-i", str(source),
           "-map", "0:v:0"]
    cmd += ["-map", "1:a:0"] if prep.get("has_audio") else []
    cmd += ["-frames:v", str(prep["frames"]), "-r", "24", "-c:v", "libx264", "-crf", "14",
            "-preset", "fast", "-pix_fmt", "yuv420p"]
    cmd += ["-c:a", "aac", "-b:a", "256k", "-shortest"] if prep.get("has_audio") else []
    cmd += [str(out_path)]
    subprocess.run(cmd, check=True, capture_output=True)
    try:
        Path(prep["path"]).unlink(missing_ok=True)
    except OSError:
        pass
    return out_name


async def _finish_h3_latent_upscale(job: dict, req: "VideoUpscaleRequest", res: dict,
                                     video_source: Optional[dict], video_path: Path) -> dict:
    """The job's result from the file ComfyUI wrote: cut to the clip's length and sound when it was
    encoded from a plain video, and served without the overlap a chained shot carries."""
    job_id = job["id"]
    if video_source:
        produced = Path(COMFYUI_OUTPUT_DIR) / (f"{res['subfolder']}/" if res.get("subfolder") else "") / res["filename"]
        out_name = await asyncio.to_thread(_finish_upscale_from_video, produced, video_path, video_source, job_id)
        result = {"url": f"/uploads/{out_name}", "filename": out_name, "comfy_filename": res["filename"],
                  "method": "h3_latent", "source": "video", "source_frames": video_source["frames"],
                  "padded_frames": video_source["padded_frames"]}
        return await asyncio.to_thread(_serve_without_overlap, result, UPLOAD_DIR / out_name,
                                       int(req.overlap_frames or 0), job_id)
    sub = f"{res['subfolder']}/" if res.get("subfolder") else ""
    result = {"url": f"/comfy_output/{sub}{res['filename']}", "filename": res["filename"], "comfy_filename": res["filename"],
              "anchor": job.get("anchor"), "anchor_error": job.get("anchor_error")}
    produced = Path(COMFYUI_OUTPUT_DIR) / sub / res["filename"]
    return await asyncio.to_thread(_serve_without_overlap, result, produced,
                                   int(req.overlap_frames or 0) if req.keep_context else 0, job_id)


async def _upscale_result_from_comfy(job: dict) -> Optional[dict]:
    """The result of an H3 upscale whose ComfyUI prompt already finished, or None.

    After a backend restart or a lost connection the job used to be run again, "answered from
    ComfyUI's cache". For a clip with no saved latent that never held: each run writes its source
    video again, ComfyUI sees a changed input and recomputes the whole graph (C22a, 2026-10-02:
    the first render finished at 22:04:57, the replay rendered it a second time). The render that
    finished is collected from ComfyUI's history instead.
    """
    if job.get("type") != "upscale" or not job.get("prompt_id") or not isinstance(job.get("request"), dict):
        return None
    try:
        req = VideoUpscaleRequest.model_validate(job["request"])
        if req.method != "h3_latent":
            return None
        state, outputs = await comfyui.prompt_state(job["prompt_id"])
        if state != "success":
            return None
        files, _latent = comfyui.output_files(outputs)
        video = next((f for f in files if str(f.get("filename", "")).lower().endswith(".mp4")), None)
        if not video:
            return None
        video_source = (job.get("upscale_ctx") or {}).get("video_source")
        if not video_source and not req.latent_filename:
            return None   # encoded from a plain video, but what that encode was is not on record
        video_path = await resolve_upload(req.video_url)
        res = {"filename": video["filename"], "subfolder": video.get("subfolder") or ""}
        logger.info("Upscale job %s: collected the finished ComfyUI render %s instead of running it again",
                    job.get("id"), video["filename"])
        return await _finish_h3_latent_upscale(job, req, res, video_source, video_path)
    except Exception:  # noqa: BLE001 -- anything unexpected falls back to running it again
        logger.warning("Could not collect upscale job %s from ComfyUI", job.get("id"), exc_info=True)
        return None


async def _run_video_upscale_job(job: dict, req: VideoUpscaleRequest) -> dict:
    require_upscale_method(req.method)
    job_id = job["id"]
    video_path = await resolve_upload(req.video_url)

    # 1x LMS sharpening. The source is encoded by the H3 VAE as a frame-aligned
    # guide latent; this works for ordinary uploaded clips and does not require a
    # previously saved H3 latent. H3 samples at 24 fps on a 17k+5 frame grid, so
    # normalize and pad the guide, then trim back to the source duration and copy
    # its original audio after generation.
    if req.method == "lms":
        import math
        import subprocess
        import uuid

        source_frames, source_fps = get_video_frame_count(video_path)
        if source_fps <= 0:
            source_fps = 24.0
        duration = source_frames / source_fps if source_frames > 0 else 0
        target_frames = max(5, int(round(duration * 24))) if duration else max(5, req.length or 124)
        if req.length > 0:
            target_frames = min(target_frames, int(req.length))
        if target_frames > 430:
            raise ComfyUIError("1× LMS 锐化目前单次最多处理 430 帧（约 17.9 秒）；请先切成较短片段。")
        valid_frames = 5 + 17 * max(0, math.ceil((target_frames - 5) / 17))

        geometry = _probe_video_geometry(video_path)
        src_w, src_h = geometry[:2] if geometry else (0, 0)
        if not src_w or not src_h:
            src_w, src_h = int(req.width), int(req.height)
        h3_w = max(32, int(round(src_w / 32)) * 32)
        h3_h = max(32, int(round(src_h / 32)) * 32)
        guide_name = f"lms_guide_{uuid.uuid4().hex[:8]}.mp4"
        guide_path = UPLOAD_DIR / guide_name
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(video_path),
             "-vf", f"fps=24,scale={h3_w}:{h3_h}:flags=lanczos,tpad=stop_mode=clone:stop_duration=30",
             "-frames:v", str(valid_frames), "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p",
             str(guide_path)], check=True, capture_output=True,
        )
        try:
            lms_req = VideoRequest(
                prompt="Enhance this video with sharp, crisp details while preserving a natural photorealistic appearance.",
                width=h3_w, height=h3_h, length=valid_frames, steps=8,
                seed=req.seed, motion_preset=DEFAULT_H3_MOTION_PRESET, accel_lora="turbo8",
                guide_video_url=f"/uploads/{guide_name}",
                style_loras=[{"name": "minimax_h3_lms_v1.0_r64.safetensors", "strength": 1.0}],
            )
            result = await _run_video_job(job, lms_req)
        finally:
            guide_path.unlink(missing_ok=True)

        generated = Path(COMFYUI_OUTPUT_DIR) / Path(result["filename"]).name
        out_name = f"lms_1x_{job_id}.mp4"
        out_path = UPLOAD_DIR / out_name
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(generated), "-i", str(video_path),
             "-map", "0:v:0", "-map", "1:a:0?", "-frames:v", str(target_frames),
             "-vf", f"scale={src_w}:{src_h}:flags=lanczos", "-r", "24",
             "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "17", "-preset", "fast",
             "-c:a", "aac", str(out_path)], check=True, capture_output=True,
        )
        return {"url": f"/uploads/{out_name}", "filename": out_name, "comfy_filename": out_name,
                "method": "lms", "source_frames": source_frames, "output_frames": target_frames}

    # 2. H3 Latent 2nd-pass upscale (Lossless Latent Refiner)
    if req.method == "h3_latent":
        latent_name = req.latent_filename
        search_dirs = [
            Path(COMFYUI_INPUT_DIR) if COMFYUI_INPUT_DIR else None,
            Path(COMFYUI_OUTPUT_DIR) if COMFYUI_OUTPUT_DIR else None,
        ]
        search_dirs = [d for d in search_dirs if d and d.is_dir()]

        found_latent = False
        if latent_name:
            for sdir in search_dirs:
                if (sdir / latent_name).is_file():
                    found_latent = True
                    break

        if not found_latent:
            video_stem = Path(urlparse(req.video_url).path).stem
            candidates = [
                f"{video_stem}.safetensors",
                f"{video_stem.replace('H3_Video_', 'H3_Latent_')}.safetensors",
                f"{video_stem.replace('video_', 'latent_')}.safetensors",
                f"{video_stem}.latent",
                f"{video_stem.replace('H3_Video_', 'H3_Latent_')}.latent",
                f"{video_stem.replace('video_', 'latent_')}.latent",
            ]
            for cand in candidates:
                for sdir in search_dirs:
                    if (sdir / cand).is_file():
                        latent_name = cand
                        found_latent = True
                        break
                if found_latent:
                    break

        # No saved latent (a trim, an edit, an import): encode the clip itself in
        # the graph, the way a chain carries a plain video in. It is normalised to
        # 24 fps and a /32 size, padded (last frame held, silence) to the 51k+39
        # grid the encoder snaps to, and the result is cut back to the clip's own
        # length with its own sound afterwards.
        video_source = None
        if not found_latent or not latent_name:
            video_source = await asyncio.to_thread(_prepare_upscale_source_video, video_path, job_id)
            latent_name = None
            job["upscale_ctx"] = {"video_source": video_source}   # for _upscale_result_from_comfy

        import workflow_builders as _wb
        manual_sigmas = req.manual_sigmas or _wb.REFINE_SIGMAS

        # The previous chain's HD tail over this chain's context window. A chained
        # shot was generated from motion context, not a first frame, so this takes
        # the first-frame slot; anything that fails leaves the refine unanchored
        # (as before) rather than failing the job.
        if req.prev_hd_url and req.anchor_frames > 0:
            try:
                prev_path = await resolve_upload(req.prev_hd_url)
                req.first_frame = await asyncio.to_thread(_hd_tail_anchor, prev_path, int(req.anchor_frames), int(req.anchor_end_frame or 0))
                job["anchor"] = {"prev_hd_url": req.prev_hd_url, "frames": int(req.anchor_frames)}
                logger.info("upscale: anchoring the %d-frame overlap on %s", req.anchor_frames, req.first_frame)
            except Exception as exc:
                job["anchor_error"] = str(exc)
                logger.warning("upscale: could not anchor on the previous chain's HD (%s)", exc)

        # A chained clip was saved without the context window regenerated at its
        # head, but its latent still has it: take the same frames off the upscale
        # so the result lines up frame for frame with its source (2026-09-15).
        # Only a context-sized difference is trimmed; anything else is logged and
        # the decode is left whole rather than cut by a wrong count.
        trim_head = 0
        context_frames = 0
        try:
            latent_path = next((d / latent_name for d in search_dirs if latent_name and (d / latent_name).is_file()), None)
            src_path = await resolve_upload(req.video_url) if req.video_url else None
            if latent_path and src_path and src_path.is_file():
                diff = _h3_latent_decoded_frames(latent_path) - _video_frame_count(src_path)
                if 0 < diff <= 64:
                    trim_head = diff
                    context_frames = diff
                elif diff:
                    logger.warning("upscale: latent/source frame difference %d is not a context window; not trimming", diff)
        except Exception as exc:
            logger.warning("upscale: could not work out the context trim (%s); decoding whole", exc)

        # A span too big for the 32 GB card does not fail, it spills into shared
        # memory and runs several times slower. A node that leaves chunking unset is
        # sized against _UPSCALE_SPAN_TOKEN_BUDGET, conditioning included.
        temporal_chunk = int(req.temporal_chunk or 0)
        if not temporal_chunk:
            try:
                src_path = await resolve_upload(req.video_url) if req.video_url else None
                n_frames, src_w, src_h = _video_frames_and_size(src_path) if src_path and src_path.is_file() else (0, 0, 0)
                # the refine samples the whole latent, context window included: chain 6's
                # 153-frame clip is a 175-frame latent (trim_head is only taken off the decode)
                n_frames += context_frames
                scale = float(req.scale_by or 2.0)
                # a clip guide is cut to the anchor overlap, and AddGuide crops it to 17k+5
                first_guide = 0
                if req.first_frame:
                    first_guide = 1
                    if req.first_frame.lower().endswith((".mp4", ".mov", ".webm", ".mkv")):
                        gf = int(req.anchor_frames or 0)
                        first_guide = max(1, (gf - 5) // 17 * 17 + 5) if gf >= 5 else 1
                refs = len([r for r in (req.reference_images or []) if r])
                temporal_chunk, sizing = _upscale_auto_chunk(
                    n_frames, src_w * scale, src_h * scale, refs, first_guide, bool(req.last_frame))
                job["auto_chunk"] = {**sizing, "chunk": temporal_chunk}
                logger.info("upscale: %d frames at %.0fx, %d refs, first guide %d frames, last guide %s: "
                            "%s -> %s", n_frames, scale, refs, first_guide, bool(req.last_frame),
                            sizing, f"chunking at {temporal_chunk}" if temporal_chunk else "one span")
            except Exception as exc:
                # unsized means unsafe: one span of an unknown length is what spills
                temporal_chunk = 102
                logger.warning("upscale: could not size the clip for auto chunking (%s); "
                               "chunking at %d", exc, temporal_chunk)

        # References arrive as file names. One that no render has used yet (a
        # board fixed after the clip was made) is not in ComfyUI's input folder,
        # and the whole graph then fails validation, so put it there first.
        req.reference_images = [await ensure_comfyui_uploaded(r) for r in (req.reference_images or []) if r]

        logger.info(
            "Running H3 Latent Upscale: latent=%s, scale_by=%s, sigmas=%s, "
            "refs=%d, guides=%s, tile=%s, chunk=%s",
            latent_name, req.scale_by, manual_sigmas,
            len(req.reference_images or []),
            "+".join(filter(None, ["first" if req.first_frame else "", "last" if req.last_frame else ""])) or "none",
            req.spatial_tile or 0, temporal_chunk or "whole"
        )
        res = await comfyui.upscale_h3_latent(
            latent_filename=latent_name,
            prompt=_refine_prompt_text(req.prompt or "", bool(req.reference_images)),
            scale_by=req.scale_by or 2.0,
            reference_filenames=req.reference_images,
            first_frame_filename=req.first_frame or "",
            last_frame_filename=req.last_frame or "",
            length=req.length or 124,
            manual_sigmas=manual_sigmas,
            sage=req.sage or DEFAULT_H3_ACCEL,
            **({"upscale_model": req.upscale_model} if req.upscale_model else {}),
            spatial_tile=int(req.spatial_tile or 0),
            chunk_frames=temporal_chunk,
            trim_head_frames=0 if req.keep_context else trim_head,
            seed=req.seed if req.seed != -1 else resolve_seed(req.seed),
            on_queued=_make_on_queued(job),
            return_info=True,
            **({"source_video": video_source["path"], "source_frames": video_source["padded_frames"],
                "source_width": video_source["width"], "source_height": video_source["height"]}
               if video_source else {}),
        )
        if isinstance(res, dict):
            return await _finish_h3_latent_upscale(job, req, res, video_source, video_path)
        out_name = f"upscale_{job_id}.mp4"
        (UPLOAD_DIR / out_name).write_bytes(res)
        return {"url": f"/uploads/{out_name}"}

    # 3. ESRGAN is deterministic and runs the whole clip in one pass
    if req.method == "esrgan" and not req.repair:
        comfy_name = await ensure_comfyui_uploaded(req.video_url)
        res = await comfyui.upscale_video_esrgan(
            comfy_filename=comfy_name,
            model_name=req.esrgan_model,
            target_width=req.width, target_height=req.height,
            on_queued=_make_on_queued(job),
            return_info=True,
        )
        if isinstance(res, dict):
            sub = f"{res['subfolder']}/" if res.get("subfolder") else ""
            result = {"url": f"/comfy_output/{sub}{res['filename']}", "filename": res["filename"], "comfy_filename": res["filename"]}
            # a chained shot enlarged with its overlap is served cut, the full file beside it, as the latent path does
            return await asyncio.to_thread(_serve_without_overlap, result,
                                           Path(COMFYUI_OUTPUT_DIR) / sub / res["filename"],
                                           int(req.overlap_frames or 0) if req.keep_context else 0, job_id)
        else:
            out_name = f"upscale_{job_id}.mp4"
            (UPLOAD_DIR / out_name).write_bytes(res)
            return {"url": f"/uploads/{out_name}"}

    raise ValueError(f"Unknown upscale method {req.method!r}; use h3_latent, lms or esrgan.")


@app.post("/interpolate-video")
async def interpolate_video(req: VideoInterpolateRequest):
    return await submit_job(
        "interpolate", lambda job: _run_video_interpolate_job(job, req), request=req,
        video_url=req.video_url,
    )


# ── Refine prompts ────────────────────────────────────────────────────────────
#
# The latent upscale graph has no LoadImage nodes: reference images are not
# wired into it and cannot be. A Ref2VA prompt handed to it therefore cites
# <Picture N> labels the model can never resolve — it is told a photograph
# exists, cannot see one, and paints one into the frame. Observed twice: a
# grid-textured photographic patch rendered across the largest flat surface in
# shot (a plush garment), and a car's rear number rewritten from the words that
# described it.
#
# The pointers are what hurt, not the descriptions behind them. An anchored
# refiner repaints at ~92% strength and is steered entirely by conditioning, so
# stripping <Subject N> down to the words "the subject" leaves it with no idea who
# is in frame -- observed as a heavily drifted shot whose prompt read "the subject
# fires the subject at the subject". So each label is resolved to the NAME its
# subject_definitions entry gives it, and those definitions are re-emitted as a
# plain-language cast paragraph with the <Picture N> pointers taken out.

_REF_KEEP_SECTIONS = ("summary", "detailed_description", "overall_soundscape", "non_diegetic_music")
_SECTION_RE = re.compile(r"^([a-z_]+):\s*$")
# "<Subject 1> is A-Qing in <Picture 1>, a small wiry woman ..." -> name, appearance
_SUBJECT_DEF_RE = re.compile(
    r"^<Subject (\d+)>\s+is\s+(.+?)(?:\s+in\s+<Picture \d+>)?\s*(?:,\s*(.*))?$"
)


def _refine_prompt_text(prompt: str, refs_mounted: bool) -> str:
    """The refine text for a latent upscale.

    A whole generation prompt (it has section headers) is flattened by
    strip_reference_labels as before. A refine text written for the upscale
    itself is kept as written when references are mounted: its <Picture N> then
    points at a board the refine can see. Stripping it anyway deleted every
    sentence that named a board, so "the keypad reads as in <Picture 1>" came
    through empty and the default text ran instead (2026-09-29).
    """
    if refs_mounted and not re.search(r"(?m)^[a-z_]+:\s*$", prompt):
        return prompt.strip()
    return strip_reference_labels(prompt)


def strip_reference_labels(prompt: str) -> str:
    """Plain-language version of a Ref2VA prompt, safe for a refine pass."""
    if not prompt or "<Picture" not in prompt and "<Subject" not in prompt and "<Video" not in prompt:
        return prompt or ""

    kept, section = [], None
    names: dict[str, str] = {}      # "<Subject 1>" -> "A-Qing"
    cast: list[str] = []            # "A-Qing is a small wiry woman ..."
    for line in prompt.splitlines():
        header = _SECTION_RE.match(line)
        if header:
            section = header.group(1)
            continue
        if section in _REF_KEEP_SECTIONS:
            kept.append(line)
            continue
        if section == "subject_definitions":
            m = _SUBJECT_DEF_RE.match(line.strip())
            if m:
                idx, name, appearance = m.group(1), m.group(2).strip(), (m.group(3) or "").strip()
                names[f"<Subject {idx}>"] = name
                if appearance:
                    # Appositive, not "X is Y": half these entries start with a
                    # preposition ("with a black vinyl roof"), which "is" mangles.
                    cast.append(f"{name}, {appearance}")
    text = chr(10).join(kept) if kept else prompt

    # The cast paragraph leads: it is what tells the refiner who it is looking at.
    if cast:
        text = " ".join(c.rstrip(".") + "." for c in cast) + chr(10) + text
    for label, name in names.items():
        text = text.replace(label, name)

    text = re.sub(r"\[[^\]]*generation[^\]]*\]\s*", "", text)
    # A label is a pointer to something the refiner cannot look at. Removing the
    # pointer is better than renaming it: "the subject" repeated nine times is
    # its own kind of noise.
    text = re.sub(r"\s*\((?:the subject )?<Picture \d+>[^)]*\)", "", text)
    text = re.sub(r"[^.]*<Picture \d+>[^.]*\.", "", text)
    # Only labels that had no subject_definitions entry reach this.
    text = re.sub(r"<Subject \d+>", "the subject", text)
    text = re.sub(r"<Video \d+>", "the shot", text)
    # An enumeration of eight identical pointers is its own kind of noise.
    text = re.sub(r"(?:the subject, )+the subject and the subject", "the subjects", text)
    text = re.sub(r"the subject and the subject", "the subjects", text)
    text = re.sub(r"[ 	]+", " ", text)

    # Per-subject lines collapse to one once the labels are gone: four traffic
    # cars and two passengers each contributed the same sentence verbatim.
    seen, kept_sentences = set(), []
    for sentence in re.split(r"(?<=\.)\s+", text):
        key = sentence.strip()
        if not key:
            continue
        if key in seen:
            continue
        seen.add(key)
        kept_sentences.append(key)
    text = " ".join(kept_sentences)

    text = re.sub("[" + chr(10) + "]{3,}", chr(10) * 2, text)
    return text.strip()


def _h3_latent_decoded_frames(path: Path) -> int:
    """Frames an H3 latent decodes to, read off its safetensors header.

    The video latent's time axis is 5n+2 for a 17n+5-frame clip (175f -> 52,
    260f -> 77, 56f -> 17, measured on this project's own files)."""
    import struct
    with open(path, "rb") as fh:
        size = struct.unpack("<Q", fh.read(8))[0]
        header = json.loads(fh.read(size))
    t = int(header["video"]["shape"][2])
    if (t - 2) % 5:
        raise ValueError(f"unexpected H3 latent time axis {t} in {path.name}")
    return (t - 2) // 5 * 17 + 5


def _video_frame_count(path: Path) -> int:
    return _video_frames_and_size(path)[0]


def _last_frame_still(video: Path) -> str:
    """The clip's last frame as an /uploads PNG (cut once per clip)."""
    out = UPLOAD_DIR / f"pinlast_{video.stem}.png"
    if not out.is_file():
        n = _video_frame_count(video)
        result = subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-i", str(video),
             "-vf", f"select=eq(n\\,{n - 1})", "-vsync", "0", "-frames:v", "1", str(out)],
            capture_output=True, text=True)
        if result.returncode != 0 or not out.is_file():
            raise RuntimeError(f"last-frame cut failed: {result.stderr.strip()[-300:]}")
    return f"/uploads/{out.name}"


def _hd_tail_anchor(prev_hd: Path, frames: int, end_frame: int = 0) -> str:
    """The last `frames` frames of a previous chain's HD file, cut frame-exact into
    ComfyUI's input folder for the next chain's refine to mount as a clip guide.

    This automates what the hd-anchorclip-* nodes did by hand (2026-09-16: one
    frame pinned only frame 0 and the rest of the overlap re-invented its detail,
    a luma dip right after the join). The sound is kept: a video-only mp4 has
    taken ComfyUI's prompt worker down before. Cut once per source file and count.
    """
    if not COMFYUI_INPUT_DIR:
        raise RuntimeError("ComfyUI input folder unknown")
    total = _video_frame_count(prev_hd)
    if total < frames:
        raise RuntimeError(f"previous HD has {total} frames, fewer than the {frames}-frame overlap")
    if end_frame:
        # the window ends at frame `end_frame` (exclusive), not at the end of the file
        if end_frame > total or end_frame < frames:
            raise RuntimeError(f"anchor window {end_frame - frames}..{end_frame} is outside the previous HD ({total} frames)")
        start = end_frame - frames
        name = f"hdanchor_{prev_hd.stem}_at{end_frame}_{frames}.mp4"
    else:
        start = total - frames
        name = f"hdanchor_{prev_hd.stem}_last{frames}.mp4"
    out = Path(COMFYUI_INPUT_DIR) / name
    if out.is_file() and _video_frame_count(out) == frames:
        return name
    fps = 24.0
    tmp = out.with_suffix(".tmp.mp4")
    result = subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", str(prev_hd),
         "-vf", f"select='gte(n\\,{start})',setpts=N/({fps}*TB)",
         "-af", f"atrim=start={start / fps},asetpts=PTS-STARTPTS",
         "-frames:v", str(frames), "-c:v", "libx264", "-crf", "12", "-preset", "fast",
         "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", str(tmp)],
        capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"anchor cut failed: {result.stderr.strip()[-300:]}")
    got = _video_frame_count(tmp)
    if got != frames:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"anchor cut has {got} frames, expected {frames}")
    os.replace(tmp, out)
    return name


def _video_frames_and_size(path: Path) -> tuple[int, int, int]:
    """(frames, width, height). Some containers leave nb_frames as N/A (a 2x refine on
    2026-09-29 ran whole and spilled because of it); those are counted packet by packet."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_packets",
         "-show_entries", "stream=width,height,nb_frames,nb_read_packets",
         "-of", "csv=p=0", str(path)], capture_output=True, text=True, check=True).stdout.strip()
    w, h, nb, packets = (out.split(",") + ["N/A"] * 4)[:4]
    n = nb if nb.strip().isdigit() else packets
    return int(n), int(w), int(h)


# What one refine span may put in front of H3 on the 32 GB card, in packed latent rows at
# 2752x1536 (172x96 tokens a row). A span pays for its video rows AND its conditioning:
# one row per reference (ref_image_size "max" encodes at the upscale grid), the rows of a
# guide clip, and the anchor row the plugin pins on every chunk after the first.
#   fit:   136f + 5 refs (+1 anchor) = 41 rows, run a dozen times on 2026-09-29
#   fit:   175f, no guide = 45 rows (chain 1, 2026-09-15)
#   spill: 175f + one guide frame = 46 rows, 1063 s (2026-09-16)
#   spill: 170f + 4 refs + a 22-frame HD-tail guide = 55 rows, 387 s for the first
#          chunk (2026-09-29 16:21) -- the pixel-only limit this replaces chose that
# Held at the repeatedly-good 41 rather than the one-off 45: past the edge WDDM spills
# into shared memory instead of failing, so overshooting only ever shows up as time.
_UPSCALE_SPAN_TOKEN_BUDGET = 41 * 172 * 96


def _h3_rows_for_frames(frames: int) -> int:
    """Video latent rows covering `frames` pixel frames (1 frame, then 4 per row)."""
    return 0 if frames <= 0 else 1 + -(-(frames - 1) // 4)


def _upscale_auto_chunk(n_frames: int, out_w: float, out_h: float, refs: int,
                        first_guide_frames: int, last_guide: bool) -> tuple[int, dict]:
    """Chunk length for a refine left on auto (0 = one span), plus the arithmetic for the log.

    Every chunk carries the references; chunk 0 carries the first-frame guide and each
    later chunk an anchor row in its place; the last-frame guide is counted everywhere
    (it only lands in the last chunk, so this errs towards smaller chunks)."""
    grid = max(1.0, (out_w / 16) * (out_h / 16))
    budget = int(_UPSCALE_SPAN_TOKEN_BUDGET // grid)
    guide_rows = _h3_rows_for_frames(first_guide_frames)
    whole = _h3_rows_for_frames(n_frames) + refs + guide_rows + int(last_guide)
    info = {"budget_rows": budget, "whole_rows": whole}
    if whole <= budget:
        return 0, info
    cond = refs + max(guide_rows, 1) + int(last_guide)
    info["cond_rows"] = cond
    max_chunk = 17
    while _h3_rows_for_frames(max_chunk + 17) + cond <= budget:
        max_chunk += 17
    # chunks overlap by 17 frames; as few as fit, then evened out
    hop = max(17, max_chunk - 17)
    pieces = max(1, -(-(n_frames - 17) // hop))
    chunk = min(max_chunk, -(-(-(-(n_frames - 17) // pieces) + 17) // 17) * 17)
    info.update(max_chunk=max_chunk, pieces=pieces)
    return max(34, chunk), info


@app.post("/upscale-video")
async def upscale_video(req: VideoUpscaleRequest):
    return await submit_job(
        "upscale", lambda job: _run_video_upscale_job(job, req), request=req,
        video_url=req.video_url,
    )


@app.get("/check-latent")
def check_latent(video_url: str, latent_filename: Optional[str] = None):
    """Whether a clip has its H3 latent, and how many overlap frames that latent
    carries ahead of the clip (context_frames).

    A chained clip is saved trimmed, but its latent still holds the overlap with
    the previous shot. Clips rendered before the untrimmed H3_Full_ file existed
    (before 2026-09-28) have no other record of it, and the enhance node hid its
    含重叠帧 option for them although the latent refine can keep those frames.
    Same rule as the upscale's own trim: a difference of 1-64 frames is context.
    """
    search_dirs = [
        Path(COMFYUI_INPUT_DIR) if COMFYUI_INPUT_DIR else None,
        Path(COMFYUI_OUTPUT_DIR) if COMFYUI_OUTPUT_DIR else None,
    ]
    search_dirs = [d for d in search_dirs if d and d.is_dir()]
    video_stem = Path(urlparse(video_url).path).stem
    candidates = [Path(latent_filename).name] if latent_filename else []
    candidates += [
        f"{video_stem}.safetensors",
        f"{video_stem.replace('H3_Video_', 'H3_Latent_')}.safetensors",
        f"{video_stem.replace('H3_Chunk_', 'H3_Latent_')}.safetensors",
        f"{video_stem.replace('video_', 'latent_')}.safetensors",
        f"{video_stem}.latent",
        f"{video_stem.replace('H3_Video_', 'H3_Latent_')}.latent",
        f"{video_stem.replace('video_', 'latent_')}.latent",
    ]
    for cand in candidates:
        for sdir in search_dirs:
            path = sdir / cand
            if not path.is_file():
                continue
            context = 0
            try:
                src = (Path(COMFYUI_OUTPUT_DIR) / Path(urlparse(video_url).path).name) if COMFYUI_OUTPUT_DIR else None
                if src is None or not src.is_file():
                    src = UPLOAD_DIR / Path(urlparse(video_url).path).name
                if src.is_file() and path.suffix == ".safetensors":
                    diff = _h3_latent_decoded_frames(path) - _video_frame_count(src)
                    if 0 < diff <= 64:
                        context = diff
            except Exception as exc:
                logger.warning("check-latent: could not count context frames for %s (%s)", cand, exc)
            return {"exists": True, "latent_filename": cand, "context_frames": context}
    return {"exists": False, "latent_filename": None, "context_frames": 0}


# ── Uploads ────────────────────────────────────────────────────────────────────

@app.post("/style-references")
async def upload_style_reference(file: UploadFile = File(...)):
    ext = Path(file.filename).suffix or ".png"
    unique_name = f"style_{uuid.uuid4().hex}{ext}"
    local_path = UPLOAD_DIR / unique_name
    img_bytes = await file.read()
    local_path.write_bytes(img_bytes)

    try:
        comfy_filename = await comfyui.upload_image(img_bytes, unique_name)
    except Exception as e:
        logger.warning("ComfyUI upload deferred for %s: %s", unique_name, e)
        comfy_filename = unique_name

    return {
        "comfy_filename": comfy_filename,
        "url": f"/uploads/{unique_name}",
    }


@app.post("/upload-video-file")
async def upload_video_file(file: UploadFile = File(...)):
    """Store an uploaded video locally; no ComfyUI upload (happens on-demand during jobs)."""
    ext = Path(file.filename or "video.mp4").suffix.lower() or ".mp4"
    unique_name = f"upload_{uuid.uuid4().hex}{ext}"
    local_path = UPLOAD_DIR / unique_name
    local_path.write_bytes(await file.read())

    resp = {"url": f"/uploads/{unique_name}"}
    try:
        import cv2
        cap = cv2.VideoCapture(str(local_path))
        if cap.isOpened():
            w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            f = cap.get(cv2.CAP_PROP_FPS)
            fc = cap.get(cv2.CAP_PROP_FRAME_COUNT)
            if w > 0 and h > 0:
                resp["width"] = w
                resp["height"] = h
            if f > 0:
                resp["fps"] = round(f, 2)
                resp["duration"] = round(fc / f, 2)
            cap.release()
    except ImportError:
        pass
    except Exception as e:
        logger.warning("Failed to extract video info: %s", e)

    return resp


@app.post("/upload-ply")
async def upload_ply(file: UploadFile = File(...)):
    """Upload a Gaussian Splatting PLY file and return its URL."""
    original_name = file.filename or "scene.ply"
    ext = Path(original_name).suffix.lower() or ".ply"
    if ext not in (".ply",):
        raise HTTPException(400, "Only .ply files are supported")
    unique_name = f"gaussian_{uuid.uuid4().hex}{ext}"
    local_path = UPLOAD_DIR / unique_name
    data = await file.read()
    local_path.write_bytes(data)
    return {
        "filename": unique_name,
        "original_name": original_name,
        "url": f"/uploads/{unique_name}",
        "size": len(data),
    }


@app.post("/upload-glb")
async def upload_glb(file: UploadFile = File(...)):
    """Upload a modified GLB file or OpenPose JSON and return its URL."""
    original_name = file.filename or "pose.glb"
    ext = Path(original_name).suffix.lower() or ".glb"
    if ext not in (".glb", ".gltf", ".json"):
        raise HTTPException(400, "Only .glb, .gltf, or .json files are supported")
    unique_name = f"pose_{uuid.uuid4().hex}{ext}"
    local_path = UPLOAD_DIR / unique_name
    data = await file.read()
    local_path.write_bytes(data)
    return {
        "filename": unique_name,
        "original_name": original_name,
        "url": f"/uploads/{unique_name}",
        "size": len(data),
    }


class Base64ImageRequest(BaseModel):
    image: str
    # What the picture is for, which decides its file name. Everything used to be
    # pose_snapshot_*, so the cut room's per-export subtitle renders filled the
    # asset library with transparent PNGs.
    purpose: Optional[str] = None


# Rendered subtitle overlays for one export: not assets, hidden from the library
# and deleted when the export that asked for them finishes.
TITLE_RENDER_PREFIX = "title_render_"
_UPLOAD_PREFIXES = {"title": TITLE_RENDER_PREFIX, "frame": "frame_grab_"}


@app.post("/upload-image-base64")
async def upload_image_base64(req: Base64ImageRequest):
    import base64
    header, encoded = req.image.split(",", 1)
    data = base64.b64decode(encoded)
    unique_name = f"{_UPLOAD_PREFIXES.get(req.purpose or '', 'pose_snapshot_')}{uuid.uuid4().hex}.png"
    local_path = UPLOAD_DIR / unique_name
    local_path.write_bytes(data)
    return {"filename": unique_name, "url": f"/uploads/{unique_name}"}


# ── Project management (multi-project, workspace-namespaced) ──────────────────
#
# Directory layout:
#   backend/workspaces/
#   └── default/
#       └── projects/
#           └── <project_id>/
#               ├── meta.json      ← name, owner_user_id, timestamps
#               └── canvas.json    ← nodes + edges + viewport
#
# User identity is supplied by the frontend via X-User-Id header (localStorage UUID).
# No authentication required — this is a private/intranet deployment.

WORKSPACES_DIR = _BACKEND_DIR / "workspaces"
WORKSPACES_DIR.mkdir(exist_ok=True)
_DEFAULT_WS = WORKSPACES_DIR / "default"
_DEFAULT_WS.mkdir(exist_ok=True)


def _ws_projects_dir(workspace: str = "default") -> Path:
    d = WORKSPACES_DIR / workspace / "projects"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _project_dir(project_id: str, workspace: str = "default") -> Path:
    return _ws_projects_dir(workspace) / project_id


def _read_meta(project_dir: Path) -> dict:
    meta_path = project_dir / "meta.json"
    if not meta_path.exists():
        return {}
    try:
        return json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception:
        return {}


# ── Scenes ────────────────────────────────────────────────────────────────────
#
# A film is one project with one canvas per scene, so a two-hour film is sixty
# canvases of a hundred nodes rather than one of six thousand. The first scene is
# the project's own canvas.json -- every project made before scenes existed is a
# one-scene film with nothing moved -- and the others live in
# scenes/<scene_id>/canvas.json. The scene list (order, name, status, linked cut)
# is kept in meta.json.

MAIN_SCENE = "main"
SCENE_STATUSES = ("todo", "in_progress", "accepted")
_SCENE_ID_RE = re.compile(r"^[a-z0-9_]{1,40}$")


def _scene_id(scene: Optional[str]) -> str:
    sid = scene or MAIN_SCENE
    if not _SCENE_ID_RE.match(sid):
        raise HTTPException(400, f"Invalid scene id: {sid}")
    return sid


def _scene_canvas_path(proj_dir: Path, scene: Optional[str]) -> Path:
    sid = _scene_id(scene)
    return proj_dir / "canvas.json" if sid == MAIN_SCENE else proj_dir / "scenes" / sid / "canvas.json"


def _scene_list(meta: dict) -> list[dict]:
    """The project's scenes in order; a project from before scenes has just its main canvas."""
    scenes = meta.get("scenes")
    if isinstance(scenes, list) and any(s.get("id") == MAIN_SCENE for s in scenes if isinstance(s, dict)):
        return [s for s in scenes if isinstance(s, dict) and s.get("id")]
    return [{"id": MAIN_SCENE, "name": "场景 1", "status": "in_progress"}]


def _lock_key(project_id: str, scene: Optional[str] = None) -> str:
    """The main scene's lock is the project lock, so agents that know nothing of scenes still work."""
    sid = _scene_id(scene)
    return project_id if sid == MAIN_SCENE else f"{project_id}/{sid}"


class ProjectCreateRequest(BaseModel):
    name: str
    description: Optional[str] = ""
    aspect_ratio: Optional[str] = "16:9"
    template: Optional[str] = "blank"
    initial_nodes: Optional[list] = None
    initial_edges: Optional[list] = None
    workspace: str = "default"


class ProjectRenameRequest(BaseModel):
    name: str
    description: Optional[str] = None
    aspect_ratio: Optional[str] = None


class CanvasSaveRequest(BaseModel):
    nodes: list
    edges: list
    viewport: Optional[dict] = None
    base_revision: Optional[int] = None


# ── Project save-lock ─────────────────────────────────────────────────────────
# An agent that is about to read-modify-write a canvas takes the lock first; the
# studio's auto-save sees it on GET /canvas and pauses, and a PUT from anyone but
# the holder is refused with 423. Locks expire on their own, so a crashed agent
# cannot leave a project frozen. Requested on 2026-09-05 after agent
# writes and browser auto-saves kept colliding on revision numbers (409s) and a
# finished render's job id was lost that way.
_CANVAS_LOCKS: dict[str, dict] = {}
_LOCK_MAX_SECONDS = 900


class LockRequest(BaseModel):
    agent: str
    seconds: int = 60
    reason: str = ""


def _active_lock(project_id: str) -> Optional[dict]:
    lock = _CANVAS_LOCKS.get(project_id)
    if lock and lock["until"] > time.time():
        return lock
    if lock:
        _CANVAS_LOCKS.pop(project_id, None)
    return None


# One click HD for a chain. The run (order, waiting for each result, writing the node)
# lives in the canvas MCP server, which already owns finishing canvas jobs; the studio
# talks to it through here so the page needs only the backend's address.
MCP_URL = os.environ.get("AI_CINEMA_MCP_URL", "http://127.0.0.1:8004/mcp").rsplit("/mcp", 1)[0].rstrip("/")


async def _chain_hd_forward(method: str, path: str, prefix: str = "chain-hd", **kwargs):
    headers = {}
    token = env_value("AI_CINEMA_MCP_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        async with comfyui_client_http(timeout=30) as client:
            response = await client.request(method, f"{MCP_URL}/{prefix}/{path}", headers=headers, **kwargs)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail=f"画布 MCP 服务（{MCP_URL}）没有响应：{exc}")
    body = response.json() if response.content else {}
    if response.status_code >= 400:
        raise HTTPException(status_code=response.status_code, detail=body.get("error") or response.text)
    return body


class ChainUpscaleRequest(BaseModel):
    node_id: str
    scene: Optional[str] = None
    scale_by: float = 2.0
    # the chain as the studio lists it, head first; left out, the server walks it itself
    shot_ids: Optional[list[str]] = None


@app.post("/projects/{project_id}/chains/upscale")
async def start_chain_upscale(project_id: str, req: ChainUpscaleRequest):
    return await _chain_hd_forward("POST", "start", json={
        "project": project_id, "node_id": req.node_id, "scene": req.scene or "", "scale_by": req.scale_by,
        "shot_ids": req.shot_ids or []})


class RedoAudioRequest(BaseModel):
    mode: str = "polish"          # polish | reroll
    seed: int = -1
    steps: int = 0
    denoise: float = 0.0
    scene: Optional[str] = None


@app.post("/projects/{project_id}/nodes/{node_id}/redo-audio")
async def redo_node_audio(project_id: str, node_id: str, req: RedoAudioRequest):
    """Redo only the sound of a finished video node (its saved latent, picture frozen), with the
    node's audio locks. Runs through the canvas MCP server, which also writes the result back."""
    return await _chain_hd_forward("POST", "start", prefix="redo-audio", json={
        "project": project_id, "node_id": node_id, "scene": req.scene or "", "mode": req.mode,
        "seed": req.seed, "steps": req.steps, "denoise": req.denoise})


class AudioRefineNodeRequest(BaseModel):
    scene: Optional[str] = None


@app.post("/projects/{project_id}/nodes/{node_id}/audio-refine")
async def run_audio_refine_node(project_id: str, node_id: str, req: AudioRefineNodeRequest):
    """Run a 声音精修 node: its conditioning (prompt, references, audio locks) is worked out from the
    canvas by the MCP server, which also writes the result back to the node."""
    return await _chain_hd_forward("POST", "start", prefix="audio-refine", json={
        "project": project_id, "node_id": node_id, "scene": req.scene or ""})


@app.get("/projects/{project_id}/chains/upscale")
async def chain_upscale_status(project_id: str, scene: Optional[str] = None):
    return await _chain_hd_forward("GET", "status", params={"project": project_id, "scene": scene or ""})


@app.post("/projects/{project_id}/chains/upscale/cancel")
async def cancel_chain_upscale(project_id: str, scene: Optional[str] = None):
    return await _chain_hd_forward("POST", "cancel", json={"project": project_id, "scene": scene or ""})


@app.get("/projects/{project_id}/lock")
async def get_canvas_lock(project_id: str, scene: Optional[str] = None):
    return {"lock": _active_lock(_lock_key(project_id, scene))}


@app.post("/projects/{project_id}/lock")
async def acquire_canvas_lock(project_id: str, req: LockRequest, scene: Optional[str] = None):
    """Take (or extend) a scene's lock for `req.agent`. 409 if another agent holds it."""
    project_id = _lock_key(project_id, scene)
    current = _active_lock(project_id)
    if current and current["agent"] != req.agent:
        raise HTTPException(409, detail={"message": "Project is locked by another agent.", "lock": current})
    lock = {
        "agent": req.agent,
        "until": time.time() + max(1, min(int(req.seconds), _LOCK_MAX_SECONDS)),
        "reason": req.reason or "",
        "since": current["since"] if current else time.time(),
    }
    _CANVAS_LOCKS[project_id] = lock
    return {"lock": lock}


@app.delete("/projects/{project_id}/lock")
async def release_canvas_lock(project_id: str, agent: str, scene: Optional[str] = None):
    project_id = _lock_key(project_id, scene)
    current = _active_lock(project_id)
    if current and current["agent"] != agent:
        raise HTTPException(409, detail={"message": "Lock is held by another agent.", "lock": current})
    _CANVAS_LOCKS.pop(project_id, None)
    return {"lock": None}


def _local_media_present(url: str) -> bool:
    """False only for one of our own files that is gone (the library's clean-up
    removes unused renders); anything else is assumed present."""
    path = urlparse(url).path
    for prefix, root in (("/uploads/", UPLOAD_DIR), ("/comfy_output/", COMFYUI_OUTPUT_DIR)):
        if path.startswith(prefix) and root:
            return (Path(root) / path[len(prefix):]).is_file()
    return True


_COVER_EXT = re.compile(r"\.(png|jpe?g|webp|gif|mp4|mov|webm|m4v)$", re.IGNORECASE)


def _read_project_summary(proj_dir: Path) -> dict:
    meta = _read_meta(proj_dir)
    if not meta:
        return {}

    node_count = 0
    edge_count = 0
    thumbnail_url = None
    # Every scene counts towards the film; the cover comes from the first scene that has one.
    for scene in _scene_list(meta):
        canvas_path = _scene_canvas_path(proj_dir, scene["id"])
        if not canvas_path.exists():
            continue
        try:
            canvas = json.loads(canvas_path.read_text(encoding="utf-8"))
            nodes = canvas.get("nodes", [])
            edges = canvas.get("edges", [])
            node_count += len(nodes)
            edge_count += len(edges)
            # Find first node with an image/video/preview url to use as visual card cover
            for n in nodes if thumbnail_url is None else []:
                d = n.get("data", {})
                url = d.get("generatedUrl") or d.get("url") or d.get("previewUrl") or d.get("image_url")
                # Pictures and clips only: a voice reference (.wav) came first on
                # a large canvas and the card showed no cover at all.
                if (url and isinstance(url, str) and d.get("mediaType") != "audio"
                        and _COVER_EXT.search(url.split("?")[0]) and _local_media_present(url)):
                    thumbnail_url = url
                    break
        except Exception:
            pass

    return {
        "id": meta.get("id", proj_dir.name),
        "name": meta.get("name", proj_dir.name),
        "description": meta.get("description", ""),
        "aspect_ratio": meta.get("aspect_ratio", "16:9"),
        "template": meta.get("template", "blank"),
        "owner_user_id": meta.get("owner_user_id"),
        "created_at": meta.get("created_at"),
        "updated_at": meta.get("updated_at"),
        "workspace": meta.get("workspace", "default"),
        "node_count": node_count,
        "edge_count": edge_count,
        "thumbnail_url": thumbnail_url,
    }


# ── Who may see a project ─────────────────────────────────────────────────────
# See the module docstring in accounts.py for why registration is open. Here is
# the other half: a project belongs to the account that made it, and an account
# only sees its own. Requests without a token (the canvas MCP server and the
# tools under tools/, which send X-Agent instead) are not scoped -- the
# production line depends on reaching every project, and requiring a token there
# would mean handing one to every script.


def _caller_user_id(authorization: Optional[str]) -> Optional[str]:
    """The account behind the request, or None when it carries no token at all.

    A token that was sent but is expired or logged out is a 401, not an
    anonymous caller: anonymous (the MCP server, tools/) sees every project,
    so treating a stale browser session that way showed it everyone's work.
    """
    token = _bearer(authorization)
    if not token:
        return None
    user = accounts.resolve(token)
    if not user:
        raise HTTPException(401, "Session expired. Please sign in again.")
    return user["id"]


def _caller_is_admin(authorization: Optional[str]) -> bool:
    """True for an admin, and for a request with no token at all -- the canvas
    MCP server and tools/ have always seen the whole disk and still must."""
    caller = _caller_user_id(authorization)
    return caller is None or accounts.is_admin(caller)


def _may_access(meta: dict, caller: Optional[str]) -> bool:
    """True when this caller may see the project `meta` describes.

    A signed-in account sees only the projects it owns -- admins included. An
    unowned project (from before accounts, or made by an agent with no owner
    configured) is shown to nobody until tools/assign_project_owner.py hands it
    to someone; showing it to every account is how one account opened the
    studio and landed on another's film. Requests with no token (the MCP
    server, tools/) are not scoped.
    """
    if caller is None:
        return True
    return meta.get("owner_user_id") == caller


def _default_owner_id() -> Optional[str]:
    """Owner for a project created without a token (the canvas MCP server,
    tools/): the account named by AI_CINEMA_DEFAULT_OWNER, else nobody."""
    username = os.environ.get("AI_CINEMA_DEFAULT_OWNER", "").strip()
    return accounts.user_id_for(username) if username else None


def _require_access(proj_dir: Path, caller: Optional[str], project_id: str) -> dict:
    """Read a project's meta, or refuse. 404 rather than 403 for someone else's:
    which ids exist is not this account's business."""
    meta = _read_meta(proj_dir)
    if not meta or not _may_access(meta, caller):
        raise HTTPException(404, f"Project not found: {project_id}")
    return meta


@app.get("/projects")
async def list_projects(workspace: str = "default", user_id: Optional[str] = None,
                        authorization: Optional[str] = _Header(None)):
    """Projects in a workspace, newest first -- the caller's own when signed in."""
    caller = _caller_user_id(authorization)
    ws_dir = _ws_projects_dir(workspace)
    projects = []
    for d in ws_dir.iterdir():
        if not d.is_dir():
            continue
        summary = _read_project_summary(d)
        if not summary:
            continue
        if not _may_access(summary, caller):
            continue
        projects.append(summary)

    # Sort newest updated_at first
    projects.sort(key=lambda p: p.get("updated_at") or p.get("created_at") or "", reverse=True)
    return {"projects": projects}


@app.post("/projects")
async def create_project(req: ProjectCreateRequest, x_user_id: Optional[str] = None,
                         authorization: Optional[str] = _Header(None)):
    """Create a new project with optional templates and return its metadata."""
    project_id = f"proj_{uuid.uuid4().hex[:12]}"
    now = datetime.now(timezone.utc).isoformat()
    proj_dir = _project_dir(project_id, req.workspace)
    proj_dir.mkdir(parents=True, exist_ok=True)

    meta = {
        "id": project_id,
        "name": req.name,
        "description": req.description or "",
        "aspect_ratio": req.aspect_ratio or "16:9",
        "template": req.template or "blank",
        # The token identifies the caller. X-User-Id is whatever the client
        # typed, so it no longer decides who owns anything.
        "owner_user_id": _caller_user_id(authorization) or _default_owner_id(),
        "workspace": req.workspace,
        "created_at": now,
        "updated_at": now,
    }
    _atomic_write_json(proj_dir / "meta.json", meta)

    # Initial canvas (blank or from template starter)
    nodes = req.initial_nodes or []
    edges = req.initial_edges or []
    (proj_dir / "canvas.json").write_text(
        json.dumps({"nodes": nodes, "edges": edges, "viewport": {"x": 0, "y": 0, "zoom": 1}}, ensure_ascii=False),
        encoding="utf-8",
    )
    logger.info("Created project %s (%s, template=%s) by user %s", project_id, req.name, req.template, x_user_id)
    return meta


@app.post("/projects/{project_id}/duplicate")
async def duplicate_project(project_id: str, workspace: str = "default", x_user_id: Optional[str] = None,
                            authorization: Optional[str] = _Header(None)):
    """Duplicate an existing project and its canvas data."""
    caller = _caller_user_id(authorization)
    src_dir = _project_dir(project_id, workspace)
    _require_access(src_dir, caller, project_id)
    if not src_dir.exists():
        raise HTTPException(404, f"Source project not found: {project_id}")

    src_meta = _read_meta(src_dir)
    new_id = f"proj_{uuid.uuid4().hex[:12]}"
    now = datetime.now(timezone.utc).isoformat()
    new_dir = _project_dir(new_id, workspace)
    new_dir.mkdir(parents=True, exist_ok=True)

    new_meta = {
        **src_meta,
        "id": new_id,
        "name": f"{src_meta.get('name', '未命名项目')} (副本)",
        # The copy belongs to whoever made it; an unscoped caller keeps the source's owner.
        "owner_user_id": caller or src_meta.get("owner_user_id"),
        "created_at": now,
        "updated_at": now,
    }
    _atomic_write_json(new_dir / "meta.json", new_meta)

    src_canvas = src_dir / "canvas.json"
    if src_canvas.exists():
        (new_dir / "canvas.json").write_text(src_canvas.read_text(encoding="utf-8"), encoding="utf-8")
    else:
        (new_dir / "canvas.json").write_text(json.dumps({"nodes": [], "edges": []}), encoding="utf-8")

    src_history = src_dir / "assistant_history.json"
    if src_history.exists():
        (new_dir / "assistant_history.json").write_text(src_history.read_text(encoding="utf-8"), encoding="utf-8")

    # The other scenes of a film; the scene list itself came across in meta.json.
    if (src_dir / "scenes").is_dir():
        shutil.copytree(src_dir / "scenes", new_dir / "scenes")
    if bible.path(src_dir).exists():
        shutil.copy2(bible.path(src_dir), bible.path(new_dir))

    logger.info("Duplicated project %s -> %s", project_id, new_id)
    return new_meta


@app.get("/projects/{project_id}")
async def get_project(project_id: str, workspace: str = "default",
                      authorization: Optional[str] = _Header(None)):
    """Get project metadata."""
    proj_dir = _project_dir(project_id, workspace)
    summary = _read_project_summary(proj_dir)
    if not summary or not _may_access(summary, _caller_user_id(authorization)):
        raise HTTPException(404, f"Project not found: {project_id}")
    return summary


@app.put("/projects/{project_id}")
async def rename_project(project_id: str, req: ProjectRenameRequest, workspace: str = "default",
                         authorization: Optional[str] = _Header(None)):
    """Rename or update project details."""
    proj_dir = _project_dir(project_id, workspace)
    meta = _require_access(proj_dir, _caller_user_id(authorization), project_id)
    if req.name is not None:
        meta["name"] = req.name
    if req.description is not None:
        meta["description"] = req.description
    if req.aspect_ratio is not None:
        meta["aspect_ratio"] = req.aspect_ratio
    meta["updated_at"] = datetime.now(timezone.utc).isoformat()
    _atomic_write_json(proj_dir / "meta.json", meta)
    return _read_project_summary(proj_dir)


# Which project mentions which file. Reading it means parsing every canvas,
# timeline and sequence (30 MB of JSON, ~1 s), and one delete used to do that
# four times: plan + asset scan for the confirmation, and again for the delete.
# Cached on the JSON files' count, newest mtime and total size (3 ms to check),
# so any save anywhere invalidates it.
_REFERENCES_CACHE: dict = {"key": None, "value": None}


def _collect_references_cached(workspaces: Path) -> dict[str, set[str]]:
    files = list(workspaces.rglob("*.json"))
    stats = [f.stat() for f in files if f.exists()]
    key = (str(workspaces.resolve()), len(stats), max((s.st_mtime_ns for s in stats), default=0),
           sum(s.st_size for s in stats))
    if _REFERENCES_CACHE["key"] != key:
        _REFERENCES_CACHE["value"] = artifact_pruner.collect_references(workspaces)
        _REFERENCES_CACHE["key"] = key
    return _REFERENCES_CACHE["value"]


def _project_asset_plan(project_id: str) -> dict:
    """The files deleting this project removes, resolved to paths the asset library owns."""
    result = project_assets.plan(WORKSPACES_DIR, project_id, asset_origin.load(),
                                 references=_collect_references_cached(WORKSPACES_DIR))
    # _scan_assets knows where every owned file is (uploads recursively, and only
    # this app's own renders in the shared ComfyUI output), so a file it does not
    # list -- someone else's render a canvas happened to use -- is never touched.
    owned = _scan_assets()
    paths = {name: Path(owned[name]["path"]) for name in result["files"] + result["companions"] if name in owned}
    return {
        "paths": paths,
        "files": [n for n in result["files"] if n in paths],
        "companions": [n for n in result["companions"] if n in paths],
        "shared": result["shared"],
        "bytes": sum(p.stat().st_size for p in paths.values() if p.exists()),
    }


@app.get("/projects/{project_id}/delete-plan")
async def project_delete_plan(project_id: str, workspace: str = "default",
                              authorization: Optional[str] = _Header(None)):
    """What deleting the project would remove from disk, for the confirmation. Changes nothing."""
    proj_dir = _project_dir(project_id, workspace)
    if not proj_dir.exists():
        raise HTTPException(404, f"Project not found: {project_id}")
    _require_access(proj_dir, _caller_user_id(authorization), project_id)
    try:
        result = await asyncio.to_thread(_project_asset_plan, project_id)
    except RuntimeError as exc:
        raise HTTPException(503, f"Cannot determine references: {exc}") from exc
    return {
        "file_count": len(result["paths"]),
        "latent_count": len(result["companions"]),
        "bytes": result["bytes"],
        "shared_count": len(result["shared"]),
    }


@app.delete("/projects/{project_id}")
async def delete_project(project_id: str, workspace: str = "default",
                         authorization: Optional[str] = _Header(None)):
    """Delete a project, its canvas data and the media files only it uses.

    Files another project also uses stay (a duplicated project shares all of its
    files with the original); see project_assets.py.
    """
    import shutil
    proj_dir = _project_dir(project_id, workspace)
    if not proj_dir.exists():
        raise HTTPException(404, f"Project not found: {project_id}")
    _require_access(proj_dir, _caller_user_id(authorization), project_id)
    # Planned before the project folder goes: the references are read from it.
    try:
        result = await asyncio.to_thread(_project_asset_plan, project_id)
    except RuntimeError as exc:
        raise HTTPException(503, f"Cannot determine references: {exc}") from exc
    shutil.rmtree(proj_dir, ignore_errors=True)

    deleted, freed, failed = 0, 0, 0
    for path in result["paths"].values():
        try:
            size = path.stat().st_size
            path.unlink()
            deleted += 1
            freed += size
        except FileNotFoundError:
            continue
        except OSError as exc:
            logger.warning("project delete: could not remove %s: %s", path, exc)
            failed += 1
    logger.info("Deleted project %s with %d files (%.2f GiB), %d shared kept, %d failed",
                project_id, deleted, freed / 2 ** 30, len(result["shared"]), failed)
    return {"status": "deleted", "id": project_id, "deleted_files": deleted,
            "freed_bytes": freed, "shared_kept": len(result["shared"]), "failed": failed}


# revision of a canvas file by (path, mtime, size): the studio polls every 3 s,
# and parsing a 4 MB canvas only to learn it has not changed cost the backend a
# parse and the browser a 4 MB download + parse each time (a large scene, 2026-09-23).
_CANVAS_REVISION_CACHE: dict[str, tuple[int, int, int]] = {}


def _canvas_file_revision(canvas_path: Path) -> int:
    stat = canvas_path.stat()
    key = str(canvas_path)
    hit = _CANVAS_REVISION_CACHE.get(key)
    if hit and hit[0] == stat.st_mtime_ns and hit[1] == stat.st_size:
        return hit[2]
    revision = int(json.loads(canvas_path.read_text(encoding="utf-8")).get("revision", 0) or 0)
    _CANVAS_REVISION_CACHE[key] = (stat.st_mtime_ns, stat.st_size, revision)
    return revision


@app.get("/projects/{project_id}/canvas")
async def load_canvas(project_id: str, workspace: str = "default", scene: Optional[str] = None,
                      since_revision: Optional[int] = None,
                      authorization: Optional[str] = _Header(None)):
    """Load one scene's canvas (nodes + edges + viewport); the first scene when none is named.

    since_revision: the revision the caller already holds. When the canvas is still
    at it, only {revision, scene, lock, unchanged: true} comes back -- the poll that
    watches for MCP edits needs nothing else.
    """
    _require_access(_project_dir(project_id, workspace), _caller_user_id(authorization), project_id)
    canvas_path = _scene_canvas_path(_project_dir(project_id, workspace), scene)
    if not canvas_path.exists():
        raise HTTPException(404, f"Canvas not found for project: {project_id} scene: {_scene_id(scene)}")
    if since_revision is not None:
        revision = await asyncio.to_thread(_canvas_file_revision, canvas_path)
        if revision == since_revision:
            return {"revision": revision, "scene": _scene_id(scene), "unchanged": True,
                    "lock": _active_lock(_lock_key(project_id, scene))}
    canvas = json.loads(canvas_path.read_text(encoding="utf-8"))
    canvas.setdefault("revision", 0)
    canvas["scene"] = _scene_id(scene)
    # The studio reads this on every poll and pauses auto-save while it is set.
    canvas["lock"] = _active_lock(_lock_key(project_id, scene))
    return canvas


@app.put("/projects/{project_id}/canvas")
async def save_canvas(project_id: str, req: CanvasSaveRequest, request: Request, workspace: str = "default",
                      scene: Optional[str] = None,
                      x_agent: Optional[str] = _Header(default=None),
                      authorization: Optional[str] = _Header(None)):
    """Save one scene's canvas; the first scene when none is named.

    While an agent holds that scene's lock only that agent (sending X-Agent) may
    write; everyone else gets 423 and keeps their edits in memory.
    """
    proj_dir = _project_dir(project_id, workspace)
    if not proj_dir.exists():
        raise HTTPException(404, f"Project not found: {project_id}")
    # Reads were already scoped; without this a stale project id in one
    # account's browser could overwrite another account's canvas.
    _require_access(proj_dir, _caller_user_id(authorization), project_id)
    if _scene_id(scene) not in {s["id"] for s in _scene_list(_read_meta(proj_dir))}:
        raise HTTPException(404, f"Scene not found: {_scene_id(scene)}")
    lock = _active_lock(_lock_key(project_id, scene))
    if lock and x_agent != lock["agent"]:
        raise HTTPException(423, detail={"message": "Canvas is locked by an agent.", "lock": lock})
    canvas_path = _scene_canvas_path(proj_dir, scene)
    current_revision = 0
    if canvas_path.exists():
        try:
            current_revision = int(json.loads(canvas_path.read_text(encoding="utf-8")).get("revision", 0))
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            current_revision = 0
    # A save that does not say which revision it was based on is refused once the
    # canvas has any history: the studio's "save before switching project" sent
    # none, and a tab loaded before an MCP edit wrote its stale copy over it
    # (proj_852faf167de2, 2026-09-24). Only a never-saved canvas takes one blind.
    base = req.base_revision
    if (base is None and current_revision > 0) or (base is not None and base != current_revision):
        raise HTTPException(
            409,
            detail={
                "message": "Canvas changed since it was loaded." if base is not None
                           else "base_revision is required.",
                "current_revision": current_revision,
            },
        )
    revision = current_revision + 1
    _keep_canvas_history(canvas_path, req.nodes, revision,
                         who=x_agent or f"studio@{request.client.host if request.client else '?'}")
    # Whoever wrote these nodes (studio, canvas MCP, a script), none may be smaller
    # than its own controls: lift any that are (backend/node_sizing.py).
    req.nodes, _lifted = enforce_node_floors(req.nodes)
    if _lifted:
        logger.info("canvas %s: raised %d node(s) to their size floor", project_id, _lifted)
    # Atomic: a canvas cut off mid-write reads as unknown references everywhere.
    _atomic_write_json(canvas_path, {
        "nodes": req.nodes,
        "edges": req.edges,
        "viewport": req.viewport,
        "revision": revision,
    })
    # Update project's updated_at timestamp
    meta = _read_meta(proj_dir)
    if meta:
        meta["updated_at"] = datetime.now(timezone.utc).isoformat()
        _atomic_write_json(proj_dir / "meta.json", meta)
    return {"status": "saved", "project_id": project_id, "revision": revision, "scene": _scene_id(scene)}


CANVAS_HISTORY_KEEP = 25


def _keep_canvas_history(canvas_path: Path, new_nodes: list, revision: int, who: str) -> None:
    """Keep the canvas as it was before this save, and log what the save changes and who made it.

    A finished render was twice put back to an older state of its node (prompt, locks, length,
    label, the clip on display) and nothing recorded who wrote it. The previous file goes to
    canvas_history/ (the last CANVAS_HISTORY_KEEP, gzipped) and the log line names the writer and
    the nodes whose data differ, so a revert can be traced to a client and undone from the copy.
    Never raises: a failure here must not lose the save.
    """
    try:
        if not canvas_path.exists():
            return
        raw = canvas_path.read_bytes()
        old = json.loads(raw.decode("utf-8"))
        old_by_id = {n.get("id"): n for n in old.get("nodes", []) if isinstance(n, dict)}
        changed = []
        for n in new_nodes:
            if not isinstance(n, dict):
                continue
            before = old_by_id.get(n.get("id"))
            if before is not None and before.get("data") != n.get("data"):
                changed.append(n.get("id"))
        gone = [i for i in old_by_id if i not in {n.get("id") for n in new_nodes if isinstance(n, dict)}]
        logger.info("canvas %s rev %s by %s: %d node(s) changed %s%s", canvas_path.parent.name,
                    revision, who, len(changed), changed[:8], f", removed {gone[:8]}" if gone else "")
        hist = canvas_path.parent / "canvas_history"
        hist.mkdir(exist_ok=True)
        import gzip
        stem = canvas_path.stem
        (hist / f"{stem}.r{int(old.get('revision', 0)):06d}.json.gz").write_bytes(gzip.compress(raw, 3))
        keep = sorted(hist.glob(f"{stem}.r*.json.gz"))
        for stale in keep[:-CANVAS_HISTORY_KEEP]:
            stale.unlink(missing_ok=True)
    except Exception as exc:       # noqa: BLE001
        logger.warning("canvas history not kept: %s", exc)


_SCENE_META_LOCK = asyncio.Lock()


class SceneCreateRequest(BaseModel):
    name: str


class ScenePatchRequest(BaseModel):
    name: Optional[str] = None
    status: Optional[str] = None
    # The cut-room sequence that is this scene's finished cut; "" unlinks it.
    sequence_id: Optional[str] = None


class SceneOrderRequest(BaseModel):
    ids: list[str]


def _sequence_seconds(proj_dir: Path, sequence_id: Optional[str]) -> Optional[float]:
    """Length of a cut-room sequence, from its clips: the scene's running time."""
    if not sequence_id or not re.match(r"^[\w-]+$", sequence_id):
        return None
    path = proj_dir / "sequences" / f"{sequence_id}.json"
    try:
        timeline = json.loads(path.read_text(encoding="utf-8")).get("timeline") or {}
    except (OSError, json.JSONDecodeError):
        return None
    fps = float(timeline.get("fps") or 24)
    end = 0.0
    for clip in timeline.get("clips") or []:
        speed = float(clip.get("speed") or 1) or 1.0
        length = max(1.0, round((float(clip.get("outFrame", 0)) - float(clip.get("inFrame", 0))) / speed))
        end = max(end, float(clip.get("start", 0)) + length)
    return round(end / fps, 2) if end else 0.0


def _scene_summary(proj_dir: Path, scene: dict) -> dict:
    node_count, thumbnail, revision = 0, None, 0
    try:
        canvas = json.loads(_scene_canvas_path(proj_dir, scene["id"]).read_text(encoding="utf-8"))
        nodes = canvas.get("nodes") or []
        node_count, revision = len(nodes), int(canvas.get("revision") or 0)
        # A rendered shot says more about a scene than a reference image does.
        videos = [(n.get("data") or {}).get("generatedUrl") for n in nodes if n.get("type") == "video"]
        media = [((n.get("data") or {}).get("generatedUrl") or (n.get("data") or {}).get("url")) for n in nodes]
        thumbnail = next((u for u in videos + media if isinstance(u, str) and u), None)
    except (OSError, json.JSONDecodeError):
        pass
    return {
        "id": scene["id"],
        "name": scene.get("name") or scene["id"],
        "status": scene.get("status") if scene.get("status") in SCENE_STATUSES else "todo",
        "sequence_id": scene.get("sequence_id") or None,
        "duration_s": _sequence_seconds(proj_dir, scene.get("sequence_id")),
        "node_count": node_count,
        "thumbnail_url": thumbnail,
        "revision": revision,
    }


def _write_scenes(proj_dir: Path, meta: dict, scenes: list[dict]) -> None:
    meta = {**meta, "scenes": scenes, "updated_at": datetime.now(timezone.utc).isoformat()}
    _atomic_write_json(proj_dir / "meta.json", meta)


def _accessible_project(project_id: str, workspace: str, authorization: Optional[str]) -> Path:
    proj_dir = _project_dir(project_id, workspace)
    if not proj_dir.exists():
        raise HTTPException(404, f"Project not found: {project_id}")
    _require_access(proj_dir, _caller_user_id(authorization), project_id)
    return proj_dir


# ── Production bible ──────────────────────────────────────────────────────────
#
# One entry per reference the film reuses (cast sheet, environment plate, voice,
# key prop); scene nodes link to it with data.bibleId. See bible.py.

_BIBLE_LOCK = asyncio.Lock()
_BIBLE_AGENT = "production-bible"


class BibleEntryRequest(BaseModel):
    kind: Optional[str] = None
    name: Optional[str] = None
    notes: Optional[str] = None
    url: Optional[str] = None
    mediaType: Optional[str] = None
    width: Optional[float] = None
    height: Optional[float] = None
    duration: Optional[float] = None
    # Nodes that already show this file and become linked to the new entry: [{"scene", "node_id"}].
    link: list[dict] = []


def _scene_canvases(proj_dir: Path) -> list[tuple[str, Path, dict]]:
    out = []
    for scene in _scene_list(_read_meta(proj_dir)):
        canvas_path = _scene_canvas_path(proj_dir, scene["id"])
        if canvas_path.exists():
            out.append((scene["id"], canvas_path, json.loads(canvas_path.read_text(encoding="utf-8"))))
    return out


def _bible_response(proj_dir: Path, data: dict) -> dict:
    usage = bible.usage((sid, c) for sid, _, c in _scene_canvases(proj_dir))
    entries = [{**e, "usage": usage.get(e["id"], {"scenes": [], "nodes": 0})} for e in data["entries"]]
    return {"revision": data["revision"], "entries": entries, "kinds": list(bible.KINDS)}


async def _rewrite_scenes(project_id: str, proj_dir: Path, scenes: set, work: Callable):
    """Run `work(canvases)` holding the save lock of every scene it rewrites.

    Same contract as the take-history clean: another agent's lock refuses the
    whole change, and open studios pick up the new revisions on their poll.
    """
    keys = {_lock_key(project_id, sid) for sid in scenes}
    for key in keys:
        held = _active_lock(key)
        if held and held["agent"] != _BIBLE_AGENT:
            raise HTTPException(409, detail={"message": "A scene is locked by an agent.", "lock": held})
    for key in keys:
        _CANVAS_LOCKS[key] = {"agent": _BIBLE_AGENT, "until": time.time() + 60,
                              "reason": "更新资料库引用", "since": time.time()}
    try:
        return await asyncio.to_thread(lambda: work([c for c in _scene_canvases(proj_dir) if c[0] in scenes]))
    finally:
        for key in keys:
            if (_CANVAS_LOCKS.get(key) or {}).get("agent") == _BIBLE_AGENT:
                _CANVAS_LOCKS.pop(key, None)


@app.get("/projects/{project_id}/bible")
async def get_bible(project_id: str, workspace: str = "default",
                    authorization: Optional[str] = _Header(None)):
    """The film's shared references, each with the scenes that use it."""
    proj_dir = _accessible_project(project_id, workspace, authorization)
    return await asyncio.to_thread(lambda: _bible_response(proj_dir, bible.load(proj_dir)))


@app.post("/projects/{project_id}/bible")
async def add_bible_entry(project_id: str, req: BibleEntryRequest, workspace: str = "default",
                          authorization: Optional[str] = _Header(None)):
    """Add an entry, optionally linking nodes that already show its file."""
    proj_dir = _accessible_project(project_id, workspace, authorization)
    fields = req.model_dump(exclude={"link"})
    if not fields.get("kind"):
        fields["kind"] = bible.guess_kind(req.name or "", req.mediaType or "")
    try:
        entry = bible.new_entry(fields)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    known = {s["id"] for s in _scene_list(_read_meta(proj_dir))}
    by_scene: dict = {}
    for item in req.link:
        sid = _scene_id(item.get("scene"))
        if sid in known and item.get("node_id"):
            by_scene.setdefault(sid, []).append(str(item["node_id"]))
    async with _BIBLE_LOCK:
        if by_scene:
            def work(canvases):
                for sid, canvas_path, canvas in canvases:
                    if bible.link(canvas, by_scene.get(sid, []), entry):
                        canvas["revision"] = int(canvas.get("revision", 0)) + 1
                        _atomic_write_json(canvas_path, canvas)
            await _rewrite_scenes(project_id, proj_dir, set(by_scene), work)
        data = bible.load(proj_dir)
        data["entries"].append(entry)
        data["revision"] += 1
        _atomic_write_json(bible.path(proj_dir), data)
        return {"entry": entry, **_bible_response(proj_dir, data)}


@app.patch("/projects/{project_id}/bible/{entry_id}")
async def update_bible_entry(project_id: str, entry_id: str, req: BibleEntryRequest,
                             workspace: str = "default", authorization: Optional[str] = _Header(None)):
    """Rename, re-file or replace an entry's file. A new file reaches every linked node in every scene."""
    proj_dir = _accessible_project(project_id, workspace, authorization)
    async with _BIBLE_LOCK:
        data = bible.load(proj_dir)
        entry = next((e for e in data["entries"] if e["id"] == entry_id), None)
        if entry is None:
            raise HTTPException(404, f"Bible entry not found: {entry_id}")
        try:
            file_changed = bible.apply_patch(entry, req.model_dump(exclude={"link"}))
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        changed: list = []
        if file_changed:
            scenes = set(bible.affected(((sid, c) for sid, _, c in _scene_canvases(proj_dir)), entry_id))
            if scenes:
                changed = await _rewrite_scenes(project_id, proj_dir, scenes,
                                                lambda cs: bible.propagate(cs, entry, entry_id, _atomic_write_json))
        data["revision"] += 1
        _atomic_write_json(bible.path(proj_dir), data)
        return {"entry": entry, "updated_nodes": changed, **_bible_response(proj_dir, data)}


@app.delete("/projects/{project_id}/bible/{entry_id}")
async def delete_bible_entry(project_id: str, entry_id: str, workspace: str = "default",
                             authorization: Optional[str] = _Header(None)):
    """Remove an entry. Linked nodes keep their file and become ordinary nodes; no file is deleted."""
    proj_dir = _accessible_project(project_id, workspace, authorization)
    async with _BIBLE_LOCK:
        data = bible.load(proj_dir)
        if not any(e["id"] == entry_id for e in data["entries"]):
            raise HTTPException(404, f"Bible entry not found: {entry_id}")
        scenes = set(bible.affected(((sid, c) for sid, _, c in _scene_canvases(proj_dir)), entry_id))
        if scenes:
            await _rewrite_scenes(project_id, proj_dir, scenes,
                                  lambda cs: bible.propagate(cs, None, entry_id, _atomic_write_json))
        data["entries"] = [e for e in data["entries"] if e["id"] != entry_id]
        data["revision"] += 1
        _atomic_write_json(bible.path(proj_dir), data)
        return _bible_response(proj_dir, data)


@app.get("/projects/{project_id}/scenes")
async def list_scenes(project_id: str, workspace: str = "default",
                      authorization: Optional[str] = _Header(None)):
    """The film's scenes in order, each with what the overview shows."""
    proj_dir = _accessible_project(project_id, workspace, authorization)
    scenes = _scene_list(_read_meta(proj_dir))
    return {"scenes": await asyncio.to_thread(lambda: [_scene_summary(proj_dir, s) for s in scenes])}


def _hd_map(proj_dir: Path) -> dict[str, dict]:
    """Every finished 视频增强 node in every scene, keyed by the clip it was made from.

    The cut room's 换成高清版 used to look only at the scene open on the canvas, so a
    film cut across scenes relinked that scene's shots and silently skipped the rest
    (2026-09-29: scene 4's C17a had an HD master; the button, opened from scene 1,
    never saw it).
    """
    out: dict[str, dict] = {}
    for scene in _scene_list(_read_meta(proj_dir)):
        path = _scene_canvas_path(proj_dir, scene["id"])
        try:
            canvas = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        nodes = {n.get("id"): n for n in canvas.get("nodes") or [] if isinstance(n, dict)}
        for node in nodes.values():
            if node.get("type") != "videoUpscale":
                continue
            data = node.get("data") or {}
            # The full file when the result was served cut: the cut room moves the
            # seam with the overlap (headFrames) at its head.
            hd = data.get("untrimmedUrl") or data.get("generatedUrl")
            if not isinstance(hd, str) or not hd:
                continue
            for edge in canvas.get("edges") or []:
                # in-video only: boards wired to in-ref-image are not its source
                if edge.get("target") != node.get("id") or edge.get("targetHandle") not in (None, "in-video"):
                    continue
                src = (nodes.get(edge.get("source")) or {}).get("data") or {}
                url = src.get("generatedUrl") or src.get("url")
                if isinstance(url, str) and url:
                    out[url] = {"url": hd, "headFrames": int(data.get("overlapFrames") or 0)}
    return out


@app.get("/projects/{project_id}/hd-map")
async def project_hd_map(project_id: str, workspace: str = "default",
                         authorization: Optional[str] = _Header(None)):
    """{source clip url: {url: HD file, headFrames: overlap frames it carries}} across all scenes."""
    proj_dir = _accessible_project(project_id, workspace, authorization)
    return {"map": await asyncio.to_thread(_hd_map, proj_dir)}


def _node_versions(proj_dir: Path, node_id: str) -> Optional[dict]:
    """Every version of one canvas node, each with the 高清 render made from it, if any.

    The cut room swaps a clip between versions of the node it came from. The node
    can sit in any scene of the film, so all of them are searched.
    """
    for scene in _scene_list(_read_meta(proj_dir)):
        path = _scene_canvas_path(proj_dir, scene["id"])
        try:
            canvas = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        nodes = {n.get("id"): n for n in canvas.get("nodes") or [] if isinstance(n, dict)}
        node = nodes.get(node_id)
        if node is None:
            continue
        data = node.get("data") or {}
        # 高清 renders wired from this node, keyed by the clip each was made from
        # (compareUrl); the upscale's own output is the HD of that clip.
        hd_of: dict[str, dict] = {}
        for edge in canvas.get("edges") or []:
            if edge.get("source") != node_id or edge.get("targetHandle") not in (None, "in-video"):
                continue
            up = nodes.get(edge.get("target")) or {}
            if up.get("type") != "videoUpscale":
                continue
            ud = up.get("data") or {}
            hd = ud.get("untrimmedUrl") or ud.get("generatedUrl")
            src = ud.get("compareUrl")
            if isinstance(hd, str) and hd and isinstance(src, str) and src:
                hd_of[src] = {"url": hd, "headFrames": int(ud.get("overlapFrames") or 0), "node": up.get("id")}
        current = data.get("generatedUrl")
        takes = [tk for tk in (data.get("takes") or []) if isinstance(tk, dict) and tk.get("url")]
        if isinstance(current, str) and current and all(tk["url"] != current for tk in takes):
            takes.insert(0, {"url": current, "untrimmedUrl": data.get("untrimmedUrl"),
                             "contextFrames": data.get("contextFrames")})
        versions = []
        for tk in takes:
            url, full = tk["url"], tk.get("untrimmedUrl")
            hd = hd_of.get(url) or (hd_of.get(full) if isinstance(full, str) else None)
            versions.append({
                "url": url,
                "untrimmedUrl": full if isinstance(full, str) and full else None,
                "contextFrames": int(tk.get("contextFrames") or 0),
                "createdAt": tk.get("createdAt"),
                "seed": tk.get("seed"),
                "adopted": bool(tk.get("adopted")),
                "current": url == current,
                "hd": hd,
            })
        return {"node_id": node_id, "scene": scene["id"], "label": data.get("label") or "", "versions": versions}
    return None


@app.get("/projects/{project_id}/nodes/{node_id}/versions")
async def node_versions(project_id: str, node_id: str, workspace: str = "default",
                        authorization: Optional[str] = _Header(None)):
    """Versions of one canvas node (newest first) with the 高清 render of each, for the cut room."""
    proj_dir = _accessible_project(project_id, workspace, authorization)
    found = await asyncio.to_thread(_node_versions, proj_dir, node_id)
    if found is None:
        raise HTTPException(404, f"Node not found in any scene: {node_id}")
    return found


@app.post("/projects/{project_id}/scenes")
async def create_scene(project_id: str, req: SceneCreateRequest, workspace: str = "default",
                       authorization: Optional[str] = _Header(None)):
    proj_dir = _accessible_project(project_id, workspace, authorization)
    name = req.name.strip()
    if not name:
        raise HTTPException(400, "A scene needs a name.")
    async with _SCENE_META_LOCK:
        meta = _read_meta(proj_dir)
        scenes = _scene_list(meta)
        scene = {"id": f"s_{uuid.uuid4().hex[:10]}", "name": name, "status": "todo"}
        _atomic_write_json(_scene_canvas_path(proj_dir, scene["id"]),
                           {"nodes": [], "edges": [], "viewport": {"x": 0, "y": 0, "zoom": 1}, "revision": 0})
        _write_scenes(proj_dir, meta, scenes + [scene])
    return _scene_summary(proj_dir, scene)


@app.patch("/projects/{project_id}/scenes/{scene_id}")
async def update_scene(project_id: str, scene_id: str, req: ScenePatchRequest, workspace: str = "default",
                       authorization: Optional[str] = _Header(None)):
    proj_dir = _accessible_project(project_id, workspace, authorization)
    if req.status is not None and req.status not in SCENE_STATUSES:
        raise HTTPException(400, f"Unknown status: {req.status}")
    async with _SCENE_META_LOCK:
        meta = _read_meta(proj_dir)
        scenes = _scene_list(meta)
        scene = next((s for s in scenes if s["id"] == scene_id), None)
        if scene is None:
            raise HTTPException(404, f"Scene not found: {scene_id}")
        if req.name is not None and req.name.strip():
            scene["name"] = req.name.strip()
        if req.status is not None:
            scene["status"] = req.status
        if req.sequence_id is not None:
            scene["sequence_id"] = req.sequence_id or None
        _write_scenes(proj_dir, meta, scenes)
    return _scene_summary(proj_dir, scene)


@app.put("/projects/{project_id}/scenes/order")
async def reorder_scenes(project_id: str, req: SceneOrderRequest, workspace: str = "default",
                         authorization: Optional[str] = _Header(None)):
    proj_dir = _accessible_project(project_id, workspace, authorization)
    async with _SCENE_META_LOCK:
        meta = _read_meta(proj_dir)
        scenes = _scene_list(meta)
        by_id = {s["id"]: s for s in scenes}
        if sorted(req.ids) != sorted(by_id):
            raise HTTPException(400, "The new order must list every scene exactly once.")
        _write_scenes(proj_dir, meta, [by_id[i] for i in req.ids])
    return {"ids": req.ids}


@app.delete("/projects/{project_id}/scenes/{scene_id}")
async def delete_scene(project_id: str, scene_id: str, workspace: str = "default",
                       authorization: Optional[str] = _Header(None)):
    """Take a scene out of the film. Its canvas moves to scenes/.trash, so nothing it
    referenced becomes unused and it can be brought back by hand."""
    proj_dir = _accessible_project(project_id, workspace, authorization)
    if _scene_id(scene_id) == MAIN_SCENE:
        raise HTTPException(400, "The first scene is the project's own canvas and cannot be removed.")
    async with _SCENE_META_LOCK:
        meta = _read_meta(proj_dir)
        scenes = _scene_list(meta)
        if not any(s["id"] == scene_id for s in scenes):
            raise HTTPException(404, f"Scene not found: {scene_id}")
        source = proj_dir / "scenes" / scene_id
        if source.is_dir():
            trash = proj_dir / "scenes" / ".trash"
            trash.mkdir(parents=True, exist_ok=True)
            os.replace(source, trash / f"{scene_id}_{int(time.time())}")
        _write_scenes(proj_dir, meta, [s for s in scenes if s["id"] != scene_id])
    return {"status": "deleted", "id": scene_id}


# ── Cut Room: timeline persistence, asset probing and export ──────────────────
# The editor keeps everything in integer frames on one global fps grid, so the
# backend never has to reconcile floating-point seconds coming from the UI.

class TimelineSaveRequest(BaseModel):
    timeline: dict
    base_revision: Optional[int] = None


class SequenceCreateRequest(BaseModel):
    name: str
    copy_from: Optional[str] = None


class SequencePatchRequest(BaseModel):
    name: str


# A project holds any number of sequences (films), each its own file under
# sequences/, listed in sequences.json. The pre-sequence timeline.json becomes
# the sequence "main" on first touch and is left on disk untouched.
_MAIN_SEQUENCE = "main"
_SEQ_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_seq_lock = asyncio.Lock()


def _atomic_write_json(path: Path, data) -> None:
    """Write to a sibling temp file and swap it in: never a truncated document."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _touch_project(proj_dir: Path) -> None:
    meta = _read_meta(proj_dir)
    if meta:
        meta["updated_at"] = _now_iso()
        _atomic_write_json(proj_dir / "meta.json", meta)


def _sequence_index(proj_dir: Path) -> dict:
    """Read sequences.json, creating it (and migrating timeline.json) if missing."""
    index_path = proj_dir / "sequences.json"
    if index_path.exists():
        return json.loads(index_path.read_text(encoding="utf-8"))
    now = _now_iso()
    legacy = proj_dir / "timeline.json"
    main_path = proj_dir / "sequences" / f"{_MAIN_SEQUENCE}.json"
    if not main_path.exists():
        if legacy.exists():
            _atomic_write_json(main_path, json.loads(legacy.read_text(encoding="utf-8")))
        else:
            _atomic_write_json(main_path, {"timeline": None, "revision": 0})
    index = {"sequences": [{"id": _MAIN_SEQUENCE, "name": "主剪辑", "created_at": now, "updated_at": now}]}
    _atomic_write_json(index_path, index)
    return index


def _sequence_path(proj_dir: Path, seq_id: str) -> Path:
    if not _SEQ_ID_RE.match(seq_id):
        raise HTTPException(400, f"Bad sequence id: {seq_id}")
    return proj_dir / "sequences" / f"{seq_id}.json"


def _open_project(project_id: str, workspace: str, authorization: Optional[str]) -> Path:
    proj_dir = _project_dir(project_id, workspace)
    if not proj_dir.exists():
        raise HTTPException(404, f"Project not found: {project_id}")
    _require_access(proj_dir, _caller_user_id(authorization), project_id)
    return proj_dir


def _find_sequence(index: dict, seq_id: str) -> dict:
    for entry in index["sequences"]:
        if entry["id"] == seq_id:
            return entry
    raise HTTPException(404, f"Sequence not found: {seq_id}")


def _load_sequence(proj_dir: Path, seq_id: str) -> dict:
    index = _sequence_index(proj_dir)
    _find_sequence(index, seq_id)
    path = _sequence_path(proj_dir, seq_id)
    if not path.exists():
        return {"timeline": None, "revision": 0}
    data = json.loads(path.read_text(encoding="utf-8"))
    return {"timeline": data.get("timeline"), "revision": int(data.get("revision", 0))}


async def _save_sequence(proj_dir: Path, project_id: str, seq_id: str, req: TimelineSaveRequest) -> dict:
    async with _seq_lock:
        index = _sequence_index(proj_dir)
        entry = _find_sequence(index, seq_id)
        path = _sequence_path(proj_dir, seq_id)
        current_revision = 0
        if path.exists():
            try:
                current_revision = int(json.loads(path.read_text(encoding="utf-8")).get("revision", 0))
            except (OSError, ValueError, TypeError, json.JSONDecodeError):
                current_revision = 0
        if req.base_revision is not None and req.base_revision != current_revision:
            raise HTTPException(409, detail={
                "message": "Timeline changed since it was loaded.",
                "current_revision": current_revision,
            })
        revision = current_revision + 1
        _atomic_write_json(path, {"timeline": req.timeline, "revision": revision})
        entry["updated_at"] = _now_iso()
        _atomic_write_json(proj_dir / "sequences.json", index)
        _touch_project(proj_dir)
    return {"status": "saved", "project_id": project_id, "sequence_id": seq_id, "revision": revision}


@app.get("/projects/{project_id}/sequences")
async def list_sequences(project_id: str, workspace: str = "default", include_timelines: bool = False,
                         authorization: Optional[str] = _Header(None)):
    """Every sequence in the project, in tab order. With include_timelines, their content too."""
    proj_dir = _open_project(project_id, workspace, authorization)
    async with _seq_lock:
        index = _sequence_index(proj_dir)
    out = []
    for entry in index["sequences"]:
        item = dict(entry)
        if include_timelines:
            item.update(_load_sequence(proj_dir, entry["id"]))
        out.append(item)
    return {"sequences": out}


@app.post("/projects/{project_id}/sequences")
async def create_sequence(project_id: str, req: SequenceCreateRequest, workspace: str = "default",
                          authorization: Optional[str] = _Header(None)):
    """New empty sequence, or a copy of an existing one (copy_from)."""
    proj_dir = _open_project(project_id, workspace, authorization)
    name = req.name.strip() or "未命名"
    async with _seq_lock:
        index = _sequence_index(proj_dir)
        content = {"timeline": None, "revision": 0}
        if req.copy_from:
            _find_sequence(index, req.copy_from)
            source = _load_sequence(proj_dir, req.copy_from)
            content = {"timeline": source["timeline"], "revision": 0}
        seq_id = f"seq_{uuid.uuid4().hex[:10]}"
        now = _now_iso()
        _atomic_write_json(_sequence_path(proj_dir, seq_id), content)
        entry = {"id": seq_id, "name": name, "created_at": now, "updated_at": now}
        index["sequences"].append(entry)
        _atomic_write_json(proj_dir / "sequences.json", index)
    return entry


@app.get("/projects/{project_id}/sequences/{seq_id}")
async def load_sequence(project_id: str, seq_id: str, workspace: str = "default",
                        authorization: Optional[str] = _Header(None)):
    proj_dir = _open_project(project_id, workspace, authorization)
    async with _seq_lock:
        return _load_sequence(proj_dir, seq_id)


@app.put("/projects/{project_id}/sequences/{seq_id}")
async def save_sequence(project_id: str, seq_id: str, req: TimelineSaveRequest, workspace: str = "default",
                        authorization: Optional[str] = _Header(None)):
    """Save one sequence. Same optimistic-revision contract as the canvas."""
    proj_dir = _open_project(project_id, workspace, authorization)
    return await _save_sequence(proj_dir, project_id, seq_id, req)


@app.patch("/projects/{project_id}/sequences/{seq_id}")
async def rename_sequence(project_id: str, seq_id: str, req: SequencePatchRequest, workspace: str = "default",
                          authorization: Optional[str] = _Header(None)):
    proj_dir = _open_project(project_id, workspace, authorization)
    name = req.name.strip()
    if not name:
        raise HTTPException(400, "Name is empty")
    async with _seq_lock:
        index = _sequence_index(proj_dir)
        entry = _find_sequence(index, seq_id)
        entry["name"] = name
        entry["updated_at"] = _now_iso()
        _atomic_write_json(proj_dir / "sequences.json", index)
    return entry


@app.delete("/projects/{project_id}/sequences/{seq_id}")
async def delete_sequence(project_id: str, seq_id: str, workspace: str = "default",
                          authorization: Optional[str] = _Header(None)):
    """Take a sequence off the list. Its file moves to sequences/.trash/, not deleted."""
    proj_dir = _open_project(project_id, workspace, authorization)
    async with _seq_lock:
        index = _sequence_index(proj_dir)
        _find_sequence(index, seq_id)
        if len(index["sequences"]) <= 1:
            raise HTTPException(400, "A project keeps at least one sequence.")
        path = _sequence_path(proj_dir, seq_id)
        if path.exists():
            trash = proj_dir / "sequences" / ".trash"
            trash.mkdir(parents=True, exist_ok=True)
            os.replace(path, trash / f"{seq_id}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json")
        index["sequences"] = [e for e in index["sequences"] if e["id"] != seq_id]
        _atomic_write_json(proj_dir / "sequences.json", index)
    return {"status": "deleted", "sequence_id": seq_id}


# The single-timeline endpoints predate sequences; they read and write "main".
@app.get("/projects/{project_id}/timeline")
async def load_timeline(project_id: str, workspace: str = "default",
                        authorization: Optional[str] = _Header(None)):
    proj_dir = _open_project(project_id, workspace, authorization)
    async with _seq_lock:
        return _load_sequence(proj_dir, _MAIN_SEQUENCE)


@app.put("/projects/{project_id}/timeline")
async def save_timeline(project_id: str, req: TimelineSaveRequest, workspace: str = "default",
                        authorization: Optional[str] = _Header(None)):
    proj_dir = _open_project(project_id, workspace, authorization)
    return await _save_sequence(proj_dir, project_id, _MAIN_SEQUENCE, req)


# ── Asset probing, proxies and waveforms ──────────────────────────────────────

class PrepareAssetRequest(BaseModel):
    url: str
    proxy: bool = True


_ASSET_PROBE_CACHE: dict[str, dict] = {}
PROXY_DIR = UPLOAD_DIR / "proxies"
PROXY_DIR.mkdir(exist_ok=True)

# Preview scrubbing decodes every frame it lands on, so the proxy is all-keyframe
# — that is what makes a step backwards instant. It is NOT meant to be a low-res
# copy: the monitor composites it up to the timeline's own size, so anything
# below the source resolution shows as a soft picture. 540p/crf26 did exactly
# that. The cap only exists to keep an upscaled 2752px master from being decoded
# frame-by-frame during a scrub.
PROXY_HEIGHT = 1080
PROXY_CRF = 20
# Bumped whenever the recipe changes, so existing proxies are rebuilt instead of
# serving the old quality forever.
PROXY_VERSION = 2
THUMB_COUNT = 12
# Peaks are drawn per clip, and a clip is usually a small window into its asset:
# a fixed bucket count spread over a long file leaves a short trim with a
# handful of fat blocks instead of a waveform. So the density follows duration —
# 40 buckets a second, about 25 ms each, which still resolves a syllable.
PEAK_RATE = 40
PEAK_BUCKETS_MIN = 400
PEAK_BUCKETS_MAX = 6000


def _probe_media(path: Path) -> dict:
    """
    Full media description for the cut room: real frame rate, frame count,
    geometry, duration and whether there is an audio stream.

    Exact frame counts matter more here than anywhere else in the app: a clip's
    length on the timeline is derived from them, so an estimate would leave the
    last frames of every shot unreachable. `-count_frames` decodes, but these
    clips are seconds long.
    """
    completed = subprocess.run(
        [os.environ.get("FFPROBE", "ffprobe"), "-v", "error", "-count_frames",
         "-show_entries",
         "stream=codec_type,width,height,nb_read_frames,nb_frames,r_frame_rate:format=duration",
         "-of", "json", str(path)],
        capture_output=True, text=True, timeout=180, check=True,
    )
    parsed = json.loads(completed.stdout)
    streams = parsed.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    has_audio = any(s.get("codec_type") == "audio" for s in streams)

    try:
        duration = float((parsed.get("format") or {}).get("duration") or 0.0)
    except (TypeError, ValueError):
        duration = 0.0

    if not video:
        # Audio-only asset — the music and ambience nodes feed the A tracks.
        return {"kind": "audio", "width": 0, "height": 0, "fps": 0.0,
                "frames": 0, "duration": duration, "has_audio": True}

    num, _, den = (video.get("r_frame_rate") or "0/1").partition("/")
    try:
        fps = float(num) / float(den) if float(den) else 0.0
    except (TypeError, ValueError, ZeroDivisionError):
        fps = 0.0

    try:
        frames = int(video.get("nb_read_frames") or video.get("nb_frames") or 0)
    except (TypeError, ValueError):
        frames = 0

    if frames <= 1:
        # A still. It has no duration of its own; the editor gives it a default
        # on-screen length instead of reading one off the file.
        return {"kind": "image", "width": int(video["width"]), "height": int(video["height"]),
                "fps": 0.0, "frames": 1, "duration": 0.0, "has_audio": False}

    if duration <= 0 and fps > 0:
        duration = frames / fps

    return {"kind": "video", "width": int(video["width"]), "height": int(video["height"]),
            "fps": fps, "frames": frames, "duration": duration, "has_audio": has_audio}


def _build_proxy(src: Path, stem: str, height: int = PROXY_HEIGHT) -> str:
    """
    All-keyframe copy for the monitor. `-g 1` is the entire point: seeking a
    generated mp4 backwards by one frame otherwise decodes from a keyframe that
    can be seconds earlier, which is what makes scrubbing feel broken.

    `height` is the preview quality level: the standard proxy is PROXY_HEIGHT (sharp, and
    heavy to play when the picture is HD); lower levels are built on demand
    (/timeline/proxy-level) for monitors that cannot keep up or are small anyway.
    """
    suffix = "" if height >= PROXY_HEIGHT else f"_{height}p"
    out = PROXY_DIR / f"{stem}_proxy_v{PROXY_VERSION}{suffix}.mp4"
    if out.exists():
        return f"/uploads/proxies/{out.name}"
    # Whatever an earlier recipe left behind is dead weight now (other levels of this recipe stay).
    for stale in PROXY_DIR.glob(f"{stem}_proxy*.mp4"):
        if not stale.name.startswith(f"{stem}_proxy_v{PROXY_VERSION}"):
            stale.unlink(missing_ok=True)
    # Written beside and renamed: a half-built file must never be taken for a proxy.
    partial = out.with_name(out.stem + ".partial.tmp")
    result = subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", str(src),
         # `min(ih, cap)` never enlarges: a 768p master stays 768p instead of
         # being blown up and re-compressed.
         # No shell here, so no quotes: the comma inside min() is escaped instead,
         # or the filtergraph parser reads it as the start of a second filter.
         # yuv420p needs an even height, hence the trunc to a multiple of 2.
         # setpts: a source whose picture starts after its sound (a fragmented
         # mp4 with B-frames and no edit list starts at 2/fps) would keep that
         # offset, and the monitor, seeking to frame n at n/fps, showed n-2.
         "-vf", rf"setpts=PTS-STARTPTS,scale=-2:2*trunc(min(ih\,{height})/2)",
         "-c:v", "libx264", "-crf", str(PROXY_CRF if height >= PROXY_HEIGHT else PROXY_CRF + 3),
         "-preset", "veryfast", "-g", "1",
         "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-f", "mp4", str(partial)],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        partial.unlink(missing_ok=True)
        raise RuntimeError(f"proxy encode failed: {result.stderr.strip()[-400:]}")
    partial.replace(out)
    return f"/uploads/proxies/{out.name}"


def _build_thumbs(src: Path, stem: str, duration: float) -> tuple[str, int]:
    """One horizontal sprite sheet per asset — the clip strip draws slices of it."""
    out = PROXY_DIR / f"{stem}_thumbs.jpg"
    if out.exists():
        return f"/uploads/proxies/{out.name}", THUMB_COUNT
    rate = max(THUMB_COUNT / duration, 0.1) if duration > 0 else 1.0
    result = subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", str(src),
         "-vf", f"fps={rate:.6f},scale=120:-2,tile={THUMB_COUNT}x1",
         "-frames:v", "1", "-q:v", "5", str(out)],
        capture_output=True, text=True,
    )
    if result.returncode != 0 or not out.exists():
        return "", 0
    return f"/uploads/proxies/{out.name}", THUMB_COUNT


def _build_levels(src: Path, duration: float = 0.0) -> tuple[list[float], list[float]]:
    """(peak, loudness) per bucket, both 0..1 of full scale, read straight off decoded PCM.

    The peak is the loudest sample in the bucket. The loudness is the RMS over a
    ~100 ms window centred on it: a waveform of peaks alone shows a door slam and a
    steady voice at the same height, while the ear (and a meter) goes by energy.
    Unweighted RMS, not K-weighted LUFS; it tracks momentary loudness closely
    enough to see which shot is hot and which is quiet.
    """
    import numpy as np

    result = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(src), "-vn",
         "-ac", "1", "-ar", "8000", "-f", "s16le", "-"],
        capture_output=True,
    )
    if result.returncode != 0 or len(result.stdout) < 2:
        return [], []
    samples = np.frombuffer(result.stdout[: len(result.stdout) // 2 * 2], dtype="<i2").astype(np.float32) / 32768.0
    seconds = duration if duration > 0 else len(samples) / 8000.0
    target = int(min(max(seconds * PEAK_RATE, PEAK_BUCKETS_MIN), PEAK_BUCKETS_MAX))
    bucket = max(1, len(samples) // target)
    count = -(-len(samples) // bucket)
    pad = count * bucket - len(samples)
    padded = np.pad(samples, (0, pad)) if pad else samples
    grid = padded.reshape(count, bucket)
    peaks = np.abs(grid).max(axis=1)
    energy = (grid * grid).sum(axis=1)
    counts = np.full(count, bucket, dtype=np.float32)
    if pad:
        counts[-1] = bucket - pad
    # ~100 ms of buckets on each side of the centre, as a running mean of energy.
    half = max(1, int(round(0.05 * len(samples) / max(seconds, 1e-6) / bucket)))
    kernel = np.ones(2 * half + 1, dtype=np.float32)
    window_energy = np.convolve(energy, kernel, mode="same")
    window_counts = np.convolve(counts, kernel, mode="same")
    loudness = np.sqrt(window_energy / np.maximum(window_counts, 1.0))
    return ([round(float(v), 3) for v in peaks[:target]], [round(float(v), 4) for v in loudness[:target]])


def _build_peaks(src: Path, duration: float = 0.0) -> list[float]:
    """Normalised peak per bucket (see _build_levels)."""
    return _build_levels(src, duration)[0]


_POSTER_LOCK = asyncio.Semaphore(4)


def _build_poster(src: Path, out: Path) -> bool:
    """A frame near the start as a JPEG, at most 640 px wide."""
    tmp = out.with_suffix(".tmp.jpg")
    for seek in ("0.04", "0"):
        result = subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-ss", seek, "-i", str(src),
             "-frames:v", "1", "-vf", "scale='min(640,iw)':-2", "-q:v", "4", str(tmp)],
            capture_output=True,
        )
        if result.returncode == 0 and tmp.exists() and tmp.stat().st_size > 0:
            os.replace(tmp, out)
            return True
    tmp.unlink(missing_ok=True)
    return False


def _download_name(requested: str, path: Path) -> str:
    """A file name safe to hand to a browser: what was asked for, else the file's own, with the extension kept."""
    cleaned = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "_", requested or "").strip(" .")[:150]
    if not cleaned:
        return path.name
    if not Path(cleaned).suffix and path.suffix:
        cleaned += path.suffix
    return cleaned


@app.get("/download")
async def download_media(src: str, name: str = ""):
    """A served file as an attachment, streamed from disk by the server.

    A page that saves a big file itself has to hold all of it in memory first, and a phone browser
    reloads the tab when that gets too big (388 MB on an iPhone, 2026-10-02: the progress reached
    100% and the page refreshed). With Content-Disposition: attachment the browser's own download
    manager takes the file instead: the page buffers nothing, it streams to disk, ranges work, and the
    browser shows its own progress. Only files already on this machine, under /uploads or
    /comfy_output, are served, judged by path like /media/poster.
    """
    local = urlparse(src).path
    if not local.startswith(("/uploads/", "/comfy_output/")):
        raise HTTPException(400, "Only local media can be downloaded.")
    try:
        path = await resolve_upload(local)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    return FileResponse(
        path, filename=_download_name(name, path), content_disposition_type="attachment",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/media/poster")
async def media_poster(src: str):
    """First frame of a served video as a small JPEG.

    Pages show this instead of a <video> until a clip is actually played: a card
    that mounts a player only to grab its own poster downloads the whole file,
    for every clip on the page, the moment the page opens. Only files already on
    this machine are read; the cache key carries size and mtime, so a clip
    overwritten in place gets a new poster.
    """
    # Judge by path, not host: the studio is also opened over Tailscale, where the
    # same file is http://100.x.x.x:8003/comfy_output/... Only the path is passed
    # on, so nothing is ever downloaded from elsewhere.
    local = urlparse(src).path if not src.startswith("data:") else ""
    if not local.startswith(("/uploads/", "/comfy_output/")):
        raise HTTPException(400, "Posters are only made for local media.")
    try:
        path = await resolve_upload(local)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    stat = path.stat()
    key = hashlib.sha1(f"{path}|{stat.st_size}|{stat.st_mtime_ns}".encode()).hexdigest()[:20]
    out = PROXY_DIR / f"poster_{key}.jpg"
    if not out.exists():
        async with _POSTER_LOCK:
            if not out.exists() and not await asyncio.to_thread(_build_poster, path, out):
                raise HTTPException(422, "Could not read a frame from this file.")
    return Response(
        out.read_bytes(), media_type="image/jpeg",
        # The URL already names the source; a changed file changes nothing in the
        # URL, so the browser must ask again, and the ETag keeps that cheap.
        headers={"Cache-Control": "no-cache", "ETag": f'"{key}"'},
    )


@app.post("/timeline/prepare-asset")
async def prepare_timeline_asset(req: PrepareAssetRequest):
    """
    Describe one media file for the cut room and build everything the editor needs
    to show it: a scrub proxy, a thumbnail strip and audio peaks.

    Cached by resolved path + mtime, so dropping the same shot on the timeline
    repeatedly costs one dictionary lookup.
    """
    try:
        path = await resolve_upload(req.url)
    except FileNotFoundError as exc:
        # An unhandled error here never reaches the CORS middleware, so the
        # browser reports it as a CORS failure instead of "no such file".
        raise HTTPException(404, f"Missing media: {req.url}") from exc
    try:
        cache_key = f"{path}:{path.stat().st_mtime_ns}"
    except OSError:
        cache_key = str(path)
    cached = _ASSET_PROBE_CACHE.get(cache_key)
    if cached:
        return cached

    try:
        info = await asyncio.to_thread(_probe_media, path)
    except (subprocess.SubprocessError, ValueError, KeyError, json.JSONDecodeError) as exc:
        raise HTTPException(400, f"Could not probe media: {exc}") from exc

    result = {"url": req.url, **info}
    stem = hashlib.sha1(cache_key.encode("utf-8")).hexdigest()[:16]

    if req.proxy and info["kind"] == "video":
        try:
            result["proxy_url"] = await asyncio.to_thread(_build_proxy, path, stem)
        except (RuntimeError, subprocess.SubprocessError) as exc:
            # The editor falls back to the original file; scrubbing is just slower.
            logger.warning("Proxy build failed for %s: %s", path.name, exc)
        thumbs, count = await asyncio.to_thread(_build_thumbs, path, stem, info["duration"])
        if thumbs:
            result["thumbs_url"], result["thumb_count"] = thumbs, count

    if info["has_audio"]:
        result["peaks"], result["rms"] = await asyncio.to_thread(_build_levels, path, info["duration"])

    _ASSET_PROBE_CACHE[cache_key] = result
    return result


class ProxyLevelRequest(BaseModel):
    url: str
    height: int = Field(ge=180, le=PROXY_HEIGHT)


_PROXY_LEVEL_LOCKS: dict[str, asyncio.Lock] = {}


@app.post("/timeline/proxy-level")
async def build_proxy_level(req: ProxyLevelRequest):
    """One video's preview proxy at a lower height (the cut room's quality menu). Built once, on first
    use; the answer is the proxy's URL. The master and the export are not touched."""
    try:
        path = await resolve_upload(req.url)
    except FileNotFoundError as exc:
        raise HTTPException(404, f"Missing media: {req.url}") from exc
    try:
        cache_key = f"{path}:{path.stat().st_mtime_ns}"
    except OSError:
        cache_key = str(path)
    stem = hashlib.sha1(cache_key.encode("utf-8")).hexdigest()[:16]
    lock = _PROXY_LEVEL_LOCKS.setdefault(f"{stem}:{req.height}", asyncio.Lock())
    async with lock:
        try:
            proxy_url = await asyncio.to_thread(_build_proxy, path, stem, req.height)
        except (RuntimeError, subprocess.SubprocessError) as exc:
            raise HTTPException(500, f"Proxy build failed: {exc}") from exc
    return {"proxy_url": proxy_url, "height": req.height}


# ── Export ────────────────────────────────────────────────────────────────────

class ExportFilters(BaseModel):
    brightness: float = 0.0
    contrast: float = 1.0
    saturation: float = 1.0
    temperature: float = 6500.0


class ExportTransition(BaseModel):
    type: str = "dissolve"     # dissolve | fade | dip
    frames: int = 0


class ExportClip(BaseModel):
    url: str
    kind: str = "video"        # video | image | audio
    start: int = 0             # timeline frame
    duration: int = 0          # timeline frames, after speed
    # Trim points in seconds. The editor holds them on its own frame grid, which
    # is rate-independent, so seconds convert cleanly for a source of any fps.
    src_in_s: float = 0.0
    src_out_s: float = 0.0
    speed: float = 1.0
    volume: float = 1.0
    muted: bool = False
    fade_in: int = 0
    fade_out: int = 0
    alpha: bool = False        # overlay carrying its own transparency (rendered text)
    fit: str = "contain"       # contain: pad with black | cover: crop to fill
    rotate: int = 0            # quarter turns clockwise: 0 | 90 | 180 | 270
    zoom: float = 1.0          # on top of the fit; 1 is exactly what fit worked out
    offset_x: float = 0.0      # fractions of the FRAME, not of the picture
    offset_y: float = 0.0
    # Kept part of the ROTATED picture, as fractions of it. None means all of it.
    crop: Optional[list[float]] = None      # [x, y, w, h]
    flip_h: bool = False       # mirror the picture; sound and timing are untouched
    flip_v: bool = False
    transition: Optional[ExportTransition] = None
    # [from, to) head frames, counted from the clip's start, whose own sound is not used: the cut
    # room's automatic seam rule. A chained clip's head is the previous shot's last frames,
    # regenerated, so over them only the previous clip's sound is heard. Only the frames the user did
    # not handle by hand are in it; a dissolve set by hand never silences anything.
    seam_mute: Optional[list[int]] = None
    filters: Optional[ExportFilters] = None


class ExportTrack(BaseModel):
    kind: str = "video"        # video | audio
    clips: list[ExportClip] = []


class TimelineExportRequest(BaseModel):
    tracks: list[ExportTrack]
    fps: int = 24
    width: int = 1920
    height: int = 1080
    duration: int = 0          # timeline frames
    name: str = "cut"
    # A timeline of nothing but sound (a voice reference trimmed on its own)
    # comes back as a 48 kHz wav instead of an mp4 with a black picture.
    audio_only: bool = False
    # The file's own frame rate when it differs from the grid. One shot slowed to
    # 0.5x on a 24 fps grid is the same 24 frames a second of picture held twice
    # as long; as a file of its own it should be 12 fps, each frame once. Frame
    # counts in the request (duration, fades, transitions) stay on `fps`.
    out_fps: Optional[float] = Field(default=None, gt=0, le=240)
    # The finished film is for the user to download, not an asset: it is written under uploads/exports/
    # (the library skips that folder); the page downloads it through /download.
    download: bool = False


# Export drives ffmpeg, not the GPU, so it must not queue behind the generation
# worker. It gets its own small registry instead of submit_job().
_EXPORT_JOBS: dict[str, dict] = {}
_EXPORT_LOCK = asyncio.Semaphore(1)


def _atempo_chain(speed: float) -> str:
    """atempo accepts 0.5–2.0 per instance, so a larger change is chained."""
    remaining = max(0.25, min(4.0, speed))
    steps = []
    while remaining > 2.0:
        steps.append(2.0)
        remaining /= 2.0
    while remaining < 0.5:
        steps.append(0.5)
        remaining /= 0.5
    steps.append(remaining)
    return ",".join(f"atempo={s:.6f}" for s in steps)


def _colour_filters(filters: Optional[ExportFilters]) -> str:
    if filters is None:
        return ""
    parts = []
    if (abs(filters.brightness) > 0.001 or abs(filters.contrast - 1) > 0.001
            or abs(filters.saturation - 1) > 0.001):
        parts.append(
            f"eq=brightness={filters.brightness:.4f}:contrast={filters.contrast:.4f}"
            f":saturation={filters.saturation:.4f}"
        )
    if abs(filters.temperature - 6500) > 1:
        parts.append(f"colortemperature=temperature={filters.temperature:.0f}")
    return "".join("," + p for p in parts)


def _tail_fades(req: TimelineExportRequest) -> dict[int, tuple[str, int]]:
    """
    Which clips have to fade out, and to what colour, keyed by their flat index.

    A dissolve needs nothing here — the incoming clip ramps its own alpha up while
    the outgoing one is still on screen underneath it. A fade or a dip is
    different: the picture has to actually reach black or white before the next
    shot arrives, so the clip leading into one gets the matching tail.
    """
    tails: dict[int, tuple[str, int]] = {}
    offset = 0
    for track in req.tracks:
        order = sorted(range(len(track.clips)), key=lambda i: track.clips[i].start)
        if track.kind == "video":
            for slot, index in enumerate(order[:-1]):
                here = track.clips[index]
                nxt = track.clips[order[slot + 1]]
                transition = nxt.transition
                if not transition or transition.frames <= 0 or transition.type not in ("fade", "dip"):
                    continue
                if nxt.start >= here.start + here.duration - 1:
                    tails[offset + index] = (
                        "white" if transition.type == "dip" else "black",
                        transition.frames,
                    )
        offset += len(track.clips)
    return tails


# A hard audio cut jumps the waveform from one sample value to another, which
# is heard as a click at the join. A few milliseconds of fade on each side of
# every cut removes it without being audible as a fade.
_SEAM_FADE_S = 0.008


def _audio_seams(req: "TimelineExportRequest") -> dict[int, tuple[bool, bool]]:
    """Per clip (by id()): whether its head / tail is a real cut that needs a
    seam fade. A split of one continuous take (same file, the next piece starts
    where the previous one ends, in source and on the timeline) is not a cut --
    fading there would put a small dip in the middle of a line."""
    out: dict[int, tuple[bool, bool]] = {}
    eps = 1.5 / max(req.fps, 1)
    for track in req.tracks:
        clips = sorted(track.clips, key=lambda c: c.start)
        for i, clip in enumerate(clips):
            head = tail = True
            if i > 0:
                prev = clips[i - 1]
                if (prev.url == clip.url and prev.start + prev.duration == clip.start
                        and abs(prev.src_out_s - clip.src_in_s) < eps and prev.speed == clip.speed):
                    head = False
            if i + 1 < len(clips):
                nxt = clips[i + 1]
                if (nxt.url == clip.url and clip.start + clip.duration == nxt.start
                        and abs(clip.src_out_s - nxt.src_in_s) < eps and nxt.speed == clip.speed):
                    tail = False
            out[id(clip)] = (head, tail)
    return out


# Windows refuses a command line over 32767 characters. A film with a subtitle per line has hundreds of
# still inputs (one picture each), and each costs ~120 characters of `-loop 1 -t .. -i <path>`.
_EXPORT_CMD_LIMIT = 28000


def _movie_still(path: Path, length_s: float, out_fps: float, label: str) -> str:
    """A picture held for `length_s`, made inside the filter graph instead of as a command-line input."""
    escaped = str(path).replace("\\", "/").replace(":", "\\:").replace("'", "\\'")
    return (f"movie=filename='{escaped}',loop=loop=-1:size=1:start=0,"
            f"setpts=N/({out_fps:g}*TB),trim=duration={length_s:.6f}[{label}]")


def _build_export_graph(
    req: TimelineExportRequest, sources: list[tuple[Path, dict]], stills_in_graph: bool = False
) -> tuple[list[str], str, float]:
    """
    Compile a timeline into a single ffmpeg invocation.

    The video model is a black base that clips are overlaid onto, bottom track
    first. That one choice buys multiple tracks, transparent overlays and cross
    dissolves at the same time, and it matches what the browser compositor does
    frame by frame in the monitor — so the export looks like the preview.
    """
    fps = req.fps
    # `fps` is the grid every frame count in the request is on; `out_fps` is how
    # often the file shows a picture. They differ only for one shot exported at
    # its real rate (see TimelineExportRequest.out_fps).
    out_fps = req.out_fps or fps
    total = max(req.duration, 1) / fps
    # A sound-only render still needs the base, but its picture is thrown away:
    # a full-size frame at full rate for the whole film was most of the mixing time.
    base = f"s=16x16:r=1" if req.audio_only else f"s={req.width}x{req.height}:r={out_fps:g}"
    inputs: list[str] = ["-f", "lavfi", "-i", f"color=c=black:{base}:d={total:.4f}"]
    chains: list[str] = []
    video_labels: list[tuple[str, float, float]] = []   # label, start_s, end_s
    audio_labels: list[str] = []
    tails = _tail_fades(req)

    flat: list[tuple[ExportClip, str]] = []
    for track in req.tracks:
        for clip in track.clips:
            flat.append((clip, track.kind))
    seams = _audio_seams(req)
    input_count = 0                     # the black base is input 0; each file input after it counts one

    for position, (clip, track_kind) in enumerate(flat):
        src, info = sources[position]
        length_s = max(clip.duration, 1) / fps
        speed = clip.speed if clip.speed and clip.speed > 0 else 1.0
        source_seconds = max(clip.src_out_s - clip.src_in_s, 1.0 / fps)
        # See _probe_has_audio: the picture of such a file starts this much after
        # its sound, so its frame n sits at n/fps + offset on the file's clock.
        video_offset = float(info.get("video_offset") or 0.0) if clip.kind != "image" else 0.0

        if clip.kind == "image" and stills_in_graph:
            # No command-line input: the picture is a source filter in the graph, which is a file.
            still_label = f"img{position}"
            chains.append(_movie_still(src, length_s, out_fps, still_label))
            video_source = still_label
        else:
            if clip.kind == "image":
                inputs += ["-loop", "1", "-t", f"{length_s:.6f}", "-i", str(src)]
            else:
                # -ss ahead of -i seeks fast and still decodes to the exact frame.
                inputs += ["-ss", f"{clip.src_in_s:.6f}",
                           "-t", f"{source_seconds + video_offset:.6f}", "-i", str(src)]
            input_count += 1
            index = input_count            # input 0 is the black base
            video_source = f"{index}:v"

        if track_kind == "video":
            # Reshaping runs in the same order as the monitor's compositor:
            # rotate, then crop what is left, then mirror, and only then fit the
            # result into the frame. Fitting first would pad the picture and then
            # rotate or crop the padding along with it.
            steps = []
            if video_offset > 0.0005:
                # After the seek the sound's clock is zero; the wanted frame is
                # video_offset later on it.
                steps.append(f"trim=start={video_offset:.6f}")
            if clip.rotate == 90:
                steps.append("transpose=1")
            elif clip.rotate == 270:
                steps.append("transpose=2")
            elif clip.rotate == 180:
                steps.append("transpose=1,transpose=1")
            if clip.crop and len(clip.crop) == 4:
                cx, cy, cw, ch = clip.crop
                if cw < 0.9995 or ch < 0.9995 or cx > 0.0005 or cy > 0.0005:
                    # Fractions of the post-rotate picture, so iw/ih here are
                    # already the rotated dimensions.
                    steps.append(
                        f"crop=iw*{cw:.6f}:ih*{ch:.6f}:iw*{cx:.6f}:ih*{cy:.6f}")
            if clip.flip_h:
                steps.append("hflip")
            if clip.flip_v:
                steps.append("vflip")
            # Fit, then free placement, in one shape for both fits: scale to the
            # frame (down for contain, up for cover) times the zoom, grow the
            # canvas to at least frame size so the next step always has something
            # to cut from, then take the frame-sized window out of it, shifted by
            # the offsets. At zoom 1 with no offset this is exactly the old
            # scale+pad / scale+crop pair.
            zoom = clip.zoom if clip.zoom and clip.zoom > 0 else 1.0
            direction = "increase" if clip.fit == "cover" else "decrease"
            # Even dimensions out of scale: a zoom can land the fitted picture on
            # an odd width (2269 at 1.18x), yuv420 pad then rounds its output
            # down below the input, and the whole export fails.
            steps.append(
                f"scale={max(2, round(req.width * zoom))}:{max(2, round(req.height * zoom))}"
                f":force_original_aspect_ratio={direction}:force_divisible_by=2")
            if clip.alpha:
                # A rendered overlay carries its own transparency; padding it with
                # opaque black would erase exactly what it is there for.
                steps.append("format=yuva420p")
            pad_colour = "black@0" if clip.alpha else "black"
            # Commas inside max() are escaped: unescaped, the filtergraph parser
            # reads them as the start of the next filter.
            steps.append(
                rf"pad=max(iw\,{req.width}):max(ih\,{req.height})"
                f":(ow-iw)/2:(oh-ih)/2:color={pad_colour}")
            # A positive offset moves the PICTURE right, so the window it is seen
            # through moves left by the same amount.
            steps.append(
                f"crop={req.width}:{req.height}"
                f":(iw-{req.width})/2-({clip.offset_x * req.width:.4f})"
                f":(ih-{req.height})/2-({clip.offset_y * req.height:.4f})")
            steps.append("setsar=1")
            steps.append(f"setpts=(PTS-STARTPTS)/{speed:.6f}" if abs(speed - 1.0) > 0.001
                         else "setpts=PTS-STARTPTS")
            steps.append(f"fps={out_fps:g}")
            # Hold the last frame if the source runs out before the clip does.
            #
            # A clip can ask for a few frames past the end of its file: an asset's
            # length on the timeline grid is rounded up from a source at another
            # rate (81 frames at 16fps is 121.5 at 24), and a file overwritten in
            # place is usually shorter than it was. The monitor holds the last
            # decoded frame there and looks right; without this the export had
            # nothing to overlay and the black base showed through, so a cut that
            # previewed clean exported with a black flash at the join
            # (reproduced 2026-09-16: 17 pure-black frames at a clip's tail).
            #
            # Bounded by the clip's own length, and the overlay stops drawing it
            # at its end anyway, so the padding can never reach the next shot.
            steps.append(f"tpad=stop_mode=clone:stop_duration={length_s:.6f}")
            chain = f"[{video_source}]" + ",".join(steps) + _colour_filters(clip.filters)
            if not clip.alpha:
                chain += ",format=yuva420p"

            transition = clip.transition
            if transition and transition.frames > 0:
                head = transition.frames / fps
                if transition.type == "dissolve":
                    chain += f",fade=t=in:st=0:d={head:.4f}:alpha=1"
                else:
                    colour = "white" if transition.type == "dip" else "black"
                    chain += f",fade=t=in:st=0:d={head:.4f}:color={colour}"
            if clip.fade_in > 0:
                chain += f",fade=t=in:st=0:d={clip.fade_in / fps:.4f}:alpha=1"
            if clip.fade_out > 0:
                chain += (f",fade=t=out:st={max(0.0, length_s - clip.fade_out / fps):.4f}"
                          f":d={clip.fade_out / fps:.4f}:alpha=1")
            tail = tails.get(position)
            if tail:
                colour, frames = tail
                chain += (f",fade=t=out:st={max(0.0, length_s - frames / fps):.4f}"
                          f":d={frames / fps:.4f}:color={colour}")

            label = f"v{position}"
            start_s = clip.start / fps
            chain += f",setpts=PTS+{start_s:.6f}/TB[{label}]"
            chains.append(chain)
            video_labels.append((label, start_s, start_s + length_s))

        # A still has no sound, and a generated shot often has no audio stream at
        # all — asking for one that is not there fails the entire graph.
        if not clip.muted and clip.kind != "image" and info.get("has_audio"):
            asteps = ["asetpts=PTS-STARTPTS"]
            if video_offset > 0.0005:
                # The input was read that much longer for the picture's sake.
                asteps.append(f"atrim=duration={source_seconds:.6f}")
            if abs(speed - 1.0) > 0.001:
                asteps.append(_atempo_chain(speed))
            asteps.append("aresample=48000")
            if abs(clip.volume - 1.0) > 0.001:
                asteps.append(f"volume={clip.volume:.4f}")
            # The automatic seam rule: these head frames are the previous shot's, so this clip's
            # own sound is not used there. From frame 0 afade "in" holds silence until its start
            # time; inside the clip a gate with 8 ms ramps either side keeps the edges click-free.
            # Either way the sound comes back on the usual 8 ms ramp.
            head_silenced = False
            mute = clip.seam_mute if clip.seam_mute and len(clip.seam_mute) == 2 else None
            if mute and 0 <= mute[0] < mute[1]:
                gate_from, gate_to = mute[0] / fps, mute[1] / fps
                if mute[0] == 0:
                    asteps.append(f"afade=t=in:st={gate_to:.4f}:d={_SEAM_FADE_S}")
                    head_silenced = True
                else:
                    half = _SEAM_FADE_S / 2
                    asteps.append(
                        f"volume='1-clip(min((t-{gate_from - half:.4f})/{_SEAM_FADE_S}"
                        f",({gate_to + half:.4f}-t)/{_SEAM_FADE_S}),0,1)':eval=frame")
            if clip.fade_in > 0:
                asteps.append(f"afade=t=in:st=0:d={clip.fade_in / fps:.4f}")
            elif head_silenced:
                pass
            elif seams.get(id(clip), (True, True))[0]:
                asteps.append(f"afade=t=in:st=0:d={_SEAM_FADE_S}")
            if clip.fade_out > 0:
                asteps.append(f"afade=t=out:st={max(0.0, length_s - clip.fade_out / fps):.4f}"
                              f":d={clip.fade_out / fps:.4f}")
            elif seams.get(id(clip), (True, True))[1]:
                # Cut the sound at the clip's own end first, so the fade lands on
                # the cut and not wherever the source happened to run out.
                asteps.append(f"atrim=duration={length_s:.6f}")
                asteps.append(f"afade=t=out:st={max(0.0, length_s - _SEAM_FADE_S):.4f}:d={_SEAM_FADE_S}")
            delay_ms = int(round(clip.start / fps * 1000))
            asteps.append(f"adelay={delay_ms}|{delay_ms}")
            label = f"a{position}"
            chains.append(f"[{index}:a]" + ",".join(asteps) + f"[{label}]")
            audio_labels.append(label)

    current = "0:v"
    # Half-open [start, end) on the frame grid. between() is closed at both ends,
    # so a clip on an upper track was still drawn on the frame where the next shot
    # starts -- its held last frame covered the incoming shot's first one.
    half = 0.5 / out_fps
    for order, (label, start_s, end_s) in enumerate(video_labels):
        out_label = f"o{order}"
        chains.append(
            f"[{current}][{label}]overlay=0:0:eof_action=pass"
            f":enable='gte(t,{start_s - half:.6f})*lt(t,{end_s - half:.6f})'[{out_label}]"
        )
        current = out_label
    chains.append(f"[{current}]format=yuv420p,trim=duration={total:.4f},setpts=PTS-STARTPTS[vout]")

    if audio_labels:
        mixed = "".join(f"[{a}]" for a in audio_labels)
        chains.append(f"{mixed}amix=inputs={len(audio_labels)}:normalize=0:dropout_transition=0,"
                      f"atrim=duration={total:.4f},asetpts=PTS-STARTPTS,aresample=48000[aout]")
    else:
        chains.append(f"anullsrc=r=48000:cl=stereo,atrim=duration={total:.4f}[aout]")

    return inputs, ";\n".join(chains), total


async def _run_export(job_id: str, req: TimelineExportRequest,
                      sources: list[tuple[Path, dict]]) -> None:
    job = _EXPORT_JOBS[job_id]
    out_name = f"cut_{job_id}.wav" if req.audio_only else f"cut_{job_id}.mp4"
    out_path = UPLOAD_DIR / EXPORT_DOWNLOAD_DIR / out_name if req.download else UPLOAD_DIR / out_name
    if req.download:
        out_path.parent.mkdir(parents=True, exist_ok=True)
    script_path = UPLOAD_DIR / f"export_{job_id}.filter"

    async with _EXPORT_LOCK:
        try:
            job["status"] = "running"
            inputs, graph, total = await asyncio.to_thread(_build_export_graph, req, sources)
            if sum(len(arg) + 1 for arg in inputs) > _EXPORT_CMD_LIMIT:
                # Hundreds of subtitle pictures would pass the command-line cap (WinError 206): they
                # go into the graph file as source filters instead.
                inputs, graph, total = await asyncio.to_thread(
                    lambda: _build_export_graph(req, sources, stills_in_graph=True))
            if req.audio_only:
                # The graph still renders its picture chain; an unmapped filter
                # output is an ffmpeg error, so sink it rather than rebuild the graph.
                graph += ";[vout]nullsink"
            # Windows caps a command line at ~32k characters and a dozen clips run
            # straight past it, so the graph is passed as a file.
            script_path.write_text(graph, encoding="utf-8")

            if req.audio_only:
                cmd = ["ffmpeg", "-y", "-v", "error", "-nostats", "-progress", "pipe:1",
                       *inputs,
                       "-filter_complex_script", str(script_path),
                       "-map", "[aout]", "-vn",
                       "-c:a", "pcm_s16le", "-ar", "48000", str(out_path)]
            else:
                cmd = ["ffmpeg", "-y", "-v", "error", "-nostats", "-progress", "pipe:1",
                       *inputs,
                       "-filter_complex_script", str(script_path),
                       "-map", "[vout]", "-map", "[aout]",
                       "-c:v", "libx264", "-crf", "17", "-preset", "medium", "-pix_fmt", "yuv420p",
                       "-r", f"{req.out_fps or req.fps:g}", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
                       "-movflags", "+faststart", str(out_path)]

            process = await asyncio.create_subprocess_exec(
                *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)

            # ffmpeg reports its own position, so the progress bar is real. For a
            # video export it is the encoded frame count: out_time follows the
            # furthest stream, and the audio reaches the end in seconds while the
            # picture is still encoding, which pinned the bar at 99%.
            assert process.stdout is not None
            total_frames = max(1.0, total * (req.out_fps or req.fps))
            async for raw in process.stdout:
                line = raw.decode("utf-8", "ignore").strip()
                if not req.audio_only:
                    if line.startswith("frame="):
                        try:
                            frames = int(line.split("=", 1)[1])
                        except ValueError:
                            continue
                        job["progress"] = round(min(0.99, frames / total_frames), 3)
                    continue
                if line.startswith(("out_time_us=", "out_time_ms=")):
                    try:
                        micros = int(line.split("=", 1)[1])
                    except ValueError:
                        continue
                    if line.startswith("out_time_ms="):
                        micros *= 1000
                    job["progress"] = round(min(0.99, micros / 1_000_000 / max(total, 0.001)), 3)

            stderr = (await process.stderr.read()).decode("utf-8", "ignore") if process.stderr else ""
            await process.wait()
            if process.returncode != 0:
                raise RuntimeError(stderr.strip()[-800:] or f"ffmpeg exited {process.returncode}")

            job["progress"] = 1.0
            job["status"] = "completed"
            job["video_url"] = (f"/uploads/{EXPORT_DOWNLOAD_DIR}/{out_name}" if req.download
                                else f"/uploads/{out_name}")
        except Exception as exc:
            logger.warning("Timeline export %s failed: %s", job_id, exc)
            job["status"] = "failed"
            job["error"] = str(exc)
        finally:
            job["finished_at"] = datetime.now(timezone.utc).isoformat()
            script_path.unlink(missing_ok=True)
            # The subtitle overlays were drawn for this render only; the next
            # export draws its own.
            for track in req.tracks:
                for clip in track.clips:
                    name = Path(urlparse(clip.url).path).name
                    if name.startswith(TITLE_RENDER_PREFIX):
                        (UPLOAD_DIR / name).unlink(missing_ok=True)


def _probe_has_audio(path: Path) -> dict:
    """Whether a file carries sound, read from its header alone.

    The export graph needs nothing else. `_probe_media` counts frames by decoding
    the whole file, which cost 12 s on a two-minute clip before a job even
    existed -- every export and transcription sat at 0% for that long.
    """
    completed = subprocess.run(
        [os.environ.get("FFPROBE", "ffprobe"), "-v", "error",
         "-show_entries", "stream=codec_type,start_time", "-of", "json", str(path)],
        capture_output=True, text=True, timeout=30, check=True,
    )
    streams = json.loads(completed.stdout).get("streams") or []

    def start(kind: str) -> Optional[float]:
        values = []
        for s in streams:
            if s.get("codec_type") == kind:
                try:
                    values.append(float(s.get("start_time")))
                except (TypeError, ValueError):
                    pass
        return min(values) if values else None

    # A fragmented mp4 (the MSE preview fragments, and files cut from them) has
    # no edit list, so B-frame reordering starts its picture at 2/fps while its
    # sound starts at 0. -ss seeks by the file's clock, so a clip trimmed into
    # such a file came out two frames early and one frame late at the join,
    # against a monitor that shows the picture from its first frame.
    video, audio = start("video"), start("audio")
    offset = 0.0
    if video is not None:
        offset = max(0.0, video - min(video, audio if audio is not None else video))
    # A wav reports no start_time at all; its sound is still there.
    has_audio = any(s.get("codec_type") == "audio" for s in streams)
    return {"has_audio": has_audio, "video_offset": offset}


async def _export_sources(req: TimelineExportRequest) -> list[tuple[Path, dict]]:
    """Every clip's file and whether it has sound, in clip order; probed in parallel, once per file."""
    clips = [clip for track in req.tracks for clip in track.clips]
    paths: list[Path] = []
    for clip in clips:
        try:
            paths.append(await resolve_upload(clip.url))
        except FileNotFoundError as exc:
            raise HTTPException(400, f"Missing media: {clip.url}") from exc

    async def probe(path: Path) -> dict:
        try:
            return await asyncio.to_thread(_probe_has_audio, path)
        except (subprocess.SubprocessError, ValueError, KeyError, json.JSONDecodeError):
            return {"has_audio": False}

    unique = list(dict.fromkeys(paths))
    infos = dict(zip(unique, await asyncio.gather(*(probe(p) for p in unique))))
    return [(path, infos[path]) for path in paths]


EXPORT_DOWNLOAD_DIR = "exports"


@app.post("/timeline/export")
async def export_timeline(req: TimelineExportRequest):
    """Render a timeline — every track, transition, fade and colour move — to one mp4."""
    clip_count = sum(len(t.clips) for t in req.tracks)
    if clip_count == 0:
        raise HTTPException(400, "Nothing to export: the timeline is empty.")

    # Resolve every source up front, so a missing shot fails the request instead
    # of a job that has already reported progress.
    sources = await _export_sources(req)

    job_id = uuid.uuid4().hex[:12]
    _EXPORT_JOBS[job_id] = {
        "id": job_id, "type": "timeline_export", "status": "queued",
        "progress": 0.0, "clips": clip_count,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    asyncio.create_task(_run_export(job_id, req, sources))
    return {"job_id": job_id, "status": "queued"}


# The backend's own interpreter: faster-whisper is in requirements.txt.
_TRANSCRIBE_PYTHON = os.environ.get("WHISPER_PYTHON", sys.executable)
_TRANSCRIBE_MODEL = os.environ.get("WHISPER_MODEL", "large-v3")
_TRANSCRIBE_PROCESSES: dict[str, asyncio.subprocess.Process] = {}
# One Whisper at a time. Each large-v3 worker holds 2-3 GB of VRAM on the card
# ComfyUI renders on; seven started together (2026-09-28) pushed a running H3
# job out into shared memory. The rest wait in stage "waiting".
_TRANSCRIBE_SLOT = asyncio.Semaphore(1)




async def _reference_voice(clip: ExportClip) -> Optional[str]:
    """The recorded voice an H3 clip re-performs, when its sound is a copy of one.

    H3 re-synthesises even a fully_copy reference through its audio VAE and the
    words come out slurred: on a monologue over a score (2026-09-22) Whisper got
    the reference line almost word for word and the render's only in fragments.
    The reference is used only when the embedded graph makes the timing
    certain: exactly one reference audio, copied from 00:00.000, and no motion
    context carried in (a chained segment's sound starts on the previous one's).
    """
    if clip.kind != "video" or clip.muted:
        return None
    try:
        path = await resolve_upload(clip.url)
    except FileNotFoundError:
        return None
    graph = await asyncio.to_thread(provenance.read_embedded_graph, path)
    if not graph:
        return None
    record = provenance.describe_generation(graph)
    refs = record.get("reference_audios") or []
    prompt = record.get("prompt") or ""
    if len(refs) != 1 or "fully_copy" not in prompt or "00:00.000" not in prompt:
        return None
    # Every motion-context node but the one that saves this clip's own latent.
    if any(("MotionContext" in c or "MaskedContext" in c) and "SaveLatent" not in c
           for c in (str(n.get("class_type", "")) for n in graph.values() if isinstance(n, dict))):
        return None
    try:
        await resolve_upload(refs[0])
    except FileNotFoundError:
        return None
    return refs[0]


async def _with_reference_voices(req: TimelineExportRequest) -> TimelineExportRequest:
    """Swap each H3 clip's sound for the reference voice it copied (see _reference_voice)."""
    tracks, voices = [], []
    for track in req.tracks:
        clips = []
        for clip in track.clips:
            ref = await _reference_voice(clip) if track.kind == "video" else None
            if ref:
                logger.info("Transcribing %s from its reference voice %s", clip.url, ref)
                # On a track of its own: a video track would run it through the
                # picture filters. Same place, trim and speed as the clip.
                voices.append(clip.model_copy(update={"url": ref, "kind": "audio"}))
                clip = clip.model_copy(update={"muted": True})
            clips.append(clip)
        tracks.append(track.model_copy(update={"clips": clips}))
    if voices:
        tracks.append(ExportTrack(kind="audio", clips=voices))
    return req.model_copy(update={"tracks": tracks})


class SubtitleTranslateRequest(BaseModel):
    lines: list[str] = Field(min_length=1, max_length=subtitle_translate.MAX_BATCH)
    source_lang: str = "en"
    target_lang: str = "zh"


@app.post("/subtitles/translate")
async def translate_subtitles(req: SubtitleTranslateRequest):
    """One batch of consecutive subtitle lines translated by the Qwen3-VL text encoder (greedy). The
    answer has one entry per line; a line the model skipped comes back '' so the caller leaves it untranslated."""
    prompt = subtitle_translate.build_prompt(req.lines, req.source_lang, req.target_lang)
    try:
        text = await comfyui.generate_text(prompt, subtitle_translate.max_tokens(req.lines))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Translation failed: {exc}")
    return {"lines": subtitle_translate.restore_breaks(req.lines, subtitle_translate.parse_numbered(text, len(req.lines)))}


@app.post("/timeline/transcribe")
async def transcribe_timeline(req: TimelineExportRequest):
    """Mix the timeline's sound as the export would, then transcribe it into timed sentences.

    Polled through /timeline/export/{job_id}; a finished job carries `segments`
    (seconds on the timeline) and the detected `language`.
    """
    req = req.model_copy(update={"audio_only": True})
    req = await _with_reference_voices(req)
    sources = await _export_sources(req)
    if not any(info.get("has_audio") or clip.kind == "audio"
               for (_, info), clip in zip(sources, (c for t in req.tracks for c in t.clips))):
        raise HTTPException(400, "Nothing to transcribe: no clip on the timeline has sound.")

    job_id = uuid.uuid4().hex[:12]
    _EXPORT_JOBS[job_id] = {
        "id": job_id, "type": "timeline_transcribe", "status": "queued", "progress": 0.0,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }

    async def run() -> None:
        job = _EXPORT_JOBS[job_id]
        mix_id = f"{job_id}_mix"
        mix = {"id": mix_id, "status": "queued", "progress": 0.0}
        _EXPORT_JOBS[mix_id] = mix

        async def follow_mix() -> None:
            # Mixing is the first fifth of the bar.
            while mix["status"] in ("queued", "running"):
                job["progress"] = round(0.2 * mix.get("progress", 0.0), 3)
                await asyncio.sleep(0.5)

        wav: Optional[Path] = None
        slot_held = False
        try:
            job["status"] = "running"
            job["stage"] = "mixing"
            follower = asyncio.create_task(follow_mix())
            await _run_export(mix_id, req, sources)
            follower.cancel()
            _EXPORT_JOBS.pop(mix_id, None)
            if mix.get("video_url"):
                wav = UPLOAD_DIR / Path(mix["video_url"]).name
            if job.get("status") == "cancelled":
                return
            if mix.get("status") != "completed" or wav is None:
                raise RuntimeError(mix.get("error") or "mixing the timeline's sound failed")

            job["progress"] = 0.2
            job["stage"] = "waiting"
            await _TRANSCRIBE_SLOT.acquire()
            slot_held = True
            if job.get("status") == "cancelled":
                return
            job["stage"] = "transcribing"
            process = await asyncio.create_subprocess_exec(
                _TRANSCRIBE_PYTHON, str(_BACKEND_DIR / "transcribe_worker.py"), str(wav),
                "--model", _TRANSCRIBE_MODEL,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            _TRANSCRIBE_PROCESSES[job_id] = process

            errors: list[str] = []

            async def read_stderr() -> None:
                assert process.stderr is not None
                async for raw in process.stderr:
                    line = raw.decode("utf-8", "ignore").strip()
                    if line.startswith("progress "):
                        try:
                            job["progress"] = round(0.2 + 0.8 * min(0.99, float(line.split()[1])), 3)
                        except ValueError:
                            pass
                    elif line:
                        errors.append(line)

            assert process.stdout is not None
            stdout, _ = await asyncio.gather(process.stdout.read(), read_stderr())
            await process.wait()
            _TRANSCRIBE_SLOT.release()
            slot_held = False
            if job.get("status") == "cancelled":
                return
            if process.returncode != 0:
                tail = "\n".join(errors)[-800:]
                raise RuntimeError(tail or f"transcriber exited {process.returncode}")
            result = json.loads(stdout.decode("utf-8"))
            job.update(segments=result["segments"], language=result.get("language"),
                       device=result.get("device"), progress=1.0, status="completed")
        except Exception as exc:
            if job.get("status") != "cancelled":
                logger.warning("Timeline transcribe %s failed: %s", job_id, exc)
                job["status"] = "failed"
                job["error"] = str(exc)
        finally:
            if slot_held:
                _TRANSCRIBE_SLOT.release()
            _EXPORT_JOBS.pop(mix_id, None)
            _TRANSCRIBE_PROCESSES.pop(job_id, None)
            if wav is not None:
                wav.unlink(missing_ok=True)
            job["finished_at"] = datetime.now(timezone.utc).isoformat()

    asyncio.create_task(run())
    return {"job_id": job_id, "status": "queued"}


# ── Source media: transcribe a window, cut a line out ─────────────────────────
#
# Voice references come from the source film, which is too large to move
# around. These address a file already on this machine by name, so an agent
# anywhere can find a line's time with Whisper and cut exactly that line.

_MEDIA_TRANSCRIBE_JOBS: dict[str, dict] = {}


def _media_by_name(name: str) -> Path:
    """A file in uploads/ or ComfyUI's output folder, by its bare file name."""
    name = (name or "").strip()
    if not name or Path(name).name != name or name.startswith("."):
        raise HTTPException(400, "Pass a bare file name, e.g. upload_xxx.mp4")
    roots = [UPLOAD_DIR] + ([Path(COMFYUI_OUTPUT_DIR)] if COMFYUI_OUTPUT_DIR else [])
    for root in roots:
        candidate = root / name
        if candidate.is_file():
            return candidate
    raise HTTPException(404, f"No media file named {name} in uploads/ or the ComfyUI output folder")


def _cut_audio(src: Path, out: Path, start: float, end: Optional[float], *,
               rate: int, channels: int, loudnorm: bool = False) -> None:
    command = ["ffmpeg", "-y", "-v", "error", "-ss", f"{max(0.0, start):.3f}"]
    if end is not None:
        command += ["-t", f"{max(0.0, end - start):.3f}"]
    command += ["-i", str(src), "-vn", "-ac", str(channels), "-ar", str(rate)]
    if loudnorm:
        command += ["-af", "loudnorm=I=-16:TP=-1.5:LRA=11"]
    command.append(str(out))
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0 or not out.exists():
        raise HTTPException(500, f"ffmpeg could not cut the audio: {result.stderr.strip()[-400:]}")


class MediaTranscribeRequest(BaseModel):
    name: str
    start: float = 0.0
    end: Optional[float] = None
    language: Optional[str] = None


@app.post("/media/transcribe")
async def transcribe_media(req: MediaTranscribeRequest):
    """Transcribe [start, end) of a media file into timed lines.

    Poll GET /media/transcribe/{job_id}; a finished job carries `segments` with
    times in seconds of the source file (the window offset is added back).
    """
    src = _media_by_name(req.name)
    if req.end is not None and req.end <= req.start:
        raise HTTPException(400, "end must be after start")
    # A caller that timed out and asked again gets the job already under way:
    # MCP clients gave up on a slow window and re-sent it every ~2.5 minutes,
    # and each resend started one more large-v3 worker (2026-09-28).
    for other in _MEDIA_TRANSCRIBE_JOBS.values():
        if (other.get("status") in ("queued", "running") and other.get("name") == req.name
                and other.get("start") == req.start and other.get("end") == req.end
                and other.get("language") == req.language):
            return {"job_id": other["id"], "status": other["status"]}
    job_id = uuid.uuid4().hex[:12]
    job = {"id": job_id, "status": "queued", "progress": 0.0, "name": req.name,
           "start": req.start, "end": req.end, "language": req.language,
           "created_at": datetime.now(timezone.utc).isoformat()}
    _MEDIA_TRANSCRIBE_JOBS[job_id] = job

    async def run() -> None:
        wav = UPLOAD_DIR / f"transcribe_{job_id}.wav"
        slot_held = False
        try:
            job["status"] = "running"
            job["stage"] = "extracting"
            await asyncio.to_thread(_cut_audio, src, wav, req.start, req.end, rate=16000, channels=1)
            job["stage"] = "waiting"
            await _TRANSCRIBE_SLOT.acquire()
            slot_held = True
            job["stage"] = "transcribing"
            args = [_TRANSCRIBE_PYTHON, str(_BACKEND_DIR / "transcribe_worker.py"), str(wav),
                    "--model", _TRANSCRIBE_MODEL]
            if req.language:
                args += ["--language", req.language]
            process = await asyncio.create_subprocess_exec(
                *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            errors: list[str] = []

            async def read_stderr() -> None:
                assert process.stderr is not None
                async for raw in process.stderr:
                    line = raw.decode("utf-8", "ignore").strip()
                    if line.startswith("progress "):
                        try:
                            job["progress"] = round(min(0.99, float(line.split()[1])), 3)
                        except ValueError:
                            pass
                    elif line:
                        errors.append(line)

            assert process.stdout is not None
            stdout, _ = await asyncio.gather(process.stdout.read(), read_stderr())
            await process.wait()
            _TRANSCRIBE_SLOT.release()
            slot_held = False
            if process.returncode != 0:
                raise RuntimeError("\n".join(errors)[-800:] or f"transcriber exited {process.returncode}")
            result = json.loads(stdout.decode("utf-8"))
            offset = req.start
            segments = []
            for seg in result.get("segments", []):
                seg = dict(seg)
                for key in ("start", "end"):
                    if isinstance(seg.get(key), (int, float)):
                        seg[key] = round(seg[key] + offset, 3)
                segments.append(seg)
            job.update(segments=segments, language=result.get("language"),
                       device=result.get("device"), progress=1.0, status="completed")
        except Exception as exc:
            logger.warning("Media transcribe %s failed: %s", job_id, exc)
            job["status"] = "failed"
            job["error"] = str(getattr(exc, "detail", exc))
        finally:
            if slot_held:
                _TRANSCRIBE_SLOT.release()
            wav.unlink(missing_ok=True)
            job["finished_at"] = datetime.now(timezone.utc).isoformat()

    asyncio.create_task(run())
    return {"job_id": job_id, "status": "queued"}


@app.get("/media/transcribe/{job_id}")
async def media_transcribe_status(job_id: str):
    job = _MEDIA_TRANSCRIBE_JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, f"No transcription job with id {job_id}")
    return job


class MediaExtractAudioRequest(BaseModel):
    name: str
    start: float = 0.0
    end: float = 0.0
    # Several lines of one speaker, joined in order into one reference, so a
    # voice reference need not carry the other speakers talking in between.
    # Each item is [start, end]; when given, start/end are ignored.
    segments: Optional[list[list[float]]] = None
    gap: float = 0.3
    out_name: Optional[str] = None
    normalize: bool = True


def _join_audio(parts: list[Path], out: Path, gap: float, loudnorm: bool) -> None:
    command = ["ffmpeg", "-y", "-v", "error"]
    for part in parts:
        command += ["-i", str(part)]
    chains, labels = [], []
    for i in range(len(parts)):
        pad = f",apad=pad_dur={gap:.3f}" if gap > 0 and i < len(parts) - 1 else ""
        chains.append(f"[{i}:a]anull{pad}[a{i}]")
        labels.append(f"[a{i}]")
    graph = ";".join(chains) + ";" + "".join(labels) + f"concat=n={len(parts)}:v=0:a=1"
    if loudnorm:
        graph += ",loudnorm=I=-16:TP=-1.5:LRA=11"
    command += ["-filter_complex", graph + "[out]", "-map", "[out]", "-ar", "48000", "-ac", "2", str(out)]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0 or not out.exists():
        raise HTTPException(500, f"ffmpeg could not join the audio: {result.stderr.strip()[-400:]}")


@app.post("/media/extract-audio")
async def extract_media_audio(req: MediaExtractAudioRequest):
    """Cut [start, end) of a media file's sound into uploads/ as a wav (48 kHz stereo,
    loudness-normalised by default) and return its url."""
    src = _media_by_name(req.name)
    windows = [(float(w[0]), float(w[1])) for w in req.segments] if req.segments else [(req.start, req.end)]
    if any(len(w) != 2 for w in (req.segments or [])):
        raise HTTPException(400, "each segment is [start, end]")
    if any(e <= s for s, e in windows):
        raise HTTPException(400, "end must be after start")
    req.start, req.end = windows[0][0], windows[-1][1]
    stem = re.sub(r"[^A-Za-z0-9_.\-]+", "_", (req.out_name or "").strip()).strip("._")
    if stem.lower().endswith(".wav"):
        stem = stem[:-4]
    stem = stem or f"audio_{Path(req.name).stem}_{req.start:.2f}-{req.end:.2f}"
    out = UPLOAD_DIR / f"{stem}.wav"
    if out.exists():
        raise HTTPException(409, f"{out.name} already exists in uploads/; pick another out_name")
    if len(windows) == 1:
        await asyncio.to_thread(_cut_audio, src, out, req.start, req.end,
                                rate=48000, channels=2, loudnorm=req.normalize)
    else:
        with tempfile.TemporaryDirectory() as tmp:
            parts = [Path(tmp) / f"part{i}.wav" for i in range(len(windows))]
            for part, (s, e) in zip(parts, windows):
                await asyncio.to_thread(_cut_audio, src, part, s, e, rate=48000, channels=2)
            await asyncio.to_thread(_join_audio, parts, out, max(0.0, req.gap), req.normalize)
    duration = sum(e - s for s, e in windows) + max(0.0, req.gap) * (len(windows) - 1)
    return {"url": f"/uploads/{out.name}", "duration": round(duration, 3),
            "source": req.name, "start": req.start, "end": req.end,
            "segments": [[s, e] for s, e in windows]}


def _media_frame(src: Path, t: float, out: Path, width: Optional[int]) -> None:
    command = ["ffmpeg", "-y", "-v", "error", "-ss", f"{max(0.0, t):.3f}", "-i", str(src),
               "-frames:v", "1"]
    if width:
        command += ["-vf", f"scale={int(width)}:-2"]
    if out.suffix == ".jpg":
        command += ["-q:v", "4"]
    command.append(str(out))
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0 or not out.exists() or not out.stat().st_size:
        raise HTTPException(404, f"No frame at {t:.3f}s in {src.name}: {result.stderr.strip()[-300:]}")


@app.get("/media/frame")
async def media_frame(name: str, t: float, width: int = 640):
    """One frame of a media file at t seconds, as a jpeg (for looking, not keeping)."""
    src = _media_by_name(name)
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "frame.jpg"
        await asyncio.to_thread(_media_frame, src, t, out, max(64, min(int(width), 3840)))
        return Response(out.read_bytes(), media_type="image/jpeg")


class MediaStillRequest(BaseModel):
    name: str
    t: float
    out_name: Optional[str] = None


@app.post("/media/still")
async def media_still(req: MediaStillRequest):
    """A full-size frame of a media file at t seconds, saved into uploads/ as a png."""
    src = _media_by_name(req.name)
    stem = re.sub(r"[^A-Za-z0-9_.\-]+", "_", (req.out_name or "").strip()).strip("._")
    if stem.lower().endswith(".png"):
        stem = stem[:-4]
    stem = stem or f"still_{Path(req.name).stem}_{req.t:.3f}s"
    out = UPLOAD_DIR / f"{stem}.png"
    if out.exists():
        raise HTTPException(409, f"{out.name} already exists in uploads/; pick another out_name")
    await asyncio.to_thread(_media_frame, src, req.t, out, None)
    width = height = None
    try:
        probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                                "stream=width,height", "-of", "csv=p=0", str(out)],
                               capture_output=True, text=True)
        if probe.returncode == 0 and "," in probe.stdout:
            width, height = (int(v) for v in probe.stdout.strip().split(",")[:2])
    except (OSError, ValueError):
        pass  # the still is saved; its size is a nicety
    return {"url": f"/uploads/{out.name}", "width": width, "height": height,
            "source": req.name, "t": req.t}


@app.post("/timeline/transcribe/{job_id}/cancel")
async def cancel_transcribe(job_id: str):
    """Stop a transcription. Mixing cannot be interrupted, but its result is thrown away."""
    job = _EXPORT_JOBS.get(job_id)
    if job is None or job.get("type") != "timeline_transcribe":
        raise HTTPException(404, f"No transcription job with id {job_id}")
    if job["status"] in ("completed", "failed", "cancelled"):
        return job
    job["status"] = "cancelled"
    process = _TRANSCRIBE_PROCESSES.get(job_id)
    if process is not None and process.returncode is None:
        process.kill()
    return job


@app.get("/timeline/export/{job_id}")
async def get_export_job(job_id: str):
    job = _EXPORT_JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, f"No export job with id {job_id}")
    return job


# ── Asset library ─────────────────────────────────────────────────────────────
#
# Everything this project has generated, listed with who still uses it. Cleanup
# is a deliberate act here — nothing is deleted on its own — so the library is
# also the only thing standing between a finished shot and a full disk.

_ASSET_KINDS = {
    ".mp4": "video", ".webm": "video", ".mov": "video",
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".gif": "image",
    ".wav": "audio", ".mp3": "audio", ".flac": "audio", ".m4a": "audio", ".aac": "audio", ".ogg": "audio",
    ".latent": "latent", ".safetensors": "latent",
    ".ply": "model", ".glb": "model",
}


def _asset_roots() -> list[tuple[Path, str]]:
    """Directories that hold our output, with the URL prefix each is served under."""
    roots = [(UPLOAD_DIR, "/uploads")]
    if COMFYUI_OUTPUT_DIR:
        roots.append((Path(COMFYUI_OUTPUT_DIR), "/comfy_output"))
    return roots


def _scan_assets() -> dict:
    """
    Every owned file under the asset roots, keyed by basename, with its project
    references and the companion files that must share its fate.

    Ownership matters: the ComfyUI output directory is shared with other work, so
    a file there is only ours if it carries one of this project's prefixes. A
    file we cannot claim is never listed and never deleted.
    """
    references = _collect_references_cached(_BACKEND_DIR / "workspaces")
    origins = asset_origin.load()

    project_names: dict[str, str] = {}
    for meta_path in (_BACKEND_DIR / "workspaces").rglob("meta.json"):
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            project_names[meta_path.parent.name] = meta.get("name") or meta_path.parent.name
        except (OSError, json.JSONDecodeError):
            continue

    files: dict[str, dict] = {}
    for root, url_prefix in _asset_roots():
        if not root.is_dir():
            continue
        owns_everything = root == UPLOAD_DIR
        for path in root.rglob("*"):
            try:
                if not path.is_file():
                    continue
                kind = _ASSET_KINDS.get(path.suffix.lower())
                if kind is None:
                    continue
                if not owns_everything and not path.name.startswith(artifact_pruner.OWNED_PREFIXES):
                    continue
                if path.parent.name == "proxies":
                    continue    # cut-room scrub proxies are derived, not assets
                if path.parent.name == EXPORT_DOWNLOAD_DIR:
                    continue    # finished films handed over for download, not assets
                if path.name.startswith(TITLE_RENDER_PREFIX):
                    continue    # subtitle overlays of an export in progress
                stat = path.stat()
            except OSError:
                continue
            projects = sorted(references.get(path.name, set()))
            origin = origins.get(path.name)
            files[path.name] = {
                # Who made it, as opposed to who still points at it. An asset
                # nobody references any more still came from somewhere, and
                # that is what keeps it out of other projects' libraries.
                "origin_project": origin["project_id"] if origin else None,
                "origin_project_name": (
                    project_names.get(origin["project_id"], origin["project_id"])
                    if origin else None
                ),
                "name": path.name,
                "url": f"{url_prefix}/{path.relative_to(root).as_posix()}",
                "kind": kind,
                "size": stat.st_size,
                "modified": stat.st_mtime,
                "projects": [{"id": pid, "name": project_names.get(pid, pid)} for pid in projects],
                "referenced": bool(projects),
                "path": str(path),
                "_stat": (stat.st_size, stat.st_mtime_ns),
            }

    # Width and height, so a library card can be laid out before its picture loads. What is not known yet
    # (a video nobody probed) is filled in by a background pass and shows up on the next listing.
    dims = asset_dims.lookup([(n, e["kind"], Path(e["path"]), *e["_stat"]) for n, e in files.items()
                              if e["kind"] in ("image", "video")])
    for name, entry in files.items():
        entry.pop("_stat", None)
        if name in dims:
            entry["width"], entry["height"] = dims[name]

    # A clip and its latent are one asset with two files. The latent rides along
    # on the clip's row instead of appearing as a nameless multi-gigabyte orphan.
    for name, entry in files.items():
        companions = [c for c in artifact_pruner.pair_names(name) if c in files and c != name]
        entry["companions"] = companions
        entry["companion_size"] = sum(files[c]["size"] for c in companions)
    owned_companions = {c for e in files.values() for c in e["companions"]
                        if files[c]["kind"] == "latent"}
    for name in owned_companions:
        files[name]["companion_of"] = next(
            n for n, e in files.items() if name in e["companions"] and e["kind"] != "latent"
        )
    return files


def _accessible_project_ids(caller: Optional[str], workspace: str = "default") -> Optional[set]:
    """Project ids this caller may see, or None when the caller is not scoped.

    None means "no filtering" -- a request with no token, which is how the
    canvas MCP server and the tools under tools/ reach the backend.
    """
    if caller is None:
        return None
    allowed = set()
    ws_dir = _ws_projects_dir(workspace)
    if ws_dir.is_dir():
        for d in ws_dir.iterdir():
            if not d.is_dir():
                continue
            meta = _read_meta(d)
            if meta and _may_access(meta, caller):
                allowed.add(meta.get("id", d.name))
    return allowed


@app.get("/assets")
async def list_assets(project: Optional[str] = None, unused_only: bool = False,
                      all_projects: bool = False,
                      authorization: Optional[str] = _Header(None)):
    """
    List generated assets, newest first, with the projects that reference them.

    `project` narrows the list to that project's assets: the ones it references,
    the ones it made (see `asset_origin`), and the ones whose origin nobody
    recorded. That last group is the residue — everything on disk from before
    the ledger existed, plus anything dropped in by hand — and it stays visible
    everywhere because an unattributable file that no project references is
    exactly what cleanup is for, and hiding it would hide the point of it.

    `all_projects` drops the narrowing entirely, for a cleanup pass that wants
    to see the whole disk from wherever it is standing.
    """
    try:
        files = await asyncio.to_thread(_scan_assets)
    except RuntimeError as exc:
        # An unreadable canvas means unknown references; listing them as unused
        # would invite deleting live files.
        raise HTTPException(503, f"Cannot determine references: {exc}") from exc

    # A latent is never an asset in its own right -- it is the clip's refine data,
    # and it rides on the clip's row. One whose clip is gone (or which predates the
    # shared pair tag) is an orphan: still counted and still cleanable, but not a
    # card of its own, because there is nothing to look at and nothing to keep.
    orphan_latents = [a for a in files.values()
                      if a["kind"] == "latent" and "companion_of" not in a]
    assets = [a for a in files.values()
              if "companion_of" not in a and a["kind"] != "latent"]
    # Another account's project must not be nameable from here, and its renders
    # must not be listed. An unattributable file stays visible to everyone --
    # see this function's docstring for why.
    allowed = _accessible_project_ids(_caller_user_id(authorization))
    is_admin = _caller_is_admin(authorization)
    if allowed is not None:
        def visible_to_caller(asset: dict) -> bool:
            asset["projects"] = [p for p in asset["projects"] if p["id"] in allowed]
            if asset["origin_project"] and asset["origin_project"] not in allowed:
                asset["origin_project"] = None
                asset["origin_project_name"] = None
                return False
            asset["referenced"] = bool(asset["projects"])
            # Everything on disk from before the origin ledger, plus anything
            # dropped in by hand, belongs to no project. Cleaning it up is the
            # admin's job; for anyone else it would be a window onto another
            # person's renders.
            if not asset["origin_project"] and not asset["referenced"]:
                return is_admin
            return True

        assets = [a for a in assets if visible_to_caller(a)]
        orphan_latents = [a for a in orphan_latents if visible_to_caller(a)]

    if project and not all_projects:
        def belongs(asset: dict) -> bool:
            if any(p["id"] == project for p in asset["projects"]):
                return True
            if asset["origin_project"]:
                return asset["origin_project"] == project
            return not asset["referenced"]
        assets = [a for a in assets if belongs(a)]
    if unused_only:
        assets = [a for a in assets if not a["referenced"]]
    assets.sort(key=lambda a: a["modified"], reverse=True)

    unused = [a for a in assets if not a["referenced"]]
    orphans = [a for a in orphan_latents if not a["referenced"]]
    return {
        "assets": assets,
        "total_bytes": sum(a["size"] + a["companion_size"] for a in assets)
                       + sum(a["size"] for a in orphan_latents),
        "unused_count": len(unused) + len(orphans),
        "unused_bytes": sum(a["size"] + a["companion_size"] for a in unused)
                        + sum(a["size"] for a in orphans),
        # Reported separately so the header can say why the cleanup frees more
        # than the visible cards add up to.
        "orphan_latent_count": len(orphans),
        "orphan_latent_bytes": sum(a["size"] for a in orphans),
    }


class AssetDeleteRequest(BaseModel):
    names: list[str] = []
    # Delete every unreferenced asset instead of a named selection.
    unused: bool = False
    # Delete only this project's own files: named files that were made in another project, that another
    # project references, or whose owner nobody recorded and nobody references come back as skipped.
    project: Optional[str] = None


def _belongs_to_project_only(entry: dict, project: str) -> bool:
    """A file that is this project's and nobody else's: made here, or (no record of where it was made)
    referenced here and by no other project."""
    referencing = {p["id"] for p in entry.get("projects") or []}
    if referencing - {project}:
        return False
    origin = entry.get("origin_project")
    if origin:
        return origin == project
    return project in referencing


def _delete_assets(names: list[str], unused: bool, project: Optional[str] = None) -> dict:
    files = _scan_assets()
    if unused:
        # Orphan latents are in scope here and only here: they have no card, so a
        # cleanup is the only thing that can ever reclaim them.
        targets = [n for n, a in files.items() if "companion_of" not in a and not a["referenced"]]
    else:
        # A latent named on its own is deleted on its own; naming a clip takes
        # its latent with it.
        targets = [n for n in names if n in files]

    deleted, freed, skipped = [], 0, [n for n in names if n not in files]
    if project:
        foreign = [n for n in targets if not _belongs_to_project_only(files[n], project)]
        skipped += foreign
        targets = [n for n in targets if n not in foreign]
    for name in targets:
        entry = files[name]
        for victim in [name, *entry["companions"]]:
            record = files.get(victim)
            if not record:
                continue
            try:
                size = Path(record["path"]).stat().st_size
                Path(record["path"]).unlink()
                deleted.append(victim)
                freed += size
            except OSError as exc:
                logger.warning("asset delete: could not remove %s: %s", victim, exc)
                skipped.append(victim)
    return {"deleted": deleted, "freed_bytes": freed, "skipped": skipped}


@app.get("/assets/{name}/provenance")
async def asset_provenance(name: str):
    """
    How this clip was generated, read back out of the clip itself.

    The reason to have it: the H3 refine pass reads the source shot's reference
    images for texture, and on the canvas those ride along in the producing
    node's `submittedResources`. A clip whose node is long gone has none, so
    upscaling it lands on different micro-detail than the take that was
    approved. ComfyUI embedded the whole executed graph in the file, and this
    is the only surviving copy — the job history keeps result URLs only, and the
    paired latent's header carries nothing but a format tag.

    `found: false` is a normal answer: hand-uploaded footage and anything made
    before the graph was embedded carries no history, and inventing one is worse
    than saying so.
    """
    files = await asyncio.to_thread(_scan_assets)
    entry = files.get(name)
    if entry is None:
        raise HTTPException(404, f"No such asset: {name}")

    record = await asyncio.to_thread(provenance.describe_media, Path(entry["path"]))
    if record is None:
        return {"found": False, "name": name}

    # The latent is the other half of the take, and the refine pass needs it by
    # name. It is paired by filename, so it survives its node too.
    latent = next(
        (c for c in entry["companions"] if files.get(c, {}).get("kind") == "latent"),
        None,
    )
    return {"found": True, "name": name, "latent_filename": latent, **record}


@app.get("/media/adopt-record")
async def media_adopt_record(url: str):
    """
    The embedded ComfyUI record of a clip on this machine, for the canvas MCP's
    adopt_render. The MCP used to open the file itself, which only worked when it
    ran on this box; asking here lets an MCP on another Tailscale machine adopt too.

    Only /uploads and ComfyUI output are looked at -- never an external download.
    """
    path_part = urlparse(url).path if ("://" in url or url.startswith("/")) else url
    from urllib.parse import unquote as _unquote
    path_part = _unquote(path_part)
    name = Path(path_part).name
    out_dir = Path(COMFYUI_OUTPUT_DIR) if COMFYUI_OUTPUT_DIR else None
    if "/uploads/" in path_part or path_part.startswith("/uploads/"):
        candidates = [UPLOAD_DIR / name]
    elif "/comfy_output/" in path_part and out_dir:
        candidates = [out_dir / path_part.split("/comfy_output/", 1)[1]]
    else:
        candidates = [c for c in ((out_dir / name) if out_dir else None, UPLOAD_DIR / name) if c]
    path = None
    for cand in candidates:
        try:
            resolved = cand.resolve()
            root = UPLOAD_DIR.resolve() if resolved.is_relative_to(UPLOAD_DIR.resolve()) else (out_dir.resolve() if out_dir else None)
            if root and resolved.is_relative_to(root) and resolved.is_file():
                path = resolved
                break
        except OSError:
            continue
    if path is None:
        raise HTTPException(404, f"No file for {url!r} under uploads or ComfyUI output.")

    record = await asyncio.to_thread(provenance.describe_media, path)
    if not record:
        return {"found": False, "name": path.name}

    if url.startswith("/") or "://" in url:
        served_url = url
    elif path.parent == UPLOAD_DIR.resolve():
        served_url = f"/uploads/{path.name}"
    else:
        served_url = f"/comfy_output/{path.relative_to(out_dir.resolve()).as_posix()}"

    # The latent is written beside the clip under the same hash, with the kind
    # swapped for "Latent": H3_Video_<hash> and H3_Chunk_<hash> both pair with
    # H3_Latent_<hash>. Matching only "H3_Video_" silently dropped the latent of
    # every adopted chain segment, which is exactly what motion context needs.
    latent = None
    kind = re.match(r"^(H3_[A-Za-z0-9]+_)(.*)$", path.stem)
    if kind:
        for suffix in (".safetensors", ".latent"):
            cand = path.with_name("H3_Latent_" + kind.group(2) + suffix)
            if cand.is_file():
                latent = cand.name
                break

    # ComfyUI's input dir is fed from uploads by name: a reference that exists
    # there has a canvas URL; otherwise the bare name is all the graph recorded.
    names = [record.get("first_frame"), record.get("last_frame"),
             *(record.get("reference_images") or []), *(record.get("reference_videos") or []),
             *(record.get("reference_audios") or [])]
    reference_urls = {n: (f"/uploads/{n}" if (UPLOAD_DIR / n).is_file() else n) for n in names if n}

    return {
        "found": True,
        "name": path.name,
        "served_url": served_url,
        "mtime_ms": int(path.stat().st_mtime * 1000),
        "latent_filename": latent,
        "reference_urls": reference_urls,
        "record": record,
    }


class AssetReplaceRequest(BaseModel):
    """Put a freshly rendered file in an existing asset's place, under its name."""
    target: str
    source_url: str


def _replace_asset(target: str, source: Path) -> dict:
    files = _scan_assets()
    entry = files.get(target)
    if entry is None:
        raise FileNotFoundError(f"No such asset: {target}")

    destination = Path(entry["path"])
    still_suffixes = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff"}
    if destination.suffix.lower() in still_suffixes and source.suffix.lower() not in still_suffixes:
        # The cut room renders everything as a clip. A still written back as the
        # clip's bytes under a .png name is a file no image node can read, so
        # frame 0 of the render (grade and crop baked in) becomes the picture.
        frame = destination.with_name(destination.stem + ".tmp" + destination.suffix)
        completed = subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(source), "-frames:v", "1", "-update", "1", str(frame)],
            capture_output=True, text=True, timeout=120,
        )
        if completed.returncode != 0 or not frame.exists():
            frame.unlink(missing_ok=True)
            raise OSError(f"could not take a still from the render: {completed.stderr.strip()[-200:]}")
        os.replace(frame, destination)
        source.unlink(missing_ok=True)
    # os.replace is atomic within a volume; a copy would leave a half-written
    # clip behind if the disk filled up mid-write.
    elif source.parent != destination.parent:
        shutil.copy2(source, destination.with_suffix(destination.suffix + ".tmp"))
        os.replace(destination.with_suffix(destination.suffix + ".tmp"), destination)
        source.unlink(missing_ok=True)
    else:
        os.replace(source, destination)

    # The latent described the take that used to be here. Keeping it would let a
    # later refine pass restore footage the user just cut away.
    dropped = []
    for companion in entry["companions"]:
        record = files.get(companion)
        if not record or record["kind"] != "latent":
            continue
        try:
            Path(record["path"]).unlink()
            dropped.append(companion)
        except OSError as exc:
            logger.warning("replace: could not drop stale latent %s: %s", companion, exc)
    return {"target": target, "url": entry["url"], "dropped_latents": dropped,
            "size": destination.stat().st_size}


@app.post("/assets/replace")
async def replace_asset(req: AssetReplaceRequest):
    """
    Overwrite one asset with another file, keeping its name and URL.

    That is what makes "trim this clip in place" work: every canvas node and
    timeline that points at the old URL now shows the trimmed cut, with no
    reference to repair. The take's latent is dropped, because it no longer
    describes the file that is there.
    """
    try:
        source = await resolve_upload(req.source_url)
    except FileNotFoundError as exc:
        raise HTTPException(400, f"Missing source: {req.source_url}") from exc
    try:
        result = await asyncio.to_thread(_replace_asset, req.target, source)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    except OSError as exc:
        # On Windows a file still open in a player cannot be replaced.
        raise HTTPException(409, f"Could not replace {req.target}: {exc}") from exc
    logger.info("asset library: replaced %s (%.1f MiB)", req.target, result["size"] / 2 ** 20)
    return {"status": "ok", **result}


@app.post("/assets/delete")
async def delete_assets(req: AssetDeleteRequest):
    """
    Delete assets by name, or every unused one at once.

    Deleting a clip deletes its latent too — they are the same take, and a latent
    left behind is the single largest kind of dead weight this project produces.
    A referenced asset is deleted when it is named explicitly: the library shows
    what uses it, and the call is the user's to make.
    """
    if not req.names and not req.unused:
        raise HTTPException(400, "Nothing to delete: name some assets or ask for the unused ones.")
    try:
        result = await asyncio.to_thread(_delete_assets, req.names, req.unused, req.project)
    except RuntimeError as exc:
        raise HTTPException(503, f"Cannot determine references: {exc}") from exc
    logger.info("asset library: deleted %d files (%.2f GiB)",
                len(result["deleted"]), result["freed_bytes"] / 2 ** 30)
    return {"status": "ok", **result}


# ── Take history cleanup ──────────────────────────────────────────────────────
# A node's superseded takes hold files nothing else uses; see take_history.py.

_HISTORY_AGENT = "asset-library"


def _media_roots() -> list[Path]:
    return [root for root, _ in _asset_roots()]


def _history_summary(result: dict) -> dict:
    roots = _media_roots()
    companions = [n for n in result["companions"] if take_history.locate(n, roots)]
    return {
        **{k: v for k, v in result.items() if k != "companions"},
        "companions": companions,
        "other_project_names": [
            (_read_meta(_project_dir(pid)) or {}).get("name") or pid for pid in result["other_projects"]
        ],
        "take_count": sum(len(e["take_indexes"]) for e in result["nodes"]),
        "bytes": take_history.sizes(result["files"] + companions, roots),
    }


@app.get("/projects/{project_id}/take-history")
async def plan_take_history(project_id: str, authorization: Optional[str] = _Header(None)):
    """What cleaning this project's node history would remove. Changes nothing."""
    _require_access(_project_dir(project_id), _caller_user_id(authorization), project_id)
    try:
        result = await asyncio.to_thread(take_history.plan, WORKSPACES_DIR, project_id)
    except RuntimeError as exc:
        raise HTTPException(503, f"Cannot determine references: {exc}") from exc
    return _history_summary(result)


@app.post("/projects/{project_id}/take-history/clean")
async def clean_take_history(project_id: str, authorization: Optional[str] = _Header(None)):
    """Remove superseded takes held by nothing else: their entries on every canvas, then the files.

    Every project whose canvas changes is locked for the duration, so a studio
    auto-save cannot write the old takes back; open studios then pick up the
    new revision on their next poll.
    """
    _require_access(_project_dir(project_id), _caller_user_id(authorization), project_id)
    try:
        preview = await asyncio.to_thread(take_history.plan, WORKSPACES_DIR, project_id)
    except RuntimeError as exc:
        raise HTTPException(503, f"Cannot determine references: {exc}") from exc
    # Locks are per scene canvas: every canvas this pass will rewrite, plus the
    # project's first scene, which is the project lock older agents know about.
    projects = {project_id} | {
        pid if scene == MAIN_SCENE else f"{pid}/{scene}"
        for pid, scene in {(e["project_id"], e["scene"]) for e in preview["nodes"]}
    }
    for pid in projects:
        held = _active_lock(pid)
        if held and held["agent"] != _HISTORY_AGENT:
            raise HTTPException(409, detail={"message": "Project is locked by another agent.", "lock": held})
    for pid in projects:
        _CANVAS_LOCKS[pid] = {"agent": _HISTORY_AGENT, "until": time.time() + 120,
                              "reason": "清理节点历史版本", "since": time.time()}
    try:
        roots = _media_roots()
        # Re-planned under the locks: the preview may already be stale.
        result = await asyncio.to_thread(take_history.apply, WORKSPACES_DIR, project_id, roots, _atomic_write_json)
    except RuntimeError as exc:
        raise HTTPException(503, f"Cannot determine references: {exc}") from exc
    finally:
        for pid in projects:
            if (_CANVAS_LOCKS.get(pid) or {}).get("agent") == _HISTORY_AGENT:
                _CANVAS_LOCKS.pop(pid, None)
    logger.info("take history: %s removed %d takes, %d files (%.2f GiB)", project_id,
                sum(len(e["take_indexes"]) for e in result["nodes"]), len(result["deleted"]),
                result["freed_bytes"] / 2 ** 30)
    return {"status": "ok", "deleted": result["deleted"], "freed_bytes": result["freed_bytes"],
            "take_count": sum(len(e["take_indexes"]) for e in result["nodes"]),
            "other_projects": result["other_projects"]}


# ── Legacy project routes (backward compatibility) ─────────────────────────────
# These existed before multi-project support. They now operate on a special
# "legacy" project within the default workspace so old clients continue to work.

_LEGACY_PROJECT_ID = "proj_legacy"

def _ensure_legacy_project():
    proj_dir = _project_dir(_LEGACY_PROJECT_ID)
    if not proj_dir.exists():
        proj_dir.mkdir(parents=True, exist_ok=True)
        now = datetime.now(timezone.utc).isoformat()
        (proj_dir / "meta.json").write_text(json.dumps({
            "id": _LEGACY_PROJECT_ID, "name": "默认项目",
            "owner_user_id": None, "workspace": "default",
            "created_at": now, "updated_at": now,
        }, ensure_ascii=False), encoding="utf-8")
        (proj_dir / "canvas.json").write_text(
            json.dumps({"nodes": [], "edges": [], "viewport": {"x": 0, "y": 0, "zoom": 1}}),
            encoding="utf-8"
        )

    # One-time migration: import any existing flat PROJECTS_DIR json files into the legacy canvas
    old_default = PROJECTS_DIR / "default.json"
    migrated_flag = proj_dir / ".migrated"
    if old_default.exists() and not migrated_flag.exists():
        try:
            old_data = json.loads(old_default.read_text(encoding="utf-8"))
            canvas_path = proj_dir / "canvas.json"
            canvas_path.write_text(json.dumps({
                "nodes": old_data.get("nodes", []),
                "edges": old_data.get("edges", []),
                "viewport": old_data.get("viewport"),
            }, ensure_ascii=False), encoding="utf-8")
            migrated_flag.write_text("migrated", encoding="utf-8")
            logger.info("Migrated legacy project data from %s", old_default)
        except Exception as e:
            logger.warning("Legacy project migration failed: %s", e)
    return proj_dir


class ProjectSaveRequest(BaseModel):
    name: str = "default"
    nodes: list
    edges: list
    viewport: Optional[dict] = None


@app.post("/project/save")
async def project_save_legacy(req: ProjectSaveRequest):
    """Legacy save endpoint — saves to the legacy project canvas."""
    _ensure_legacy_project()
    await save_canvas(_LEGACY_PROJECT_ID, CanvasSaveRequest(
        nodes=req.nodes, edges=req.edges, viewport=req.viewport
    ))
    return {"status": "saved", "name": req.name}


@app.get("/project/load")
async def project_load_legacy(name: str = "default"):
    """Legacy load endpoint — loads from the legacy project canvas."""
    _ensure_legacy_project()
    return await load_canvas(_LEGACY_PROJECT_ID)


@app.get("/project/list")
async def project_list_legacy(authorization: Optional[str] = _Header(None)):
    """Legacy list endpoint. Scoped like /projects so it cannot be used to read
    past the account filter from a browser."""
    result = await list_projects(authorization=authorization)
    return {"projects": [{"name": p["name"], "saved_at": p.get("updated_at")} for p in result["projects"]]}


# ── Maintenance ────────────────────────────────────────────────────────────────

@app.post("/cleanup-uploads")
async def cleanup_uploads(days: int = 7, dry_run: bool = False):
    """
    Delete upload files older than `days`. Files referenced by recent job history
    and state.json are always kept. NOTE: canvases referencing deleted files will
    lose those previews — use with care.
    """
    import time
    cutoff = time.time() - days * 86400
    keep = {Path(h.get("url", "")).name for h in _history if h.get("url")}
    keep.add(STATE_FILE.name)

    deleted, freed = [], 0
    for p in UPLOAD_DIR.iterdir():
        if not p.is_file() or p.name in keep:
            continue
        if p.stat().st_mtime < cutoff:
            freed += p.stat().st_size
            deleted.append(p.name)
            if not dry_run:
                try:
                    p.unlink()
                except OSError as e:
                    logger.warning("Could not delete %s: %s", p.name, e)

    return {
        "dry_run": dry_run,
        "deleted_count": len(deleted),
        "freed_bytes": freed,
        "deleted": deleted[:200],
    }


# ── Gaussian Splatting / Pose viewers ─────────────────────────────────────────

@app.get("/gaussian/viewer", response_class=HTMLResponse)
async def gaussian_viewer_page():
    """Serve the Gaussian Splatting WebGL viewer HTML page."""
    viewer_path = _BACKEND_DIR / "gaussian_viewer.html"
    if not viewer_path.exists():
        raise HTTPException(404, "Gaussian viewer HTML not found")
    return viewer_path.read_text(encoding="utf-8")


@app.get("/pose/viewer", response_class=HTMLResponse)
async def pose_viewer_page():
    """Serve the 3D Pose Editor HTML page."""
    viewer_path = _BACKEND_DIR / "pose_viewer.html"
    if not viewer_path.exists():
        raise HTTPException(404, "Pose viewer HTML not found")
    return HTMLResponse(
        content=viewer_path.read_text(encoding="utf-8"),
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )


class GaussianModelRequest(BaseModel):
    image_url: str
    # True: a queued job (job_id back at once; it can be pinned, cancelled and watched like any other).
    # False (the default): the call waits and answers with the file, which the MCP tool and the film
    # scripts rely on.
    queued: bool = False


async def _generate_gaussian_model(req: GaussianModelRequest) -> dict:
    """SHARP: one picture -> a PLY in uploads/."""
    target_path = await resolve_upload(req.image_url)
    comfy_image = await comfyui.upload_image(target_path.read_bytes(), target_path.name)

    ply_path_str = await comfyui.generate_gaussian_model(comfy_image)

    # Copy to local uploads dir
    import shutil
    unique_name = f"gaussian_{uuid.uuid4().hex}.ply"
    local_path = UPLOAD_DIR / unique_name
    shutil.copy2(ply_path_str, local_path)

    return {
        "filename": unique_name,
        "original_name": Path(ply_path_str).name,
        "url": f"/uploads/{unique_name}",
        "size": local_path.stat().st_size,
    }


async def _run_gaussian_model_job(job: dict, req: GaussianModelRequest) -> dict:
    return await _generate_gaussian_model(req)


@app.post("/generate-gaussian-model")
async def generate_gaussian_model(req: GaussianModelRequest):
    """Generate PLY from image using ComfyUI SHARP workflow."""
    if not await comfyui.health_check():
        raise HTTPException(503, "ComfyUI is not running.")
    if req.queued:
        return await submit_job("gaussian_model", lambda job: _run_gaussian_model_job(job, req), request=req)
    try:
        return await _generate_gaussian_model(req)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class WorldGaussianRequest(BaseModel):
    """One picture -> a whole-scene splat with FlashWorld (see world_gen.py).

    trajectory: ring (walk a small circle looking outward -- look all round and move
    a metre or two), orbit (push in, then arc left round a point `distance` ahead),
    pan (turn in place; a panorama that holds only from that spot). vfov is the
    picture's vertical field of view in degrees.
    """
    image_url: str
    prompt: str = ""
    trajectory: str = "ring"
    radius: float = 1.5
    distance: float = 10.0
    degrees: float = 360.0
    vfov: float = 45.0
    max_gaussians: int = 1_500_000


async def _run_world_gaussian_job(job: dict, req: WorldGaussianRequest) -> dict:
    import world_gen
    from PIL import Image as _PILImage
    image = await resolve_upload(req.image_url)
    with _PILImage.open(image) as im:
        width, height = im.size
    cameras = world_gen.build_trajectory(req.trajectory, width, height, vfov=req.vfov,
                                         radius=req.radius, distance=req.distance,
                                         degrees=req.degrees)
    # FlashWorld runs outside ComfyUI and needs ~24 GB; whatever ComfyUI holds goes first.
    await comfyui.free_memory(unload_models=True, free_memory=True)
    work = UPLOAD_DIR / f"_world_{job['id']}"
    ply, video = await asyncio.to_thread(world_gen.run_flashworld, image, req.prompt, cameras, work)
    stem = f"world_{job['id']}"
    kept = await asyncio.to_thread(world_gen.prune_ply, ply, UPLOAD_DIR / f"{stem}.ply",
                                   req.max_gaussians, True, world_gen.SCENE_SCALE)
    shutil.copy2(video, UPLOAD_DIR / f"{stem}.mp4")
    # How to place a camera in this splat: the picture's camera at the origin, x right,
    # y down, looking down +z (as a SHARP splat); ply units = metres * scene_scale.
    # `cameras` are FlashWorld's input trajectory, in its own world frame and metres.
    (UPLOAD_DIR / f"{stem}.json").write_text(json.dumps({
        "source": req.image_url, "frame": "picture_camera_opencv", "units": "metres",
        "scene_scale": world_gen.SCENE_SCALE,
        "trajectory": req.trajectory, "vfov": req.vfov, "image_size": [width, height],
        "cameras": cameras, "gaussians": kept}), encoding="utf-8")
    shutil.rmtree(work, ignore_errors=True)
    return {"url": f"/uploads/{stem}.ply", "video_url": f"/uploads/{stem}.mp4",
            "meta_url": f"/uploads/{stem}.json", "gaussians": kept}


class GaussianViewRequest(BaseModel):
    """One still of a splat from a placed camera (see gs_render_view.py for the frame:
    the source picture's camera at the origin, x right, y down, z forward, metres)."""
    ply_url: str
    x: float = 0.0
    y: float = 0.0
    z: float = 0.0
    yaw: float = 0.0
    pitch: float = 0.0
    vfov: float = 45.0
    width: int = 1376
    height: int = 768


@app.post("/gaussian/render-view")
async def gaussian_render_view(req: GaussianViewRequest):
    """Server-side capture for callers without the browser viewer (the canvas MCP).
    Runs gsplat in FlashWorld's venv, which has it built for this GPU."""
    import world_gen
    ply = await resolve_upload(req.ply_url)
    # A FlashWorld splat is stored shrunk (see world_gen.SCENE_SCALE); its sidecar says
    # by how much. The request is in metres either way.
    scale = 1.0
    sidecar = ply.with_suffix(".json")
    if sidecar.exists():
        scale = float(json.loads(sidecar.read_text(encoding="utf-8")).get("scene_scale", 1.0))
    x, y, z = req.x * scale, req.y * scale, req.z * scale
    python = world_gen.FLASHWORLD_DIR / ".venv" / "Scripts" / "python.exe"
    if not python.exists():
        python = world_gen.FLASHWORLD_DIR / ".venv" / "bin" / "python"
    out_name = f"gs_view_{uuid.uuid4().hex[:12]}.png"
    cmd = [str(python), str(_BACKEND_DIR / "gs_render_view.py"), str(ply), str(UPLOAD_DIR / out_name),
           # --opt=value: a leading minus ("-1,0,0") would otherwise read as a flag
           f"--pos={x},{y},{z}", f"--yaw={req.yaw}", f"--pitch={req.pitch}",
           f"--vfov={req.vfov}", f"--size={req.width}x{req.height}"]
    proc = await asyncio.to_thread(subprocess.run, cmd, capture_output=True, text=True,
                                   encoding="utf-8", errors="replace", timeout=300)
    if proc.returncode != 0 or not (UPLOAD_DIR / out_name).exists():
        raise HTTPException(500, f"render failed: {(proc.stderr or proc.stdout)[-1500:]}")
    return {"url": f"/uploads/{out_name}"}


class RouteGaussianRequest(BaseModel):
    """Several clips of one continuous camera move, in route order -> one splat (see route_gs.py).

    clip_urls: the clips' video files (/comfy_output/... or /uploads/...). frame_step: sample every n-th frame
    (widened so that no run gets more than max_frames frames). shared_frames: how many sampled frames of a clip
    are repeated at the start of the next one, to align them. metres_per_unit: the first clip's reconstruction
    unit in metres -- an assumption, nothing measures it.
    """
    clip_urls: list[str]
    frame_step: int = 9
    shared_frames: int = 5
    max_frames: int = 36
    metres_per_unit: float = 30.5
    max_gaussians: int = 0   # 0 = no cap; a number keeps that many, highest opacity first
    mask_people: bool = False   # drop people (SAM 3.1 tracking masks) from the splat; for clips that show actors
    adaptive_frames: bool = True   # follow the clip's motion when picking frames
    frame_width: int = 704   # width of the frames WorldMirror sees (its own maximum is 952)
    mask_fallback: bool = False   # SAM 3.1 masks failing is an error unless this allows SAM 2.1 large instead


async def _run_route_gaussian_job(job: dict, req: RouteGaussianRequest) -> dict:
    import route_gs
    clips = [await resolve_upload(u) for u in req.clip_urls]
    # WorldMirror needs most of the card; whatever ComfyUI holds goes first.
    await comfyui.free_memory(unload_models=True, free_memory=True)
    stem = f"route_{job['id']}"
    def cancelled() -> bool:      # cancel_job() marks this dict; route_gs polls it and stops its children
        return job.get("status") == "cancelled"

    try:
        result = await asyncio.to_thread(
            route_gs.build_route_gaussian, clips, UPLOAD_DIR / f"{stem}.ply", UPLOAD_DIR / f"_{stem}",
            frame_step=req.frame_step, shared=req.shared_frames, max_frames=req.max_frames,
            metres_per_unit=req.metres_per_unit, max_gaussians=req.max_gaussians,
            mask_people=req.mask_people, adaptive=req.adaptive_frames, mask_fallback=req.mask_fallback,
            cache_dir=UPLOAD_DIR / "_route_cache", frame_width=req.frame_width, should_stop=cancelled)
    except route_gs.RouteCancelled:
        return {}          # the job is already marked cancelled; _execute_job keeps that
    finally:
        shutil.rmtree(UPLOAD_DIR / f"_{stem}", ignore_errors=True)    # work dir; clips live in _route_cache
    return {"url": f"/uploads/{stem}.ply", "meta_url": f"/uploads/{stem}.json",
            "name": f"WorldMirror · 路线拼接（{len(clips)} 段）", **result}


@app.post("/generate-route-gaussian")
async def generate_route_gaussian(req: RouteGaussianRequest):
    if not req.clip_urls:
        raise HTTPException(400, "clip_urls is empty")
    if len(req.clip_urls) > 1 and req.shared_frames < 3:
        raise HTTPException(400, "shared_frames must be at least 3 to align neighbouring clips")
    return await submit_job("route_gaussian", lambda job: _run_route_gaussian_job(job, req), request=req)


@app.post("/generate-world-gaussian")
async def generate_world_gaussian(req: WorldGaussianRequest):
    import world_gen
    if req.trajectory not in world_gen.TRAJECTORIES:
        raise HTTPException(400, f"trajectory must be one of {world_gen.TRAJECTORIES}")
    return await submit_job("world_gaussian", lambda job: _run_world_gaussian_job(job, req),
                            request=req, prompt=req.prompt)


# ── Geometry passes ────────────────────────────────────────────────────────────
# Feed the results to /generate as depth_reference_filenames. Estimating depth from
# a still holds that frame's own geometry; rendering it from a reconstructed splat
# holds a location's geometry across every shot filmed there.

class EstimateDepthRequest(BaseModel):
    image_url: str
    resolution: int = 1024
    ckpt_name: str = "depth_anything_v2_vitl.pth"


@app.post("/estimate-depth")
async def estimate_depth(req: EstimateDepthRequest):
    """Estimate a depth map from a still, at the still's own dimensions."""
    if not await comfyui.health_check():
        raise HTTPException(503, "ComfyUI is not running.")
    try:
        target_path = await resolve_upload(req.image_url)
        comfy_image = await comfyui.upload_image(target_path.read_bytes(), target_path.name)
        png = await comfyui.estimate_depth(comfy_image, req.resolution, req.ckpt_name)

        out_name = f"depth_{uuid.uuid4().hex}.png"
        (UPLOAD_DIR / out_name).write_bytes(png)
        return {"url": f"/uploads/{out_name}", "filename": out_name}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class RenderPassRequest(BaseModel):
    ply_url: str                       # from /generate-gaussian-model or /upload-ply
    render_style: str = "depth"        # depth | normal | clay | color
    width: int = 1280
    height: int = 720
    frames: int = 1                    # >1 orbits a full turn, giving a sequence
    # Camera — the shot's actual position and lens, not a description of one.
    mode: str = "orbit"                # orbit | look_at | quaternion
    yaw: float = 35.0
    pitch: float = 15.0
    distance: float = 4.0
    position_x: float = 4.0
    position_y: float = 4.0
    position_z: float = 4.0
    quat_x: float = 0.0
    quat_y: float = 0.0
    quat_z: float = 0.0
    quat_w: float = 1.0
    target_x: float = 0.0
    target_y: float = 0.0
    target_z: float = 0.0
    roll: float = 0.0
    fov: float = 35.0
    zoom: float = 1.0
    camera_type: str = "perspective"
    splat_scale: float = 1.0
    sharpen: float = 2.0
    opacity_threshold: float = 0.0
    background: str = "#000000"


class CharswapTarget(BaseModel):
    """One person to replace: a point on the frame (0-1 from the top left) and whose photo."""
    x: float = Field(ge=0.0, le=1.0)
    y: float = Field(ge=0.0, le=1.0)
    image_url: str


class CharswapRequest(BaseModel):
    """Character replacement through Viggle-Animate (the MiniMax-H3 ref2va finetune).

    Two inputs and no prompt: the still supplies the identity, the driving clip supplies
    blocking, camera, set, lighting and everyone else in frame. The text encoder is
    replaced by a frozen 362-token embedding, so there is nothing to write -- a caller
    that wants a different result changes the inputs.

    Measured 2026-09-07 (RUNLOG "Viggle-Animate 取代 Ref2VA+抠图"): lands the swap with no
    matting on the case the Ref2VA route needs matting for, holds identity for all 107
    frames, no reference-still bleed. Two boundaries: the face blends (hair from the
    still, bone structure from the driving performer), and **held props are lost** -- a
    shot whose story is a raised prop belongs on the Ref2VA route.
    """
    video_url: str
    character_image_url: str
    # Frames at 24 fps, snapped to H3's 17k+5 grid by the builder. 0 = the clip's own
    # length, which is what a caller should normally want: a cap above what the clip
    # supplies hands the conditioning node a short batch and the output mosaics.
    length: int = 0
    seed: int = 95051
    sampler: str = "euler"
    # The conditioning canvas is 0.4-0.98 MP; the driving clip is scaled to this first.
    megapixels: float = 0.8
    # "person" (换人): the whole person, clothes included, comes from the still.
    # "head" (换头): the face, and the still's hair colour and bangs; the hair length and the clothes
    # stay the clip's. In both a frame of the driving clip is repainted by Qwen and that frame becomes
    # the reference, so the pose and light the model is shown are the clip's own (see
    # CHARSWAP_FACE_PROMPT). There is no face-only mode: see docs/CHARSWAP.md.
    # "reference": the picture is already the reference and goes to Viggle unchanged.
    mode: str = "person"
    # Which frame of the clip is repainted; negative = the frame whose face is
    # largest and most frontal (found with MediaPipe), else the middle. A clip that opens on the
    # back of the head gives Qwen no face to replace there.
    face_frame_seconds: float = -1.0
    # The whole Qwen edit prompt, <image 1> = the clip's frame, <image 2> = the photo.
    # Name what is in the frame (who, clothes, setting), what must stay, and what the new hair is.
    # Empty = written for you from what a vision model sees in the two pictures (face_prompt.py);
    # if that fails, the generic CHARSWAP_FACE_PROMPT, which is the weaker choice (see its notes).
    face_prompt: str = ""
    # Person mode, several people in the clip: who is replaced. Each target is a point on the frame
    # at face_frame_seconds (a negative time means the first frame) and the photo that person becomes;
    # everyone not pointed at stays. Empty = the one person of character_image_url, as before.
    targets: list[CharswapTarget] = Field(default_factory=list, max_length=4)
    # "viggle": the swap described above (a repainted frame of the clip, then Viggle). "h3": MiniMax-H3's own
    # edit of the whole clip with the photo as a reference and a six-section prompt (written from what the
    # vision model sees unless face_prompt is given): slower, but it follows a pose that changes through the
    # clip, which one reference frame cannot. Person mode only. docs/CHARSWAP.md has the measurements.
    engine: str = "viggle"
    # H3 engine: the speed LoRA ("taomate3": 3 steps, "turbo8": 8 steps) and the size ("source": the clip's own, at
    # most 1376 on the long edge; "small": 864 on the long edge, about 4x faster).
    h3_accel: str = "turbo8"
    h3_size: str = "source"
    # H3 engine, no points: the pose of a person put where an animal moved on four legs. "auto": upright when the clip's
    # subject is an animal and the photo a person; "follow": leave it to the clip; "upright": always.
    pose: str = "auto"


# Measured 2026-10-04 on a 5 s clip (grey wool coat, rain-streaked window, camera over the
# shoulder), same clip and swap seed throughout:
#   - sunlit full-length photo as the reference: a different woman, the coat as triangular facets;
#   - a repainted frame from a prompt that described the clip's frame (woman, grey wool coat,
#     looking back over her shoulder, rain-streaked window) and the new hair (straight black hair
#     with full see-through bangs ...) and named the coat and window in its keep-list, two Qwen
#     seeds: the new face on all 124 frames and the coat held, both times, and again on a rerun;
#   - a repainted frame from the generic prompt below, with and without cropping the photo to a
#     bust and with the new hair spelled out (six tries): Qwen kept the clip's own bob and head
#     turn, and the coat came out as camouflage every time.
# Hair length matters in back views: a reference with hair tied back made the model paint a
# long brown strand down the coat in the opening seconds, where the clip's woman is seen from
# behind (it read as blood). Telling Qwen to keep the clip's hair length ("ends at the nape,
# nothing hangs down the back") removed it.
# Both kinds of reference looked right. A generic prompt cannot name what is in the clip, so the
# caller can pass the whole prompt (`face_prompt`); the default is only a starting point.
CHARSWAP_FACE_PROMPT = (
    "Edit <image 1>, a frame from a video. Replace the face and hairstyle of the person in "
    "<image 1> with the face and hairstyle of the person in <image 2>: copy the hair of "
    "<image 2> completely, its length, its bangs and how it is worn, and keep none of the "
    "original hair. Keep everything else in <image 1> exactly as it is: the clothes, the turn "
    "of the shoulders and the angle of the head, the background, the lighting, the colours "
    "and the framing."
)


# The generic default for "person" mode: the whole person, clothes included, comes from the photo.
CHARSWAP_PERSON_PROMPT = (
    "Edit <image 1>, a frame from a video. Replace the person in <image 1> with the person in "
    "<image 2>: the same face, the same hair and the same clothes as in <image 2>. Nothing of the "
    "original person may remain: not the face, not the hair, not the clothes. Keep everything else "
    "in <image 1> exactly as it is: the turn of the body and the angle of the head, the "
    "background, the lighting, the colours and the framing."
)


def charswap_face_prompt(override: str = "", mode: str = "head") -> str:
    """The Qwen edit prompt: the caller's own when given, else the generic default for the mode."""
    if override.strip():
        return override.strip()
    return CHARSWAP_PERSON_PROMPT if mode == "person" else CHARSWAP_FACE_PROMPT


CHARSWAP_FACE_NEGATIVE = (
    "changed clothes, clothes from image 2, background of image 2, changed pose, changed "
    "background, changed light, extra people, blur, plastic skin, text, watermark"
)


def charswap_face_frame_seconds(requested: float, duration: float) -> float:
    """The moment of the driving clip that is repainted: the requested one, else the middle,
    kept inside the clip (a time at or past the end has no frame to cut)."""
    last = max(0.0, duration - 0.05)
    if requested < 0:
        return min(duration / 2, last)
    return min(requested, last)


def charswap_inspect_report(survey: list[dict], duration: float, frames: int,
                             photo_face_ratio: Optional[float]) -> dict:
    """What a swap's inputs look like and what is likely to go wrong, from a face survey of the
    clip (face_crop.survey_faces) and the photo's face width over its width (None = no face).

    Only measurable things are reported: it cannot say whether the swap will succeed.
    """
    best = face_crop.pick_best(survey)
    seen = [r for r in survey if r["face_ratio"] > 0]
    frontal = [r for r in survey if r["score"] > 0]
    warnings: list[str] = []
    if not seen:
        warnings.append("No face found in any sampled frame of the clip: face mode has nothing to "
                        "repaint. Use person mode with a reference that matches the clip.")
    elif not frontal:
        warnings.append("The face is only ever seen in profile; face mode will repaint the least "
                        "turned frame and the reference may not look like the new person.")
    if seen:
        first_face = min(r["t"] for r in seen)
        if first_face >= 0.5:
            warnings.append(
                f"The first {first_face:.1f} s show no face (seen from behind). Tell the face prompt "
                "to keep the clip's hair length, or a reference with tied-back hair gets painted "
                "as a strand down the back of the coat.")
        if max(r["face_ratio"] for r in seen) < 0.05:
            warnings.append("The face is under 5% of the frame width everywhere: a small face is "
                            "repainted badly. Crop or use a closer clip.")
    if photo_face_ratio is None:
        warnings.append("No face found in the photo.")
    elif photo_face_ratio < face_crop.LARGE_FACE:
        warnings.append(f"The face is {photo_face_ratio * 100:.0f}% of the photo's width; face mode "
                        "crops it to a bust before repainting.")
    if frames > 124:
        warnings.append(f"{frames} frames: more than one pass holds (124), the swap runs in "
                        "overlapping windows and a long clip is more likely to drift.")
    return {"best_frame_seconds": best, "duration": round(duration, 3), "frames": frames,
            "faces_seen": len(seen), "samples": len(survey), "photo_face_ratio": photo_face_ratio,
            "warnings": warnings, "survey": survey}


class CharswapInspectRequest(BaseModel):
    video_url: str
    character_image_url: str = ""


@app.post("/charswap/inspect")
async def charswap_inspect(req: CharswapInspectRequest):
    """Look at a swap's two inputs before spending a minute of GPU on it: where the clip's best
    face frame is, and what is likely to go wrong (see charswap_inspect_report)."""
    video_path = await resolve_upload(req.video_url)
    survey, duration, frames = await asyncio.to_thread(face_crop.survey_faces, video_path)
    photo_ratio = None
    if req.character_image_url:
        photo_path = await resolve_upload(req.character_image_url)
        box = await asyncio.to_thread(face_crop.face_box, photo_path)
        if box is not None:
            from PIL import Image
            with Image.open(photo_path) as im:
                photo_ratio = round(box[2] / im.width, 4)
    return charswap_inspect_report(survey, duration, frames, photo_ratio)


def _stop_if_cancelled(job: dict) -> None:
    """Between a job's ComfyUI prompts. A cancel interrupts the prompt that is running; the stages
    after it must not start. Raised as a ComfyUIError, which the job runner records as a cancel."""
    if job.get("status") == "cancelled":
        raise ComfyUIError("Job cancelled by user")


async def _auto_face_prompt(frame_name: str, photo_path: Path, mode: str = "head",
                            job: Optional[dict] = None) -> Optional[str]:
    """The edit prompt written from what the Qwen3-VL encoder sees in the frame and in the photo;
    None when it cannot be written (the caller falls back to the generic prompt)."""
    try:
        frame_in = await comfyui.upload_image((UPLOAD_DIR / frame_name).read_bytes(), frame_name)
        photo_in = await comfyui.upload_image(photo_path.read_bytes(), photo_path.name)
        queued = _make_on_queued(job) if job is not None else None
        frame = face_prompt.parse_fields(
            await comfyui.describe_image(frame_in, face_prompt.FRAME_ASK, on_queued=queued),
            face_prompt.FRAME_FIELDS + ("view", "limbs", "other"))
        if job is not None:
            _stop_if_cancelled(job)
        if mode == "person":
            photo = face_prompt.parse_fields(
                await comfyui.describe_image(photo_in, face_prompt.PERSON_PHOTO_ASK, max_length=260, on_queued=queued),
                face_prompt.PERSON_PHOTO_FIELDS)
            return face_prompt.compose_person_prompt(frame, photo)
        photo = face_prompt.parse_fields(
            await comfyui.describe_image(photo_in, face_prompt.PHOTO_ASK, on_queued=queued), face_prompt.PHOTO_FIELDS)
        return face_prompt.compose_face_prompt(frame, photo)
    except ComfyUIError:
        if job is not None and job.get("status") == "cancelled":
            raise                                 # the user stopped it: do not carry on without a prompt
        logger.warning("Could not write the face prompt automatically", exc_info=True)
        return None
    except Exception as exc:                      # a vision step must never sink the swap
        logger.warning("Could not write the face prompt automatically: %s", exc)
        return None


async def _charswap_face_reference(job: dict, req: CharswapRequest, video_path: Path,
                                   duration: float, still_path: Path) -> tuple[str, float, str]:
    """Repaint one frame of the clip with the still's person; return its upload URL, the time of the
    frame and the prompt used.

    The frame is the clip's most frontal large face unless the caller names a time. The still goes to
    Qwen cropped to a bust-up (to about the waist for 换人, where the clothes must show) when its face
    is small (face_crop): a face a few percent of a full-length photo is read badly. The prompt is the
    caller's own, else written from what a vision model sees in the frame and the photo.
    """
    requested = req.face_frame_seconds
    if requested < 0:
        # A whole-person swap wants a pose the whole clip shares: look for the face in the middle half.
        central = (0.25, 0.75) if req.mode == "person" else None
        best = await asyncio.to_thread(face_crop.best_face_frame, video_path, 24, central)
        requested = best if best is not None else -1.0
    seconds = charswap_face_frame_seconds(requested, duration)
    frame_name = f"charswap_face_src_{job['id']}.png"
    await asyncio.to_thread(_extract_video_still, video_path, UPLOAD_DIR / frame_name, seconds)
    _stop_if_cancelled(job)
    job["batch_info"] = "CHARSWAP · FACE REFERENCE"
    save_state()
    face_url = req.character_image_url
    crop_name = f"charswap_face_crop_{job['id']}.png"
    if await asyncio.to_thread(face_crop.crop_to_bust, still_path, UPLOAD_DIR / crop_name, req.mode == "person"):
        face_url = f"/uploads/{crop_name}"
    prompt = req.face_prompt.strip()
    if not prompt:
        photo_path = (UPLOAD_DIR / crop_name) if face_url != req.character_image_url else still_path
        prompt = await _auto_face_prompt(frame_name, photo_path, req.mode, job) or ""
    prompt = charswap_face_prompt(prompt, req.mode)
    _stop_if_cancelled(job)
    painted = await _run_qwen_image_job(job, QwenImageRequest(
        prompt=prompt,
        negative_prompt=CHARSWAP_FACE_NEGATIVE,
        reference_urls=[f"/uploads/{frame_name}", face_url],
        seed=req.seed,
        speed="base",  # identity edits with a negative prompt: the turbo LoRA is weaker there and takes none
    ))
    _stop_if_cancelled(job)
    return painted["url"], seconds, prompt


async def _describe_target(frame_name: str, target: CharswapTarget, photo_path: Optional[Path], index: int,
                            job: dict) -> dict:
    """What a vision model sees at the pointed-at person of the frame and in their new photo. A step it
    cannot do leaves its facts empty: the edit prompt then names the person by place alone."""
    queued = _make_on_queued(job)
    facts: dict = {"x": target.x, "wears": "", "view": "", "photo": {}}
    try:
        strip_name = f"charswap_target_{job['id']}_{index}.png"
        if await asyncio.to_thread(face_crop.crop_around_point, UPLOAD_DIR / frame_name,
                                   UPLOAD_DIR / strip_name, target.x, target.y):
            strip_in = await comfyui.upload_image((UPLOAD_DIR / strip_name).read_bytes(), strip_name)
            seen = face_prompt.parse_fields(
                await comfyui.describe_image(strip_in, face_prompt.POINT_ASK, on_queued=queued),
                face_prompt.POINT_FIELDS)
            facts["wears"], facts["view"] = seen.get("wears", ""), seen.get("view", "")
        _stop_if_cancelled(job)
        if photo_path is not None:
            photo_in = await comfyui.upload_image(photo_path.read_bytes(), photo_path.name)
            facts["photo"] = face_prompt.parse_fields(
                await comfyui.describe_image(photo_in, face_prompt.PERSON_PHOTO_ASK, max_length=260, on_queued=queued),
                face_prompt.PERSON_PHOTO_FIELDS)
    except ComfyUIError:
        if job.get("status") == "cancelled":
            raise
        logger.warning("Could not describe target %d", index, exc_info=True)
    except Exception as exc:
        logger.warning("Could not describe target %d: %s", index, exc)
    return facts


async def _charswap_people_reference(job: dict, req: CharswapRequest, video_path: Path,
                                     duration: float) -> tuple[str, float, str]:
    """The reference for a clip with several people, of whom the user pointed at some: one frame of the
    clip, repainted by Qwen so that each pointed-at person becomes their photo's person and everyone else
    stays. <image 1> is the frame, <image 2...> the photos in the order of `req.targets`.

    The frame is exactly the one the user pointed on (face_frame_seconds, the first frame when negative):
    a point means something only on its own frame.
    """
    seconds = charswap_face_frame_seconds(max(req.face_frame_seconds, 0.0), duration)
    frame_name = f"charswap_face_src_{job['id']}.png"
    await asyncio.to_thread(_extract_video_still, video_path, UPLOAD_DIR / frame_name, seconds)
    _stop_if_cancelled(job)
    job["batch_info"] = "CHARSWAP · PEOPLE REFERENCE"
    save_state()
    photo_urls: list[str] = []
    facts: list[dict] = []
    for i, target in enumerate(req.targets):
        photo_path = await resolve_upload(target.image_url)
        url = target.image_url
        crop_name = f"charswap_face_crop_{job['id']}_{i}.png"
        if await asyncio.to_thread(face_crop.crop_to_bust, photo_path, UPLOAD_DIR / crop_name, True):
            url, photo_path = f"/uploads/{crop_name}", UPLOAD_DIR / crop_name
        photo_urls.append(url)
        if not req.face_prompt.strip():
            facts.append(await _describe_target(frame_name, target, photo_path, i, job))
    prompt = req.face_prompt.strip() or face_prompt.compose_people_prompt(facts)
    _stop_if_cancelled(job)
    painted = await _run_qwen_image_job(job, QwenImageRequest(
        prompt=prompt,
        negative_prompt=CHARSWAP_FACE_NEGATIVE,
        reference_urls=[f"/uploads/{frame_name}", *photo_urls],
        seed=req.seed,
        speed="base",  # identity edits with a negative prompt: the turbo LoRA is weaker there and takes none
    ))
    _stop_if_cancelled(job)
    return painted["url"], seconds, prompt


H3_ENGINE_MAX_FRAMES = 226      # 17k+5: 9.4 s at 24 fps, one render window; a longer clip is a chain of windows
# The H3 engine's own weights: the official ref2va base and the Character-Swap LoRA that is trained on the plain
# instruction of face_prompt.compose_h3_swap_instruction. Both are required: with the six-section prompts and the
# stock bases the clip's camera and setting came back changed (docs/CHARSWAP.md).
H3_SWAP_LORA = "h3/h3_character_swap_pro4500_1000.safetensors"
H3_SWAP_LORA_URL = "https://huggingface.co/akatz-ai/MiniMax-H3-Character-Swap-LoRA"
H3_SWAP_PRESET = "ref2va"
# The frame of the clip the vision model is asked about, as a fraction of its length: the middle one.
H3_PROMPT_FRACTION = 0.5


def charswap_h3_length(frames: int) -> int:
    """The frames an H3 edit renders for a clip of `frames` frames at 24 fps: the largest 5 + 17k that
    the clip supplies (a longer request than the clip has mosaics, like Viggle's)."""
    n = int(frames)
    while n > 5 and (n - 5) % 17:
        n -= 1
    return n


def charswap_h3_size(width: int, height: int, small: bool) -> tuple[int, int]:
    """The render size of the H3 engine: the clip's own aspect, a long edge of 1376 (864 when `small`)
    that is never above the clip's own, both edges on the 32 px grid."""
    long_edge = max(width, height)
    target = min(864 if small else 1376, long_edge)
    scale = target / long_edge
    w = max(32, round(width * scale / 32) * 32)
    h = max(32, round(height * scale / 32) * 32)
    return w, h


async def _charswap_h3_targets(job: dict, req: CharswapRequest, video_path: Path, duration: float) -> list[dict]:
    """Who the H3 swap replaces, one dict per person in the order of the pictures, for the instruction
    (face_prompt.compose_h3_swap_instruction). Without points: the vision model names the main person of the clip's middle
    frame. With points: each pointed-at person is named by place and clothes at the frame the points were made on, as for
    the Viggle engine. A step the model cannot do leaves the person unnamed and the instruction says "the main performer"
    or names the place alone."""
    queued = _make_on_queued(job)
    try:
        if req.targets:
            pointed = f"charswap_face_src_{job['id']}.png"
            await asyncio.to_thread(_extract_video_still, video_path, UPLOAD_DIR / pointed,
                                    charswap_face_frame_seconds(max(req.face_frame_seconds, 0.0), duration))
            _stop_if_cancelled(job)
            people = []
            for i, target in enumerate(req.targets):
                facts = await _describe_target(pointed, target, None, i, job)
                people.append({"x": target.x, "wears": facts.get("wears", "")})
            return people
        name = f"charswap_h3_frame_{job['id']}.png"
        await asyncio.to_thread(_extract_video_still, video_path, UPLOAD_DIR / name,
                                charswap_face_frame_seconds(duration * H3_PROMPT_FRACTION, duration))
        _stop_if_cancelled(job)
        uploaded = await comfyui.upload_image((UPLOAD_DIR / name).read_bytes(), name)
        who = face_prompt.parse_who(
            await comfyui.describe_image(uploaded, face_prompt.H3_WHO_ASK, max_length=120, on_queued=queued))
        return [{"who": who}]
    except ComfyUIError:
        if job.get("status") == "cancelled":
            raise
        logger.warning("Could not describe who the H3 swap replaces", exc_info=True)
    except Exception as exc:                      # a vision step must never sink the swap
        logger.warning("Could not describe who the H3 swap replaces: %s", exc)
    return [{"x": t.x} for t in req.targets] or [{}]


async def _charswap_h3_pose(job: dict, req: CharswapRequest, video_path: Path, duration: float,
                            who: str) -> Optional[tuple[str, str]]:
    """The upright-walking clause and the start/end stance sentence (face_prompt.compose_upright_pose) when a person
    replaces an animal, else None. "auto" asks the vision model what the clip's subject and the photo are; a step it
    cannot do leaves the pose to the clip (None) for "auto" and the clause without a stance for "upright"."""
    if req.pose == "follow":
        return None
    queued = _make_on_queued(job)

    async def ask(path: Path, question: str, length: int = 40) -> str:
        _stop_if_cancelled(job)
        uploaded = await comfyui.upload_image(path.read_bytes(), path.name)
        return await comfyui.describe_image(uploaded, question, max_length=length, on_queued=queued)

    try:
        mid = UPLOAD_DIR / f"charswap_h3_frame_{job['id']}.png"           # written by _charswap_h3_targets
        if req.pose == "auto":
            photo = await resolve_upload(req.character_image_url)
            if face_prompt.parse_kind(await ask(mid, face_prompt.H3_KIND_ASK)) != "animal":
                return None
            if face_prompt.parse_kind(await ask(photo, face_prompt.H3_KIND_ASK)) != "person":
                return None
        stances = []
        for name, at in (("first", 0.1), ("last", max(0.0, duration - 0.15))):
            frame = UPLOAD_DIR / f"charswap_h3_{name}_{job['id']}.png"
            await asyncio.to_thread(_extract_video_still, video_path, frame, at)
            stances.append(face_prompt.parse_facing(await ask(frame, face_prompt.H3_FACING_ASK, 60)))
        return face_prompt.compose_upright_pose(who, stances[0], stances[1])
    except ComfyUIError:
        if job.get("status") == "cancelled":
            raise
        logger.warning("Could not read the pose of the H3 swap", exc_info=True)
    except Exception as exc:
        logger.warning("Could not read the pose of the H3 swap: %s", exc)
    return face_prompt.compose_upright_pose(who, ("", False), ("", False)) if req.pose == "upright" else None


def _h3_swap_lora_missing() -> bool:
    """True when the ComfyUI install is known and the Character-Swap LoRA is not in its loras folder."""
    root = Path(COMFYUI_OUTPUT_DIR).parent if COMFYUI_OUTPUT_DIR else None
    loras = root / "models" / "loras" if root else None
    return bool(loras and loras.is_dir() and not (loras / H3_SWAP_LORA).is_file())


async def _run_charswap_h3(job: dict, req: CharswapRequest) -> dict:
    """The H3-native swap: the clip is <Video 1>, the picture <Picture 1>, and H3's own edit render with the
    Character-Swap LoRA does the rest under one plain instruction (the caller's, else "Replace only <who> in <Video 1>
    with the character in <Picture 1>. ..." with <who> named by the vision model)."""
    if req.mode != "person":
        raise ValueError("the H3 engine swaps the whole person: use mode \"person\"")
    if req.h3_accel not in ("taomate3", "turbo8"):
        raise ValueError(f'h3_accel must be "taomate3" or "turbo8", got {req.h3_accel!r}')
    if req.h3_size not in ("source", "small"):
        raise ValueError(f'h3_size must be "source" or "small", got {req.h3_size!r}')
    if req.pose not in ("auto", "follow", "upright"):
        raise ValueError(f'pose must be "auto", "follow" or "upright", got {req.pose!r}')
    if _h3_swap_lora_missing():
        raise ValueError(f"the H3 engine needs the Character-Swap LoRA {H3_SWAP_LORA} in ComfyUI's models/loras "
                         f"(from {H3_SWAP_LORA_URL}); it is not there")
    video_path = await resolve_upload(req.video_url)
    geometry = _probe_video_geometry(video_path)
    if not geometry:
        raise ValueError("could not read the driving clip's size and length")
    fps = _probe_fps(video_path) or 24.0
    frames = int(geometry[2] * 24.0 / fps)
    length = charswap_h3_length(frames)
    if length < 22:
        raise ValueError(f"the clip is too short for the H3 engine ({frames} frames at 24 fps)")
    # A longer clip is rendered as a chain of windows, each one continuing the last from the latent it saved (the
    # video job's chunked continuation); the clip is cut to each window as <Video 1>.
    chunk_frames = H3_ENGINE_MAX_FRAMES if length > H3_ENGINE_MAX_FRAMES else 0
    width, height = charswap_h3_size(geometry[0], geometry[1], req.h3_size == "small")

    # One person per render. The LoRA swapped two people at once only half-way (the second person's face and hair but
    # not the outfit, 2026-10-04, the same instruction that swapped one person completely), so each pointed-at person
    # is a render of their own and each render takes the last one's clip as <Video 1>.
    passes: list[tuple[str, str]] = []                     # (the instruction, the picture) of each render
    typed = req.face_prompt.strip()
    if typed and len(req.targets) > 1:
        raise ValueError("a hand-written prompt names one person: point at one person, or leave the prompt empty "
                         "and each pointed-at person is swapped in a render of their own")
    if typed:
        passes.append((typed, req.targets[0].image_url if req.targets else req.character_image_url))
    else:
        job["batch_info"] = "CHARSWAP · H3 PROMPT"
        save_state()
        people = await _charswap_h3_targets(job, req, video_path, geometry[2] / fps)
        if req.targets:
            places = face_prompt._places([t.x for t in req.targets])
            for target, person, place in zip(req.targets, people, places):
                passes.append((face_prompt.compose_h3_swap_instruction([{**person, "place": place}]), target.image_url))
        else:
            pose = await _charswap_h3_pose(job, req, video_path, geometry[2] / fps, people[0].get("who", ""))
            passes.append((face_prompt.compose_h3_swap_instruction(people, pose), req.character_image_url))
    _stop_if_cancelled(job)

    source, rendered = req.video_url, {}
    for i, (prompt, picture) in enumerate(passes, start=1):
        _stop_if_cancelled(job)
        job["charswap_recovery"] = None
        if i == len(passes) and not chunk_frames:
            # What a restart needs to collect the finished render instead of describing and rendering again: only
            # the prompt id the H3 job records itself, and only for the last render (the clip of an earlier one is
            # not the result, so a restart in the middle of several starts again).
            job["charswap_recovery"] = {"engine": "h3", "result": {
                "mode": "h3", "face_frame_seconds": -1.0, "face_prompt": "\n\n".join(p for p, _ in passes)}}
        job["batch_info"] = "CHARSWAP · H3" + (f" {i}/{len(passes)}" if len(passes) > 1 else "")
        save_state()
        rendered = await _run_video_job(job, VideoRequest(
            prompt=prompt, raw_prompt=True, mode="edit",
            ref_video_urls=[source], ref_image_urls=[picture],
            audio_strategy="copy_source", width=width, height=height, length=length,
            seed=req.seed, motion_preset=H3_SWAP_PRESET, accel_lora=req.h3_accel, chunk_frames=chunk_frames,
            style_loras=[{"name": H3_SWAP_LORA, "strength": 1.0}], fps=24))
        source = rendered["url"]
    return {**rendered, "mode": "h3", "face_frame_seconds": -1.0, "face_prompt": "\n\n".join(p for p, _ in passes)}


async def _charswap_result_from_comfy(job: dict) -> Optional[dict]:
    """The result of a swap whose Viggle prompt ComfyUI already finished, or None.

    A backend restart puts a running swap back in the queue, and run again from the start it describes,
    repaints and renders the whole clip a second time (the Qwen and Viggle graphs are new prompts, so
    ComfyUI's cache does not answer them). When the restart came after the Viggle prompt was queued, the
    render is taken from ComfyUI's history instead, like an upscale's (_upscale_result_from_comfy).
    """
    recovery = job.get("charswap_recovery")
    if job.get("type") != "charswap" or not isinstance(recovery, dict):
        return None
    if recovery.get("engine") == "h3":
        # The H3 render is ComfyUI's file as it is: the result is its name and the fields recorded before.
        try:
            state, outputs = await comfyui.prompt_state(job.get("prompt_id") or "")
            files, _latent = comfyui.output_files(outputs) if state == "success" else ([], None)
            video = next((f for f in files if str(f.get("filename", "")).lower().endswith(".mp4")), None)
            if not video:
                return None
            sub = f"{video['subfolder']}/" if video.get("subfolder") else ""
            return {**(recovery.get("result") or {}), "url": f"/comfy_output/{sub}{video['filename']}",
                    "filename": video["filename"], "comfy_filename": video["filename"], "recovered": True}
        except Exception:  # noqa: BLE001 -- anything unexpected falls back to running it again
            logger.warning("Could not collect swap job %s from ComfyUI", job.get("id"), exc_info=True)
            return None
    prompt_id, result = recovery.get("viggle_prompt_id"), recovery.get("result")
    if not prompt_id or not isinstance(result, dict) or not result.get("filename"):
        return None
    try:
        state, outputs = await comfyui.prompt_state(prompt_id)
        if state != "success":
            return None
        files, _latent = comfyui.output_files(outputs)
        video = next((f for f in files if str(f.get("filename", "")).lower().endswith(".mp4")), None)
        if not video:
            return None
        mp4 = await comfyui.get_video_bytes(video["filename"], video.get("subfolder") or "", "output")
        (UPLOAD_DIR / result["filename"]).write_bytes(mp4)
        logger.info("Swap job %s: collected the finished ComfyUI render %s instead of running it again",
                    job.get("id"), video["filename"])
        return result
    except Exception:  # noqa: BLE001 -- anything unexpected falls back to running it again
        logger.warning("Could not collect swap job %s from ComfyUI", job.get("id"), exc_info=True)
        return None


async def _run_charswap_job(job: dict, req: CharswapRequest) -> dict:
    require_node("charswap")
    job.pop("charswap_recovery", None)      # a run from the start has nothing of an earlier run to collect
    if req.engine not in ("viggle", "h3"):
        raise ValueError(f'engine must be "viggle" or "h3", got {req.engine!r}')
    if req.engine == "h3":
        return await _run_charswap_h3(job, req)
    if req.targets and req.mode != "person":
        raise ValueError(f'targets only work in person mode, got mode {req.mode!r}')
    job_id = job["id"]
    video_path = await resolve_upload(req.video_url)
    ref_path = await resolve_upload(req.character_image_url)

    geometry = _probe_video_geometry(video_path)
    if not req.length and not geometry:
        raise ValueError("could not read the driving clip's frame count; pass length")
    # The graph loads the clip at 24 fps, so a 30 fps source supplies fewer frames than
    # it has: 435 frames at 30 fps are 348 at 24. Asking for more than arrive mosaics.
    fps = _probe_fps(video_path) or 24.0
    length = req.length or int(geometry[2] * 24.0 / fps)
    # Never upscale: a 0.5 MP clip taken to 0.8 MP is 60% more tokens and no detail.
    megapixels = req.megapixels
    if geometry:
        megapixels = min(megapixels, geometry[0] * geometry[1] / 1e6)

    if req.mode not in ("person", "head", "reference"):
        raise ValueError(f'mode must be "person", "head" or "reference", got {req.mode!r}')
    # Person and head make their reference from a repainted frame of the clip: the photo itself is never
    # fed to Viggle (a reference that does not match the clip gives a stranger and a coat of facets).
    # Only "reference" hands the caller's picture over untouched.
    duration = (geometry[2] / fps) if geometry else length / 24.0
    if req.mode == "reference":
        # The caller made the reference themselves (two people, a pose the repaint cannot hold):
        # it goes to Viggle as it is.
        reference_url, face_seconds, face_prompt_used = req.character_image_url, -1.0, ""
    elif req.targets:
        reference_url, face_seconds, face_prompt_used = await _charswap_people_reference(
            job, req, video_path, duration)
    else:
        reference_url, face_seconds, face_prompt_used = await _charswap_face_reference(
            job, req, video_path, duration, ref_path)
    ref_path = await resolve_upload(reference_url)
    _stop_if_cancelled(job)

    comfy_video = await comfyui.upload_video(video_path.read_bytes(), video_path.name)
    comfy_ref = await comfyui.upload_image(ref_path.read_bytes(), ref_path.name)

    job["batch_info"] = "CHARSWAP"
    save_state()

    # Viggle is a second ~20 GB H3 transformer. Left beside the resident H3 (~20 GB)
    # and its text encoder (~15 GB) it fills 64 GB of RAM and Windows pages; a run on
    # 2026-09-21 sat at step 0 for 7 min. Unload before, and again after so the next
    # H3 job does not meet Viggle. ComfyUI applies /free between prompts.
    # What a restart needs to collect the finished render instead of running the whole job again
    # (_charswap_result_from_comfy): the result's own fields, and the id of the Viggle prompt itself
    # (job["prompt_id"] is also the Qwen and description prompts before it).
    result = {"url": f"/uploads/charswap_{job_id}.mp4", "filename": f"charswap_{job_id}.mp4", "mode": req.mode,
              "reference": {"url": reference_url, "source_url": req.character_image_url},
              "face_frame_seconds": face_seconds, "face_prompt": face_prompt_used}
    recovery = job["charswap_recovery"] = {"result": result, "viggle_prompt_id": None}
    queued = _make_on_queued(job)

    def viggle_queued(prompt_id):
        recovery["viggle_prompt_id"] = prompt_id
        queued(prompt_id)

    await comfyui.free_memory(unload_models=True, free_memory=True)
    try:
        mp4 = await comfyui.charswap_viggle(
            video_filename=comfy_video, reference_filename=comfy_ref,
            length=length, seed=req.seed,
            sampler=req.sampler, megapixels=megapixels,
            keep_audio=_has_audio_stream(video_path),
            on_queued=viggle_queued,
        )
    finally:
        await comfyui.free_memory(unload_models=True, free_memory=True)

    (UPLOAD_DIR / result["filename"]).write_bytes(mp4)
    return result


@app.post("/charswap")
async def charswap(req: CharswapRequest):
    """Swap the performer in a clip for the person in one still. No prompt exists."""
    return await submit_job(
        "charswap", lambda job: _run_charswap_job(job, req), request=req,
        video_url=req.video_url,
    )


class ReangleRequest(BaseModel):
    """See an accepted clip from another camera (CrossView-Warp LoRA on H3 ref2va).

    The performance, timing and sound are the source's; only the camera moves. The clip
    is depth-warped (MoGe) to the new camera inside the graph, and the warp pins the
    target at frame 0 through AddGuide while the clip itself rides along as a silent
    reference for identity and look. The model fills what the source camera never saw
    (the warp's magenta holes); reference images on `ref_image_urls` steer that fill.
    The source's own audio is muxed back afterwards -- the model's would be invented.

    Measured 2026-09-21 on two real chains: holds identity, costume and set at
    20-90 degrees. Weak where a large object sits right at the lens (a huge area to
    invent). `keyframes` cuts between several cameras in one clip; a cut can land 1-3
    frames early.
    """
    video_url: str
    # First source frame to use; `length` frames from there (0 = as many as the clip
    # has, snapped DOWN to H3's 17k+5 grid so every frame has a source frame).
    start_frame: int = 0
    length: int = 0
    azimuth: float = 30.0            # degrees; + orbits right, - left
    elevation: float = 0.0           # degrees; + above the subject
    distance: float = 1.0            # 1 = the source's distance (unreliable in v1)
    # [{"f", "az", "el", "dist"}], f counted from 1 within the used window. Two
    # keyframes on adjacent frames are a hard cut. Empty = one fixed camera.
    keyframes: list[dict] = []
    ref_image_urls: list[str] = []   # optional appearance references for the fill
    prompt: str = "crossview"        # the LoRA's trigger; text after it steers the fill
    lora_strength: float = 0.8
    megapixels: float = 0.5          # the LoRA's training size; the output is scaled to the source
    steps: int = 8
    seed: int = 81000
    keep_source_audio: bool = True
    # Depth from a brightened copy of the clip: "auto" does it for a dark clip
    # (mean luma under DEPTH_DARK_LUMA), "on" always, "off" never. See
    # _reangle_depth_source.
    depth_boost: str = "auto"
    # MoGe's own mask of unreliable pixels (holes in the warp). On by default,
    # as the released workflow runs.
    apply_mask: bool = True
    # Rotation centre {"x", "y", "z"} in MoGe camera space (z = metres ahead of the
    # lens); None = estimated from the middle of the frame. Set it on the subject
    # when the middle of the frame is far away (looking out of a car).
    pivot: Optional[dict] = None
    smooth_depth: bool = False       # edge-aware depth smoothing: fewer speckle holes
    depth_ratio: float = 6.0         # depth relief; lower = less tearing near the lens
    # True: orbit the pivot but keep looking where the source looked (what the
    # accepted chain-12 test ran). False: look at the pivot (the node's default).
    keep_source_aim: bool = True
    # The model renders at `megapixels` (the LoRA's own size); "source" scales the
    # result back to the source clip's width and height, "render" keeps it.
    output_size: str = "source"


CROSSVIEW_LORA = "h3/MiniMax-H3_Ref2VA-LoRA-CrossView-Warp_v1_3500.safetensors"


def _reangle_render_size(src_w: int, src_h: int, megapixels: float = 0.5) -> tuple[int, int]:
    """The model's render size: `megapixels` at the source's aspect, on the 32 px grid.

    Not the source size: the CrossView LoRA was trained at 0.5 MP, and at 1376x768
    it ignores the warp and copies the source (C27 frame 31, -30 deg, pivot
    0.8 m: 960x544 re-angled, 1376x768 unchanged, 2026-09-28). The output is
    scaled back to the source size afterwards (output_size).
    """
    import math
    aspect = src_w / src_h
    width = max(384, round(math.sqrt(megapixels * 1e6 * aspect) / 32) * 32)
    return width, max(384, round(width / aspect / 32) * 32)


DEPTH_DARK_LUMA = 70  # mean Y (0-255) below which "auto" brightens the depth input


def _clip_mean_luma(path: Path) -> float:
    """Mean luma (0-255) of a clip's first frame, or 255 if it cannot be read."""
    import io
    import subprocess
    from PIL import Image
    out = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", str(path), "-frames:v", "1",
                          "-f", "image2pipe", "-vcodec", "png", "-"], capture_output=True)
    try:
        img = Image.open(io.BytesIO(out.stdout)).convert("L")
    except Exception:  # noqa: BLE001 -- unreadable: treat as bright, change nothing
        return 255.0
    hist = img.histogram()
    return sum(i * n for i, n in enumerate(hist)) / max(1, sum(hist))


async def _reangle_depth_source(src_path: Path, mode: str) -> Optional[str]:
    """A brightened copy of `src_path` for MoGe to read depth from, or None.

    Only the depth estimate sees it; the warp still moves the original frames.
    Levels are stretched per frame (normalize) and the shadows lifted (gamma), so
    a night interior gives MoGe something to hold on to.
    """
    import subprocess
    if mode == "off":
        return None
    if mode != "on":
        luma = await asyncio.to_thread(_clip_mean_luma, src_path)
        if luma >= DEPTH_DARK_LUMA:
            return None
    out = src_path.with_name(src_path.stem + "_depthsrc.mp4")
    await asyncio.to_thread(subprocess.run, [
        "ffmpeg", "-y", "-loglevel", "error", "-i", str(src_path),
        "-vf", "normalize=strength=1:smoothing=0,eq=gamma=1.4",
        "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "12", str(out),
    ], check=True, capture_output=True)
    return f"/uploads/{out.name}"


async def _run_reangle_job(job: dict, req: ReangleRequest) -> dict:
    import math
    import subprocess


    job_id = job["id"]
    video_path = await resolve_upload(req.video_url)
    geometry = _probe_video_geometry(video_path)
    if not geometry or not geometry[2]:
        raise ValueError("could not read the source clip's size and frame count")
    src_w, src_h, src_frames = geometry[:3]
    _, src_fps = get_video_frame_count(video_path)
    src_fps = src_fps or 24.0

    available = src_frames - int(req.start_frame)
    wanted = min(int(req.length) or available, available)
    if wanted < 5:
        raise ValueError(f"start_frame {req.start_frame} leaves {available} frames; need at least 5")
    length = 5 + 17 * ((wanted - 5) // 17)
    for kf in req.keyframes:
        if not 1 <= int(kf.get("f", 0)) <= length:
            raise ValueError(f"keyframe f={kf.get('f')} is outside 1..{length} (the window rendered)")

    width, height = _reangle_render_size(src_w, src_h, req.megapixels)

    # One prepared clip serves as both the warp source and the silent reference:
    # the window, at the render size, no audio (the tested setup, 2026-09-21).
    src_name = f"reangle_src_{job_id}.mp4"
    src_path = UPLOAD_DIR / src_name
    await asyncio.to_thread(subprocess.run, [
        "ffmpeg", "-y", "-loglevel", "error", "-i", str(video_path),
        "-vf", (f"trim=start_frame={int(req.start_frame)}:end_frame={int(req.start_frame) + length},"
                f"setpts=PTS-STARTPTS,scale={width}:{height}:flags=lanczos"),
        "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "12", str(src_path),
    ], check=True, capture_output=True)

    depth_source = await _reangle_depth_source(src_path, req.depth_boost)

    job["batch_info"] = "REANGLE"
    save_state()
    vreq = VideoRequest(
        prompt=req.prompt or "crossview", raw_prompt=True,
        width=width, height=height, length=length, steps=req.steps, seed=req.seed,
        motion_preset="crossview",
        ref_video_urls=[f"/uploads/{src_name}"],
        ref_image_urls=list(req.ref_image_urls),
        style_loras=[{"name": CROSSVIEW_LORA, "strength": float(req.lora_strength)}],
        crossview_warp={"source": f"/uploads/{src_name}", "azimuth": req.azimuth,
                        "elevation": req.elevation, "distance": req.distance,
                        "keyframes": list(req.keyframes),
                        "depth_source": depth_source, "apply_mask": req.apply_mask,
                        "pivot": req.pivot, "smooth_depth": req.smooth_depth,
                        "depth_ratio": req.depth_ratio, "keep_source_aim": req.keep_source_aim},
        block_sparse=True,
    )
    result = await _run_video_job(job, vreq)

    rel = urlparse(result["url"]).path.split("/comfy_output/", 1)[-1]
    generated = Path(COMFYUI_OUTPUT_DIR) / rel
    out_name = f"reangle_{job_id}.mp4"
    out_path = UPLOAD_DIR / out_name
    # Back to the source's size, so a re-angled shot drops into the chain beside
    # the others (the model itself runs at `megapixels`).
    rescale = req.output_size == "source" and (src_w, src_h) != (width, height)
    video_codec = (["-vf", f"scale={src_w}:{src_h}:flags=lanczos", "-c:v", "libx264",
                    "-crf", "12", "-pix_fmt", "yuv420p"] if rescale else ["-c:v", "copy"])
    if req.keep_source_audio or rescale:
        # Same frames, same timing: the source's own sound for this window, and the
        # graph ComfyUI embedded (read by adopt_render) carried over.
        audio_in = (["-ss", f"{int(req.start_frame) / src_fps:.4f}", "-i", str(video_path)]
                    if req.keep_source_audio else [])
        audio_map = ["-map", "1:a:0?", "-c:a", "aac", "-b:a", "192k", "-shortest"] if req.keep_source_audio else ["-an"]
        await asyncio.to_thread(subprocess.run, [
            "ffmpeg", "-y", "-loglevel", "error", "-i", str(generated), *audio_in,
            # "prompt" is not a standard mp4 key: without use_metadata_tags the
            # muxer drops it silently even with -map_metadata.
            "-map", "0:v:0", *audio_map, "-map_metadata", "0",
            "-movflags", "+use_metadata_tags", *video_codec, str(out_path),
        ], check=True, capture_output=True)
    else:
        shutil.copyfile(generated, out_path)
    out_w, out_h = (src_w, src_h) if rescale else (width, height)
    return {**result, "url": f"/uploads/{out_name}", "filename": out_name,
            "comfy_url": result["url"], "width": out_w, "height": out_h, "length": length}


def _reangle_source_head(keyframes: list[dict]) -> tuple[int, list[dict]]:
    """Frames at the start that keep the source camera, and the keyframes after them.

    A shot list that opens on the source camera (0/0) and then cuts or moves to a
    new one gives (the last source-camera frame, the rest shifted to start at 1).
    Otherwise (0, keyframes). Those opening frames are the source's own; rendering them made the
    model copy the source for the whole clip, the re-angled part included (C27
    2026-09-28: the per-shot render from the cut turned, the full render did not).
    """
    kfs = sorted(keyframes, key=lambda k: int(k.get("f", 0)))
    held = 0
    while held < len(kfs) and float(kfs[held].get("az", 0)) == 0 and float(kfs[held].get("el", 0)) == 0:
        held += 1
    if not held or held >= len(kfs) or int(kfs[0].get("f", 0)) != 1:
        return 0, list(keyframes)
    head = int(kfs[held - 1]["f"])
    rest = [{**k, "f": int(k["f"]) - head} for k in kfs[held:]]
    if rest[0]["f"] != 1:
        # A move out of the source camera: the window starts one frame into it,
        # at the angle the move has reached by then.
        t = 1 / rest[0]["f"]
        rest.insert(0, {**rest[0], "f": 1, "az": float(rest[0].get("az", 0)) * t,
                        "el": float(rest[0].get("el", 0)) * t})
    return head, rest


async def _run_reangle_split_job(job: dict, req: ReangleRequest) -> dict:
    """Keep the source's opening frames, re-angle only from the cut, join the two."""
    import subprocess


    head, rest = _reangle_source_head(req.keyframes)
    if not head:
        return await _run_reangle_job(job, req)
    video_path = await resolve_upload(req.video_url)
    _, src_fps = get_video_frame_count(video_path)
    src_fps = src_fps or 24.0
    sub = ReangleRequest(**{**req.model_dump(),
                            "start_frame": int(req.start_frame) + head,
                            "length": max(0, int(req.length) - head) if req.length else 0,
                            "keyframes": rest if len(rest) > 1 else [],
                            "azimuth": float(rest[0].get("az", req.azimuth)),
                            "elevation": float(rest[0].get("el", req.elevation)),
                            "keep_source_audio": False, "output_size": "source"})
    result = await _run_reangle_job(job, sub)
    tail = UPLOAD_DIR / result["filename"]
    geometry = _probe_video_geometry(tail)
    w, h = geometry[:2]
    out_name = f"reangle_{job['id']}_joined.mp4"
    out_path = UPLOAD_DIR / out_name
    s0 = int(req.start_frame)
    graph = (f"[0:v]trim=start_frame={s0}:end_frame={s0 + head},setpts=PTS-STARTPTS,"
             f"scale={w}:{h}:flags=lanczos,fps={src_fps:g},setsar=1[a];"
             f"[1:v]fps={src_fps:g},setsar=1[b];[a][b]concat=n=2:v=1:a=0[v]")
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(video_path), "-i", str(tail)]
    if req.keep_source_audio:
        cmd += ["-ss", f"{s0 / src_fps:.4f}", "-i", str(video_path)]
    cmd += ["-filter_complex", graph, "-map", "[v]"]
    cmd += (["-map", "2:a:0?", "-c:a", "aac", "-b:a", "192k", "-shortest"] if req.keep_source_audio else ["-an"])
    cmd += ["-map_metadata", "1", "-movflags", "+use_metadata_tags",
            "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", str(out_path)]
    await asyncio.to_thread(subprocess.run, cmd, check=True, capture_output=True)
    tail.unlink(missing_ok=True)
    return {**result, "url": f"/uploads/{out_name}", "filename": out_name,
            "length": head + int(result.get("length") or 0), "source_head_frames": head}


@app.post("/reangle")
async def reangle(req: ReangleRequest):
    """Re-render an accepted clip from a new camera; performance and sound unchanged."""
    return await submit_job(
        "reangle", lambda job: _run_reangle_split_job(job, req), request=req,
        video_url=req.video_url,
    )


class ReangleStillRequest(ReangleRequest):
    """One frame of the real render at the chosen angle, not just its warp."""
    frame: int = 0                   # source frame to render; the still is this frame


async def _run_reangle_still_job(job: dict, req: ReangleStillRequest) -> dict:
    """Render a short window (22 frames) from `frame` and keep frame 0.

    Same angle, references, prompt, LoRA, seed and steps as the full render, so the
    still shows what the render will look like at that moment. Not the 5-frame
    minimum: at 5 frames the model ignores the warp and copies the source (
    C27 frame 31, 2026-09-28: 5 frames unchanged, 22 frames re-angled).
    """
    import subprocess

    sub = ReangleRequest(**{**req.model_dump(exclude={"frame"}),
                            "start_frame": int(req.frame), "length": 22,
                            "keyframes": [], "keep_source_audio": False})
    result = await _run_reangle_job(job, sub)
    clip = UPLOAD_DIR / result["filename"]
    out_name = f"reangle_still_{job['id']}.png"
    await asyncio.to_thread(subprocess.run, [
        "ffmpeg", "-y", "-loglevel", "error", "-i", str(clip), "-frames:v", "1", str(UPLOAD_DIR / out_name),
    ], check=True, capture_output=True)
    clip.unlink(missing_ok=True)
    return {"url": f"/uploads/{out_name}", "filename": out_name, "frame": int(req.frame),
            "azimuth": req.azimuth, "elevation": req.elevation}


@app.post("/reangle/still")
async def reangle_still(req: ReangleStillRequest):
    """Render one frame of the re-angled clip, at the frame the user chose."""
    return await submit_job(
        "reangle_still", lambda job: _run_reangle_still_job(job, req), request=req,
        video_url=req.video_url,
    )


# pablodawson/MiniMax-H3-360-Orbit-LoRA, saved here under the name of the file it was released as.
ORBIT_LORA = "h3/minimax_h3_flf2v_lora_v1.safetensors"
# The one prompt the LoRA was trained on. The official Space fixes it ("Prompt (fixed)"), and a LoRA trained on
# a single sentence follows it only when it is sent verbatim, so the node never takes another.
ORBIT_PROMPT = (
    "One frozen instant. Only the camera moves. In a continuous 360 orbit. Preserve every person and object in "
    "exactly the same world position, orientation, shape and pose throughout the shot. Airborne objects remain "
    "suspended at the captured height and angle: no wobbling, shaking, spinning, drifting, falling or continued "
    "action. Keep faces, hands, clothing, liquids and the background motionless while retaining their natural "
    "appearance. Camera parallax is the only source of apparent movement. No cuts, zoom, morphing or added objects."
)


def _orbit_frames(duration: float) -> int:
    """Seconds -> the next frame count H3's video VAE decodes (17k + 5 at 24 fps), as the official Space does."""
    n = max(5, round(float(duration) * 24))
    return n + (5 - n % 17) % 17


class OrbitRequest(BaseModel):
    """One picture orbited by the camera while the scene stays frozen (360-Orbit LoRA on H3 FL2VA).

    The picture is both the first and the last frame, which is the wiring the LoRA was trained with: the camera
    leaves the picture and comes back to it. Defaults are the official Space's (768x768, LoRA 1.0, 3 s); the 28 steps are the fl2va preset's own count
    for a run with no speed LoRA, so the request has no step count to give.

    Measured 2026-10-05 on a street frame: the swing is about +-120 degrees, not a full turn, and a frame with a
    clear subject in the middle holds better than a wide street. Backgrounds the picture never showed are invented.
    """
    image_url: str
    width: int = 768
    height: int = 768
    duration: float = 3.0            # seconds; snapped up to the 17k+5 frame grid
    seed: int = 904231
    lora_strength: float = 1.0
    # Read by the job scheduler, which keys the loaded-model family on it.
    motion_preset: str = "fl2va"
    length: int = 0                  # filled from `duration`, and steps from the preset, so the scheduler can size it
    steps: int = 28


async def _run_orbit_job(job: dict, req: OrbitRequest) -> dict:
    length = _orbit_frames(req.duration)
    job["batch_info"] = "ORBIT"
    save_state()
    vreq = VideoRequest(
        prompt=ORBIT_PROMPT, raw_prompt=True,
        image_url=req.image_url,
        # Same picture pinned at the last frame: sent as a guide, as the node that made the first test did.
        guide_frames=[{"url": req.image_url, "frame_index": -1}],
        width=req.width, height=req.height, length=length, seed=req.seed,
        motion_preset="fl2va", accel_lora="none",
        style_loras=[{"name": ORBIT_LORA, "strength": float(req.lora_strength)}],
        block_sparse=True, shift_video=12.0,
    )
    result = await _run_video_job(job, vreq)
    return {**result, "width": req.width, "height": req.height, "length": length}


@app.post("/orbit")
async def orbit(req: OrbitRequest):
    """Orbit the camera 360-style around one picture, the scene frozen."""
    require_node("videoOrbit")      # the FL2VA int8 checkpoint has no w4a8 build for a 16 GB card
    req.length = _orbit_frames(req.duration)
    return await submit_job(
        "orbit", lambda job: _run_orbit_job(job, req), request=req,
        image_url=req.image_url,
    )


class ReanglePreviewRequest(BaseModel):
    """One warped frame: what the CrossView model will be pinned to at this angle."""
    video_url: str
    start_frame: int = 0
    azimuth: float = 30.0
    elevation: float = 0.0
    megapixels: float = 0.5
    depth_boost: str = "auto"
    apply_mask: bool = True
    pivot: Optional[dict] = None
    smooth_depth: bool = False
    depth_ratio: float = 6.0
    keep_source_aim: bool = True


@app.post("/reangle/preview")
async def reangle_preview(req: ReanglePreviewRequest):
    """Run only MoGe + CrossViewWarp on a few frames and return the first warped frame.

    The render follows this guide; when it is mostly magenta holes (depth failed, or
    the angle asks for more than the source saw) the model falls back to copying the
    source clip and the camera does not move -- seen 2026-09-22 on a shot through a
    doorway. Seconds instead of a full render.
    """
    import math
    import subprocess
    from PIL import Image

    video_path = await resolve_upload(req.video_url)
    geometry = _probe_video_geometry(video_path)
    if not geometry or not geometry[2]:
        raise HTTPException(400, "could not read the source clip's size and frame count")
    src_w, src_h, _ = geometry[:3]
    width, height = _reangle_render_size(src_w, src_h, req.megapixels)

    tag = uuid.uuid4().hex[:10]
    src_name = f"reangle_preview_src_{tag}.mp4"
    src_path = UPLOAD_DIR / src_name
    s = int(req.start_frame)
    await asyncio.to_thread(subprocess.run, [
        "ffmpeg", "-y", "-loglevel", "error", "-i", str(video_path),
        "-vf", f"trim=start_frame={s}:end_frame={s + 5},setpts=PTS-STARTPTS,scale={width}:{height}:flags=lanczos",
        "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "12", str(src_path),
    ], check=True, capture_output=True)
    depth_url = await _reangle_depth_source(src_path, req.depth_boost)
    try:
        comfy_src = await comfyui.upload_video(src_path.read_bytes(), src_name)
        comfy_depth = None
        if depth_url:
            dp = UPLOAD_DIR / depth_url.rsplit("/", 1)[-1]
            comfy_depth = await comfyui.upload_video(dp.read_bytes(), dp.name)
            dp.unlink(missing_ok=True)
    finally:
        src_path.unlink(missing_ok=True)

    # Same MoGe/CrossViewWarp settings as the render (workflow_builders crossview_warp).
    wf = {
        "85": {"class_type": "LoadVideo", "inputs": {"file": comfy_src}},
        "86": {"class_type": "GetVideoComponents", "inputs": {"video": ["85", 0]}},
        "80": {"class_type": "LoadMoGeModel", "inputs": {"model_name": "moge_2_vitl_normal_fp16.safetensors"}},
        "81": {"class_type": "MoGeInference", "inputs": {
            "moge_model": ["80", 0], "image": ["84", 0] if comfy_depth else ["86", 0],
            "resolution_level": 2, "fov_x_degrees": 0.0,
            "batch_size": 4, "force_projection": True, "apply_mask": bool(req.apply_mask),
            "refine_steps": 0}},
        "82": {"class_type": "CrossViewWarp", "inputs": {
            "frames": ["86", 0], "moge_geometry": ["81", 0],
            "azimuth": float(req.azimuth), "elevation": float(req.elevation), "distance": 1.0,
            "hfov": 50.0, "vertical_shift": 0.0, "depth_ratio": float(req.depth_ratio),
            "smooth_depth": bool(req.smooth_depth),
            "invert_depth": False, "pivot_override": False,
            "keep_source_aim": bool(req.keep_source_aim),
            **({"pivot_override": True, "pivot_x": float(req.pivot.get("x", 0.0)),
                "pivot_y": float(req.pivot.get("y", 0.0)), "pivot_z": float(req.pivot.get("z", 1.05))}
               if req.pivot else {}),
            "use_keyframes": False, "keyframes": ""}},
        **({"83": {"class_type": "LoadVideo", "inputs": {"file": comfy_depth}},
            "84": {"class_type": "GetVideoComponents", "inputs": {"video": ["83", 0]}}}
           if comfy_depth else {}),
        "90": {"class_type": "ImageFromBatch", "inputs": {"image": ["82", 0], "batch_index": 0, "length": 1}},
        "91": {"class_type": "SaveImage", "inputs": {"images": ["90", 0], "filename_prefix": "reangle_preview/warp"}},
    }
    png = await comfyui._run_image_workflow(wf, timeout=300)
    out_name = f"reangle_preview_{tag}.png"
    out_path = UPLOAD_DIR / out_name
    out_path.write_bytes(png)

    # Share of the frame that is broken: 16 px blocks more than 15% hole (the node
    # paints holes pure magenta). Counting pixels undercounts a shattered warp, whose
    # holes are a fine dither of magenta between surviving dark points.
    def _holes() -> float:
        import numpy as np
        a = np.asarray(Image.open(out_path).convert("RGB")).astype(int)
        m = (a[..., 0] > 200) & (a[..., 2] > 200) & (a[..., 1] < 60)
        h, w = (m.shape[0] // 16) * 16, (m.shape[1] // 16) * 16
        blocks = m[:h, :w].reshape(h // 16, 16, w // 16, 16).mean(axis=(1, 3))
        return float((blocks > 0.15).mean())
    hole_ratio = await asyncio.to_thread(_holes)
    return {"url": f"/uploads/{out_name}", "hole_ratio": round(hole_ratio, 3),
            "azimuth": req.azimuth, "elevation": req.elevation}


@app.post("/render-pass")
async def render_pass(req: RenderPassRequest):
    """Render one geometry pass of a splat from a given camera."""
    if not await comfyui.health_check():
        raise HTTPException(503, "ComfyUI is not running.")
    if req.render_style not in ("depth", "normal", "clay", "color"):
        raise HTTPException(422, f"Unknown render_style: {req.render_style}")
    try:
        ply_path = await resolve_upload(req.ply_url)
        camera = req.model_dump(exclude={"ply_url", "render_style", "width", "height"})
        png = await comfyui.render_splat_pass(
            str(ply_path), width=req.width, height=req.height,
            render_style=req.render_style, **camera,
        )
        out_name = f"pass_{req.render_style}_{uuid.uuid4().hex}.png"
        (UPLOAD_DIR / out_name).write_bytes(png)
        return {"url": f"/uploads/{out_name}", "filename": out_name}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class PanoReconstructRequest(BaseModel):
    panorama_url: str
    fov_degrees: float = 65.0
    overlap_percent: float = 10.0
    output_size: int = 1024
    skip_poles: bool = True
    output_prefix: str = "panoscene"


@app.post("/reconstruct-panorama")
async def reconstruct_panorama(req: PanoReconstructRequest):
    """Panorama -> overlapping views with extrinsics -> one merged splat."""
    if not await comfyui.health_check():
        raise HTTPException(503, "ComfyUI is not running.")
    try:
        path = await resolve_upload(req.panorama_url)
        comfy_name = await comfyui.upload_image(path.read_bytes(), path.name)
        merged = await comfyui.reconstruct_from_panorama(
            panorama_filename=comfy_name, fov_degrees=req.fov_degrees,
            overlap_percent=req.overlap_percent, output_size=req.output_size,
            skip_poles=req.skip_poles, output_prefix=req.output_prefix,
        )
        import shutil
        out_name = f"panoscene_{uuid.uuid4().hex}.ply"
        shutil.copy2(merged, UPLOAD_DIR / out_name)
        return {"url": f"/uploads/{out_name}", "filename": out_name,
                "size": (UPLOAD_DIR / out_name).stat().st_size}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class MergeViewsRequest(BaseModel):
    views: list                        # [{"ply_url": ..., "translate": [x,y,z], "rotate": [rx,ry,rz]}]
    filename_prefix: str = "merged_scene"


@app.post("/merge-views")
async def merge_views(req: MergeViewsRequest):
    """Fuse per-view reconstructions into one splat covering the whole location."""
    if not await comfyui.health_check():
        raise HTTPException(503, "ComfyUI is not running.")
    if len(req.views) < 2:
        raise HTTPException(422, "At least two views are required")
    try:
        resolved = []
        for v in req.views:
            path = await resolve_upload(v["ply_url"])
            resolved.append({
                "ply_path": str(path),
                "translate": tuple(v.get("translate", (0.0, 0.0, 0.0))),
                "rotate": tuple(v.get("rotate", (0.0, 0.0, 0.0))),
            })
        merged = await comfyui.merge_multiview_splats(resolved, req.filename_prefix)

        import shutil
        out_name = f"merged_{uuid.uuid4().hex}.ply"
        shutil.copy2(merged, UPLOAD_DIR / out_name)
        return {"url": f"/uploads/{out_name}", "filename": out_name,
                "size": (UPLOAD_DIR / out_name).stat().st_size}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class RepairViewRequest(BaseModel):
    broken_view_url: str               # a splat render from a camera the shell can't cover
    reference_url: str                 # the original plate
    prompt: str = "高斯泼溅,参考图2的场景图，修复图1的场景图透视并修复空白区域"
    steps: int = 10
    cfg: float = 1.0
    seed: int = -1
    denoise: float = 1.0


@app.post("/repair-view")
async def repair_view(req: RepairViewRequest):
    """Turn a torn novel-view render into a clean one usable for re-reconstruction."""
    if not await comfyui.health_check():
        raise HTTPException(503, "ComfyUI is not running.")
    try:
        broken = await resolve_upload(req.broken_view_url)
        ref = await resolve_upload(req.reference_url)
        comfy_broken = await comfyui.upload_image(broken.read_bytes(), broken.name)
        comfy_ref = await comfyui.upload_image(ref.read_bytes(), ref.name)

        png = await comfyui.repair_gaussian_view(
            broken_view_filename=comfy_broken, reference_filename=comfy_ref,
            prompt=req.prompt, steps=req.steps, cfg=req.cfg,
            seed=req.seed, denoise=req.denoise,
        )
        out_name = f"repaired_{uuid.uuid4().hex}.png"
        (UPLOAD_DIR / out_name).write_bytes(png)
        return {"url": f"/uploads/{out_name}", "filename": out_name}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class ExtractPoseRequest(BaseModel):
    image_url: str


@app.post("/extract-pose")
async def extract_pose(req: ExtractPoseRequest):
    """Generate 3D Pose GLB from image using ComfyUI SCAIL workflow."""
    if not await comfyui.health_check():
        raise HTTPException(503, "ComfyUI is not running.")

    try:
        target_path = await resolve_upload(req.image_url)
        comfy_image = await comfyui.upload_image(target_path.read_bytes(), target_path.name)

        glb_path_str = await comfyui.generate_pose(comfy_image)

        # Copy to local uploads dir
        import shutil
        unique_name = f"pose_{uuid.uuid4().hex}.glb"
        local_path = UPLOAD_DIR / unique_name
        shutil.copy2(glb_path_str, local_path)

        return {"url": f"/uploads/{unique_name}"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/extract-wholebody-3d")
async def extract_wholebody_3d(req: ExtractPoseRequest):
    """
    Extract full-body 3D joints (body 33 + hands 21×2 + face key pts) via MediaPipe Holistic.
    Returns JSON with 3D world coordinates — loaded by the pose viewer's wholebody mode.
    """
    try:
        target_path = await resolve_upload(req.image_url)

        from wholebody_extractor import extract_wholebody_3d as _extract
        data = await asyncio.get_event_loop().run_in_executor(None, _extract, str(target_path))

        unique_name = f"wholebody_{uuid.uuid4().hex}.json"
        (UPLOAD_DIR / unique_name).write_text(json.dumps(data), encoding="utf-8")
        return {"url": f"/uploads/{unique_name}", "detected": data["detected"]}
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/extract-dwpose")
async def extract_dwpose(req: ExtractPoseRequest):
    """Extract full-body OpenPose image (body + face + hands) via DWPreprocessor."""
    if not await comfyui.health_check():
        raise HTTPException(503, "ComfyUI is not running.")

    try:
        target_path = await resolve_upload(req.image_url)
        comfy_image = await comfyui.upload_image(target_path.read_bytes(), target_path.name)
        pose_png = await comfyui.extract_openpose_image(comfy_image)

        unique_name = f"dwpose_{uuid.uuid4().hex}.png"
        (UPLOAD_DIR / unique_name).write_bytes(pose_png)
        return {"url": f"/uploads/{unique_name}"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class GaussianCaptureRequest(BaseModel):
    image: str          # base64 data URL  (data:image/png;base64,...)
    ply_filename: str = "scene"


@app.post("/gaussian/capture")
async def gaussian_capture(req: GaussianCaptureRequest):
    """Receive a rendered screenshot from the Gaussian viewer iframe and save it."""
    import base64 as _base64
    from io import BytesIO as _BytesIO
    from PIL import Image as _Image

    data_url = req.image
    if "," in data_url:
        data_url = data_url.split(",", 1)[1]

    try:
        img_bytes = _base64.b64decode(data_url)
        # Validate it's a real image
        _Image.open(_BytesIO(img_bytes)).verify()
        img_bytes = _base64.b64decode(data_url)  # re-decode after verify() exhausts buffer
    except Exception as e:
        raise HTTPException(400, f"Invalid image data: {e}")

    base = Path(req.ply_filename).stem[:40]
    out_name = f"gaussian_capture_{base}_{uuid.uuid4().hex[:8]}.png"
    out_path = UPLOAD_DIR / out_name
    out_path.write_bytes(img_bytes)

    return {
        "url": f"/uploads/{out_name}",
        "filename": out_name,
    }


# ── AI Assistant History Persistence ──────────────────────────────────────────

def _assistant_history_file(project_id: Optional[str] = None, workspace: str = "default") -> Path:
    if project_id:
        pdir = _project_dir(project_id, workspace)
        if pdir.exists():
            return pdir / "assistant_history.json"
        return UPLOAD_DIR / f"assistant_history_{project_id}.json"
    return UPLOAD_DIR / "assistant_history.json"


class AssistantHistoryRequest(BaseModel):
    messages: list[dict]
    model: Optional[str] = None
    customApiKey: Optional[str] = None
    customBaseUrl: Optional[str] = None
    project_id: Optional[str] = None
    workspace: str = "default"


@app.get("/api/assistant/history")
async def get_assistant_history(
    project_id: Optional[str] = None,
    workspace: str = "default",
    limit: Optional[int] = None,
    offset: Optional[int] = None
):
    """Retrieve persisted AI Assistant conversation history and preferences for a specific project."""
    history_file = _assistant_history_file(project_id, workspace)
    if history_file.exists():
        try:
            data = json.loads(history_file.read_text(encoding="utf-8"))
            messages = data.get("messages", [])
            total = len(messages)
            if limit is not None and limit > 0:
                # If offset is provided, slice accordingly, else slice latest `limit`
                if offset is not None:
                    sliced = messages[offset:offset + limit]
                else:
                    sliced = messages[-limit:]
                return {
                    **data,
                    "messages": sliced,
                    "total": total,
                }
            return {
                **data,
                "total": total,
            }
        except Exception as e:
            logger.warning(f"Failed to read assistant history from {history_file}: {e}")
    return {"messages": [], "model": "moonshotai/kimi-k3", "total": 0}


@app.post("/api/assistant/history")
async def save_assistant_history(req: AssistantHistoryRequest):
    """Save AI Assistant conversation history and preferences to server storage for a specific project."""
    try:
        data = {
            "messages": req.messages,
            "model": req.model,
            "customApiKey": req.customApiKey,
            "customBaseUrl": req.customBaseUrl,
            "project_id": req.project_id,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        history_file = _assistant_history_file(req.project_id, req.workspace)
        history_file.parent.mkdir(parents=True, exist_ok=True)
        history_file.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        return {"ok": True}
    except Exception as e:
        logger.error(f"Failed to save assistant history: {e}")
        raise HTTPException(500, f"Failed to save history: {e}")


@app.delete("/api/assistant/history")
async def clear_assistant_history(project_id: Optional[str] = None, workspace: str = "default"):
    """Clear AI Assistant conversation history for a specific project."""
    try:
        history_file = _assistant_history_file(project_id, workspace)
        if history_file.exists():
            history_file.unlink(missing_ok=True)
        return {"ok": True}
    except Exception as e:
        logger.error(f"Failed to clear assistant history: {e}")
        raise HTTPException(500, f"Failed to clear history: {e}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=BACKEND_PORT)
