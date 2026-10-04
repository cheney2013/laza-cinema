"""The version comes from the repository's VERSION file and reaches the API."""
import re
import unittest
from pathlib import Path

import version_info


class VersionInfoTest(unittest.TestCase):
    def test_version_is_the_first_line_of_the_version_file(self):
        first = (Path(__file__).resolve().parent.parent / "VERSION").read_text(encoding="utf-8").splitlines()[0].strip()
        self.assertEqual(version_info.version(), first)
        self.assertRegex(first, r"^\d+\.\d+\.\d+$")

    def test_info_names_the_product(self):
        info = version_info.info()
        self.assertEqual(info["name"], "LAZA CINEMA STUDIO")
        self.assertEqual(set(info), {"name", "version", "commit"})
        self.assertTrue(info["commit"] == "" or re.fullmatch(r"[0-9a-f]{7,}", info["commit"]))

    def test_the_api_serves_it(self):
        import asyncio
        import main
        self.assertEqual(asyncio.run(main.get_version()), version_info.info())
        self.assertEqual(main.app.version, version_info.version())
        self.assertEqual(main.app.title, "LAZA CINEMA STUDIO")


if __name__ == "__main__":
    unittest.main()
