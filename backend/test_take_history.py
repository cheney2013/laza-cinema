"""take_history: which old takes may go, and what removing them leaves behind."""
import json
from pathlib import Path

import take_history as th


def write(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")


def node(node_id, shown, takes, **extra):
    return {"id": node_id, "type": "video", "data": {
        "label": node_id, "generatedUrl": f"/comfy_output/{shown}",
        "takes": [{"id": t, "url": f"/comfy_output/{t}", "prompt": "p"} for t in takes], **extra}}


def workspace(tmp_path, nodes, timeline_clips=(), copy_nodes=None):
    ws = tmp_path / "workspaces"
    write(ws / "default/projects/p1/canvas.json", {"nodes": nodes, "edges": [], "revision": 7})
    if copy_nodes is not None:
        write(ws / "default/projects/p2/canvas.json", {"nodes": copy_nodes, "edges": [], "revision": 3})
    write(ws / "default/projects/p1/sequences/s1.json",
          {"timeline": {"assets": {str(i): {"url": f"/comfy_output/{c}"} for i, c in enumerate(timeline_clips)}}})
    return ws


def test_only_superseded_takes_are_history(tmp_path):
    ws = workspace(tmp_path, [node("n", "H3_Video_c.mp4", ["H3_Video_c.mp4", "H3_Video_b.mp4", "H3_Video_a.mp4"])])
    result = th.plan(ws, "p1")
    assert result["files"] == ["H3_Video_a.mp4", "H3_Video_b.mp4"]
    assert "H3_Latent_a.safetensors" in result["companions"]


def test_a_take_used_anywhere_else_stays(tmp_path):
    ws = workspace(
        tmp_path,
        [node("n", "H3_Video_c.mp4", ["H3_Video_c.mp4", "H3_Video_b.mp4", "H3_Video_a.mp4"]),
         node("later", "H3_Video_x.mp4", [], chainParts=["/comfy_output/H3_Latent_b.safetensors"])],
        timeline_clips=["H3_Video_a.mp4"],
    )
    result = th.plan(ws, "p1")
    assert result["files"] == ["H3_Video_b.mp4"]           # a is on a timeline
    assert "H3_Latent_b.safetensors" not in result["companions"]   # the latent feeds another chain
    assert result["kept_in_use"] == 1


def test_without_a_matching_take_the_first_is_kept(tmp_path):
    ws = workspace(tmp_path, [node("n", "adopted.mp4", ["H3_Video_new.mp4", "H3_Video_old.mp4"])])
    assert th.plan(ws, "p1")["files"] == ["H3_Video_old.mp4"]


def test_a_copy_that_shows_the_take_keeps_it(tmp_path):
    ws = workspace(tmp_path, [node("n", "H3_Video_c.mp4", ["H3_Video_c.mp4", "H3_Video_b.mp4"])],
                   copy_nodes=[node("n", "H3_Video_b.mp4", ["H3_Video_b.mp4"])])
    assert th.plan(ws, "p1")["files"] == []


def test_apply_prunes_every_canvas_then_deletes(tmp_path):
    ws = workspace(tmp_path, [node("n", "H3_Video_c.mp4", ["H3_Video_c.mp4", "H3_Video_b.mp4"])],
                   copy_nodes=[node("n", "H3_Video_c.mp4", ["H3_Video_c.mp4", "H3_Video_b.mp4"])])
    media = tmp_path / "out"
    media.mkdir()
    for name in ("H3_Video_b.mp4", "H3_Latent_b.safetensors", "H3_Video_c.mp4"):
        (media / name).write_bytes(b"x" * 10)

    result = th.apply(ws, "p1", [media], write)

    assert sorted(result["deleted"]) == ["H3_Latent_b.safetensors", "H3_Video_b.mp4"]
    assert result["other_projects"] == ["p2"]
    assert (media / "H3_Video_c.mp4").exists()
    for project, revision in (("p1", 8), ("p2", 4)):
        canvas = json.loads((ws / f"default/projects/{project}/canvas.json").read_text())
        assert [t["id"] for t in canvas["nodes"][0]["data"]["takes"]] == ["H3_Video_c.mp4"]
        assert canvas["revision"] == revision


def test_files_outside_the_roots_are_never_found(tmp_path):
    root = tmp_path / "out"
    root.mkdir()
    (tmp_path / "secret.mp4").write_bytes(b"x")
    assert th.locate("../secret.mp4", [root]) is None


def test_scene_canvases_belong_to_their_project(tmp_path):
    from artifact_pruner import project_of, scene_of
    root = tmp_path / "workspaces" / "default" / "projects" / "p1"
    assert project_of(root / "canvas.json") == "p1" and scene_of(root / "canvas.json") == "main"
    assert project_of(root / "scenes" / "s_2" / "canvas.json") == "p1"
    assert scene_of(root / "scenes" / "s_2" / "canvas.json") == "s_2"
    assert project_of(root / "sequences" / ".trash" / "q.json") == "p1"


def test_the_same_node_id_in_two_scenes_is_two_nodes(tmp_path):
    ws = workspace(tmp_path, [node("n", "H3_Video_c.mp4", ["H3_Video_c.mp4", "H3_Video_b.mp4"])])
    write(ws / "default/projects/p1/scenes/s_2/canvas.json",
          {"nodes": [node("n", "H3_Video_z.mp4", ["H3_Video_z.mp4", "H3_Video_y.mp4"])], "edges": [], "revision": 1})
    media = tmp_path / "out"
    media.mkdir()
    result = th.apply(ws, "p1", [media], write)
    assert sorted((e["scene"], e["files"][0]) for e in result["nodes"]) == [("main", "H3_Video_b.mp4"), ("s_2", "H3_Video_y.mp4")]
    second = json.loads((ws / "default/projects/p1/scenes/s_2/canvas.json").read_text())
    assert [t["id"] for t in second["nodes"][0]["data"]["takes"]] == ["H3_Video_z.mp4"]
    first = json.loads((ws / "default/projects/p1/canvas.json").read_text())
    assert [t["id"] for t in first["nodes"][0]["data"]["takes"]] == ["H3_Video_c.mp4"]


if __name__ == "__main__":
    import tempfile

    for name, test in list(globals().items()):
        if name.startswith("test_") and callable(test):
            with tempfile.TemporaryDirectory() as tmp:
                test(Path(tmp))
            print("ok", name)
