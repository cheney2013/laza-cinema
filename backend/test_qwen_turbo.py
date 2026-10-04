"""Qwen-Image-2.1 turbo: the Viggle distilled LoRA path of build_qwen_image_21_workflow and its request defaults."""
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
        self.assertFalse(by_class(wf, "ViggleTurboLora"))

    def test_text_to_image_turbo_uses_unmerged_lora_and_seven_steps(self):
        wf = wb.build_qwen_image_21_workflow(prompt="p", width=768, height=1376, seed=5, turbo=True)
        self.assertFalse(by_class(wf, "KSampler"))
        self.assertFalse(by_class(wf, "LoraLoaderModelOnly"), "merging drops part of the LoRA's update")
        (lora_id, lora), = by_class(wf, "ViggleTurboLora")
        self.assertEqual(lora["inputs"]["lora_name"], wb.QWEN_TURBO_LORA)
        self.assertEqual(lora["inputs"]["strength"], 1.0)
        self.assertEqual(lora["inputs"]["model"], ["qi:1", 0])
        self.assertEqual(wf["qi:guider"]["inputs"]["model"], [lora_id, 0])
        sampler = wf["qi:6"]
        self.assertEqual(sampler["class_type"], "SamplerCustomAdvanced")
        self.assertEqual(sampler["inputs"]["latent_image"], ["qi:5", 0])
        self.assertEqual(wf["qi:noise"]["inputs"]["noise_seed"], 5)
        sigmas = wf["qi:sigmas"]["inputs"]
        self.assertEqual(sigmas["latent"], ["qi:5", 0])
        self.assertEqual(len(sigmas["nodes"].split(",")), wb.QWEN_TURBO_STEPS)
        self.assertEqual(wb.QWEN_TURBO_STEPS, 7)

    def test_edit_turbo_puts_the_lora_before_the_cache_and_sizes_sigmas_from_the_encoder_latent(self):
        wf = wb.build_qwen_image_21_workflow(prompt="p", reference_filenames=["a.png", "b.png"], turbo=True)
        self.assertEqual(wf["qi:cache"]["inputs"]["model"], ["qi:lora", 0])
        self.assertEqual(wf["qi:guider"]["inputs"]["model"], ["qi:cache", 0])
        self.assertEqual(wf["qi:6"]["inputs"]["latent_image"], ["qi:4", 2])
        self.assertEqual(wf["qi:sigmas"]["inputs"]["latent"], ["qi:4", 2])
        self.assertEqual(wf["qi:4"]["inputs"]["images.image_2"], ["qi:ref2", 0])

    def test_fixed_size_edit_keeps_its_empty_latent(self):
        wf = wb.build_qwen_image_21_workflow(prompt="p", reference_filenames=["a.png"], fixed_size=True,
                                             width=1376, height=768, turbo=True)
        self.assertEqual(wf["qi:6"]["inputs"]["latent_image"], ["qi:5", 0])
        self.assertEqual(wf["qi:sigmas"]["inputs"]["latent"], ["qi:5", 0])

    def test_every_node_the_turbo_graph_wires_exists(self):
        wf = wb.build_qwen_image_21_workflow(prompt="p", reference_filenames=["a.png"], turbo=True)
        for key, node in wf.items():
            for value in node["inputs"].values():
                if isinstance(value, list) and len(value) == 2 and isinstance(value[0], str):
                    self.assertIn(value[0], wf, f"{key} points at a node that is not in the graph")

    def test_turbo_refuses_another_lora_and_another_base(self):
        with self.assertRaises(ValueError):
            wb.build_qwen_image_21_workflow(prompt="p", lora_name="QI2.1_AnyAngle.safetensors", turbo=True)
        with self.assertRaises(ValueError):
            wb.build_qwen_image_21_workflow(prompt="p", base_model="noctAnime", turbo=True)


class QwenTurboRequestTest(unittest.TestCase):
    def test_the_node_defaults_to_turbo(self):
        self.assertEqual(main.QwenImageRequest(prompt="p").speed, "turbo")

    def test_only_two_speeds_exist(self):
        self.assertEqual(main.QwenImageRequest(prompt="p", speed="base").speed, "base")
        with self.assertRaises(Exception):
            main.QwenImageRequest(prompt="p", speed="turbo6")


if __name__ == "__main__":
    unittest.main()
