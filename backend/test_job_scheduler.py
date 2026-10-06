import asyncio
import unittest
from datetime import datetime, timezone
from unittest import mock

import job_scheduler as sched
import main

NOW = 1_800_000_000.0


def job(jid, jtype, request=None, age=0.0, pinned=None):
    j = {"id": jid, "type": jtype, "status": "queued",
         "created_at": datetime.fromtimestamp(NOW - age, timezone.utc).isoformat(),
         "sched": sched.describe(jtype, request)}
    if pinned:
        j["pinned"] = pinned
    return j


LONG_H3 = {"length": 124 * 6, "width": 1376, "height": 768, "steps": 8}
EST = sched.Estimator([])


def order(queued, resident=None, start_in=0.0):
    return [e["job"]["id"] for e in sched.plan(queued, resident, NOW, start_in, EST)]


class PlanTest(unittest.TestCase):
    def test_describe(self):
        self.assertEqual(sched.describe("qwen_image", {})["family"], "qwen")
        self.assertEqual(sched.describe("video", {"motion_preset": "hybrid"})["family"], "h3:hybrid")
        self.assertEqual(sched.describe("upscale", {"method": "h3_latent"})["family"], "h3:default")
        self.assertEqual(sched.describe("video_trim", {})["family"], sched.NO_MODEL)
        d = sched.describe("video", {"length": 430, "chunk_frames": 124, "motion_context_length": 22})
        self.assertEqual(d["stages"], 4)

    def test_short_job_overtakes_long_one(self):
        q = [job("long", "video", LONG_H3, age=60), job("short", "qwen_image", age=30)]
        self.assertEqual(order(q, resident="qwen"), ["short", "long"])

    def test_long_job_is_not_starved(self):
        q = [job("long", "video", LONG_H3, age=6 * 3600)] + [
            job(f"s{i}", "qwen_image", age=10) for i in range(5)]
        self.assertEqual(order(q, resident="h3:default")[0], "long")

    def test_same_family_groups(self):
        # Equal-length jobs; the ones matching the resident model run together.
        q = [job("f1", "inpaint", age=40), job("q1", "qwen_image", age=30),
             job("f2", "inpaint", age=20), job("q2", "qwen_image", age=10)]
        self.assertEqual(order(q, resident="qwen", start_in=600), ["q1", "q2", "f1", "f2"])

    def test_pinned_first(self):
        q = [job("a", "qwen_image", age=100), job("b", "video", LONG_H3, pinned=2.0),
             job("c", "video", pinned=1.0)]
        self.assertEqual(order(q)[:2], ["c", "b"])

    def test_eta_accumulates(self):
        out = sched.plan([job("a", "video_trim"), job("b", "video_trim")], None, NOW, 100, EST)
        self.assertEqual(out[0]["eta"], 100)
        self.assertGreater(out[1]["eta"], 100)

    def test_estimator_learns_from_history(self):
        start = datetime.fromtimestamp(NOW, timezone.utc).isoformat()
        end = datetime.fromtimestamp(NOW + 50, timezone.utc).isoformat()
        hist = [{"type": "qwen_image", "status": "done", "started_at": start,
                 "completed_at": end, "sched": sched.describe("qwen_image", {})}]
        self.assertAlmostEqual(sched.Estimator(hist).seconds(job("x", "qwen_image")), 50)

    def test_needs_free(self):
        self.assertTrue(sched.needs_free("h3:default", "qwen"))
        self.assertFalse(sched.needs_free("h3:default", "h3:hybrid"))
        self.assertFalse(sched.needs_free(None, "qwen"))
        self.assertFalse(sched.needs_free("qwen", sched.NO_MODEL))
        # A light pass runs beside H3 without evicting it.
        self.assertFalse(sched.needs_free("h3:default", "esrgan"))
        self.assertFalse(sched.needs_free("h3:default", "rife"))
        self.assertEqual(sched.switch_cost("h3:default", "audio"), 0.0)

    def test_light_job_leaves_resident_alone(self):
        h = job("h", "video", age=10)
        out = sched.plan([job("r", "interpolate", age=50), h], "h3:default", NOW, 0, EST)
        self.assertEqual([e["job"]["id"] for e in out], ["r", "h"])
        self.assertEqual(out[1]["service"], EST.seconds(h))  # no reload after rife


class CutInTest(unittest.TestCase):
    def test_same_family_short_cuts_in(self):
        q = [job("q", "qwen_image", age=5), job("h", "video", age=5)]
        self.assertEqual(sched.cut_in(q, "h3:default", NOW, EST)["id"], "h")

    def test_other_family_needs_to_have_waited(self):
        self.assertIsNone(sched.cut_in([job("q", "qwen_image", age=5)], "h3:default", NOW, EST))
        self.assertEqual(
            sched.cut_in([job("q", "qwen_image", age=900)], "h3:default", NOW, EST)["id"], "q")

    def test_long_job_never_cuts_in_unless_pinned(self):
        self.assertIsNone(sched.cut_in([job("l", "video", LONG_H3, age=900)], "h3:default", NOW, EST))
        self.assertEqual(sched.cut_in([job("l", "video", LONG_H3, pinned=1.0)],
                                      "h3:default", NOW, EST)["id"], "l")


