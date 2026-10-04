"""ComfyUI WebSocket + REST client for local FLUX model inference.

Workflow graphs themselves live in workflow_builders.py (and ./workflows/*.json);
this module handles transport: upload, queueing, progress, and result retrieval.
"""

import os

try:
    from envfile import comfyui_dir
except ImportError:  # imported as backend.comfyui_client
    from backend.envfile import comfyui_dir

import io
import json
import time
import uuid
import random
import asyncio
import logging
from typing import Optional

from pathlib import Path

import httpx
import socket
import ssl
from urllib.parse import urlparse

import websockets

import workflow_builders as wb


# Building an httpx client loads the CA bundle: about 67 ms of CPU on the event loop, every time (measured
# 2026-10-03). Every wait on a ComfyUI job polled with a new client every 2 s, so with a few dozen jobs
# waiting the loop spent its time making SSL contexts and /health took up to 16 s. One context, shared.
_SSL_CONTEXT = ssl.create_default_context()


def _http(**kwargs):
    """httpx.AsyncClient that reuses the process's SSL context instead of building its own."""
    kwargs.setdefault("verify", _SSL_CONTEXT)
    return httpx.AsyncClient(**kwargs)

logger = logging.getLogger(__name__)

def _listening(url: str) -> bool:
    """Whether anything is accepting connections at `url`'s host:port."""
    try:
        parsed = urlparse(url)
        with socket.socket() as sock:
            sock.settimeout(0.4)
            return sock.connect_ex((parsed.hostname or "127.0.0.1",
                                    parsed.port or (443 if parsed.scheme == "https" else 80))) == 0
    except Exception:
        return False


def _resolve_comfyui_url() -> str:
    """Resolve ComfyUI URL from environment variable or root .env file.

    A configured URL wins, but only if something is actually listening on it: the desktop
    app does not always come back on the same port, alternating between 8188 and 8189
    across restarts, and a pinned port that has moved leaves every job failing to connect
    for a reason that looks nothing like a port problem.
    """
    configured = os.environ.get("COMFYUI_URL")
    if not configured:
        for env_path in [Path(__file__).parent.parent / ".env", Path(__file__).parent / ".env"]:
            if env_path.is_file():
                try:
                    for line in env_path.read_text(encoding="utf-8").splitlines():
                        line = line.strip()
                        if line.startswith("COMFYUI_URL=") and not line.startswith("#"):
                            configured = line.split("=", 1)[1].strip().strip('"').strip("'")
                            break
                except Exception:
                    pass
            if configured:
                break

    if configured:
        configured = configured.rstrip("/")
        if _listening(configured):
            return configured

    for port in (8188, 8189):
        candidate = f"http://127.0.0.1:{port}"
        if _listening(candidate):
            if configured:
                logger.warning("ComfyUI is not on %s; using %s instead", configured, candidate)
            return candidate

    return configured or "http://127.0.0.1:8188"


COMFYUI_BASE = _resolve_comfyui_url()
COMFYUI_WS = COMFYUI_BASE.replace("http://", "ws://").replace("https://", "wss://")


def _resolve_comfyui_dir(var: str) -> str:
    """ComfyUI's output / input directory (envfile.comfyui_dir), logged loudly when unknown:
    docs/DEPLOY.md and tools/check_install.py explain how to set it."""
    value = comfyui_dir(var)
    if not value:
        logger.error("%s is not set: files ComfyUI writes (clips, point clouds) cannot be found. "
                     "Set it in .env to the output/input folder of your ComfyUI install.", var)
    return value


# ComfyUI's own output directory — SHARP/NLF nodes write .ply/.glb files here
COMFYUI_OUTPUT_DIR = _resolve_comfyui_dir("COMFYUI_OUTPUT_DIR")
# 3D file inputs resolve against ComfyUI's input dir, the same way LoadImage does,
# so a generated .ply has to be moved there before a workflow can reference it.
COMFYUI_INPUT_DIR = _resolve_comfyui_dir("COMFYUI_INPUT_DIR")


def _resolve_seed(seed: int) -> int:
    return seed if seed != -1 else random.randint(0, 2**32 - 1)


class ComfyUIError(Exception):
    pass


def _describe_node_phase(class_type: str, node_id: str = "") -> str:
    ct = (class_type or "").lower()
    if "unetloader" in ct or "diffusion" in ct or "checkpoint" in ct:
        return "正在加载 DiT 扩散模型与权重…"
    if "cliploader" in ct or ("clip" in ct and "loader" in ct):
        return "正在加载文本编码器模型…"
    if "vaeloader" in ct or ("vae" in ct and "loader" in ct):
        return "正在加载 VAE 编解码器…"
    if "loraloader" in ct or "lora" in ct:
        return "正在加载 LoRA 权重…"
    if "referencetovideo" in ct or "imagetovideo" in ct or "textencode" in ct:
        return "正在解析提示词与编码参考特征…"
    if "sampler" in ct or "ksampler" in ct:
        return "扩散去噪采样中…"
    if "vaedecode" in ct:
        return "正在进行 VAE 解码与音视频合成…"
    if "createvideo" in ct or "savevideo" in ct or "saveimage" in ct or "savelatent" in ct:
        return "正在封装输出视频与缓存…"
    if "upscale" in ct or "rife" in ct or "interpolate" in ct:
        return "正在进行画质增强与后处理…"
    if class_type:
        return f"正在执行: {class_type}…"
    return "正在初始化引擎与加载权重…"


def _machine_profile():
    """machine_profile, imported late: it reads COMFYUI_BASE from this module."""
    try:
        import machine_profile
    except ImportError:
        from backend import machine_profile
    return machine_profile


