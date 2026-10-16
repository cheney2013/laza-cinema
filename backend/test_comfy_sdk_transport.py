import base64
import json
import types
import unittest

import comfy_sdk_transport as t
from comfyui_client import ComfyUIClient, ComfyUIError


def _id(f, s="", ty="output"):
    raw = json.dumps({"j": "job", "f": f, "s": s, "t": ty}).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=") + ".sig"


def _out(node, kind, name, s="", ty="output"):
    model = types.SimpleNamespace(
        node_id=node, name=name, id=_id(name, s, ty),
        type=types.SimpleNamespace(value=kind))
    return types.SimpleNamespace(_model=model)


class HistoryOutputs(unittest.TestCase):
    def test_kinds_map_to_history_keys_and_asset_id_gives_subfolder_and_type(self):
        outs = [_out("2", "image", "a.png", "sub"), _out("3", "video", "c.mp4", "", "output"),
                _out("4", "audio", "s.flac"), _out("5", "image", "t.png", "", "temp"),
                _out("6", "unknown", "z.bin")]
        got = t.history_outputs(outs)
        self.assertEqual(got["2"]["images"], [{"filename": "a.png", "subfolder": "sub", "type": "output"}])
        self.assertEqual(got["3"]["gifs"][0]["filename"], "c.mp4")
        self.assertEqual(got["4"]["audio"][0]["filename"], "s.flac")
        self.assertEqual(got["5"]["images"][0]["type"], "temp")
        self.assertNotIn("6", got)

    def test_unreadable_id_keeps_name(self):
        m = types.SimpleNamespace(node_id="1", name="a.png", id="???", type="image")
        self.assertEqual(t.history_outputs([m])["1"]["images"][0],
                         {"filename": "a.png", "subfolder": "", "type": "output"})

    def test_picker_prefers_durable_and_raises_without_images(self):
        outs = t.history_outputs([_out("5", "image", "t.png", "", "temp"), _out("2", "image", "a.png")])
        self.assertEqual([i["filename"] for i in ComfyUIClient._pick_images(outs, {})], ["a.png"])
        with self.assertRaises(ComfyUIError):
            ComfyUIClient._pick_images({}, {})


if __name__ == "__main__":
    unittest.main()
