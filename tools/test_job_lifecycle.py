r"""Regression tests for ComfyUI job lifecycle handling (comfyui_client.py).

Guards the failure mode where the UI and ComfyUI disagree: a job that finished
in ComfyUI showing as failed/blank, or a dead job leaving the UI spinning.

    backend\.venv\Scripts\python tools\test_job_lifecycle.py

Needs a reachable ComfyUI and an idle queue (it waits for one). Runs 4 real
short generations, so budget a few minutes of GPU.

Both assertions below were added because an EARLIER version of these tests
passed while the fix underneath was broken:
  - "no misleading poll warning": ComfyUIError raised inside the history poll was
    being swallowed by `except Exception` and recounted as an HTTP failure. The
    job-level verdict still looked right only because the websocket event
    happened to arrive too.
  - "leaked state": queue_prompt registers per-prompt state that only the
    wait_for_result return paths cleared, so a cancelled wait leaked it forever.
"""
import asyncio, logging, os, sys, time, httpx

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "backend"))
from comfyui_client import ComfyUIClient, ComfyUIError   # noqa: E402
import workflow_builders as wb                            # noqa: E402

COMFY = os.environ.get("COMFYUI_URL", "http://127.0.0.1:8188").rstrip("/")
P = "A candle burns on a stone ledge in a dark hall. The flame leans and steadies."

LOGS = []
class _Cap(logging.Handler):
    def emit(self, r): LOGS.append(r.getMessage())
logging.getLogger("comfyui_client").addHandler(_Cap())
logging.getLogger().addHandler(_Cap())

def wf(seed):
    return wb.build_h3_video_workflow(P, width=1216, height=672, length=124,
                                      steps=4, seed=seed)

async def qlen(c):
    q = (await c.get(f"{COMFY}/queue")).json()
    return len(q.get("queue_running", [])) + len(q.get("queue_pending", []))

async def is_running(c, pid):
    q = (await c.get(f"{COMFY}/queue")).json()
    return any(len(i) > 1 and i[1] == pid for i in q.get("queue_running", []) or [])

async def wait_idle(c, tries=240):
    for _ in range(tries):
        if await qlen(c) == 0:
            return True
        await asyncio.sleep(15)
    return False

async def test_interrupt_isolation(cl, c):
    """execution_interrupted is broadcast=True: cancelling ANY job reaches every
    client. A healthy job must not die because a different one was cancelled."""
    print("\n--- interrupt A, B must survive ---")
    LOGS.clear()
    pidA = await cl.queue_prompt(wf(78001))
    pidB = await cl.queue_prompt(wf(78002))
    assert cl._client_ids[pidA] != cl._client_ids[pidB], "prompts must not share a clientId"
    tB = asyncio.create_task(cl.wait_for_result(pidB, timeout=900, expect_images=False))
    tA = asyncio.create_task(cl.wait_for_result(pidA, timeout=900, expect_images=False))
    for _ in range(120):
        if await is_running(c, pidA):
            break
        await asyncio.sleep(1)
    await c.post(f"{COMFY}/interrupt")
    try:
        await tA; a = "completed"
    except ComfyUIError as e:
        a = str(e)
    try:
        out = await tB
        b_ok, b = (isinstance(out, dict) and len(out) > 0), f"COMPLETED ({len(out)} nodes)"
    except ComfyUIError as e:
        b_ok, b = False, f"ERROR {e}"
    bad = [m for m in LOGS if "backup poll error" in m or "reachability check failed" in m]
    print(f"  A: {a}\n  B: {b}")
    r = [("A reported interrupted", "interrupt" in a.lower()),
         ("B survived", b_ok),
         ("no misleading poll warning", not bad)]
    for n, ok in r:
        print(f"  {n:28s}: {'PASS' if ok else 'FAIL'}")
    return all(ok for _, ok in r)

async def test_vanished_job_fails_fast(cl, c):
    """A prompt that leaves the queue without reaching history (ComfyUI restart,
    queue cleared) must fail in seconds, not block until `timeout`."""
    print("\n--- deleted prompt must fail fast ---")
    pidA = await cl.queue_prompt(wf(78003))
    pidB = await cl.queue_prompt(wf(78004))
    tA = asyncio.create_task(cl.wait_for_result(pidA, timeout=900, expect_images=False))
    for _ in range(120):
        if await is_running(c, pidA):
            break
        await asyncio.sleep(1)
    t0 = time.time()
    tB = asyncio.create_task(cl.wait_for_result(pidB, timeout=900, expect_images=False))
    await asyncio.sleep(1)
    await c.post(f"{COMFY}/queue", json={"delete": [pidB]})
    try:
        await tB; msg, ok = "completed(unexpected)", False
    except ComfyUIError as e:
        msg = str(e); ok = "disappear" in msg.lower()
    el = time.time() - t0
    await c.post(f"{COMFY}/interrupt")
    try:
        await tA
    except ComfyUIError:
        pass
    print(f"  B: {msg}   after {el:.1f}s")
    r = [("failed fast (<60s)", el < 60), ("correct reason", ok)]
    for n, okk in r:
        print(f"  {n:28s}: {'PASS' if okk else 'FAIL'}")
    return all(okk for _, okk in r)

async def main():
    cl = ComfyUIClient(COMFY)
    async with httpx.AsyncClient(timeout=15) as c:
        if not await wait_idle(c):
            print("!! queue never went idle"); return 1
        results = [await test_interrupt_isolation(cl, c)]
        await wait_idle(c)
        results.append(await test_vanished_job_fails_fast(cl, c))
        leaked = len(cl._progress) + len(cl._workflows) + len(cl._client_ids)
        print(f"\n  leaked state                : {'PASS' if leaked == 0 else f'FAIL ({leaked})'}")
        results.append(leaked == 0)
        print(f"\n==== {'ALL PASS' if all(results) else 'FAILURES PRESENT'} ====")
        return 0 if all(results) else 1

if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
