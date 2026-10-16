"""ComfyUI-H3-ClipPreview: whole-clip sampling preview for MiniMax H3, decoded on the CPU.

ComfyUI's built-in latent preview shows the first frame only and decodes on the
GPU. This wraps latent_preview.prepare_callback: after every sampler step the
current x0 estimate (video channels only, ~15 MB) is copied to host memory and
handed to a low-priority worker process that decodes the whole clip with taeh3
at half spatial resolution and writes output/h3_clip_preview/<prompt_id>_s<step>.mp4.
A step that arrives while the worker is busy replaces the queued one, so the
sampler never waits. The GPU cost is one device-to-host copy per step.

Each written clip is announced on the websocket as "h3_clip_preview"
({prompt_id, step, total, filename, subfolder}).

Disable by setting H3_CLIP_PREVIEW=0 before starting ComfyUI, or per prompt with
extra_data {"h3_clip_preview": false}.
"""
import logging
import os
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

import torch

import folder_paths
import latent_preview

log = logging.getLogger("h3-clip-preview")
HERE = Path(__file__).resolve().parent
OUT_SUB = "h3_clip_preview"
EVENT = "h3_clip_preview"
ENABLED = os.environ.get("H3_CLIP_PREVIEW", os.environ.get("AICINEMA_LIVE_PREVIEW", "1")) != "0"


# The decode process holds about 5 GB; below this much free RAM the step is skipped.
MIN_FREE_GB = float(os.environ.get("H3_CLIP_PREVIEW_MIN_FREE_GB", "8"))


def _low_memory() -> bool:
    try:
        import psutil
        return psutil.virtual_memory().available < MIN_FREE_GB * 2**30
    except Exception:  # noqa: BLE001 -- without psutil there is no check
        return False


def _is_h3(model) -> bool:
    try:
        fmt = model.model.latent_format
    except AttributeError:
        return False
    return type(fmt).__name__.startswith("MiniMaxH3")


class _Worker:
    """One decode subprocess, fed the latest latent only."""

    def __init__(self):
        self.proc = None
        self.lock = threading.Lock()
        self.pending = None          # (prompt_id, step, total, latent)
        self.busy = False            # a decode is running; the callback skips its copy
        self.fails = 0               # consecutive failed decodes
        self.disabled = False        # taeh3 missing or ffmpeg broken: stop trying
        self.finished_id = None      # prompt whose sampling has ended
        self.low_memory_noted = None # prompt the low-RAM warning was logged for
        self.wake = threading.Event()
        self.tmp = Path(tempfile.gettempdir()) / "h3_clip_preview"
        self.tmp.mkdir(exist_ok=True)
        threading.Thread(target=self._loop, daemon=True, name="h3-clip-preview").start()

    def _start(self):
        extra = {}
        if sys.platform == "win32":
            extra["creationflags"] = subprocess.BELOW_NORMAL_PRIORITY_CLASS | subprocess.CREATE_NO_WINDOW
        else:
            extra["preexec_fn"] = lambda: os.nice(10)
        self.proc = subprocess.Popen(
            [sys.executable, str(HERE / "worker.py")],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding="utf-8", bufsize=1, cwd=str(Path(folder_paths.base_path)), **extra,
        )

    def submit(self, prompt_id, step, total, latent):
        # Only the host copy happens on the sampler thread; writing it to disk
        # waits for the worker thread.
        with self.lock:
            self.pending = (prompt_id, step, total, latent)
        self.wake.set()

    def finish(self, prompt_id):
        """Sampling of this prompt has ended; let the decode process go once it is idle."""
        self.finished_id = prompt_id
        self.wake.set()

    def _stop_proc(self):
        if self.proc is None:
            return
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=10)
        except Exception:  # noqa: BLE001
            self.proc.kill()
        self.proc = None

    def _loop(self):
        while True:
            self.wake.wait()
            self.wake.clear()
            with self.lock:
                job, self.pending = self.pending, None
            if not job:
                # Nothing queued and the prompt is over: hand the process's ~5 GB back.
                if self.finished_id is not None:
                    self.finished_id = None
                    self._stop_proc()
                continue
            prompt_id, step, total, latent = job
            if (self.proc is None or self.proc.poll() is not None) and _low_memory():
                if self.low_memory_noted != prompt_id:
                    self.low_memory_noted = prompt_id
                    log.warning("clip preview skipped: less than %.0f GB of RAM free "
                                "(H3_CLIP_PREVIEW_MIN_FREE_GB)", MIN_FREE_GB)
                continue
            self.busy = True
            path = self.tmp / f"{prompt_id}_{step}.pt"
            out_dir = Path(folder_paths.get_output_directory()) / OUT_SUB
            out_dir.mkdir(exist_ok=True)
            name = f"{prompt_id}_s{step:02d}.mp4"
            try:
                # %TEMP% gets cleaned while ComfyUI runs for days; recreate it rather
                # than lose every preview until the next restart.
                self.tmp.mkdir(parents=True, exist_ok=True)
                torch.save(latent, path)
                if self.proc is None or self.proc.poll() is not None:
                    self._start()
                self.proc.stdin.write(f"{path}\t{out_dir / name}\n")
                self.proc.stdin.flush()
                reply = self.proc.stdout.readline().strip()
            except Exception:  # noqa: BLE001 -- a preview must never break a render
                log.warning("clip preview worker failed", exc_info=True)
                reply = ""
                self.proc = None
            path.unlink(missing_ok=True)
            self.busy = False
            # Past its last queued step a prompt's decode process ends, so its ~5 GB
            # goes back to the OS before the next prompt stages ~38 GB of weights.
            # On 2026-09-23 the machine froze at exactly that moment with the worker
            # still resident.
            with self.lock:
                idle = self.pending is None
            if idle and self.finished_id == prompt_id:
                self.finished_id = None
                self._stop_proc()
            # taeh3 missing or ffmpeg failing makes the worker exit on every start;
            # a few tries, then stop copying latents for nothing.
            if reply == "ok":
                self.fails = 0
            else:
                self.fails += 1
                if self.fails >= 3 and not self.disabled:
                    self.disabled = True
                    log.warning("clip preview disabled after %d failed decodes "
                                "(is taeh3.safetensors in models/vae_approx?)", self.fails)
                    self._stop_proc()
            if reply != "ok":
                continue
            # Older steps of this prompt are superseded, and a finished prompt's
            # last clip (written after the backend cleaned up) goes with the next one.
            for f in out_dir.glob("*_s*.mp4"):
                if f.name != name:
                    f.unlink(missing_ok=True)
            try:
                from server import PromptServer
                PromptServer.instance.send_sync(EVENT, {
                    "prompt_id": prompt_id, "step": step, "total": total,
                    "filename": name, "subfolder": OUT_SUB})
            except Exception:  # noqa: BLE001
                pass


