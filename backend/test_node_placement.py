"""Where nodes created over MCP are put: next to what they are wired to, never overlapping."""

import unittest

from mcp_test_support import import_mcp_server

from node_placement import GAP, MARGIN, place_nodes


def node(node_id, x=0, y=0, w=240, h=300):
    return {"id": node_id, "type": "image", "position": {"x": x, "y": y}, "width": w, "height": h}


def edge(src, dst):
    return {"source": src, "target": dst}


def size(n):
    return int(n.get("width") or 240), int(n.get("height") or 300)


def rect(nodes, positions, node_id):
    n = next(x for x in nodes if x["id"] == node_id)
    p = positions.get(node_id) or n["position"]
    w, h = size(n)
    return p["x"], p["y"], w, h


def overlaps(a, b):
    return not (a[0] + a[2] <= b[0] or b[0] + b[2] <= a[0] or a[1] + a[3] <= b[1] or b[1] + b[3] <= a[1])


class PlacementTest(unittest.TestCase):
    def assertNoOverlap(self, nodes, positions):
        ids = [n["id"] for n in nodes]
        for i, a in enumerate(ids):
            for b in ids[i + 1:]:
                self.assertFalse(overlaps(rect(nodes, positions, a), rect(nodes, positions, b)), f"{a} overlaps {b}")

    def test_output_goes_right_of_its_source_aligned_to_its_top(self):
        nodes = [node("src", 100, 200), node("up")]
        pos = place_nodes(nodes, [edge("src", "up")], ["up"], size)
        self.assertEqual(pos["up"], {"x": 100 + 240 + GAP, "y": 200})

    def test_input_goes_left_of_its_target(self):
        nodes = [node("video", 800, 100, 540, 400), node("ref")]
        pos = place_nodes(nodes, [edge("ref", "video")], ["ref"], size)
        self.assertEqual(pos["ref"], {"x": 800 - 240 - GAP, "y": 100})

    def test_inputs_to_one_target_stack_in_a_column(self):
        nodes = [node("video", 800, 100, 540, 400), node("r1"), node("r2"), node("r3")]
        edges = [edge("r1", "video"), edge("r2", "video"), edge("r3", "video")]
        pos = place_nodes(nodes, edges, ["r1", "r2", "r3"], size)
        self.assertEqual({p["x"] for p in pos.values()}, {800 - 240 - GAP})
        self.assertEqual(len({p["y"] for p in pos.values()}), 3)
        self.assertNoOverlap(nodes, pos)

    def test_second_output_of_a_source_goes_under_the_first(self):
        nodes = [node("src", 0, 0), node("a", 300, 0), node("b")]
        pos = place_nodes(nodes, [edge("src", "a"), edge("src", "b")], ["b"], size)
        self.assertEqual(pos["b"]["x"], 300)
        self.assertGreaterEqual(pos["b"]["y"], 300 + MARGIN)

    def test_never_lands_on_an_unrelated_node(self):
        nodes = [node("src", 0, 0), node("blocker", 300, 0, 400, 900), node("up")]
        pos = place_nodes(nodes, [edge("src", "up")], ["up"], size)
        self.assertNoOverlap(nodes, pos)
        self.assertGreaterEqual(pos["up"]["x"], 240 + GAP // 2)   # still to the right of its source

    def test_unwired_nodes_go_in_a_row_below_everything(self):
        nodes = [node("a", 0, 0), node("b", 500, 800), node("n1"), node("n2")]
        pos = place_nodes(nodes, [], ["n1", "n2"], size)
        self.assertGreater(pos["n1"]["y"], 800 + 300)
        self.assertEqual(pos["n1"]["y"], pos["n2"]["y"])
        self.assertGreater(pos["n2"]["x"], pos["n1"]["x"])
        self.assertNoOverlap(nodes, pos)

    def test_chain_added_in_one_batch_runs_left_to_right(self):
        nodes = [node("src", 0, 0), node("hd1"), node("hd2")]
        edges = [edge("src", "hd1"), edge("hd1", "hd2")]
        pos = place_nodes(nodes, edges, ["hd2", "hd1"], size)   # given out of order
        self.assertLess(pos["hd1"]["x"], pos["hd2"]["x"])
        self.assertEqual(pos["hd1"]["y"], 0)
        self.assertNoOverlap(nodes, pos)

    def test_empty_canvas(self):
        nodes = [node("n1"), node("n2")]
        pos = place_nodes(nodes, [], ["n1", "n2"], size)
        self.assertNoOverlap(nodes, pos)

    def test_dense_canvas_stays_free_of_overlaps(self):
        nodes = [node(f"o{i}", (i % 8) * 300, (i // 8) * 340) for i in range(64)]
        new = [node(f"n{i}") for i in range(12)]
        edges = [edge(f"o{i}", f"n{i}") for i in range(12)]
        pos = place_nodes(nodes + new, edges, [n["id"] for n in new], size)
        self.assertNoOverlap(nodes + new, pos)


class FarSiblingTest(unittest.TestCase):
    def test_inputs_wired_in_from_far_away_do_not_pull_the_new_one_there(self):
        nodes = [node("video", 9600, 1400, 450, 390), node("far", 2300, 1400), node("new")]
        edges = [edge("far", "video"), edge("new", "video")]
        pos = place_nodes(nodes, edges, ["new"], size)
        self.assertEqual(pos["new"]["x"], 9600 - 240 - GAP)


class WantsAutoTest(unittest.TestCase):
    def test_placeholder_and_missing_positions_are_placed(self):
        cms = import_mcp_server()
        self.assertTrue(cms._wants_auto_position({"op": "add_node"}))
        self.assertTrue(cms._wants_auto_position({"op": "add_node", "position": "auto"}))
        self.assertTrue(cms._wants_auto_position({"op": "add_node", "position": {"x": 0, "y": 0}}))
        self.assertFalse(cms._wants_auto_position({"op": "add_node", "position": {"x": 0, "y": 0}, "keep_position": True}))
        self.assertFalse(cms._wants_auto_position({"op": "add_node", "position": {"x": 400, "y": 0}}))

    def test_a_batch_places_a_node_beside_its_source(self):
        cms = import_mcp_server()
        canvas = {"nodes": [{"id": "shot", "type": "video", "position": {"x": 100, "y": 100}, "width": 540, "height": 400, "data": {}}],
                  "edges": []}
        ops = [{"op": "add_node", "type": "videoUpscale", "id": "hd", "position": {"x": 0, "y": 0}},
               {"op": "add_edge", "source": "shot", "target": "hd"}]
        results = [cms._apply_operation(canvas, o) for o in ops]
        auto = [r["id"] for o, r in zip(ops, results) if o["op"] == "add_node" and cms._wants_auto_position(o)]
        pos = place_nodes(canvas["nodes"], canvas["edges"], auto, cms._bounds)
        self.assertEqual(pos["hd"]["x"], 100 + 540 + GAP)
        self.assertEqual(pos["hd"]["y"], 100)


if __name__ == "__main__":
    unittest.main()
