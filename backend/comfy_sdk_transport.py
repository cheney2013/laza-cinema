"""Job transport through the Comfy SDK and a local comfy-api-proxy (COMFY_TRANSPORT=sdk).

The studio talks to ComfyUI in two ways. The default, "native", is ComfyUI's own HTTP + WebSocket
protocol. With COMFY_TRANSPORT=sdk the life of a job -- submit, follow, cancel, outputs -- goes through
the Comfy SDK (comfy-sdk on PyPI) against the Comfy API v2 that comfy-api-proxy serves in front of the
same local ComfyUI. Input uploads, /free, /system_stats and /object_info stay native: the SDK has no
equivalent for them.

This module only translates. ComfyUIClient keeps its public contract (queue_prompt returns an id,
wait_for_result returns the same history-shaped outputs, cancel/abandon/state keep their meaning).
"""
from __future__ import annotations

import base64
import json
import logging
import os
from typing import Any, AsyncIterator, Optional

try:
    from envfile import env_value
except ImportError:  # imported as backend.comfy_sdk_transport
    from backend.envfile import env_value

logger = logging.getLogger(__name__)

# comfy-api-proxy's default port (8189) is where ComfyUI Desktop sometimes comes back, and
# comfyui_client._resolve_comfyui_url fails over to it. The proxy therefore gets its own port.
DEFAULT_SDK_URL = "http://127.0.0.1:8290"

# Proxy output kind -> the history key ComfyUI filed that output under.
_KIND_KEY = {
    "image": "images",
    "video": "gifs",
    "audio": "audio",
    "text": "text",
    "file": "files",
    "latent": "latents",
}

# comfy-sdk job statuses (comfy_sdk._core.TERMINAL).
SUCCEEDED = "succeeded"
TERMINAL = frozenset({"succeeded", "canceled", "failed", "expired"})


def enabled() -> bool:
    return (env_value("COMFY_TRANSPORT") or "native").lower() == "sdk"


def sdk_url() -> str:
    return (env_value("COMFY_SDK_URL") or DEFAULT_SDK_URL).rstrip("/")


def decode_asset_id(asset_id: str) -> dict:
    """The proxy's asset id is `<urlsafe base64 of {"j": job, "f": filename, "s": subfolder, "t": type}>.<signature>`."""
    try:
        payload = asset_id.split(".", 1)[0]
        raw = base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except Exception:  # noqa: BLE001 -- an id we cannot read just loses its subfolder
        return {}


def history_outputs(outputs: list[Any]) -> dict[str, dict[str, list[dict]]]:
    """SDK outputs -> the {node_id: {"images": [{filename, subfolder, type}]}} shape of /history."""
    result: dict[str, dict[str, list[dict]]] = {}
    for out in outputs:
        model = getattr(out, "_model", out)
        kind = getattr(getattr(model, "type", None), "value", getattr(model, "type", None))
        key = _KIND_KEY.get(str(kind))
        if not key:
            continue
        meta = decode_asset_id(str(getattr(model, "id", "") or ""))
        item = {
            "filename": getattr(model, "name", None) or meta.get("f") or "",
            "subfolder": meta.get("s") or "",
            "type": meta.get("t") or "output",
        }
        if not item["filename"]:
            continue
        result.setdefault(str(getattr(model, "node_id", "")), {}).setdefault(key, []).append(item)
    return result


class SdkTransport:
    """One AsyncComfy client and the jobs this process submitted."""

    def __init__(self, base_url: Optional[str] = None):
        self.base_url = (base_url or sdk_url()).rstrip("/")
        self._client = None
        self._jobs: dict[str, Any] = {}

    def _comfy(self):
        if self._client is None:
            from comfy_sdk import AsyncComfy
            # The SDK reads the base URL from the environment each time a client is built. The
            # studio never talks to Comfy Cloud, so setting it for the process is safe.
            os.environ["COMFY_BASE_URL"] = self.base_url
            self._client = AsyncComfy()
        return self._client

    async def submit(self, workflow: dict) -> str:
        """Submit an API-format graph; return the job id (which is also ComfyUI's prompt_id).

        Never retried here: a second submit is a second job, and a reused idempotency key is
        rejected rather than replayed (see the SDK page of the Comfy docs)."""
        comfy = self._comfy()
        wf = comfy.workflows.from_json(workflow)
        job = await comfy.submit(wf)
        self._jobs[job.id] = job
        for old in list(self._jobs)[:-64]:
            del self._jobs[old]
        return job.id

    async def job(self, job_id: str):
        """The handle of a job, rehydrated by id when this process did not submit it."""
        job = self._jobs.get(job_id)
        if job is None:
            job = await self._comfy().jobs.get(job_id)
            self._jobs[job_id] = job
        return job

    async def events(self, job_id: str) -> AsyncIterator[Any]:
        job = await self.job(job_id)
        async for ev in job.events():
            yield ev

    async def refresh(self, job_id: str):
        job = await self.job(job_id)
        await job.refresh()
        return job

    async def cancel(self, job_id: str):
        job = await self.job(job_id)
        await job.cancel()
        return job

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None
