"""A 16 GB profile refuses what cannot run there, before ComfyUI is asked."""
import importlib
import os
import unittest


def _load(name: str):
    os.environ["H3_MACHINE_PROFILE"] = name
    import machine_profile
    return importlib.reload(machine_profile)


class DisabledOnLowVram(unittest.TestCase):
    def tearDown(self):
        os.environ.pop("H3_MACHINE_PROFILE", None)
        importlib.reload(importlib.import_module("machine_profile"))

    def test_lowvram_refuses_int8_presets(self):
        mp = _load("lowvram")
        for name in ("fused", "hybrid", "ref2va_full", "hyperflow"):
            with self.assertRaises(ValueError, msg=name):
                mp.require_preset(name)
        mp.require_preset("pruned_w4a8")
        # singularity and ref2va are substituted before the check, so they stay usable
        for name in ("singularity", "ref2va", "crossview"):
            mp.require_preset(mp.substitute_preset(name))
        self.assertEqual(mp.substitute_preset("ref2va"), "pruned_w4a8")
        # "singularity" runs Singularity's own w4a8 build, not the official ref2va one
        self.assertEqual(mp.substitute_preset("singularity"), "singularity_w4a8")
        self.assertEqual(mp.substitute_unet("Minimax-h3_Singularity_ref2va_Pruned_v1.3_int8.safetensors"),
                         "Minimax-h3_Singularity_ref2va_v1.3_Pruned_w4a8.safetensors")
        # crossview keeps its LoRA but its 21 GB checkpoint is swapped for the w4a8 build
        self.assertEqual(
            mp.substitute_unet("minimax_h3_ref2va_pruned_int8_convrot.safetensors"),
            "minimax_h3_ref2va_pruned_w4a8_mixed.safetensors")

    def test_lowvram_refuses_heavy_nodes(self):
        mp = _load("lowvram")
        with self.assertRaises(ValueError):
            mp.require_node("charswap")
        for node in ("video", "videoReangle"):
            mp.require_node(node)

    def test_lowvram_refuses_latent_enhance(self):
        mp = _load("lowvram")
        with self.assertRaises(ValueError):
            mp.require_upscale_method("h3_latent")
        for method in ("esrgan", "lms"):
            mp.require_upscale_method(method)
        self.assertEqual(mp.PROFILE["upscale_method"], "esrgan")

    def test_workstation_refuses_nothing(self):
        mp = _load("workstation")
        for name in ("fused", "hyperflow", "crossview"):
            mp.require_preset(name)
        mp.require_node("charswap")
        mp.require_upscale_method("h3_latent")
        self.assertEqual(mp.PROFILE["upscale_method"], "h3_latent")

    def test_text_encoder_is_nvfp4_unless_overridden(self):
        mp = _load("workstation")
        self.assertEqual(mp.text_encoder(), mp.TEXT_ENCODERS["nvfp4"])
        os.environ["H3_TEXT_ENCODER"] = "int4"
        self.assertEqual(mp.text_encoder(), mp.TEXT_ENCODERS["int4"])
        os.environ["H3_TEXT_ENCODER"] = "my_encoder.safetensors"
        self.assertEqual(mp.text_encoder(), "my_encoder.safetensors")
        os.environ.pop("H3_TEXT_ENCODER")

    def test_builders_use_the_configured_encoder(self):
        mp = _load("workstation")
        import workflow_builders as wb

        def names():
            graph = wb.build_h3_video_workflow(prompt="x")
            return {n["inputs"]["clip_name"] for n in graph.values()
                    if isinstance(n, dict) and "clip_name" in n.get("inputs", {})}

        self.assertEqual(names(), {mp.TEXT_ENCODERS["nvfp4"]})
        os.environ["H3_TEXT_ENCODER"] = "int4"
        self.assertEqual(names(), {mp.TEXT_ENCODERS["int4"]})
        os.environ.pop("H3_TEXT_ENCODER")

    def test_default_attention_patch_per_profile(self):
        # Sol smeared faces at 864x480 on the 16 GB build; the workstation keeps its measured default.
        self.assertEqual(_load("lowvram").PROFILE["h3_accel"], "kjsage")
        self.assertEqual(_load("workstation").PROFILE["h3_accel"], "sol")

    def test_sol_is_never_used_on_a_w4a8_checkpoint(self):
        _load("workstation")
        import workflow_builders as wb
        for unet in ("minimax_h3_ref2va_pruned_w4a8_mixed.safetensors", "Minimax-h3_Singularity_ref2va_v1.3_Pruned_w4a8.safetensors"):
            self.assertEqual(wb.accel_for_unet(unet, "sol"), "kjsage")
            self.assertEqual(wb.accel_for_unet(unet, "solpv"), "kjsage")
            self.assertEqual(wb.accel_for_unet(unet, "sol,solchunk"), "kjsage,solchunk")
            self.assertEqual(wb.accel_for_unet(unet, ""), "")          # no patch stays no patch
            self.assertEqual(wb.accel_for_unet(unet, "kjsage"), "kjsage")
            graph = wb.build_h3_video_workflow(prompt="x", unet_name=unet, sage="sol")
            attention = {n["class_type"] for n in graph.values() if isinstance(n, dict) and "AttentionPatch" in n.get("class_type", "")}
            self.assertEqual(attention, {"MiniMaxH3MemoryEfficientSageAttentionPatch"})
        # int8 checkpoints keep whatever was asked for
        self.assertEqual(wb.accel_for_unet("Minimax-h3_Singularity_ref2va_Pruned_v1.3_int8.safetensors", "sol"), "sol")
        self.assertEqual(wb.accel_for_unet("", "sol"), "sol")

    def test_backend_decides_which_attention_a_preset_may_use(self):
        import main
        # workstation checkpoints are int8: Sol allowed
        policy = main.h3_attention_policy("singularity")
        self.assertIn("sol", policy["allowed"])
        self.assertEqual(policy["blocked"], {})
        # an explicit w4a8 checkpoint blocks Sol whatever the preset says
        policy = main.h3_attention_policy("singularity", "minimax_h3_ref2va_pruned_w4a8_mixed.safetensors")
        self.assertNotIn("sol", policy["allowed"])
        self.assertIn("sol", policy["blocked"])
        self.assertEqual(policy["default"], "kjsage")
        # on the 16 GB profile the preset itself resolves to w4a8
        from unittest import mock
        import machine_profile
        with mock.patch.object(machine_profile, "PROFILE", machine_profile.MACHINE_PROFILES["lowvram"]):
            for preset in ("singularity", "ref2va", "crossview", "pruned_w4a8"):
                policy = main.h3_attention_policy(preset)
                self.assertNotIn("sol", policy["allowed"], preset)
                self.assertEqual(policy["allowed"], ["kjsage", "none"], preset)

    def test_depth_control_uses_the_core_nodes_and_defaults_to_2_0(self):
        _load("workstation")
        import workflow_builders as wb
        for kwargs, net in (({}, "minimax_h3_fun_controlnet_union_2.0_pruned_bf16.safetensors"),
                            ({"control_net_name": "minimax_h3_fun_controlnet_union_pruned_bf16.safetensors"},
                             "minimax_h3_fun_controlnet_union_pruned_bf16.safetensors")):
            graph = wb.build_h3_video_workflow(prompt="x", control_video_filename="c.mp4", control_strength=0.8, **kwargs)
            classes = {n["class_type"] for n in graph.values() if isinstance(n, dict)}
            self.assertIn("ModelPatchLoader", classes)
            self.assertIn("MiniMaxH3FunControlNetApply", classes)
            self.assertNotIn("H3FunControlLoader", classes)          # the custom 1.x loader is gone
            self.assertNotIn("H3FunControlApply", classes)
            self.assertEqual(graph["91"]["inputs"]["name"], net)
            self.assertEqual(graph["92"]["inputs"]["strength"], 0.8)
            self.assertEqual(graph["92"]["inputs"]["control_video"], ["90", 0])

    def test_profile_is_public(self):
        mp = _load("lowvram")
        public = mp.public_profile()
        self.assertIn("charswap", public["disabled_node_types"])
        self.assertIn("hyperflow", public["disabled_presets"])


if __name__ == "__main__":
    unittest.main()
