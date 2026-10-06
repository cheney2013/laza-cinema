"""The H3 video call chain main.py -> ComfyUIClient.generate_h3_video -> build_h3_video_workflow
passes keywords by name. A keyword added on one layer and not the next does not fail at import:
it fails every render at run time (2026-10-06, motion_context_noise_aug, about two minutes in
production). Check the names statically."""
import ast
import inspect
import textwrap
import unittest
from pathlib import Path

import comfyui_client
import workflow_builders


def _keywords(tree: ast.AST, callee: str) -> list[tuple[int, str]]:
    out = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            name = getattr(node.func, "attr", None) or getattr(node.func, "id", None)
            if name == callee:
                out += [(node.lineno, kw.arg) for kw in node.keywords if kw.arg]
    return out


class H3CallSignatureTest(unittest.TestCase):
    def test_main_passes_only_what_the_client_takes(self):
        tree = ast.parse((Path(__file__).with_name("main.py")).read_text(encoding="utf-8"))
        takes = set(inspect.signature(comfyui_client.ComfyUIClient.generate_h3_video).parameters)
        calls = _keywords(tree, "generate_h3_video")
        self.assertTrue(calls, "no generate_h3_video call found in main.py")
        self.assertEqual([c for c in calls if c[1] not in takes], [])

    def test_client_passes_only_what_the_builder_takes(self):
        src = textwrap.dedent(inspect.getsource(comfyui_client.ComfyUIClient.generate_h3_video))
        takes = set(inspect.signature(workflow_builders.build_h3_video_workflow).parameters)
        calls = _keywords(ast.parse(src), "build_h3_video_workflow")
        self.assertTrue(calls, "generate_h3_video no longer calls build_h3_video_workflow")
        self.assertEqual([c for c in calls if c[1] not in takes], [])


if __name__ == "__main__":
    unittest.main()
