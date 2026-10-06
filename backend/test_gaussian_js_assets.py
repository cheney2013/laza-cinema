"""/gaussian/js/ serves what the viewer pages load from it and nothing else from the backend directory."""
import re
import unittest
from pathlib import Path

import main
from fastapi.testclient import TestClient

BACKEND = Path(main.__file__).parent


class GaussianJsAssets(unittest.TestCase):
    def test_serves_every_file_the_viewer_pages_load(self):
        client = TestClient(main.app)
        loaded = set()
        for page in ("gaussian_viewer.html", "pose_viewer.html"):
            loaded |= set(re.findall(r"/gaussian/js/([\w.-]+)", (BACKEND / page).read_text(encoding="utf-8")))
        self.assertTrue(loaded)
        for name in sorted(loaded):
            response = client.get(f"/gaussian/js/{name}", headers={"Origin": "http://127.0.0.1:4000"})
            self.assertEqual(response.status_code, 200, name)
            self.assertEqual(response.content, (BACKEND / name).read_bytes(), name)
            self.assertEqual(response.headers["access-control-allow-origin"], "*", name)
            self.assertEqual(client.head(f"/gaussian/js/{name}").status_code, 200, name)

    def test_nothing_else_from_the_backend_directory(self):
        client = TestClient(main.app)
        for path in ("main.py", "accounts.py", "gaussian_viewer.html", "workspaces/accounts.json",
                     "..%2Fbackend%2Fmain.py", "MAIN.PY", "fly_controls.js.", ""):
            self.assertEqual(client.get(f"/gaussian/js/{path}").status_code, 404, path)
            self.assertEqual(client.head(f"/gaussian/js/{path}").status_code, 404, path)


if __name__ == "__main__":
    unittest.main()
