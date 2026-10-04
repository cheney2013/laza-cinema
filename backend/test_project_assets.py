"""project_assets: what a deleted project takes with it."""
import json
from pathlib import Path

import project_assets


def canvas(ws: Path, project: str, urls: list[str]) -> None:
    path = ws / "default" / "projects" / project / "canvas.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    nodes = [{"id": str(i), "data": {"generatedUrl": u}} for i, u in enumerate(urls)]
    path.write_text(json.dumps({"nodes": nodes, "edges": []}), encoding="utf-8")


def test_files_only_this_project_uses_go(tmp_path):
    canvas(tmp_path, "p1", ["/comfy_output/H3_Video_a.mp4", "/uploads/shared.png"])
    canvas(tmp_path, "p2", ["/uploads/shared.png"])
    result = project_assets.plan(tmp_path, "p1", {})
    assert result["files"] == ["H3_Video_a.mp4"]
    assert result["shared"] == ["shared.png"]
    assert "H3_Latent_a.safetensors" in result["companions"]


def test_files_it_made_but_no_longer_mentions_go(tmp_path):
    canvas(tmp_path, "p1", [])
    origins = {"old.png": {"project_id": "p1"}, "theirs.png": {"project_id": "p2"}}
    assert project_assets.plan(tmp_path, "p1", origins)["files"] == ["old.png"]


def test_a_latent_another_project_holds_stays(tmp_path):
    canvas(tmp_path, "p1", ["/comfy_output/H3_Video_a.mp4"])
    canvas(tmp_path, "p2", ["/comfy_output/H3_Latent_a.safetensors"])
    assert "H3_Latent_a.safetensors" not in project_assets.plan(tmp_path, "p1", {})["companions"]


def test_a_file_made_here_but_used_elsewhere_stays(tmp_path):
    canvas(tmp_path, "p1", [])
    canvas(tmp_path, "p2", ["/uploads/gift.png"])
    assert project_assets.plan(tmp_path, "p1", {"gift.png": {"project_id": "p1"}})["files"] == []


if __name__ == "__main__":
    import tempfile

    for name, test in list(globals().items()):
        if name.startswith("test_") and callable(test):
            with tempfile.TemporaryDirectory() as tmp:
                test(Path(tmp))
            print("ok", name)
