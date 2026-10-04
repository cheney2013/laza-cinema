"""Live whole-clip preview of MiniMax H3 renders, decoded on the CPU.

ComfyUI's own latent preview shows only the first frame and decodes on the
GPU. This wraps latent_preview.prepare_callback: after every sampler step the
current x0 estimate (video channels only, ~15 MB) is copied to host memory and
handed to a low-priority worker process that decodes the whole clip with taeh3
at half spatial resolution (~3 s for 146 frames at 768x1376 on 32 threads) and
writes output/live_preview/<prompt_id>_s<step>.mp4. A step that arrives while
the worker is busy replaces the queued one, so the sampler never waits.

The GPU cost is one device-to-host copy per step. Each written clip is
announced on the websocket as "aicinema.live_preview".

Kept outside core files so ComfyUI updates do not remove it. Disable by setting
AICINEMA_LIVE_PREVIEW=0 before starting ComfyUI.
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

log = logging.getLogger("aicinema-live-preview")
HERE = Path(__file__).resolve().parent
OUT_SUB = "live_preview"
ENABLED = os.environ.get("AICINEMA_LIVE_PREVIEW", "1") != "0"


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
        self.wake = threading.Event()
        self.tmp = Path(tempfile.gettempdir()) / "aicinema_live_preview"
        self.tmp.mkdir(exist_ok=True)
        threading.Thread(target=self._loop, daemon=True, name="live-preview").start()

    def _start(self):
        flags = 0
        if sys.platform == "win32":
            flags = subprocess.BELOW_NORMAL_PRIORITY_CLASS | subprocess.CREATE_NO_WINDOW
        self.proc = subprocess.Popen(
            [sys.executable, str(HERE / "worker.py")],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, bufsize=1, creationflags=flags,
            cwd=str(Path(folder_paths.base_path)),
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
                log.warning("live preview worker failed", exc_info=True)
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
                    log.warning("live preview disabled after %d failed decodes "
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
                PromptServer.instance.send_sync("aicinema.live_preview", {
                    "prompt_id": prompt_id, "step": step, "total": total,
                    "filename": name, "subfolder": OUT_SUB})
            except Exception:  # noqa: BLE001
                pass


_worker = None
_original = latent_preview.prepare_callback
_opted_out_cache: dict = {}


def _opted_out(prompt_id) -> bool:
    """The prompt was queued with extra_data {"aicinema_live_preview": false} (a spoken line, whose picture
    nobody looks at)."""
    if prompt_id in _opted_out_cache:
        return _opted_out_cache[prompt_id]
    out = False
    try:
        import server
        queue = server.PromptServer.instance.prompt_queue
        with queue.mutex:
            for item in queue.currently_running.values():
                if item[1] == prompt_id and len(item) > 3 and isinstance(item[3], dict):
                    out = item[3].get("aicinema_live_preview") is False
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
            log.warning("live preview capture failed", exc_info=True)
    return callback


latent_preview.prepare_callback = prepare_callback

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
