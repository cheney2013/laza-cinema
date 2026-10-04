import unittest
from unittest import mock

import comfyui_client
import machine_profile
import workflow_builders as wb

W4A8 = "minimax_h3_ref2va_pruned_w4a8_mixed.safetensors"
INT8 = "minimax_h3_ref2va_pruned_int8_convrot.safetensors"


class LowVramSubstitutesTest(unittest.IsolatedAsyncioTestCase):
    """On a 16 GB machine the local-repair and bridge builders load the w4a8 build."""

    async def _submit(self, profile_name, call):
        seen = {}
        client = comfyui_client.ComfyUIClient.__new__(comfyui_client.ComfyUIClient)

        async def fake_run(workflow, **kw):
            seen["wf"] = workflow
            return {}
        client._run_video_workflow = fake_run
        with mock.patch.object(machine_profile, "PROFILE", machine_profile.MACHINE_PROFILES[profile_name]):
            await call(client)
        return seen["wf"]

    @staticmethod
    def _unets(wf):
        return [n["inputs"]["unet_name"] for n in wf.values() if n.get("class_type") == "UNETLoader"]

    async def test_bridge(self):
        call = lambda c: c.av_bridge_h3(source_video="a.mp4", prompt="p", head_end=39, tail_start=146)
        low = await self._submit("lowvram", call)
        self.assertEqual(self._unets(low), [W4A8])
        self.assertEqual(low["bridge:video"]["class_type"], "VAEDecodeTiled")
        high = await self._submit("workstation", call)
        self.assertEqual(self._unets(high), [INT8])
        self.assertEqual(high["bridge:video"]["class_type"], "VAEDecode")

    async def test_reshot(self):
        call = lambda c: c.temporal_reshot_h3(source_video="a.mp4", prompt="p", start_frame=40, frame_count=56)
        self.assertEqual(self._unets(await self._submit("lowvram", call)), [W4A8])
        self.assertEqual(self._unets(await self._submit("workstation", call)), [INT8])

    def test_singularity_preset_is_singularitys_own_w4a8_build_on_lowvram(self):
        # Not the official ref2va w4a8: Singularity's own quantised build (2026-10-04).
        with mock.patch.object(machine_profile, "PROFILE", machine_profile.MACHINE_PROFILES["lowvram"]):
            self.assertEqual(machine_profile.substitute_preset("singularity"), "singularity_w4a8")
            self.assertEqual(machine_profile.substitute_unet("other.safetensors"), "other.safetensors")


if __name__ == "__main__":
    unittest.main()
