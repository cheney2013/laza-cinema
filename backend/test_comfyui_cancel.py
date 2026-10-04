"""Cancelling our prompt must never interrupt someone else's ComfyUI job."""
import asyncio
import json
import unittest
from unittest import mock

import httpx

import comfyui_client


class _FakeComfy:
    def __init__(self, running=(), pending=(), queue_ok=True):
        self.running, self.pending, self.queue_ok = list(running), list(pending), queue_ok
        self.calls = []

    def handler(self, request):
        body = json.loads(request.content) if request.content else None
        self.calls.append((request.method, request.url.path, body))
        if request.method == "GET" and request.url.path == "/queue":
            if not self.queue_ok:
                return httpx.Response(500)
            return httpx.Response(200, json={
                "queue_running": [[0, p, {}, {}, []] for p in self.running],
                "queue_pending": [[1, p, {}, {}, []] for p in self.pending],
            })
        return httpx.Response(200, json={})

    def posts(self):
        return [(path, body) for m, path, body in self.calls if m == "POST"]


def _run(fake, coro_fn):
    transport = httpx.MockTransport(fake.handler)
    real = httpx.AsyncClient
    with mock.patch.object(comfyui_client.httpx, "AsyncClient",
                           lambda *a, **kw: real(transport=transport, **kw)):
        client = comfyui_client.ComfyUIClient("http://comfy")
        return asyncio.run(coro_fn(client))


class CancelPromptTest(unittest.TestCase):
    def test_running_prompt_gets_targeted_interrupt(self):
        fake = _FakeComfy(running=["ours"])
        _run(fake, lambda c: c.cancel_prompt("ours"))
        self.assertEqual(fake.posts(), [("/interrupt", {"prompt_id": "ours"})])

    def test_pending_prompt_is_dequeued_not_interrupted(self):
        fake = _FakeComfy(running=["theirs"], pending=["ours"])
        _run(fake, lambda c: c.cancel_prompt("ours"))
        self.assertEqual(fake.posts(), [("/queue", {"delete": ["ours"]})])

    def test_absent_prompt_touches_nothing(self):
        fake = _FakeComfy(running=["theirs"])
        _run(fake, lambda c: c.cancel_prompt("ours"))
        self.assertEqual(fake.posts(), [])

    def test_no_prompt_id_never_global_interrupt(self):
        fake = _FakeComfy(running=["theirs"])
        self.assertFalse(_run(fake, lambda c: c.cancel_prompt(None)))
        self.assertEqual(fake.calls, [])

    def test_queue_unreadable_still_scoped(self):
        fake = _FakeComfy(queue_ok=False)
        _run(fake, lambda c: c.cancel_prompt("ours"))
        for path, body in fake.posts():
            self.assertIsNotNone(body)
            self.assertIn("ours", json.dumps(body))

    def test_abandon_running_prompt_is_targeted(self):
        fake = _FakeComfy(running=["ours"])
        self.assertEqual(_run(fake, lambda c: c.abandon_prompt("ours")), "interrupted")
        self.assertEqual(fake.posts(), [("/interrupt", {"prompt_id": "ours"})])


if __name__ == "__main__":
    unittest.main()
