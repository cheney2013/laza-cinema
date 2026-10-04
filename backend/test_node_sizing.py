"""Node size floors: every canvas write lifts nodes that are smaller than their controls."""
import json
import unittest
from pathlib import Path

import node_sizing
from mcp_test_support import import_mcp_server

CASES = json.loads((Path(__file__).resolve().parent.parent / "frontend" / "lib" / "nodeFloors.cases.json")
                   .read_text(encoding="utf-8"))


class NodeFloorTests(unittest.TestCase):
    def test_floor_matches_the_studio_cases(self):
        # frontend/lib/nodeSizing.test.ts checks the same file against migrateNodeSizes.
        for case in CASES:
            self.assertEqual(list(node_sizing.node_floor(case["node"])), case["floor"], case["name"])

    def test_small_nodes_are_lifted(self):
        nodes = [json.loads(json.dumps(c["node"])) for c in CASES]
        lifted, changed = node_sizing.enforce_node_floors(nodes)
        self.assertEqual(changed, len(CASES))
        for node, case in zip(lifted, CASES):
            self.assertGreaterEqual(node["width"], case["floor"][0], case["name"])
            self.assertGreaterEqual(node["height"], case["floor"][1], case["name"])

    def test_larger_nodes_are_left_alone(self):
        node = {"id": "v", "type": "video", "width": 1071, "height": 900, "data": {"generatedUrl": "/x.mp4"}}
        _, changed = node_sizing.enforce_node_floors([node])
        self.assertEqual(changed, 0)
        self.assertEqual((node["width"], node["height"]), (1071, 900))

    def test_groups_and_untyped_nodes_are_skipped(self):
        nodes = [{"id": "g", "type": "group", "width": 10, "height": 10}, {"id": "x", "width": 5, "height": 5}]
        _, changed = node_sizing.enforce_node_floors(nodes)
        self.assertEqual(changed, 0)

    def test_style_size_is_kept_in_step(self):
        node = {"id": "q", "type": "qwenImage", "width": 100, "height": 50,
                "style": {"width": 100, "height": 50}, "data": {}}
        node_sizing.enforce_node_floors([node])
        self.assertEqual(node["style"]["width"], node["width"])
        self.assertEqual(node["style"]["height"], node["height"])

    def test_mcp_default_dims_are_the_shared_table(self):
        canvas_mcp_server = import_mcp_server()
        self.assertIs(canvas_mcp_server._DEFAULT_DIMS, node_sizing.DEFAULT_DIMS)


if __name__ == "__main__":
    unittest.main()