class ComfyUIClient:
    def __init__(self, base_url: Optional[str] = None):
        self.base_url = (base_url or _resolve_comfyui_url()).rstrip("/")
        self.ws_url = self.base_url.replace("http://", "ws://").replace("https://", "wss://")
        self.client_id = str(uuid.uuid4())
        self._workflows: dict[str, dict] = {}
        self._progress: dict[str, dict] = {}
        self._client_ids: dict[str, str] = {}
        self.active_prompt_id: Optional[str] = None
        # Where each prompt's time went: per-node seconds and raw per-step
        # sampler seconds, kept after _cleanup so the worker can file them with
        # the job (take_timings). seq orders prompts across jobs.
        self._timing: dict[str, dict] = {}
        self.timing_seq = 0

    def _timing_node(self, prompt_id: str, class_type: Optional[str]) -> None:
        """Close the running node's clock and, if class_type, start the next."""
        t = self._timing.get(prompt_id)
        if t is None:
            return
        now = time.time()
        if t.get("cur") is not None:
            t["nodes"].append([t["cur"], now - t["cur_t"]])
        t["cur"], t["cur_t"] = class_type, now
        if class_type is not None and t.get("started") is None:
            t["started"] = now

    def take_timings(self, since_seq: int) -> list[dict]:
        """Remove and return timings of prompts queued at or after since_seq."""
        out = [t for t in self._timing.values() if t["seq"] >= since_seq]
        for pid in [p for p, t in self._timing.items() if t["seq"] >= since_seq]:
            del self._timing[pid]
        return sorted(out, key=lambda t: t["seq"])

    def _ensure_active_url(self) -> None:
        if not _listening(self.base_url):
            new_base = _resolve_comfyui_url()
            if new_base != self.base_url:
                logger.info("ComfyUI URL dynamic switch: %s -> %s", self.base_url, new_base)
                self.base_url = new_base.rstrip("/")
                self.ws_url = self.base_url.replace("http://", "ws://").replace("https://", "wss://")

    def _cleanup(self, prompt_id: str) -> None:
        self._timing_node(prompt_id, None)
        # Live previews are only for watching a render; the finished clip replaces them.
        try:
            for f in (Path(COMFYUI_OUTPUT_DIR) / "live_preview").glob(f"{prompt_id}_s*.mp4"):
                f.unlink(missing_ok=True)
        except OSError:
            pass
        self._progress.pop(prompt_id, None)
        self._workflows.pop(prompt_id, None)
        self._client_ids.pop(prompt_id, None)
        if self.active_prompt_id == prompt_id:
            self.active_prompt_id = None

    @staticmethod
    def _history_outcome(history: dict, prompt_id: str) -> Optional[str]:
        """'success' | 'error' | 'interrupted' for a finished prompt, else None.

        Presence in history does NOT mean success -- interrupted and failed runs
        are recorded too, and treating them as done yields an empty output set
        that surfaces as a job that "finished" with nothing in it.
        """
        rec = history.get(prompt_id)
        if not rec:
            return None
        status = rec.get("status") or {}
        for event, _data in reversed(status.get("messages") or []):
            if event == "execution_success":
                return "success"
            if event == "execution_error":
                return "error"
            if event == "execution_interrupted":
                return "interrupted"
        if status.get("completed"):
            return "success"
        s = status.get("status_str")
        if s == "success":
            return "success"
        if s == "error":
            return "error"
        # Recorded but unlabelled (older builds): fall back to treating it as done.
        return "success" if rec.get("outputs") else None

    async def health_check(self) -> bool:
        self._ensure_active_url()
        try:
            async with _http(timeout=3) as client:
                r = await client.get(f"{self.base_url}/system_stats")
                return r.status_code == 200
        except Exception:
            return False

    async def get_system_stats(self) -> dict:
        self._ensure_active_url()
        try:
            async with _http(timeout=3) as client:
                r = await client.get(f"{self.base_url}/system_stats")
                if r.status_code == 200:
                    return r.json()
        except Exception as e:
            logger.error(f"Error fetching ComfyUI system stats: {e}")
        return {}

    async def require_node_class(self, class_type: str, hint: str) -> None:
        """Fail with a clear message when ComfyUI has not loaded a custom node class.

        A missing class otherwise shows up only as a rejected prompt at submit time.
        """
        self._ensure_active_url()
        try:
            async with _http(timeout=10) as client:
                r = await client.get(f"{self.base_url}/object_info/{class_type}")
                known = r.status_code == 200 and class_type in (r.json() or {})
        except Exception as e:
            raise RuntimeError(f"could not ask ComfyUI whether {class_type} is loaded: {e}") from e
        if not known:
            raise RuntimeError(f"ComfyUI has no node {class_type}. {hint}")

    async def upload_image(self, image_bytes: bytes, filename: str) -> str:
        """Upload image to ComfyUI input folder, return filename."""
        async with _http(timeout=30) as client:
            files = {"image": (filename, io.BytesIO(image_bytes), "image/png")}
            data = {"type": "input", "overwrite": "true"}
            r = await client.post(f"{self.base_url}/upload/image", files=files, data=data)
            if r.status_code != 200:
                raise ComfyUIError(f"Upload failed: {r.text}")
            result = r.json()
            return result.get("name", filename)

    async def upload_video(self, video_bytes: bytes, filename: str) -> str:
        """Upload video to ComfyUI input folder via the /upload/image endpoint."""
        async with _http(timeout=120) as client:
            files = {"image": (filename, io.BytesIO(video_bytes), "video/mp4")}
            data = {"type": "input", "overwrite": "true"}
            r = await client.post(f"{self.base_url}/upload/image", files=files, data=data)
            if r.status_code != 200:
                raise ComfyUIError(f"Video upload failed: {r.text}")
            return r.json().get("name", filename)

    async def upload_audio(self, audio_bytes: bytes, filename: str) -> str:
        """Upload an audio file to ComfyUI's input folder."""
        suffix = Path(filename).suffix.lower()
        content_type = {
            ".m4a": "audio/mp4",
            ".mp3": "audio/mpeg",
            ".wav": "audio/wav",
            ".flac": "audio/flac",
            ".ogg": "audio/ogg",
            ".aac": "audio/aac",
        }.get(suffix, "application/octet-stream")
        async with _http(timeout=120) as client:
            files = {"image": (filename, io.BytesIO(audio_bytes), content_type)}
            data = {"type": "input", "overwrite": "true"}
            r = await client.post(f"{self.base_url}/upload/image", files=files, data=data)
            if r.status_code != 200:
                raise ComfyUIError(f"Audio upload failed: {r.text}")
            return r.json().get("name", filename)

    async def queue_prompt(self, workflow: dict, live_preview: bool = True) -> str:
        """Submit workflow, return prompt_id. `live_preview=False` asks the aicinema-live-preview plugin to
        skip this prompt (it reads the flag from the prompt's extra_data)."""
        self._ensure_active_url()
        cid = str(uuid.uuid4())
        payload = {"prompt": workflow, "client_id": cid}
        if not live_preview:
            payload["extra_data"] = {"aicinema_live_preview": False}
        async with _http(timeout=30) as client:
            r = await client.post(f"{self.base_url}/prompt", json=payload)
            if r.status_code != 200:
                try:
                    err_json = r.json()
                    node_errors = err_json.get("node_errors", {})
                    if node_errors:
                        details = []
                        for nid, errs in node_errors.items():
                            for e in errs.get("errors", []):
                                details.append(f"Node {nid}: {e.get('message', e.get('type', ''))}")
                        if details:
                            raise ComfyUIError("; ".join(details))
                    err_msg = err_json.get("error", {}).get("message") or err_json.get("message") or r.text
                    raise ComfyUIError(f"ComfyUI validation error: {err_msg}")
                except (json.JSONDecodeError, Exception) as e:
                    if isinstance(e, ComfyUIError):
                        raise
                    raise ComfyUIError(f"Queue failed: {r.text}")
            res = r.json()
            if "prompt_id" not in res:
                raise ComfyUIError(f"ComfyUI did not return a prompt_id: {res}")
            prompt_id = res["prompt_id"]
            self._workflows[prompt_id] = workflow
            self._client_ids[prompt_id] = cid
            self.active_prompt_id = prompt_id
            self.timing_seq += 1
            self._timing[prompt_id] = {"seq": self.timing_seq, "started": None, "queued": time.time(),
                                       "nodes": [], "steps": [], "cur": None, "cur_t": None}
            for old in list(self._timing)[:-64]:
                del self._timing[old]
            self._progress[prompt_id] = {
                "step": 0,
                "max": 0,
                "eta": None,
                "speed": None,
                "phase": "已提交至渲染队列，等待启动…",
                "node_id": None,
                "node_type": None,
                "start_time": None,
                "last_time": time.time(),
            }
            return prompt_id

    async def interrupt(self, prompt_id: str) -> bool:
        """Interrupt `prompt_id` if -- and only if -- it is the one executing.

        Always sends the prompt_id: a bare POST /interrupt is a global
        interrupt in ComfyUI and kills whatever is running, including jobs
        submitted by other clients. With a prompt_id, ComfyUI (server.py
        post_interrupt) checks it against queue_running and skips otherwise.
        """
        async with _http(timeout=10) as client:
            try:
                r = await client.post(f"{self.base_url}/interrupt",
                                      json={"prompt_id": prompt_id})
                return r.status_code == 200
            except Exception:
                return False

    async def cancel_prompt(self, prompt_id: Optional[str] = None) -> bool:
        """Stop our prompt without touching anyone else's.

        Running -> targeted interrupt; pending -> removed from the queue.
        Without a prompt_id there is nothing we can safely stop.
        """
        if not prompt_id:
            logger.warning("cancel_prompt called without prompt_id; not interrupting ComfyUI")
            return False
        try:
            async with _http(timeout=5) as client:
                r = await client.get(f"{self.base_url}/queue")
                r.raise_for_status()
                q = r.json()
        except Exception as e:
            # Can't see the queue: both calls below are scoped to prompt_id,
            # so issuing both is still safe for other clients' jobs.
            logger.warning("Could not read ComfyUI queue to cancel %s: %s", prompt_id, e)
            q = None
        running = q is None or any(len(it) > 1 and it[1] == prompt_id
                                   for it in q.get("queue_running", []) or [])
        pending = q is None or any(len(it) > 1 and it[1] == prompt_id
                                   for it in q.get("queue_pending", []) or [])
        ok = True
        if pending:
            try:
                async with _http(timeout=5) as client:
                    r = await client.post(f"{self.base_url}/queue", json={"delete": [prompt_id]})
                    ok = r.status_code == 200
            except Exception as e:
                logger.warning(f"Failed to delete prompt {prompt_id} from ComfyUI queue: {e}")
                ok = False
        if running:
            ok = await self.interrupt(prompt_id) and ok
        return ok

    async def abandon_prompt(self, prompt_id: str) -> str:
        """Stop a prompt this process will never collect the result of.

        Used when the backend restarts around a running job: the job is failed
        on our side, but ComfyUI would carry on rendering it and the next real
        job would wait behind it for its whole duration. Only touches ComfyUI
        when the prompt is actually still there -- the interrupt is
        targeted by prompt_id so it never hits whatever else is running.

        Returns 'interrupted' | 'dequeued' | 'absent' | 'unreachable'.
        """
        try:
            async with _http(timeout=5) as client:
                r = await client.get(f"{self.base_url}/queue")
                if r.status_code != 200:
                    return "unreachable"
                q = r.json()
                running = any(len(it) > 1 and it[1] == prompt_id
                              for it in q.get("queue_running", []) or [])
                pending = any(len(it) > 1 and it[1] == prompt_id
                              for it in q.get("queue_pending", []) or [])
                if pending:
                    await client.post(f"{self.base_url}/queue", json={"delete": [prompt_id]})
                    logger.info("Removed orphaned prompt %s from ComfyUI queue", prompt_id)
                    return "dequeued"
                if running:
                    await client.post(f"{self.base_url}/interrupt",
                                      json={"prompt_id": prompt_id})
                    logger.info("Interrupted orphaned prompt %s in ComfyUI", prompt_id)
                    return "interrupted"
                return "absent"
        except Exception as e:
            logger.warning("Could not abandon prompt %s: %s", prompt_id, e)
            return "unreachable"
        finally:
            self._cleanup(prompt_id)

    async def prompt_state(self, prompt_id: str) -> tuple[str, dict]:
        """Where a prompt stands, asked of ComfyUI itself, for a job this process did not queue.

        Returns (state, outputs): state is 'success' | 'error' | 'interrupted' (from
        history, outputs filled on success), 'running' | 'pending' (still queued),
        'gone' (ComfyUI knows nothing of it, e.g. it restarted) or 'unreachable'.
        """
        try:
            async with _http(timeout=10) as client:
                r = await client.get(f"{self.base_url}/history/{prompt_id}")
                if r.status_code != 200:
                    return "unreachable", {}
                history = r.json()
                outcome = self._history_outcome(history, prompt_id)
                if outcome:
                    return outcome, (history.get(prompt_id) or {}).get("outputs", {}) or {}
                q = await client.get(f"{self.base_url}/queue")
                if q.status_code != 200:
                    return "unreachable", {}
                queue = q.json()
                for key, state in (("queue_running", "running"), ("queue_pending", "pending")):
                    if any(len(it) > 1 and it[1] == prompt_id for it in queue.get(key, []) or []):
                        return state, {}
                return "gone", {}
        except Exception as e:  # noqa: BLE001 -- any failure means "cannot tell"
            logger.warning("Could not read state of prompt %s: %s", prompt_id, e)
            return "unreachable", {}

    @staticmethod
    def output_files(outputs: dict) -> tuple[list[dict], Optional[str]]:
        """Media files a finished prompt saved (videos first, then audio, then images), and its latent."""
        media: list[tuple[int, dict]] = []
        latent = None
        for node_output in outputs.values():
            if not isinstance(node_output, dict):
                continue
            for rank, key in enumerate(("videos", "gifs", "audio", "images")):
                for item in node_output.get(key, []) or []:
                    if isinstance(item, dict) and item.get("type") == "output" and item.get("filename"):
                        media.append((rank, item))
            for key in ("latents", "latent"):
                for item in node_output.get(key, []) or []:
                    name = item.get("filename") if isinstance(item, dict) else item
                    if isinstance(name, str) and name.endswith((".latent", ".safetensors")):
                        latent = latent or Path(name).name
        # The untrimmed continuation (H3_Full_) sorts after the real result.
        media.sort(key=lambda pair: (pair[0], str(pair[1].get("filename", "")).startswith("H3_Full_")))
        files = [item for _, item in media]
        if not latent and files and COMFYUI_OUTPUT_DIR:
            stem = Path(files[0]["filename"]).stem
            guess = stem.replace("H3_Video_", "H3_Latent_").replace("H3_Chunk_", "H3_Latent_")
            for cand in (f"{guess}.safetensors", f"{guess}.latent"):
                if (Path(COMFYUI_OUTPUT_DIR) / cand).is_file():
                    latent = cand
                    break
        return files, latent

    async def free_memory(self, unload_models: bool = True, free_memory: bool = True) -> bool:
        """Call ComfyUI's /free endpoint to explicitly unload resident models and free GPU memory."""
        async with _http(timeout=10) as client:
            try:
                r = await client.post(
                    f"{self.base_url}/free",
                    json={"unload_models": unload_models, "free_memory": free_memory}
                )
                return r.status_code == 200
            except Exception as e:
                logger.warning(f"Failed to call ComfyUI /free: {e}")
                return False

    async def _prompt_is_gone(self, client, prompt_id: str) -> bool:
        """True if the prompt is in neither the running nor the pending queue.

        Combined with "not in history" this means ComfyUI no longer knows about
        the job at all. Checked over several consecutive polls because there is a
        brief window between leaving the queue and landing in history.
        """
        try:
            r = await client.get(f"{self.base_url}/queue")
            if r.status_code != 200:
                return False
            q = r.json()
            for key in ("queue_running", "queue_pending"):
                for item in q.get(key, []) or []:
                    if len(item) > 1 and item[1] == prompt_id:
                        return False
            return True
        except Exception:
            return False   # cannot tell -> do not declare it gone

    async def _finish_from_history(self, prompt_id: str, outcome: str,
                                   history: dict, expect_images: bool):
        """Single exit for a prompt that history reports as finished."""
        self._cleanup(prompt_id)
        if outcome == "interrupted":
            raise ComfyUIError("Execution interrupted")
        if outcome == "error":
            rec = history.get(prompt_id) or {}
            msg = "unknown error"
            for event, data in reversed((rec.get("status") or {}).get("messages") or []):
                if event == "execution_error":
                    d = data or {}
                    msg = (d.get("exception_message") or d.get("exception_type")
                           or "unknown error")
                    node = d.get("node_id", "")
                    raise ComfyUIError(f"ComfyUI execution error at node {node}: {msg}")
            raise ComfyUIError(f"ComfyUI execution error: {msg}")
        if expect_images:
            return await self._get_output_images(prompt_id)
        return (history.get(prompt_id) or {}).get("outputs", {})

    async def wait_for_result(self, prompt_id: str, timeout: int = 180, expect_images: bool = True):
        """
        Wait via WebSocket until prompt completes, return list of output images.
        Captures ComfyUI progress messages and stores them in _progress[prompt_id].
        """
        try:
            return await self._wait_for_result_inner(prompt_id, timeout, expect_images)
        finally:
            # Also covers asyncio.CancelledError (a BaseException, so no `except`
            # here catches it): when the caller's HTTP request is dropped the
            # per-prompt entries would otherwise leak for the life of the process,
            # and _workflows holds a whole workflow dict each. _cleanup is idempotent.
            self._cleanup(prompt_id)

    async def _wait_for_result_inner(self, prompt_id: str, timeout: int, expect_images: bool):
        self.active_prompt_id = prompt_id
        # First check if it's already in history (e.g., we disconnected and reconnected)
        async with _http(timeout=10) as client:
            r = await client.get(f"{self.base_url}/history/{prompt_id}")
            if r.status_code == 200:
                history = r.json()
                outcome = self._history_outcome(history, prompt_id)
                if outcome:
                    return await self._finish_from_history(
                        prompt_id, outcome, history, expect_images)

        deadline = asyncio.get_event_loop().time() + timeout
        if prompt_id not in self._progress:
            self._progress[prompt_id] = {
                "step": 0,
                "max": 0,
                "eta": None,
                "speed": None,
                "phase": "正在连接渲染引擎…",
                "node_id": None,
                "node_type": None,
                "start_time": None,
                "last_time": time.time(),
            }

        consecutive_http_errors = 0
        last_history_check = 0.0
        vanished_polls = 0

        while asyncio.get_event_loop().time() < deadline:
            # Rebuilt on every (re)connect: ComfyUI Desktop can come back on the other
            # port, and _ensure_active_url moves base_url/ws_url with it. A URL built once
            # kept dialling the dead port while HTTP (on the new one) said "all fine".
            self._ensure_active_url()
            ws_url = f"{self.ws_url}/ws?clientId={self._client_ids.get(prompt_id, self.client_id)}"
            try:
                async with websockets.connect(ws_url, max_size=None, ping_interval=20, ping_timeout=20) as ws:
                    consecutive_http_errors = 0
                    while asyncio.get_event_loop().time() < deadline:
                        now = asyncio.get_event_loop().time()
                        if now - last_history_check > 2.0:
                            last_history_check = now
                            try:
                                async with _http(timeout=4) as client:
                                    r = await client.get(f"{self.base_url}/history/{prompt_id}")
                                    if r.status_code == 200:
                                        consecutive_http_errors = 0
                                        history = r.json()
                                        outcome = self._history_outcome(history, prompt_id)
                                        if outcome:
                                            logger.info(f"Prompt {prompt_id} finished ({outcome}) via history backup poll")
                                            return await self._finish_from_history(
                                                prompt_id, outcome, history, expect_images)
                                        # Not in history. If it is not queued either,
                                        # ComfyUI restarted or the queue was cleared and
                                        # this prompt no longer exists -- fail fast
                                        # instead of blocking until `timeout`.
                                        if await self._prompt_is_gone(client, prompt_id):
                                            vanished_polls += 1
                                            if vanished_polls >= 3:
                                                self._cleanup(prompt_id)
                                                raise ComfyUIError(
                                                    "Job disappeared from ComfyUI "
                                                    "(server restarted or queue cleared)")
                                        else:
                                            vanished_polls = 0
                            except ComfyUIError:
                                # A verdict (interrupted / failed / vanished), not a
                                # polling failure -- let it out instead of counting it
                                # as an HTTP error and reporting "server disconnected".
                                raise
                            except Exception as e:
                                consecutive_http_errors += 1
                                logger.warning(f"History backup poll error: {e}")
                                if consecutive_http_errors >= 4:
                                    self._cleanup(prompt_id)
                                    raise ComfyUIError(f"ComfyUI server disconnected or unreachable: {e}")

                        try:
                            raw = await asyncio.wait_for(ws.recv(), timeout=1.0)
                        except asyncio.TimeoutError:
                            continue

                        if isinstance(raw, bytes):
                            continue  # preview frame

                        msg = json.loads(raw)
                        msg_type = msg.get("type")

                        if msg_type == "aicinema.live_preview":
                            # The live-preview plugin (custom_nodes/aicinema-live-preview)
                            # decoded the whole clip on the CPU after a sampler step.
                            d = msg.get("data", {})
                            target = d.get("prompt_id")
                            if target in self._progress:
                                self._progress[target]["preview"] = {
                                    "url": f"/comfy_output/{d.get('subfolder', 'live_preview')}/{d.get('filename')}",
                                    "step": d.get("step"),
                                }
                            continue

                        if msg_type == "progress":
                            d = msg.get("data", {})
                            val = int(d.get("value", 0))
                            max_val = int(d.get("max", 0))
                            target_prompt_id = d.get("prompt_id") or prompt_id
                            now = time.time()

                            prev = self._progress.get(target_prompt_id, {})
                            prev_val = prev.get("step", 0)
                            start_time = prev.get("start_time")
                            last_time = prev.get("last_time")
                            ema_raw = prev.get("ema_raw")
                            ema_calls = prev.get("ema_calls", 0)

                            # ComfyUI's console line ("2/8 [01:22<04:06, 41.16s/it]")
                            # is tqdm measuring from the moment the sampler node
                            # started. Anchoring on the first progress *message*
                            # instead, and then dividing by `val` -- which counts the
                            # step that had already run before that anchor -- reported
                            # about half ComfyUI's seconds-per-step early in a job.
                            if not start_time or val < prev_val or (prev.get("max") and max_val != prev.get("max")):
                                start_time = prev.get("node_started") or now
                                last_time = start_time
                                prev_val = 0
                                ema_raw = None
                                ema_calls = 0

                            eta = prev.get("eta")
                            speed = prev.get("speed")
                            if val > prev_val and last_time and now > last_time:
                                step_time = (now - last_time) / (val - prev_val)
                                tm = self._timing.get(target_prompt_id)
                                if tm is not None:
                                    tm["steps"].extend([step_time] * (val - prev_val))
                                # tqdm's EMA (smoothing=0.3) with the same bias
                                # correction, so the rate tracks ComfyUI's rather than
                                # being a lifetime average.
                                beta = 0.7
                                ema_raw = step_time * (1 - beta) + (ema_raw or 0.0) * beta
                                ema_calls += 1
                                smoothed = ema_raw / (1 - beta ** ema_calls)
                                speed = round(smoothed, 2)
                                eta = max(0, round(max(0, max_val - val) * smoothed))

                            self._progress[target_prompt_id] = {
                                **prev,
                                "step": val,
                                "max": max_val,
                                "eta": eta,
                                "speed": speed,
                                "start_time": start_time,
                                "ema_raw": ema_raw,
                                "ema_calls": ema_calls,
                                "last_time": now,
                                "phase": f"扩散去噪采样中 ({val}/{max_val})",
                            }

                        elif msg_type == "executing":
                            data = msg.get("data", {})
                            target_node = data.get("node")
                            # No `or prompt_id` fallback: on reconnect ComfyUI sends a
                            # bare {"node": ...} with no prompt_id (server.py ~line 290),
                            # and defaulting that to our own id can fake a completion.
                            target_prompt_id = data.get("prompt_id")

                            if target_node is None and target_prompt_id == prompt_id:
                                self._cleanup(prompt_id)
                                if expect_images:
                                    return await self._get_output_images(prompt_id)
                                return await self._get_raw_history_outputs(prompt_id)
                            elif target_node is not None and target_prompt_id == prompt_id:
                                node_str = str(target_node)
                                wf = self._workflows.get(prompt_id, {})
                                class_type = wf.get(node_str, {}).get("class_type", "")
                                phase_desc = _describe_node_phase(class_type, node_str)
                                prev = self._progress.get(prompt_id, {})
                                fresh = {}
                                if prev.get("node_id") != node_str:
                                    self._timing_node(prompt_id, class_type)
                                    # tqdm inside the node starts counting here, so
                                    # this is the t0 the console's elapsed/rate use.
                                    fresh = {
                                        "node_started": time.time(),
                                        "start_time": None,
                                        "ema_raw": None,
                                        "ema_calls": 0,
                                        "step": 0,
                                        "max": 0,
                                        "eta": None,
                                        "speed": None,
                                    }
                                self._progress[prompt_id] = {
                                    **prev,
                                    **fresh,
                                    "phase": phase_desc,
                                    "node_id": node_str,
                                    "node_type": class_type,
                                }

                        elif msg_type == "execution_success":
                            if msg.get("data", {}).get("prompt_id") != prompt_id:
                                continue
                            self._cleanup(prompt_id)
                            if expect_images:
                                return await self._get_output_images(prompt_id)
                            return await self._get_raw_history_outputs(prompt_id)

                        elif msg_type == "execution_error":
                            data = msg.get("data", {})
                            # Another job's failure must not kill this one: one client
                            # can have several prompts in flight, and ComfyUI targets
                            # execution_error at the client, not at the prompt.
                            if data.get("prompt_id") != prompt_id:
                                continue
                            self._cleanup(prompt_id)
                            err_msg = data.get('exception_message') or data.get('exception_type') or 'unknown error'
                            node_id = data.get('node_id', '')
                            raise ComfyUIError(f"ComfyUI execution error at node {node_id}: {err_msg}")

                        elif msg_type == "execution_interrupted":
                            data = msg.get("data", {})
                            # execution_interrupted is sent with broadcast=True
                            # (execution.py:699), so cancelling ANY job -- from the
                            # ComfyUI UI, another script, anything -- reaches us here.
                            # Without this guard a healthy job gets declared dead while
                            # ComfyUI happily finishes it, which is exactly the
                            # "done in ComfyUI but failed in the UI" symptom.
                            if data.get("prompt_id") != prompt_id:
                                continue
                            self._cleanup(prompt_id)
                            raise ComfyUIError("Execution interrupted")

            except (websockets.exceptions.WebSocketException, OSError) as ws_err:
                logger.warning(f"WebSocket disconnected ({ws_err}). Testing ComfyUI HTTP reachability...")
                try:
                    async with _http(timeout=3) as client:
                        r = await client.get(f"{self.base_url}/history/{prompt_id}")
                        if r.status_code == 200:
                            consecutive_http_errors = 0
                            history = r.json()
                            outcome = self._history_outcome(history, prompt_id)
                            if outcome:
                                return await self._finish_from_history(
                                    prompt_id, outcome, history, expect_images)
                            # Same vanish test as the connected branch: after a ComfyUI
                            # restart the prompt is in neither history nor the queue.
                            if await self._prompt_is_gone(client, prompt_id):
                                vanished_polls += 1
                                if vanished_polls >= 3:
                                    self._cleanup(prompt_id)
                                    raise ComfyUIError(
                                        "Job disappeared from ComfyUI "
                                        "(server restarted or queue cleared)")
                            else:
                                vanished_polls = 0
                except ComfyUIError:
                    raise
                except Exception as http_err:
                    consecutive_http_errors += 1
                    logger.warning(f"ComfyUI HTTP reachability check failed ({http_err}) [{consecutive_http_errors}/3]")
                    if consecutive_http_errors >= 3:
                        self._cleanup(prompt_id)
                        raise ComfyUIError(f"ComfyUI server disconnected or crashed: {http_err}")

                await asyncio.sleep(2.0)

        # Deadline reached. Give history one last look -- the job may have landed
        # between polls -- but never hand back an empty result as if it succeeded;
        # that surfaces as a job the UI calls "done" with nothing to show.
        try:
            async with _http(timeout=10) as client:
                r = await client.get(f"{self.base_url}/history/{prompt_id}")
                if r.status_code == 200:
                    history = r.json()
                    outcome = self._history_outcome(history, prompt_id)
                    if outcome:
                        return await self._finish_from_history(
                            prompt_id, outcome, history, expect_images)
        except ComfyUIError:
            raise
        except Exception as e:
            logger.warning(f"Final history check failed for {prompt_id}: {e}")
        self._cleanup(prompt_id)
        raise ComfyUIError(
            f"Timed out after {timeout}s waiting for ComfyUI job {prompt_id}")

    async def _get_raw_history_outputs(self, prompt_id: str) -> dict:
        async with _http(timeout=30) as client:
            r = await client.get(f"{self.base_url}/history/{prompt_id}")
            if r.status_code == 200:
                return r.json().get(prompt_id, {}).get("outputs", {})
        return {}

    def get_progress(self, prompt_id: Optional[str] = None) -> dict:
        """Return live step, ETA, speed, and phase for the active prompt."""
        data = None
        if prompt_id:
            # Asked about a specific prompt: answer about THAT prompt or not at all.
            # Falling through to "whatever is in the dict" reports another job's
            # progress once this one is cleaned up, which is what made the UI show
            # a finished shot suddenly jump to some other shot's percentage.
            data = self._progress.get(prompt_id)
        elif self.active_prompt_id:
            data = self._progress.get(self.active_prompt_id)

        if data:
            step = data.get("step", 0)
            max_val = data.get("max", 0)
            eta = data.get("eta")
            speed = data.get("speed")
            start_time = data.get("start_time")
            phase = data.get("phase")
            node_type = data.get("node_type")

            now = time.time()
            elapsed = None
            anchor = start_time or data.get("node_started")
            if anchor:
                elapsed = max(0, round(now - anchor))
            if eta is not None:
                # Count the ETA down between websocket messages, so a slow step
                # reads as slow instead of frozen. Recomputing it from step count
                # here is what used to contradict the ComfyUI console.
                eta = max(0, round(eta - (now - (data.get("last_time") or now))))

            return {
                "step": step,
                "max": max_val,
                "eta": eta,
                "speed": speed,
                "elapsed": elapsed,
                "phase": phase,
                "node_type": node_type,
                "preview": data.get("preview"),
            }
        return {"step": 0, "max": 0, "eta": None, "speed": None, "elapsed": None,
                "phase": None, "node_type": None, "preview": None}

    async def _get_output_images(self, prompt_id: str) -> list[dict]:
        async with _http(timeout=30) as client:
            r = await client.get(f"{self.base_url}/history/{prompt_id}")
            if r.status_code != 200:
                raise ComfyUIError("Failed to fetch history")
            history = r.json()

        outputs = history.get(prompt_id, {}).get("outputs", {})
        images = []
        for node_output in outputs.values():
            for img in node_output.get("images", []):
                images.append(img)

        if not images:
            prompt_data = history.get(prompt_id, {})
            outputs_dump = json.dumps(outputs)
            status_dump = json.dumps(prompt_data.get("status", {}))
            raise ComfyUIError(f"No output images produced. History outputs: {outputs_dump}, Status: {status_dump}")

        # Some workflows contain preview/cache nodes before their SaveImage node.
        # ComfyUI reports those frames with type="temp" and they can therefore be
        # the first item in history.  Returning that item makes the canvas persist
        # a /comfy_output/easyPreview_temp_*.png URL even though the file lives in
        # ComfyUI's temp directory; the completed node then renders as a black card.
        # Prefer durable outputs while keeping the old fallback for third-party
        # workflows which genuinely expose only temp images.
        persisted = [img for img in images if img.get("type") == "output"]
        return persisted or images

    async def _get_output_videos(self, prompt_id: str) -> list[dict]:
        """Retrieve video outputs from history. Handles 'videos', 'gifs', and 'images' keys."""
        async with _http(timeout=30) as client:
            r = await client.get(f"{self.base_url}/history/{prompt_id}")
            if r.status_code != 200:
                raise ComfyUIError("Failed to fetch history")
            history = r.json()

        outputs = history.get(prompt_id, {}).get("outputs", {})
        videos = []
        for node_output in outputs.values():
            for key in ("videos", "gifs", "images"):
                for item in node_output.get(key, []):
                    if item.get("type") == "output":
                        videos.append(item)
        # The untrimmed continuation (H3_Full_) is a by-product, never the result.
        return sorted(videos, key=lambda item: str(item.get("filename", "")).startswith("H3_Full_"))

    async def _get_output_video_by_node(self, prompt_id: str, node_id: str) -> Optional[dict]:
        """Retrieve video output from a specific node in history."""
        async with _http(timeout=30) as client:
            r = await client.get(f"{self.base_url}/history/{prompt_id}")
            if r.status_code != 200:
                raise ComfyUIError("Failed to fetch history")
            history = r.json()

        outputs = history.get(prompt_id, {}).get("outputs", {})
        node_output = outputs.get(node_id, {})
        for key in ("videos", "gifs", "images"):
            for item in node_output.get(key, []):
                if item.get("type") == "output":
                    return item
        return None

    async def _get_output_audio(self, prompt_id: str) -> list[dict]:
        """Retrieve audio outputs from history (SaveAudio* nodes report under 'audio')."""
        async with _http(timeout=30) as client:
            r = await client.get(f"{self.base_url}/history/{prompt_id}")
            if r.status_code != 200:
                raise ComfyUIError("Failed to fetch history")
            history = r.json()

        outputs = history.get(prompt_id, {}).get("outputs", {})
        audio = []
        for node_output in outputs.values():
            for item in node_output.get("audio", []):
                if item.get("type") == "output":
                    audio.append(item)
        return audio

    async def _get_output_latents(self, prompt_id: str) -> list[dict]:
        """Retrieve latent outputs from history (SaveLatent nodes report under 'latents' or outputs)."""
        async with _http(timeout=30) as client:
            r = await client.get(f"{self.base_url}/history/{prompt_id}")
            if r.status_code != 200:
                return []
            history = r.json()

        outputs = history.get(prompt_id, {}).get("outputs", {})
        latents = []
        for node_output in outputs.values():
            if not isinstance(node_output, dict):
                continue
            for key in ("latents", "latent", "files", "outputs", "safetensors", "latent_path"):
                for item in node_output.get(key, []):
                    if isinstance(item, dict) and (item.get("type") == "output" or "filename" in item):
                        latents.append(item)
                    elif isinstance(item, str) and (item.endswith(".latent") or item.endswith(".safetensors")):
                        latents.append({"filename": Path(item).name, "type": "output"})
            if "filename" in node_output and (str(node_output["filename"]).endswith(".latent") or str(node_output["filename"]).endswith(".safetensors")):
                latents.append(node_output)
        return latents

    async def _run_audio_workflow(
        self, workflow: dict, timeout: int, on_queued=None,
        error_msg: str = "No audio output produced",
        return_info: bool = False,
    ):
        """Queue an audio workflow, wait, and return output clip info or raw bytes."""
        prompt_id = await self.queue_prompt(workflow)
        await self._notify_queued(on_queued, prompt_id)
        await self.wait_for_result(prompt_id, timeout=timeout, expect_images=False)
        clips = await self._get_output_audio(prompt_id)
        if not clips:
            raise ComfyUIError(error_msg)
        a = clips[0]
        if return_info:
            return {
                "prompt_id": prompt_id,
                "filename": a.get("filename"),
                "subfolder": a.get("subfolder", ""),
                "type": a.get("type", "output"),
            }
        return await self.get_image_bytes(a["filename"], a.get("subfolder", ""), a.get("type", "output"))

    async def generate_music(
        self,
        tags: str,
        lyrics: str = "[instrumental]",
        seconds: float = 60.0,
        steps: int = 60,
        cfg: float = 5.0,
        seed: int = -1,
        lyrics_strength: float = 0.99,
        on_queued: Optional[callable] = None,
        return_info: bool = False,
    ):
        """Text-to-music with ACE-Step v1 3.5B. Returns output info dict or FLAC bytes."""
        workflow = wb.build_ace_step_music_workflow(
            tags=tags, lyrics=lyrics, seconds=seconds, steps=steps, cfg=cfg,
            seed=_resolve_seed(seed), lyrics_strength=lyrics_strength,
        )
        return await self._run_audio_workflow(
            workflow, timeout=1800, on_queued=on_queued,
            error_msg="No music output produced",
            return_info=return_info,
        )

    async def generate_ambience(
        self,
        prompt: str,
        seconds: float = 30.0,
        steps: int = 50,
        cfg: float = 5.0,
        seed: int = -1,
        negative_prompt: str = "",
        on_queued: Optional[callable] = None,
        return_info: bool = False,
    ):
        """Text-to-audio (ambience / SFX) with Stable Audio Open 1.0. Returns output info dict or FLAC bytes."""
        workflow = wb.build_stable_audio_workflow(
            prompt=prompt, seconds=seconds, steps=steps, cfg=cfg,
            seed=_resolve_seed(seed), negative_prompt=negative_prompt,
        )
        return await self._run_audio_workflow(
            workflow, timeout=1800, on_queued=on_queued,
            error_msg="No ambience output produced",
            return_info=return_info,
        )

    async def get_image_bytes(self, filename: str, subfolder: str = "", img_type: str = "output") -> bytes:
        params = {"filename": filename, "subfolder": subfolder, "type": img_type}
        async with _http(timeout=60) as client:
            r = await client.get(f"{self.base_url}/view", params=params)
            r.raise_for_status()
            return r.content

    async def resume_video_job(self, prompt_id: str, timeout: int = 3600) -> bytes:
        """Resume waiting for a video job that was already queued."""
        await self.wait_for_result(prompt_id, timeout=timeout)
        vids = await self._get_output_videos(prompt_id)
        if not vids:
            raise ComfyUIError("No video output produced")
        v = vids[0]
        return await self.get_image_bytes(v["filename"], v.get("subfolder", ""), v.get("type", "output"))

    # ── Shared execution helpers ───────────────────────────────────────────────

    @staticmethod
    async def _notify_queued(on_queued, prompt_id: str):
        if on_queued:
            if asyncio.iscoroutinefunction(on_queued):
                await on_queued(prompt_id)
            else:
                on_queued(prompt_id)

    async def _run_image_workflow(self, workflow: dict, timeout: int = 1800, return_info: bool = False):
        """Queue a workflow, wait, and return the first output image's info dict or raw bytes."""
        prompt_id = await self.queue_prompt(workflow)
        images = await self.wait_for_result(prompt_id, timeout=timeout)
        if not images:
            raise ComfyUIError("No output images produced")
        img = images[0]
        if return_info:
            return {
                "prompt_id": prompt_id,
                "filename": img["filename"],
                "subfolder": img.get("subfolder", ""),
                "type": img.get("type", "output"),
            }
        return await self.get_image_bytes(img["filename"], img.get("subfolder", ""), img.get("type", "output"))

    async def get_video_bytes(self, filename: str, subfolder: str = "", vid_type: str = "output") -> bytes:
        """Retrieve video bytes from local ComfyUI output folder directly if available, otherwise via HTTP."""
        if COMFYUI_OUTPUT_DIR:
            sub = subfolder.strip("/\\") if subfolder else ""
            local_p = Path(COMFYUI_OUTPUT_DIR) / sub / filename
            if local_p.is_file():
                try:
                    return local_p.read_bytes()
                except Exception as e:
                    logger.warning("Could not read local video file directly (%s), falling back to HTTP: %s", local_p, e)
        return await self.get_image_bytes(filename, subfolder, vid_type)

    async def _run_video_workflow(
        self,
        workflow: dict,
        timeout: int,
        on_queued=None,
        error_msg: str = "No video output produced",
        return_info: bool = False,
        return_meta: bool = False,
        live_preview: bool = True,
    ):
        """Queue a workflow, wait, and return output video info dict or raw bytes."""
        prompt_id = await self.queue_prompt(workflow, live_preview=live_preview)
        await self._notify_queued(on_queued, prompt_id)
        await self.wait_for_result(prompt_id, timeout=timeout, expect_images=False)
        vids = await self._get_output_videos(prompt_id)
        if not vids:
            raise ComfyUIError(error_msg)
        v = vids[0]
        if return_info or return_meta:
            latents = await self._get_output_latents(prompt_id)
            latent_fn = latents[0]["filename"] if latents else None
            if not latent_fn and v.get("filename"):
                v_stem = Path(v["filename"]).stem
                search_dirs = [
                    Path(COMFYUI_OUTPUT_DIR) if COMFYUI_OUTPUT_DIR else None,
                ]
                search_dirs = [d for d in search_dirs if d and d.is_dir()]
                # A clip that continues from another one is saved as
                # H3_Chunk_<tag> and its latent as H3_Latent_<tag>; matching only
                # the H3_Video_ prefix left every chained clip without a latent,
                # so the next link in the chain had nothing to continue from
                # (2026-09-09).
                latent_stem = v_stem.replace('H3_Video_', 'H3_Latent_').replace('H3_Chunk_', 'H3_Latent_')
                cands = [
                    f"{latent_stem}.safetensors",
                    f"{latent_stem}.latent",
                    f"{v_stem}.safetensors",
                    f"{v_stem}.latent",
                ]
                for cand in cands:
                    for sdir in search_dirs:
                        if (sdir / cand).is_file():
                            latent_fn = cand
                            break
                    if latent_fn:
                        break

            untrimmed = next((x.get("filename") for x in vids
                              if str(x.get("filename", "")).startswith("H3_Full_")), None)
            return {
                "prompt_id": prompt_id,
                "filename": v.get("filename"),
                "subfolder": v.get("subfolder", ""),
                "type": v.get("type", "output"),
                "latent_filename": latent_fn,
                "untrimmed_filename": untrimmed,
            }
        return await self.get_video_bytes(v["filename"], v.get("subfolder", ""), v.get("type", "output"))

    # ── Image generation ───────────────────────────────────────────────────────

    async def generate(
        self,
        prompt: str,
        reference_filenames: list[str],
        model: str = "flux1-kontext-dev.safetensors",
        width: int = 1024,
        height: int = 1024,
        steps: int = 20,
        guidance: float = 2.5,
        seed: int = -1,
        return_info: bool = False,
    ):
        """High-level: generate with FLUX.1-Kontext (character consistency)."""
        workflow = wb.build_kontext_workflow(
            prompt=prompt,
            reference_filenames=reference_filenames,
            model=model,
            width=width,
            height=height,
            steps=steps,
            guidance=guidance,
            seed=_resolve_seed(seed),
        )
        return await self._run_image_workflow(workflow, return_info=return_info)

    async def generate_flux2(
        self,
        prompt: str,
        width: int = 1024,
        height: int = 1024,
        steps: int = 20,
        guidance: float = 4.0,
        seed: int = -1,
        return_info: bool = False,
    ):
        """High-level: pure text-to-image with FLUX.2-dev."""
        workflow = wb.build_flux2_workflow(
            prompt=prompt,
            width=width,
            height=height,
            steps=steps,
            guidance=guidance,
            seed=_resolve_seed(seed),
        )
        return await self._run_image_workflow(workflow, return_info=return_info)

    async def generate_flux2_with_references(
        self,
        prompt: str,
        reference_filenames: list[str],
        pose_reference_filenames: list[str] = None,
        depth_reference_filenames: list[str] = None,
        width: int = 1024,
        height: int = 1024,
        steps: int = 20,
        guidance: float = 4.0,
        seed: int = -1,
        depth_strength: float = 0.8,
        return_info: bool = False,
    ):
        workflow = wb.build_flux2_i2i_workflow(
            prompt=prompt,
            reference_filenames=reference_filenames,
            pose_reference_filenames=pose_reference_filenames,
            depth_reference_filenames=depth_reference_filenames,
            width=width,
            height=height,
            steps=steps,
            guidance=guidance,
            seed=_resolve_seed(seed),
            depth_strength=depth_strength,
        )
        return await self._run_image_workflow(workflow, return_info=return_info)

    async def generate_inpaint(
        self,
        prompt: str,
        image_filename: str,
        mask_filename: str,
        width: int,
        height: int,
        steps: int = 20,
        guidance: float = 4.0,
        seed: int = -1,
        reference_filename: Optional[str] = None,
        return_info: bool = False,
    ):
        workflow = wb.build_flux2_inpaint_workflow(
            prompt=prompt,
            image_filename=image_filename,
            mask_filename=mask_filename,
            width=width,
            height=height,
            steps=steps,
            guidance=guidance,
            seed=_resolve_seed(seed),
            reference_filename=reference_filename,
        )
        return await self._run_image_workflow(workflow, return_info=return_info)

    async def _free_unless_last_used(self, unet_name: str) -> None:
        """Ask ComfyUI to unload its models unless unet_name is already resident.

        ComfyUI reports no list of loaded models, so "resident" is judged from the
        graph that will run just before ours: the last queued prompt if the queue
        is busy, otherwise the most recent history entry. Qwen-Image-2.1 next to
        resident H3 weights ran at 36 s/step on the 32 GB card (2026-09-22); after
        /free it is back to normal. /free is a queue flag, applied between prompts,
        so it never cuts a running job short.
        """
        def uses(graph) -> bool:
            return isinstance(graph, dict) and any(
                isinstance(n, dict) and n.get("inputs", {}).get("unet_name") == unet_name
                for n in graph.values())
        try:
            async with _http(timeout=10) as client:
                q = (await client.get(f"{self.base_url}/queue")).json()
                busy = (q.get("queue_running") or []) + (q.get("queue_pending") or [])
                if busy:
                    last = max(busy, key=lambda item: item[0])
                    resident = uses(last[2])
                else:
                    h = (await client.get(f"{self.base_url}/history",
                                          params={"max_items": 1})).json()
                    entry = next(iter(h.values()), None) if isinstance(h, dict) else None
                    resident = bool(entry) and uses((entry.get("prompt") or [None] * 3)[2])
                if resident:
                    return
                await client.post(f"{self.base_url}/free",
                                  json={"unload_models": True, "free_memory": True})
                logger.info("ComfyUI /free before %s (it was not the last model used)", unet_name)
        except Exception as e:  # never block a render on the check itself
            logger.warning("VRAM free check before %s failed: %s", unet_name, e)

    async def generate_qwen_image_21(
        self,
        prompt: str,
        reference_filenames: Optional[list] = None,
        negative_prompt: str = "",
        width: int = 1376,
        height: int = 768,
        steps: int = 25,
        cfg: float = 1.0,
        seed: int = -1,
        return_info: bool = False,
        fixed_size: bool = False,
        lora_name: str = "",
        lora_strength: float = 1.0,
        base_model: str = "qwen21",
        ref_resolution: int = wb.QWEN_IMAGE_21_REF_RESOLUTION,
    ):
        """Qwen-Image-2.1, text-to-image or edit. See build_qwen_image_21_workflow.

        reference_filenames are ComfyUI input names in `<image N>` order; with any
        of them the canvas follows reference 1's aspect ratio and width/height are
        ignored.
        """
        await self._free_unless_last_used(wb.qwen_image_21_unet(base_model))
        workflow = wb.build_qwen_image_21_workflow(
            prompt=prompt,
            reference_filenames=reference_filenames,
            negative_prompt=negative_prompt,
            width=width,
            height=height,
            steps=steps,
            cfg=cfg,
            seed=_resolve_seed(seed),
            fixed_size=fixed_size,
            lora_name=lora_name,
            lora_strength=lora_strength,
            base_model=base_model,
            ref_resolution=ref_resolution,
        )
        return await self._run_image_workflow(workflow, return_info=return_info)

    async def upscale_image_esrgan(
        self,
        image_filename: str,
        model_name: str = "RealESRGAN_x2.pth",
        target_width: int = 0,
        target_height: int = 0,
    ) -> bytes:
        """RealESRGAN upscale of one still. Returns PNG bytes. See build_esrgan_image_workflow."""
        workflow = wb.build_esrgan_image_workflow(image_filename, model_name, target_width, target_height)
        return await self._run_image_workflow(workflow)

    # ── Gaussian Splatting / Pose ──────────────────────────────────────────────

    async def estimate_depth(
        self,
        image_filename: str,
        resolution: int = 1024,
        ckpt_name: str = "depth_anything_v2_vitl.pth",
    ) -> bytes:
        """Estimate a depth map from a still. Returns PNG bytes at the source size."""
        workflow = wb.build_depth_estimate_workflow(image_filename, resolution, ckpt_name)
        return await self._run_image_workflow(workflow)

    async def estimate_video_depth(
        self,
        video_filename: str,
        fps: float,
        resolution: int = 518,
        on_queued=None,
    ) -> bytes:
        """Per-frame depth of a clip as a silent mp4 (see build_video_depth_workflow)."""
        workflow = wb.build_video_depth_workflow(video_filename, fps, resolution)
        prompt_id = await self.queue_prompt(workflow)
        await self._notify_queued(on_queued, prompt_id)
        return await self.resume_video_job(prompt_id)

    async def charswap_viggle(
        self,
        video_filename: str,
        reference_filename: str,
        length: int = 107,
        seed: int = 95051,
        sampler: str = "euler",
        megapixels: float = 0.8,
        keep_audio: bool = False,
        on_queued=None,
    ) -> bytes:
        """Swap the performer in a clip for the person in one still (Viggle-Animate).

        No prompt exists on this route -- identity comes from the still, everything else
        from the driving clip. About 180 s for 348 frames at 0.5 MP (windowed); held props are
        lost, so a prop-driven shot belongs on the Ref2VA route instead. See `build_viggle_charswap_workflow`.
        """
        workflow = wb.build_viggle_charswap_workflow(
            video_filename=video_filename,
            reference_filename=reference_filename,
            length=length, seed=_resolve_seed(seed),
            sampler=sampler, megapixels=megapixels, keep_audio=keep_audio,
        )
        return await self._run_video_workflow(
            workflow, timeout=3600, on_queued=on_queued,
            error_msg="No charswap video produced")

    async def reconstruct_from_panorama(
        self,
        panorama_filename: str,
        fov_degrees: float = 65.0,
        overlap_percent: float = 10.0,
        output_size: int = 1024,
        skip_poles: bool = True,
        output_prefix: str = "panoscene",
    ) -> str:
        """Reconstruct a full location from a panorama. Returns the merged .ply path."""
        workflow = wb.build_panorama_reconstruct_workflow(
            panorama_filename=panorama_filename, fov_degrees=fov_degrees,
            overlap_percent=overlap_percent, output_size=output_size,
            skip_poles=skip_poles, output_prefix=output_prefix,
        )
        prompt_id = await self.queue_prompt(workflow)
        await self.wait_for_result(prompt_id, expect_images=False)

        import glob
        for root in (COMFYUI_OUTPUT_DIR, os.path.dirname(COMFYUI_OUTPUT_DIR)):
            hits = glob.glob(os.path.join(root, "**", f"{output_prefix}_merged*.ply"), recursive=True)
            if hits:
                return max(hits, key=os.path.getctime)
        raise ComfyUIError(f"Merged panorama PLY not found for prefix {output_prefix}")

    async def merge_multiview_splats(self, views: list, filename_prefix: str = "merged_scene") -> str:
        """Fuse per-view reconstructions into one splat. Returns the merged .ply path.

        `views` items: {"ply_path": local path, "translate": (x,y,z), "rotate": (rx,ry,rz)}
        """
        staged = [
            {"ply_filename": self.stage_3d_input(v["ply_path"]),
             "translate": v.get("translate", (0.0, 0.0, 0.0)),
             "rotate": v.get("rotate", (0.0, 0.0, 0.0))}
            for v in views
        ]
        workflow = wb.build_multiview_merge_workflow(staged, filename_prefix=filename_prefix)
        prompt_id = await self.queue_prompt(workflow)
        await self.wait_for_result(prompt_id, expect_images=False)

        import glob
        pattern = os.path.join(COMFYUI_OUTPUT_DIR, "**", f"{filename_prefix}*.ply")
        files = glob.glob(pattern, recursive=True)
        if not files:
            raise ComfyUIError(f"Merged PLY not found for prefix {filename_prefix}")
        return max(files, key=os.path.getctime)

    async def repair_gaussian_view(
        self,
        broken_view_filename: str,
        reference_filename: str,
        prompt: str = "高斯泼溅,参考图2的场景图，修复图1的场景图透视并修复空白区域",
        steps: int = 10,
        cfg: float = 1.0,
        seed: int = -1,
        denoise: float = 1.0,
    ) -> bytes:
        """Repair a torn splat render into a usable novel view. Returns PNG bytes."""
        workflow = wb.build_gaussian_view_repair_workflow(
            broken_view_filename=broken_view_filename,
            reference_filename=reference_filename,
            prompt=prompt, steps=steps, cfg=cfg,
            seed=_resolve_seed(seed), denoise=denoise,
        )
        return await self._run_image_workflow(workflow, timeout=600)

    def stage_3d_input(self, local_path: str) -> str:
        """Copy a 3D file into ComfyUI's input/3d dir; returns the workflow reference."""
        import shutil as _shutil

        dst_dir = os.path.join(COMFYUI_INPUT_DIR, "3d")
        os.makedirs(dst_dir, exist_ok=True)
        name = os.path.basename(local_path)
        dst = os.path.join(dst_dir, name)
        if os.path.abspath(local_path) != os.path.abspath(dst):
            _shutil.copyfile(local_path, dst)
        return f"3d/{name}"

    async def render_splat_pass(
        self,
        ply_path: str,
        width: int = 1280,
        height: int = 720,
        render_style: str = "depth",
        **camera,
    ) -> bytes:
        """Render one geometry pass of a splat from a specified camera.

        This is what makes a location reusable: the camera moves, the scene does
        not, so every shot's depth pass comes off the same geometry.
        """
        workflow = wb.build_splat_render_workflow(
            ply_filename=self.stage_3d_input(ply_path),
            width=width, height=height, render_style=render_style, **camera,
        )
        return await self._run_image_workflow(workflow, timeout=600)

    async def generate_gaussian_model(self, image_filename: str) -> str:
        """
        Generate Gaussian Splatting model (.ply) using SHARP node.
        Returns the local path to the newest generated .ply file in the ComfyUI output dir.
        """
        workflow = wb.build_gaussian_model_workflow(image_filename)
        prompt_id = await self.queue_prompt(workflow)
        await self.wait_for_result(prompt_id, expect_images=False)

        # After completion, find the newest sharp_*.ply in the ComfyUI output dir
        import glob
        ply_files = glob.glob(os.path.join(COMFYUI_OUTPUT_DIR, "sharp_*.ply"))
        if not ply_files:
            raise ComfyUIError("Failed to find generated PLY file in ComfyUI output directory.")

        return max(ply_files, key=os.path.getctime)

    async def generate_pose(self, image_filename: str) -> str:
        """
        Generate 3D pose model (.glb) using SCAIL nodes.
        Returns the local path to the newest generated .glb file in <output>/nlf_pose_3d.
        """
        workflow = wb.build_pose_workflow(image_filename)
        prompt_id = await self.queue_prompt(workflow)
        await self.wait_for_result(prompt_id, expect_images=False)

        import glob
        pose_dir = os.path.join(COMFYUI_OUTPUT_DIR, "nlf_pose_3d")
        glb_files = glob.glob(os.path.join(pose_dir, "*.glb"))
        if not glb_files:
            raise ComfyUIError("Failed to find generated GLB file in ComfyUI output directory.")

        return max(glb_files, key=os.path.getctime)

    async def extract_openpose_image(self, image_filename: str, render_size: int = 768) -> bytes:
        """
        Extract full-body OpenPose image (body + hands + face) using SCAIL VitPose pipeline.
        """
        workflow = wb.build_openpose_extract_workflow(image_filename, render_size)
        prompt_id = await self.queue_prompt(workflow)
        images = await self.wait_for_result(prompt_id, timeout=180, expect_images=True)

        if not images:
            raise ComfyUIError("姿势提取没有产生输出图片")

        img = images[0]
        img_bytes = await self.get_image_bytes(
            img["filename"], img.get("subfolder", ""), img.get("type", "output")
        )

        # Detect blank output: a pose image with skeleton is always >> 5 KB.
        # A solid-black PNG compresses to < 3 KB regardless of canvas size.
        if len(img_bytes) < 5000:
            raise ComfyUIError("未能识别到图片中的人物姿势，请确保图片中有完整、清晰的人体")

        return img_bytes

    # ── Reference-video sizing ────────────────────────────────────────────────

    @staticmethod
    def _probe_video_size(filename: str) -> Optional[tuple[int, int]]:
        """(width, height) of a reference already staged in ComfyUI's input dir.

        Returns None when the file cannot be found or read — callers then leave
        the reference untouched, which is the previous behaviour.
        """
        if not filename:
            return None
        candidates = []
        for root in (COMFYUI_INPUT_DIR, COMFYUI_OUTPUT_DIR):
            if root:
                candidates.append(Path(root) / Path(filename).name)
        candidates.append(Path(filename))

        path = next((c for c in candidates if c.is_file()), None)
        if path is None:
            return None

        try:
            import cv2
            cap = cv2.VideoCapture(str(path))
            if cap.isOpened():
                w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
                h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
                cap.release()
                if w > 0 and h > 0:
                    return w, h
        except Exception as e:
            logger.debug("cv2 could not size %s: %s", path, e)

        # ffprobe fallback: cv2 is optional and some builds lack the codec.
        try:
            import subprocess
            out = subprocess.run(
                [os.environ.get("FFPROBE", "ffprobe"), "-v", "error",
                 "-select_streams", "v:0", "-show_entries", "stream=width,height",
                 "-of", "csv=p=0:s=x", str(path)],
                capture_output=True, text=True, timeout=30,
            ).stdout.strip().split("x")
            if len(out) >= 2:
                w, h = int(out[0]), int(out[1])
                if w > 0 and h > 0:
                    return w, h
        except Exception as e:
            logger.debug("ffprobe could not size %s: %s", path, e)
        return None

    @staticmethod
    def _resolve_reference_path(filename: str):
        """Where a staged reference actually lives, or None."""
        if not filename:
            return None
        candidates = []
        for root in (COMFYUI_INPUT_DIR, COMFYUI_OUTPUT_DIR):
            if root:
                candidates.append(Path(root) / Path(filename).name)
        candidates.append(Path(filename))
        return next((c for c in candidates if c.is_file()), None)

    @staticmethod
    def _probe_video_has_audio(filename: str) -> Optional[bool]:
        """True/False if the reference carries an audio stream, None if unknown.

        A silent reference video must not be handed to `ref_video_audios`: the
        H3 node encodes whatever it is given and emits an `<Audio N>` label for
        it, so a soundless previs turns into a silence reference the prompt
        never mentions — and this model generates its own soundtrack.
        """
        path = ComfyUIClient._resolve_reference_path(filename)
        if path is None:
            return None
        try:
            import subprocess
            out = subprocess.run(
                [os.environ.get("FFPROBE", "ffprobe"), "-v", "error",
                 "-select_streams", "a", "-show_entries", "stream=index",
                 "-of", "csv=p=0", str(path)],
                capture_output=True, text=True, timeout=30,
            )
            if out.returncode == 0:
                return bool(out.stdout.strip())
        except Exception as e:
            logger.debug("ffprobe could not read audio streams of %s: %s", path, e)
        return None

    @staticmethod
    def _fit_inside(src: tuple[int, int], max_w: int, max_h: int) -> Optional[tuple[int, int]]:
        """Largest size that fits in the box while keeping the source's ratio.

        Returns None when the source already fits: a reference is conditioning,
        not output, so upscaling a small one costs memory and adds no detail.
        """
        sw, sh = src
        if sw <= 0 or sh <= 0:
            return None
        scale = min(max_w / sw, max_h / sh)
        if scale >= 1.0:
            return None
        # Snap to a multiple of 8 for the VAE. At these sizes that moves the
        # aspect ratio by well under a percent, so the framing still matches
        # the reference — which is the whole point of the ratio being kept.
        w = max(8, int(round(sw * scale / 8)) * 8)
        h = max(8, int(round(sh * scale / 8)) * 8)
        return w, h

    # ── MiniMax H3 Video + Audio generation ───────────────────────────────────

    async def generate_h3_video(
        self,
        prompt: str,
        first_frame_filename: Optional[str] = None,
        last_frame_filename: Optional[str] = None,
        last_frame_index: int = -1,
        guide_frames: Optional[list] = None,
        image_reference_filenames: list[str] = None,
        audio_reference_filenames: list[str] = None,
        video_reference_filenames: list[str] = None,
        width: int = 1376,
        height: int = 768,
        length: int = 124,
        steps: int = wb.DEFAULT_H3_STEPS,
        seed: int = -1,
        scheduler: str = "simple",
        # The default checkpoint has the turbo LoRA merged in; see
        # wb.build_h3_video_workflow for when to name one here instead.
        lora_name: str = "",
        lora_strength: float = 1.0,
        # The style LoRA stacks on top of the merged turbo in the workflow. It is
        # threaded through here because main.py has always sent it; without
        # these two parameters every /generate-video call raised TypeError.
        style_lora_name: str = "",
        style_lora_strength: float = 1.0,
        # Several style LoRAs, stacked in order: [{"name", "strength"}]
        style_loras: list | None = None,
        # 'match' (default) lets the node shrink each reference to the output's
        # pixel area; 'max' keeps a 2048px short edge for identity fidelity, at
        # the cost of carrying more reference tokens through every step.
        ref_image_size: str = "match",
        sage: str = wb.DEFAULT_H3_ACCEL,
        shift_video: float = 12.0,
        shift_audio: float = 3.0,
        motion_context_latent: str = "",
        motion_context_video: str = "",
        motion_context_length: int = 22,
        motion_context_audio: int = 24,
        existing_context_length: int = 0,
        motion_context_end_frame: int = 0,
        chunk_frames: int = 0,
        control_video_filename: str = "",
        guide_video_filename: str = "",
        chunk_index: int = -1,
        control_skip_frames: int = 0,
        control_strength: float = 1.0,
        # A spoken line is only its sound: no H3_Latent_ file, no live-preview clips.
        save_latent: bool = True,
        live_preview: bool = True,
        # The default fused checkpoint has Mystic 0.7 motion merged in and
        # cannot be dialled back; a restrained-motion shot names the hybrid base
        # here and brings its own turbo LoRA.
        unet_name: str = "",
        tiled_vae_decode: bool = False,
        hyperflow_lora: str = "",
        # CrossView re-angle route (build_h3_video_workflow documents all three).
        sampler: str = "",
        crossview_warp: Optional[dict] = None,
        block_sparse: bool = False,
        # Audio locks: backend/audio_lock.py builds the track and the ranges.
        audio_lock_track: str = "",
        audio_lock_ranges: str = "",
        audio_lock_feather: float = 0.0,
        # Redo only the sound of a finished render (audio_redo.py).
        audio_redo: Optional[dict] = None,
        refine_latent: str = "",
        refine_video: str = "",
        on_queued: Optional[callable] = None,
        return_info: bool = False,
    ):
        """Native Video + Audio generation via MiniMax H3 (Ref2VA / FL2VA / I2VA / L2VA / T2VA)."""
        # A reference video is fed in at its own resolution — there is no resize
        # in the graph — so a 1080p previs against a 768p generation carries
        # ~2x the pixels per frame for no gain. Size each one down to the
        # generation box, keeping its aspect ratio, and leave small ones alone.
        video_reference_sizes: list[Optional[tuple[int, int]]] = []
        silent_video_references: list[str] = []
        for vid in (video_reference_filenames or []):
            src = self._probe_video_size(vid)
            fitted = self._fit_inside(src, width, height) if src else None
            if src and fitted:
                logger.info("Reference video %s: %dx%d -> %dx%d (ratio kept)",
                            vid, src[0], src[1], fitted[0], fitted[1])
            elif src:
                logger.info("Reference video %s: %dx%d already fits %dx%d",
                            vid, src[0], src[1], width, height)
            else:
                logger.info("Reference video %s: size unreadable, passing through", vid)
            video_reference_sizes.append(fitted)
            # A previs render has no audio track. Mounting its (silent) audio
            # would add an <Audio N> reference the prompt never declares.
            if self._probe_video_has_audio(vid) is False:
                logger.info("Reference video %s: no audio stream, leaving ref_video_audio unmounted", vid)
                silent_video_references.append(vid)

        if audio_lock_track:
            await self.require_node_class(
                "AicinemaLockAudioRanges",
                "Run `python tools/install_comfy_nodes.py` and restart ComfyUI.")
        if audio_redo:
            await self.require_node_class(
                "H3AudioRefineMask",
                "Third-party pack: git clone https://github.com/Adudeguyman/ComfyUI-H3-AudioRefine "
                "(MIT, tested at commit d78d34f, v1.0.4) into ComfyUI/custom_nodes and restart ComfyUI.")
            await self.require_node_class(
                "AicinemaPackSavedLatent",
                "Run `python tools/install_comfy_nodes.py` and restart ComfyUI.")
        workflow = wb.build_h3_video_workflow(
            prompt=prompt,
            first_frame_filename=first_frame_filename,
            last_frame_filename=last_frame_filename,
            last_frame_index=last_frame_index,
            guide_frames=guide_frames or [],
            image_reference_filenames=image_reference_filenames or [],
            audio_reference_filenames=audio_reference_filenames or [],
            video_reference_filenames=video_reference_filenames or [],
            video_reference_sizes=video_reference_sizes,
            silent_video_references=silent_video_references,
            ref_image_size=ref_image_size,
            width=width,
            height=height,
            length=length,
            steps=steps,
            seed=_resolve_seed(seed),
            scheduler=scheduler,
            lora_name=lora_name,
            lora_strength=lora_strength,
            style_lora_name=style_lora_name,
            style_lora_strength=style_lora_strength,
            style_loras=style_loras or [],
            sage=sage,
            shift_video=shift_video,
            shift_audio=shift_audio,
            motion_context_latent=motion_context_latent,
            motion_context_video=motion_context_video,
            existing_context_length=existing_context_length,
            motion_context_end_frame=motion_context_end_frame,
            motion_context_length=motion_context_length,
            motion_context_audio=motion_context_audio,
            chunk_frames=chunk_frames,
            chunk_index=chunk_index,
            control_video_filename=control_video_filename,
            guide_video_filename=guide_video_filename,
            control_skip_frames=control_skip_frames,
            control_strength=control_strength,
            tiled_vae_decode=tiled_vae_decode,
            hyperflow_lora=hyperflow_lora,
            sampler=sampler,
            crossview_warp=crossview_warp,
            block_sparse=block_sparse,
            audio_lock_track=audio_lock_track,
            audio_lock_ranges=audio_lock_ranges,
            audio_lock_feather=audio_lock_feather,
            audio_redo=audio_redo,
            refine_latent=refine_latent,
            refine_video=refine_video,
            save_latent=save_latent,
            **({"unet_name": unet_name} if unet_name else {}),
        )
        return await self._run_video_workflow(workflow, timeout=2400, on_queued=on_queued, return_info=return_info, return_meta=True,
                                              live_preview=live_preview)

    async def temporal_reshot_h3(
        self,
        source_video: str,
        prompt: str,
        start_frame: int,
        frame_count: int,
        context_before: int = 39,
        context_after: int = 39,
        edge_blend_frames: int = 0,
        image_reference_filenames: list[str] = None,
        steps: int = 20,
        seed: int = -1,
        lora_name: str = "",
        lora_strength: float = 1.0,
        style_lora_name: str = "",
        style_lora_strength: float = 1.0,
        condition_source_audio: bool = False,
        sage: str = wb.DEFAULT_H3_ACCEL,
        on_queued: Optional[callable] = None,
        return_info: bool = False,
    ):
        """Replace one full-frame interval while preserving the source outside it."""
        mp = _machine_profile()
        workflow = wb.build_h3_temporal_reshot_workflow(
            unet_name=mp.substitute_unet("minimax_h3_ref2va_pruned_int8_convrot.safetensors"),
            source_video=source_video,
            prompt=prompt,
            start_frame=start_frame,
            frame_count=frame_count,
            context_before=context_before,
            context_after=context_after,
            edge_blend_frames=edge_blend_frames,
            image_reference_filenames=image_reference_filenames or [],
            steps=steps,
            seed=_resolve_seed(seed),
            lora_name=lora_name,
            lora_strength=lora_strength,
            style_lora_name=style_lora_name,
            style_lora_strength=style_lora_strength,
            condition_source_audio=condition_source_audio,
            sage=sage,
        )
        return await self._run_video_workflow(
            workflow, timeout=3600, on_queued=on_queued,
            error_msg="No H3 temporal reshot video produced", return_info=return_info)

    async def av_bridge_h3(
        self,
        source_video: str,
        prompt: str,
        head_end: int,
        tail_start: int,
        preserve: int = 39,
        target: int = 107,
        width: int = 1376,
        height: int = 768,
        steps: int = 20,
        seed: int = -1,
        shift_video: float = 12.0,
        shift_audio: float = 3.0,
        sage: str = wb.DEFAULT_H3_ACCEL,
        on_queued: Optional[callable] = None,
        return_info: bool = False,
    ):
        """Regenerate the middle of a clip with both of its ends frozen.

        No reference images or audio: the bridge graph is text-conditioned and
        the two frozen endpoints are the anchor. Anything the repair has to look
        like must be written into `prompt`.
        """
        mp = _machine_profile()
        workflow = wb.build_h3_av_bridge_workflow(
            unet_name=mp.substitute_unet("minimax_h3_ref2va_pruned_int8_convrot.safetensors"),
            tiled_vae_decode=bool(mp.PROFILE.get("tiled_vae_decode")),
            source_video=source_video,
            prompt=prompt,
            head_end=head_end,
            tail_start=tail_start,
            preserve=preserve,
            target=target,
            width=width,
            height=height,
            steps=steps,
            seed=_resolve_seed(seed),
            shift_video=shift_video,
            shift_audio=shift_audio,
            sage=sage,
        )
        return await self._run_video_workflow(
            workflow, timeout=3600, on_queued=on_queued,
            error_msg="No H3 AV bridge video produced", return_info=return_info)

    @staticmethod
    def _read_latent_dims(latent_filename: str) -> Optional[tuple[int, int]]:
        """(latent_w, latent_h) of the saved video stream, or None if unreadable.

        Read straight from the safetensors header (a JSON blob after an 8-byte
        length), so no torch/safetensors import is needed. The upscaler node sizes
        its target from these; guessing them from the video's pixel dimensions is
        how width/height end up swapped on portrait clips.
        """
        import json as _json
        import struct as _struct
        for d in (COMFYUI_OUTPUT_DIR, COMFYUI_INPUT_DIR):
            if not d:
                continue
            path = Path(d) / latent_filename
            if not path.is_file():
                continue
            try:
                with open(path, "rb") as fh:
                    n = _struct.unpack("<Q", fh.read(8))[0]
                    hdr = _json.loads(fh.read(n))
                shape = (hdr.get("video") or {}).get("shape")
                if shape and len(shape) >= 2:
                    return int(shape[-1]), int(shape[-2])
            except Exception as e:
                logger.warning(f"Could not read latent dims from {path}: {e}")
            return None
        return None

    @staticmethod
    def _read_latent_frames(latent_filename: str) -> Optional[int]:
        """Frame count of the saved video stream, or None if unreadable.

        H3 packs frames into tokens on a (1, 4, 4, 4, 4) repeating grid, so T
        latent tokens carry `sum(FRAME_PER_TOKEN[i % 5] for i in range(T))` frames
        -- the same arithmetic the H3 nodes use. Read from the safetensors header.
        """
        import json as _json
        import struct as _struct
        FRAME_PER_TOKEN = (1, 4, 4, 4, 4)
        for d in (COMFYUI_OUTPUT_DIR, COMFYUI_INPUT_DIR):
            if not d:
                continue
            path = Path(d) / latent_filename
            if not path.is_file():
                continue
            try:
                with open(path, "rb") as fh:
                    n = _struct.unpack("<Q", fh.read(8))[0]
                    hdr = _json.loads(fh.read(n))
                shape = (hdr.get("video") or {}).get("shape")
                if shape and len(shape) >= 3:
                    tokens = int(shape[-3])
                    return sum(FRAME_PER_TOKEN[i % 5] for i in range(tokens))
            except Exception as e:
                logger.warning(f"Could not read latent frames from {path}: {e}")
            return None
        return None

    async def upscale_h3_latent(
        self,
        latent_filename: str,
        prompt: str = "",
        scale_by: float = 2.0,
        reference_filenames: Optional[list] = None,
        first_frame_filename: str = "",
        last_frame_filename: str = "",
        length: int = 124,
        seed: int = -1,
        manual_sigmas: str = wb.REFINE_SIGMAS,
        spatial_tile: int = 0,
        # 0 = the whole clip in one span (no temporal chunking); see the builder.
        chunk_frames: int = 0,
        control_video_filename: str = "",
        chunk_index: int = -1,
        control_skip_frames: int = 0,
        control_strength: float = 1.0,
        # The refine checkpoint has the turbo LoRA merged in; see
        # wb.build_h3_latent_upscale_workflow.
        lora_name: str = "",
        lora_strength: float = 1.0,
        sage: str = wb.DEFAULT_H3_ACCEL,
        # A file in latent_upscale_models/; empty = the builder's default (H3_LATENT_UPSCALER).
        upscale_model: str = "",
        # frames to take off the decoded head: a chained clip's context window
        trim_head_frames: int = 0,
        on_queued: Optional[callable] = None,
        return_info: bool = False,
        # A plain video (absolute path, prepared by the caller: 24 fps, /32,
        # source_frames on the 51k+39 grid) encoded in the graph instead of a
        # saved latent. latent_filename is then unused.
        source_video: str = "",
        source_frames: int = 0,
        source_width: int = 0,
        source_height: int = 0,
    ):
        """Upscale a finished H3 latent, then re-sample it once at the new size."""
        if source_video:
            workflow = wb.build_h3_latent_upscale_workflow(
                latent_filename="",
                source_latent_w=source_width // 16, source_latent_h=source_height // 16,
                source_video=source_video,
                prompt=prompt, scale_by=scale_by,
                reference_filenames=reference_filenames,
                first_frame_filename=first_frame_filename,
                last_frame_filename=last_frame_filename,
                length=source_frames, seed=_resolve_seed(seed),
                manual_sigmas=manual_sigmas, spatial_tile=spatial_tile,
                chunk_frames=chunk_frames, lora_name=lora_name, lora_strength=lora_strength,
                sage=sage, **({"upscale_model": upscale_model} if upscale_model else {}),
            )
            return await self._run_video_workflow(workflow, timeout=2400, on_queued=on_queued, error_msg="No H3 upscale video produced", return_info=return_info)
        # Ensure latent file is available in ComfyUI's input directory
        search_dirs = [
            Path(COMFYUI_INPUT_DIR) if COMFYUI_INPUT_DIR else None,
            Path(COMFYUI_OUTPUT_DIR) if COMFYUI_OUTPUT_DIR else None,
        ]
        search_dirs = [d for d in search_dirs if d and d.is_dir()]
        if COMFYUI_INPUT_DIR:
            dst = Path(COMFYUI_INPUT_DIR) / latent_filename
            if not dst.is_file():
                for sdir in search_dirs:
                    src = sdir / latent_filename
                    if src.is_file():
                        try:
                            import shutil
                            shutil.copy2(src, dst)
                            break
                        except Exception as e:
                            logger.warning("Could not copy latent: %s", e)

        dims = self._read_latent_dims(latent_filename)
        extra = {}
        if dims:
            extra["source_latent_w"], extra["source_latent_h"] = dims
        frames = self._read_latent_frames(latent_filename)
        if frames:
            length = frames
        else:
            logger.warning(
                f"Latent dims for {latent_filename} unavailable; upscaler will use "
                f"builder defaults and may mis-size the target")
        # The refine builder has never wired a control video, and it has no
        # chunk_index either: passing any of them raised TypeError before a job
        # was queued, which is what killed every latent upscale coming through
        # here (2026-09-12). They stay in this signature because callers pass
        # them, but a caller that actually sets one should hear about it rather
        # than have it silently dropped.
        if control_video_filename or control_skip_frames or control_strength != 1.0:
            logger.warning(
                "upscale_h3_latent ignores control_video_filename/"
                "control_skip_frames/control_strength: the refine builder has no "
                "control-video input")
        workflow = wb.build_h3_latent_upscale_workflow(
            latent_filename=latent_filename,
            **({"upscale_model": upscale_model} if upscale_model else {}),
            **extra,
            # Empty on purpose: the builder picks the refine text, and which one
            # is right depends on whether anything is mounted to be named.
            prompt=prompt,
            scale_by=scale_by,
            reference_filenames=reference_filenames,
            first_frame_filename=first_frame_filename,
            last_frame_filename=last_frame_filename,
            length=length,
            seed=_resolve_seed(seed),
            manual_sigmas=manual_sigmas,
            spatial_tile=spatial_tile,
            # chunk_index is a generator concept -- it tags one chunk of a chained
            # shot. The upscale builder has no such parameter and passing it raised
            # a TypeError on every latent upscale that came through here, which is
            # what stopped the character sheets (2026-09-12).
            chunk_frames=chunk_frames,
            lora_name=lora_name,
            lora_strength=lora_strength,
            sage=sage,
            trim_head_frames=trim_head_frames,
        )
        return await self._run_video_workflow(workflow, timeout=2400, on_queued=on_queued, error_msg="No H3 upscale video produced", return_info=return_info)

    # ── Video upscale / interpolation ──────────────────────────────────────────

    async def upscale_video_esrgan(
        self,
        comfy_filename: str,
        model_name: str = "RealESRGAN_x2.pth",
        target_width: int = 0,
        target_height: int = 0,
        on_queued: Optional[callable] = None,
        return_info: bool = False,
    ):
        """Deterministic ESRGAN upscale of a whole clip in one pass."""
        workflow = wb.build_esrgan_upscale_workflow(
            video_filename=comfy_filename,
            model_name=model_name,
            target_width=target_width,
            target_height=target_height,
        )
        return await self._run_video_workflow(
            workflow, timeout=3600, on_queued=on_queued,
            error_msg="No upscaled video produced",
            return_info=return_info,
        )

    async def interpolate_video(
        self,
        video_filename: str,
        rife_multiplier: int,
        fps: float,
        on_queued=None,
    ) -> bytes:
        """Run a single-pass RIFE frame interpolation on a pre-generated video."""
        workflow = wb.build_rife_interpolate_workflow(video_filename, rife_multiplier, fps)
        prompt_id = await self.queue_prompt(workflow)
        await self._notify_queued(on_queued, prompt_id)
        return await self.resume_video_job(prompt_id)
        unet_name: str = "",
