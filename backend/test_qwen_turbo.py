"""Qwen-Image-2.1 turbo: the official Qwen-Image-2.1-Turbo checkpoint path of build_qwen_image_21_workflow and its request defaults."""
import unittest

import main
import workflow_builders as wb


def by_class(workflow, name):
    return [(k, n) for k, n in workflow.items() if n["class_type"] == name]


class QwenTurboGraphTest(unittest.TestCase):
    def test_default_graph_is_unchanged(self):
        wf = wb.build_qwen_image_21_workflow(prompt="p", reference_filenames=["a.png"])
        self.assertEqual(wf["qi:6"]["class_type"], "KSampler")
        self.assertEqual(wf["qi:6"]["inputs"]["steps"], 25)
        self.assertEqual(wf["qi:1"]["inputs"]["unet_name"], wb.QWEN_IMAGE_21_UNET)
        self.assertFalse(by_class(wf, "ManualSigmas"))

    def test_text_to_image_turbo_loads_the_turbo_checkpoint_with_eight_steps_and_no_lora(self):
        wf = wb.build_qwen_image_21_workflow(prompt="p", width=768, height=1344, seed=5, turbo=True)
        self.assertFalse(by_class(wf, "KSampler"))
        self.assertFalse(by_class(wf, "LoraLoaderModelOnly"))
        self.assertFalse(by_class(wf, "ViggleTurboLora"), "the Viggle LoRA path was replaced by the official checkpoint")
        self.assertEqual(wf["qi:1"]["inputs"]["unet_name"], wb.QWEN_IMAGE_21_TURBO_UNET)
        self.assertEqual(wf["qi:guider"]["inputs"]["model"], ["qi:1", 0])
        sampler = wf["qi:6"]
        self.assertEqual(sampler["class_type"], "SamplerCustomAdvanced")
        self.assertEqual(sampler["inputs"]["latent_image"], ["qi:5", 0])
        self.assertEqual(wf["qi:noise"]["inputs"]["noise_seed"], 5)
        self.assertEqual(wf["qi:sampler"]["inputs"]["sampler_name"], "euler")
        self.assertEqual(wb.QWEN_TURBO_STEPS, 8)

    def test_turbo_sigmas_are_the_saved_schedule_with_the_terminal_zero(self):
        wf = wb.build_qwen_image_21_workflow(prompt="p", turbo=True)
        values = [float(v) for v in wf["qi:sigmas"]["inputs"]["sigmas"].split(",")]
        self.assertEqual(len(values), wb.QWEN_TURBO_STEPS + 1, "N steps need N+1 sigmas")
        self.assertEqual(values[0], 1.0)
        self.assertEqual(values[-1], 0.0, "without the terminal 0 the last step stops half denoised")
        self.assertEqual(values[-2], 0.414568)
        self.assertEqual(values, sorted(values, reverse=True))
        self.assertNotIn("latent", wf["qi:sigmas"]["inputs"], "no resolution shift: the card's scheduler has shift 1.0")

    def test_edit_turbo_puts_the_cache_between_the_checkpoint_and_the_guider(self):
        wf = wb.build_qwen_image_21_workflow(prompt="p", reference_filenames=["a.png", "b.png"], turbo=True)
        self.assertEqual(wf["qi:cache"]["inputs"]["model"], ["qi:1", 0])
        self.assertEqual(wf["qi:guider"]["inputs"]["model"], ["qi:cache", 0])
        self.assertEqual(wf["qi:6"]["inputs"]["latent_image"], ["qi:4", 2])
        self.assertEqual(wf["qi:4"]["inputs"]["images.image_2"], ["qi:ref2", 0])

    def test_fixed_size_edit_keeps_its_empty_latent(self):
        wf = wb.build_qwen_image_21_workflow(prompt="p", reference_filenames=["a.png"], fixed_size=True,
                                             width=1344, height=768, turbo=True)
        self.assertEqual(wf["qi:6"]["inputs"]["latent_image"], ["qi:5", 0])

    def test_every_node_the_turbo_graph_wires_exists(self):
        wf = wb.build_qwen_image_21_workflow(prompt="p", reference_filenames=["a.png"], turbo=True)
        for key, node in wf.items():
            for value in node["inputs"].values():
                if isinstance(value, list) and len(value) == 2 and isinstance(value[0], str):
                    self.assertIn(value[0], wf, f"{key} points at a node that is not in the graph")

    def test_stackable_loras_chain_after_the_mode_lora_in_order(self):
        wf = wb.build_qwen_image_21_workflow(
            prompt="p", reference_filenames=["a.png"], lora_name="mode.safetensors", lora_strength=0.8,
            extra_loras=[{"name": "one.safetensors", "strength": 0.5}, {"name": "two.safetensors"}])
        self.assertEqual(wf["qi:lora"]["inputs"]["model"], ["qi:1", 0])
        self.assertEqual(wf["qi:lora"]["inputs"]["strength_model"], 0.8)
        self.assertEqual(wf["qi:lora2"]["inputs"]["model"], ["qi:lora", 0])
        self.assertEqual(wf["qi:lora2"]["inputs"]["strength_model"], 0.5)
        self.assertEqual(wf["qi:lora3"]["inputs"]["model"], ["qi:lora2", 0])
        self.assertEqual(wf["qi:lora3"]["inputs"]["strength_model"], 1.0, "strength defaults to 1")
        self.assertEqual(wf["qi:cache"]["inputs"]["model"], ["qi:lora3", 0], "references: the cache sits after the last LoRA")

    def test_a_stackable_lora_alone_loads_first_and_feeds_the_sampler(self):
        wf = wb.build_qwen_image_21_workflow(prompt="p", extra_loras=[{"name": "one.safetensors", "strength": 0.7}])
        self.assertEqual(wf["qi:lora"]["inputs"]["lora_name"], "one.safetensors")
        self.assertEqual(wf["qi:6"]["class_type"], "KSampler")
        self.assertEqual(wf["qi:6"]["inputs"]["model"], ["qi:lora", 0])

    def test_blank_stack_entries_are_ignored(self):
        wf = wb.build_qwen_image_21_workflow(prompt="p", extra_loras=[{"name": ""}, None])
        self.assertFalse(by_class(wf, "LoraLoaderModelOnly"))

    def test_turbo_refuses_another_lora_and_another_base(self):
        with self.assertRaises(ValueError):
            wb.build_qwen_image_21_workflow(prompt="p", extra_loras=[{"name": "one.safetensors"}], turbo=True)
        with self.assertRaises(ValueError):
            wb.build_qwen_image_21_workflow(prompt="p", lora_name="QI2.1_AnyAngle.safetensors", turbo=True)
        with self.assertRaises(ValueError):
            wb.build_qwen_image_21_workflow(prompt="p", base_model="noctAnime", turbo=True)


class QwenTurboRequestTest(unittest.TestCase):
    def test_the_node_defaults_to_turbo(self):
        self.assertEqual(main.QwenImageRequest(prompt="p").speed, "turbo")

    def test_extra_loras_come_through_the_request(self):
        req = main.QwenImageRequest(prompt="p", extra_loras=[{"name": "one.safetensors", "strength": 0.6}])
        self.assertEqual([x.model_dump() for x in req.extra_loras], [{"name": "one.safetensors", "strength": 0.6}])
        self.assertEqual(main.QwenImageRequest(prompt="p").extra_loras, [])

    def test_only_two_speeds_exist(self):
        self.assertEqual(main.QwenImageRequest(prompt="p", speed="base").speed, "base")
        with self.assertRaises(Exception):
            main.QwenImageRequest(prompt="p", speed="turbo6")


if __name__ == "__main__":
    unittest.main()
