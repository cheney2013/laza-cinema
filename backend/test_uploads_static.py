"""uploads/ and comfy_output/ (main._RevalidatingStaticFiles): sent in 1 MB chunks, whole and by range, and the
browser must revalidate."""
import os
import tempfile
import unittest
from pathlib import Path

import main
from fastapi.testclient import TestClient
from starlette.applications import Starlette
from starlette.routing import Mount


class UploadsStaticFiles(unittest.TestCase):
    def test_large_file_whole_and_by_range(self):
        tmp = Path(tempfile.mkdtemp())
        data = os.urandom(3 * main._RevalidatingStaticFiles.CHUNK_SIZE + 12345)
        (tmp / "big.bin").write_bytes(data)
        client = TestClient(Starlette(routes=[Mount("/u", main._RevalidatingStaticFiles(directory=str(tmp)))]))
        whole = client.get("/u/big.bin")
        self.assertEqual(whole.status_code, 200)
        self.assertEqual(whole.content, data)
        self.assertEqual(whole.headers["cache-control"], "no-cache")
        for first, last in ((0, 99), (1000, 2_500_000), (len(data) - 5000, len(data) - 1)):
            part = client.get("/u/big.bin", headers={"Range": f"bytes={first}-{last}"})
            self.assertEqual(part.status_code, 206, (first, last))
            self.assertEqual(part.content, data[first:last + 1], (first, last))
        self.assertEqual(client.get("/u/big.bin", headers={"If-None-Match": whole.headers["etag"]}).status_code, 304)


if __name__ == "__main__":
    unittest.main()
