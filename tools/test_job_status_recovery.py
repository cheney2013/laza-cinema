r"""Regression tests for job status recovery around backend restarts (main.py).

Guards the failure mode where a canvas node stayed on "generating" forever:
  - a graceful restart (uvicorn --reload, Ctrl+C) cancelled the worker task and
    recorded the running job as a bare "cancelled" that the UI never handled;
  - a job that scrolled out of the 20-entry /queue history window looked
    identical to a job that was still running;
  - a ComfyUI prompt queued by a job that died with the backend kept the GPU
    busy, so the next job sat at "queued" for the whole orphaned render.

    backend\.venv\Scripts\python tools\test_job_status_recovery.py

Runs entirely in-process against a scratch state file: no ComfyUI, no GPU,
and the real backend/uploads/state.json is never touched.
"""
import asyncio
import json
import os
import sys
import tempfile
import types
from pathlib import Path

import httpx

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "backend"))

import main                                   # noqa: E402
import comfyui_client as cc                   # noqa: E402

FAILS = []


def check(cond, label):
    print(("  PASS  " if cond else "  FAIL  ") + label)
    if not cond:
        FAILS.append(label)


# ── abandon_prompt against a fake ComfyUI ─────────────────────────────────────

async def test_abandon_prompt():
    print("abandon_prompt")
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.method, request.url.path, request.content))
        if request.method == "GET" and request.url.path == "/queue":
            return httpx.Response(200, json={
                "queue_running": [[0, "p-run", {}, {}, []]],
                "queue_pending": [[1, "p-pend", {}, {}, []]],
            })
        return httpx.Response(200, json={})

    def factory(**kw):
        return httpx.AsyncClient(transport=httpx.MockTransport(handler),
                                 base_url="http://fake")

    real_httpx = cc.httpx
    cc.httpx = types.SimpleNamespace(AsyncClient=factory)
    try:
        client = cc.ComfyUIClient("http://fake")
        client._progress["p-run"] = {"step": 1}
        client._workflows["p-run"] = {}

        check(await client.abandon_prompt("p-run") == "interrupted", "running prompt is interrupted")
        check(("POST", "/interrupt", b"") in calls, "POST /interrupt was sent")
        check("p-run" not in client._progress and "p-run" not in client._workflows,
              "per-prompt state is cleaned up")

        calls.clear()
        check(await client.abandon_prompt("p-pend") == "dequeued", "pending prompt is deleted from the queue")
        check(any(m == "POST" and p == "/queue" and b"p-pend" in body for m, p, body in calls),
              "POST /queue delete carried the prompt id")
        check(not any(p == "/interrupt" for _, p, _ in calls), "dequeue does not fire the global /interrupt")

        calls.clear()
        check(await client.abandon_prompt("p-none") == "absent", "unknown prompt: nothing to do")
        check(all(m == "GET" for m, _, _ in calls), "unknown prompt: no writes to ComfyUI")
    finally:
        cc.httpx = real_httpx

    def down(**kw):
        raise OSError("connection refused")
    cc.httpx = types.SimpleNamespace(AsyncClient=down)
    try:
        check(await cc.ComfyUIClient("http://fake").abandon_prompt("p-x") == "unreachable",
              "ComfyUI down: reported, not raised")
    finally:
        cc.httpx = real_httpx


# ── main.py lifespan / queue behaviour ────────────────────────────────────────

class Api:
    def __init__(self):
        self.c = httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),
                                   base_url="http://t")

    async def get(self, path):
        return await self.c.get(path)

    async def close(self):
        await self.c.aclose()


async def wait_until(pred, timeout=5.0):
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        if pred():
            return True
        await asyncio.sleep(0.02)
    return pred()