class ChunkYieldTest(unittest.IsolatedAsyncioTestCase):
    async def test_short_job_runs_between_chunks(self):
        order_run = []

        async def chain(j):
            for c in range(3):
                if c:
                    await main._yield_between_chunks(j)
                order_run.append(f"chunk{c}")
                await asyncio.sleep(0)
            return {}

        async def short(j):
            order_run.append("short")
            return {}

        pending, runners = [], {}
        free = mock.AsyncMock(return_value=True)
        with mock.patch.object(main, "save_state"), mock.patch.object(main, "GENERATION_ENABLED", True), \
                mock.patch.object(main, "_pending", pending), mock.patch.object(main, "_runners", runners), \
                mock.patch.object(main, "_queue_wake", asyncio.Event()), mock.patch.object(main, "_history", []), \
                mock.patch.object(main, "_suspended", []), mock.patch.object(main, "_resident_family", None), \
                mock.patch.object(main.comfyui, "free_memory", free), \
                mock.patch.object(main.comfyui, "get_system_stats", mock.AsyncMock(return_value={})), \
                mock.patch.object(main.comfyui, "last_family", mock.AsyncMock(return_value=None)), \
                mock.patch.object(main.comfyui, "loaded_vram_bytes", mock.AsyncMock(return_value=None)), \
                mock.patch.object(main, "_record_timing", lambda job, prompts: None):
            await main.submit_job("video", chain)
            worker = asyncio.create_task(main._job_worker())
            while not order_run:
                await asyncio.sleep(0)
            await main.submit_job("video_trim", short)
            # Both jobs recorded, not just all four steps run: cancelling between the last
            # step and the return would mark the long job as interrupted.
            for _ in range(100):
                if len(order_run) == 4 and len(main._history) == 2:
                    break
                await asyncio.sleep(0.01)
            worker.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await worker
            self.assertEqual(order_run, ["chunk0", "short", "chunk1", "chunk2"])
            self.assertEqual([j["status"] for j in main._history], ["done", "done"])
            self.assertIsNone(main._active_job)
            free.assert_not_awaited()


def done(jtype, request, secs, prompts=None):
    start = datetime.fromtimestamp(NOW, timezone.utc).isoformat()
    end = datetime.fromtimestamp(NOW + secs, timezone.utc).isoformat()
    j = {"type": jtype, "status": "done", "request": request,
         "started_at": start, "completed_at": end}
    return sched.timing_record(j, prompts)


SMALL = {"length": 146, "width": 768, "height": 1376, "steps": 8}
BIG = {"length": 243, "width": 1376, "height": 768, "steps": 8}


class DurationTest(unittest.TestCase):
    def test_bucket_median_ignores_paged_run(self):
        recs = [done("video", SMALL, s) for s in (95, 98, 100, 394, 97)]
        est = sched.Estimator([], recs)
        q = {"type": "video", "request": SMALL}
        self.assertAlmostEqual(est.seconds(q), 97.5)
        self.assertEqual(est.interval(q), (95, 100))
        self.assertEqual(est.source(q), "bucket")

    def test_paged_steps_flag_the_record(self):
        prompts = [{"nodes": [["Loader", 5.0], ["KSampler", 80.0], ["VAEDecode", 10.0]],
                    "steps": [10.0] * 7 + [40.0]}]
        rec = done("video", SMALL, 100, prompts)
        self.assertTrue(rec["paged"])
        self.assertEqual((rec["pre"], rec["post"]), (5.0, 10.0))

    def test_new_size_is_interpolated_superlinearly(self):
        def run(req, step):
            n = sched.tokens("video", req)
            return done("video", req, 8 * step + 10 + n, [
                {"nodes": [["L", 10.0], ["KSampler", 8 * step], ["VAEDecode", n]],
                 "steps": [step] * 8}])
        # step = 0.05 N + 0.0005 N^2 on two sizes; ask for a third.
        f = lambda req: 0.05 * sched.tokens("video", req) + 0.0005 * sched.tokens("video", req) ** 2
        est = sched.Estimator([], [run(SMALL, f(SMALL)), run(BIG, f(BIG))])
        mid = {"length": 200, "width": 1376, "height": 768, "steps": 8}
        q = {"type": "video", "request": mid}
        self.assertEqual(est.source(q), "fit")
        self.assertAlmostEqual(est.step_seconds(q), f(mid), places=3)
        self.assertAlmostEqual(est.seconds(q), 10 + 8 * f(mid) + sched.tokens("video", mid), places=1)


def sched_qwen():
    import workflow_builders
    return workflow_builders.QWEN_IMAGE_21_UNET


