"""/download serves a local file as an attachment (so a phone browser's own download manager takes it) and nothing else."""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import main
from fastapi.testclient import TestClient


class DownloadRoute(unittest.TestCase):
    def test_attachment_ranges_and_only_local_media(self):
        with tempfile.TemporaryDirectory() as tmp:
            clip = Path(tmp) / "cut_x.mp4"
            clip.write_bytes(b"0123456789")

            async def fake_resolve(local):
                if local.endswith("cut_x.mp4"):
                    return clip
                raise FileNotFoundError("missing")

            with mock.patch.object(main, "resolve_upload", fake_resolve):
                client = TestClient(main.app)
                ok = client.get("/download", params={"src": "/uploads/cut_x.mp4", "name": 'a/b:"film".mp4'})
                self.assertEqual(ok.status_code, 200)
                self.assertEqual(ok.content, b"0123456789")
                disposition = ok.headers["content-disposition"]
                self.assertTrue(disposition.startswith("attachment"))
                filename = disposition.split("filename", 1)[1]
                self.assertNotIn("/", filename)
                self.assertNotIn(":", filename)
                self.assertEqual(ok.headers["accept-ranges"], "bytes")

                ranged = client.get("/download", params={"src": "/uploads/cut_x.mp4"}, headers={"Range": "bytes=2-4"})
                self.assertEqual(ranged.status_code, 206)
                self.assertEqual(ranged.content, b"234")

                self.assertEqual(client.get("/download", params={"src": "/etc/passwd"}).status_code, 400)
                self.assertEqual(client.get("/download", params={"src": "/uploads/nope.mp4"}).status_code, 404)


if __name__ == "__main__":
    unittest.main()