_worker = None
_original = latent_preview.prepare_callback
if "aicinema-live-preview" in (getattr(_original, "__module__", "") or ""):
    log.warning("the earlier 'aicinema-live-preview' pack is loaded: remove it from custom_nodes, "
                "two copies would decode every step twice")
_opted_out_cache: dict = {}


def _opted_out(prompt_id) -> bool:
    """The prompt was queued with extra_data {"h3_clip_preview": false}."""
    if prompt_id in _opted_out_cache:
        return _opted_out_cache[prompt_id]
    out = False
    try:
        import server
        queue = server.PromptServer.instance.prompt_queue
        with queue.mutex:
            for item in queue.currently_running.values():
                if item[1] == prompt_id and len(item) > 3 and isinstance(item[3], dict):
                    out = (item[3].get("h3_clip_preview") is False
                           or item[3].get("h3_clip_preview") is False)
    except Exception:  # noqa: BLE001
        out = False
    if len(_opted_out_cache) > 64:
        _opted_out_cache.clear()
    _opted_out_cache[prompt_id] = out
    return out


def prepare_callback(model, steps, x0_output_dict=None, *args, **kwargs):
    inner = _original(model, steps, x0_output_dict, *args, **kwargs)
    if not ENABLED or not _is_h3(model):
        return inner

    def callback(step, x0, x, total_steps):
        inner(step, x0, x, total_steps)
        global _worker
        try:
            from comfy_execution.utils import get_executing_context
            ctx = get_executing_context()
            if ctx is None or _opted_out(ctx.prompt_id):
                return
            # The last step's clip would land just as the real decode finishes.
            if step + 1 >= total_steps:
                if _worker is not None:
                    _worker.finish(ctx.prompt_id)
                return
            # A decode is still running and would replace this step anyway: skip the copy.
            if _worker is not None and (_worker.disabled or _worker.busy):
                return
            lat = x0.tensors[0] if getattr(x0, "is_nested", False) else x0
            lat = lat[:1, :24].detach().to("cpu", torch.float16)
            if _worker is None:
                _worker = _Worker()
            _worker.submit(ctx.prompt_id, step + 1, total_steps, lat)
        except Exception:  # noqa: BLE001
            log.warning("clip preview capture failed", exc_info=True)
    return callback


def _compat_problems() -> list:
    """Names this pack relies on that are not public ComfyUI API. Verified on ComfyUI 0.38.0."""
    problems = []
    if not callable(getattr(latent_preview, "prepare_callback", None)):
        problems.append("latent_preview.prepare_callback")
    try:
        from comfy_execution.utils import get_executing_context  # noqa: F401
    except Exception:  # noqa: BLE001
        problems.append("comfy_execution.utils.get_executing_context")
    try:
        from comfy.taesd.taehv import MemBlock, TGrow, TPool, TWorkItem  # noqa: F401
    except Exception:  # noqa: BLE001
        problems.append("comfy.taesd.taehv (MemBlock, TGrow, TPool, TWorkItem)")
    try:
        import server
        if not hasattr(server.PromptServer, "send_sync"):
            problems.append("server.PromptServer.send_sync")
    except Exception:  # noqa: BLE001
        problems.append("server.PromptServer")
    return problems


_problems = _compat_problems()
if _problems:
    log.warning("ComfyUI-H3-ClipPreview is inactive: this ComfyUI lacks %s (verified on ComfyUI 0.38.0)",
                ", ".join(_problems))
else:
    latent_preview.prepare_callback = prepare_callback

WEB_DIRECTORY = "./web"

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