def room(vram_free_gib, ram_free_gib=40.0, vram_total_gib=32.0):
    gib = 1024 ** 3
    return {"devices": [{"vram_free": vram_free_gib * gib, "vram_total": vram_total_gib * gib}],
            "system": {"ram_free": ram_free_gib * gib}}


class FreeByRoomTests(unittest.TestCase):
    # `import main` reads the footprints learned from real jobs (VRAM_FOOTPRINTS_FILE); these
    # tests are about the estimates, so they run without them (H3 had learned 17.4 GiB, which
    # fits in 24 free and failed test_does_not_fit).
    def setUp(self):
        self._learned = dict(sched.LEARNED_VRAM_GIB)
        sched.LEARNED_VRAM_GIB.clear()

    def tearDown(self):
        sched.LEARNED_VRAM_GIB.clear()
        sched.LEARNED_VRAM_GIB.update(self._learned)

    def test_fits_beside_what_is_loaded(self):
        self.assertFalse(sched.lacks_room(room(24), "qwen"))
        self.assertFalse(sched.lacks_room(room(24), "qwen_text"))

    def test_does_not_fit(self):
        self.assertTrue(sched.lacks_room(room(10), "qwen"))
        self.assertTrue(sched.lacks_room(room(24, ram_free_gib=10), "qwen"))
        # H3 wants the whole card: 24 GiB free is not enough.
        self.assertTrue(sched.lacks_room(room(24), "h3:default"))
        self.assertFalse(sched.lacks_room(room(31), "h3:default"))

    def test_unreadable_numbers_or_unknown_family_give_no_verdict(self):
        self.assertIsNone(sched.lacks_room({}, "qwen"))
        self.assertIsNone(sched.lacks_room(room(24), "esrgan"))

    def test_should_free_follows_the_room_not_the_last_family(self):
        # Qwen resident but there is room for H3's neighbour: no unload.
        self.assertFalse(sched.should_free("qwen", "qwen"))
        self.assertFalse(sched.should_free("h3:default", "qwen", room(24)))
        # Nothing is tracked as resident, yet the card is full: unload.
        self.assertTrue(sched.should_free(None, "qwen", room(3)))
        self.assertTrue(sched.should_free("h3:default", "qwen", room(3)))
        # A light pass never unloads.
        self.assertFalse(sched.should_free("h3:default", "esrgan", room(1)))

    def test_a_model_already_in_vram_is_not_unloaded_for_its_own_weights(self):
        # Qwen is loaded (so little is free), nothing is tracked, and ComfyUI's last graph was Qwen's.
        qwen_graph = {"1": {"class_type": "UNETLoader", "inputs": {"unet_name": sched_qwen()}}}
        self.assertEqual(sched.family_of_graph(qwen_graph), "qwen")
        self.assertFalse(sched.should_free(sched.family_of_graph(qwen_graph), "qwen", room(3)))
        # ...while a different family still unloads it.
        self.assertTrue(sched.should_free(sched.family_of_graph(qwen_graph), "h3:default", room(3)))

    def test_family_of_graph(self):
        text_only = {"1": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_8b_int8_convrot.safetensors"}}}
        self.assertEqual(sched.family_of_graph(text_only), "qwen")
        h3 = {"1": {"class_type": "MiniMaxH3ImageToVideo", "inputs": {}}}
        self.assertEqual(sched.family_of_graph(h3), "h3")
        viggle = {"1": {"class_type": "UNETLoader", "inputs": {"unet_name": "minimax_h3_ref2va_viggle_pruned_int8_convrot.safetensors"}}}
        self.assertEqual(sched.family_of_graph(viggle), "viggle")
        self.assertIsNone(sched.family_of_graph({"1": {"class_type": "SaveVideo", "inputs": {}}}))
        self.assertIsNone(sched.family_of_graph(None))

    def test_learned_footprint_replaces_the_estimate(self):
        gib = 1024 ** 3
        saved = dict(sched.LEARNED_VRAM_GIB)
        sched.LEARNED_VRAM_GIB.clear()
        try:
            self.assertTrue(sched.lacks_room(room(14), "qwen"))          # estimate: 16 + headroom
            self.assertAlmostEqual(sched.note_loaded("qwen", 2 * gib, 12 * gib), 10.0)
            self.assertFalse(sched.lacks_room(room(14), "qwen"))         # learned: 10 + headroom
            # Weights already resident add nothing: no new figure, and a smaller run does not shrink it much.
            self.assertIsNone(sched.note_loaded("qwen", 12 * gib, 12.2 * gib))
            self.assertAlmostEqual(sched.note_loaded("qwen", 0, 4 * gib), 9.0)
        finally:
            sched.LEARNED_VRAM_GIB.clear()
            sched.LEARNED_VRAM_GIB.update(saved)

    def test_should_free_falls_back_to_the_old_rule_without_numbers(self):
        self.assertTrue(sched.should_free("h3:default", "qwen", None))
        self.assertTrue(sched.should_free("h3:default", "qwen", {}))
        self.assertFalse(sched.should_free(None, "qwen", None))


if __name__ == "__main__":
    unittest.main()