async def test_main(state_file: Path):
    abandoned = []

    async def fake_abandon(prompt_id):
        abandoned.append(prompt_id)
        return "interrupted"

    async def fake_health():
        return False

    main.STATE_FILE = state_file
    main.comfyui.abandon_prompt = fake_abandon
    main.comfyui.health_check = fake_health

    # ── 1. hard kill: state.json says a job was running when the process died ──
    print("startup after hard kill")
    running = {"id": "j-run", "type": "video", "status": "running", "prompt_id": "p-old",
               "created_at": "x", "started_at": "x", "completed_at": None, "result": None, "error": None}
    queued = {"id": "j-queued", "type": "scene", "status": "queued", "prompt_id": None,
              "created_at": "x", "started_at": None, "completed_at": None, "result": None, "error": None}
    old_hist = [{"id": f"j-old-{i}", "type": "scene", "status": "done", "result": {"url": f"/u/{i}.png"}}
                for i in range(main.HISTORY_LIMIT + 5)]
    state_file.write_text(json.dumps({"queue": [running, queued], "history": old_hist,
                                      "active_job": running}))
    main._pending, main._history, main._active_job = [], [], None
    main._job_queue = asyncio.Queue()

    async with main.lifespan(main.app):
        api = Api()
        r = (await api.get("/queue?ids=j-run,j-queued,j-old-0,nope")).json()
        t = r["tracked"]
        check(set(t) == {"j-run", "j-queued"}, "tracked answers for the jobs it knows")
        check(t["j-run"]["status"] == "error" and t["j-run"]["error"] == main.SHUTDOWN_ERROR,
              "running job from the dead process is reported as a restart error")
        check(t["j-queued"]["status"] == "error", "queued job from the dead process is failed too")
        check(sorted(r["missing"]) == ["j-old-0", "nope"], "missing lists unknown + pruned ids")
        check(r["pending"] == [] and r["active"] is None, "queue is empty after recovery")
        check(len(main._history) == main.HISTORY_LIMIT, "history trimmed to HISTORY_LIMIT")
        check(sum(1 for j in main._history if j["id"] == "j-run") == 1, "active job recorded exactly once")
        check(abandoned == ["p-old"], "orphaned ComfyUI prompt of the dead job is abandoned (queued job had none)")
        check((await api.get("/job/nope")).status_code == 404, "/job/<unknown> is 404")
        check((await api.get("/job/j-run")).json()["status"] == "error", "/job/<stale> is the error record")
        persisted = json.loads(state_file.read_text())
        check(persisted["active_job"] is None and persisted["queue"] == [], "recovery persisted to state.json")
        await api.close()

    # ── 2. graceful shutdown while a job is running ────────────────────────────
    print("graceful shutdown mid-job")
    abandoned.clear()
    main._job_queue = asyncio.Queue()
    release_prompt = asyncio.Event()
    hold = asyncio.Event()

    async def runner(job):
        await release_prompt.wait()
        job["prompt_id"] = "p-live"
        main.save_state()
        await hold.wait()          # never set: the job is "rendering" until shutdown
        return {"url": "/never.mp4"}

    async with main.lifespan(main.app):
        api = Api()
        sub = await main.submit_job("video", runner)
        jid = sub["job_id"]
        check(await wait_until(lambda: main._active_job and main._active_job["id"] == jid),
              "job becomes active")
        r = (await api.get(f"/queue?ids={jid}")).json()
        check(r["tracked"][jid]["status"] == "running", "tracked reports running")
        check(r["active"]["progress"]["phase"] == "正在准备素材与构建工作流…",
              "phase before the prompt is queued describes preparation, not weight loading")
        release_prompt.set()
        check(await wait_until(lambda: main._active_job and main._active_job.get("prompt_id") == "p-live"),
              "runner registered its prompt id")
        r = (await api.get(f"/queue?ids={jid}")).json()
        check(bool(r["active"]["progress"]["phase"]), "phase is never empty for an active job")
        await api.close()
        # leaving the block == uvicorn shutdown

    hist = [j for j in main._history if j["id"] == jid]
    check(len(hist) == 1, "interrupted job landed in history exactly once")
    check(hist and hist[0]["status"] == "error" and hist[0]["error"] == main.SHUTDOWN_ERROR,
          "shutdown is recorded as a restart error, not a bare 'cancelled'")
    check(main._active_job is None, "no active job after shutdown")
    check(abandoned == ["p-live"], "the live ComfyUI prompt is abandoned on shutdown")
    persisted = json.loads(state_file.read_text())
    check(any(j["id"] == jid and j["status"] == "error" for j in persisted["history"]),
          "verdict written to state.json before exit")

    # ── 3. restart after that graceful shutdown: nothing to re-mark ───────────
    print("restart after graceful shutdown")
    abandoned.clear()
    main._pending, main._history, main._active_job = [], [], None
    main._job_queue = asyncio.Queue()
    async with main.lifespan(main.app):
        api = Api()
        r = (await api.get(f"/queue?ids={jid}")).json()
        check(r["tracked"][jid]["status"] == "error", "the frontend can still find the verdict after restart")
        check(abandoned == [], "nothing abandoned twice")
        await api.close()

    # ── 4. user cancel right before shutdown keeps 'cancelled' ────────────────
    print("user cancel survives shutdown")
    main._job_queue = asyncio.Queue()
    hold2 = asyncio.Event()

    async def runner2(job):
        await hold2.wait()
        return {}

    async with main.lifespan(main.app):
        api = Api()
        jid2 = (await main.submit_job("scene", runner2))["job_id"]
        await wait_until(lambda: main._active_job and main._active_job["id"] == jid2)
        main.comfyui.cancel_prompt = lambda *a, **k: asyncio.sleep(0, result=True)
        await main.cancel_job(jid2)
        await api.close()
    j2 = next(j for j in main._history if j["id"] == jid2)
    check(j2["status"] == "cancelled", "explicit user cancel is not rewritten as a restart error")


async def amain():
    await test_abandon_prompt()
    with tempfile.TemporaryDirectory() as d:
        await test_main(Path(d) / "state.json")


if __name__ == "__main__":
    asyncio.run(amain())
    print()
    if FAILS:
        print(f"{len(FAILS)} FAILED:")
        for f in FAILS:
            print("  -", f)
        sys.exit(1)
    print("ALL PASSED")
