"""Qwen-Image 2.1 works the references at ref_resolution (0 = their own size), from the request down to the encoder."""
import unittest

import main
import workflow_builders as wb


def encoder_resolution(workflow):
    return next(n["inputs"]["resolution"] for n in workflow.values() if n["class_type"] == "TextEncodeQwenImage21")


class QwenRefResolutionTest(unittest.TestCase):
    def test_default_is_one_megapixel(self):
        self.assertEqual(main.QwenImageRequest(prompt="p").ref_resolution, 1024)
        wf = wb.build_qwen_image_21_workflow(prompt="p", reference_filenames=["a.png"])
        self.assertEqual(encoder_resolution(wf), 1024)

    def test_zero_keeps_the_reference_at_its_own_size(self):
        self.assertEqual(main.QwenImageRequest(prompt="p", ref_resolution=0).ref_resolution, 0)
        wf = wb.build_qwen_image_21_workflow(prompt="p", reference_filenames=["a.png"], ref_resolution=0)
        self.assertEqual(encoder_resolution(wf), 0)

    def test_the_encoder_cap_is_enforced_at_the_request(self):
        with self.assertRaises(Exception):
            main.QwenImageRequest(prompt="p", ref_resolution=5000)


if __name__ == "__main__":
    unittest.main()
