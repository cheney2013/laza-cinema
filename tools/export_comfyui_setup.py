"""Record how this machine's ComfyUI is put together, so another machine can copy it.

ComfyUI itself is not part of this repository, and the node packs it runs are a mix of public git
checkouts, local edits on top of them, and plain copies that have no git history. This writes:

  tools/comfyui_setup/setup.json  ComfyUI commit + version, and for every custom node pack: its
                                  git remote and commit, or "copy" when it is not a checkout
  tools/comfyui_setup/patches/<pack>.patch   the uncommitted edits of every modified checkout
  tools/comfyui_setup/requirements.txt   pip freeze of ComfyUI's own .venv, when it has one
  --zip PATH                      optionally, a zip of the packs that are not git checkouts, and of
                                  the git packs whose repository has since disappeared (the only way
                                  to get those)

Run it on the machine that works:
  python tools/export_comfyui_setup.py --comfyui D:\\ComfyUI-sage3\\ComfyUI [--zip bundle.zip]

Only the pack folders are read; model files are never touched.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKIP_DIRS = {"__pycache__", ".git", "node_modules", ".venv", "ckpts"}
# Weights are downloaded separately (docs/DEPLOY.md); they must not end up in the bundle.
WEIGHT_SUFFIXES = {".safetensors", ".pth", ".pt", ".onnx", ".bin", ".ckpt", ".gguf", ".engine"}
# Packs written for this project; they live in the repository under comfyui_nodes/ as well.
OWN_PACKS = {"aicinema-live-preview", "aicinema_audio_lock"}
# What the studio needs: every pack that defines a node class the backend names (workflow_builders.py,
# comfyui_client.py, main.py; checked against ComfyUI's /object_info on 2026-10-04), the RIFE pack for
# frame interpolation ("RIFE VFI" has a space in its name and escapes a pattern search) and the live preview.
# Everything else in custom_nodes/ is something else installed beside it (layer styling, workflow
# encryption, panorama and gaussian packs the studio never calls) and is not installed by default.
REQUIRED_PACKS = {
    "ComfyUI-H3-Motion-Context-MultiRef", "comfyui-h3-motion-context", "comfyui-kjnodes", "ComfyUI-Sharp",
    "Comfyui-MMH3-UltimateUpscale", "ComfyUI-FL-MiniMaxH3", "ComfyUI-SCAIL-Pose", "comfyui-videohelpersuite",
    "ComfyUI-Viggle-Animate-H3", "ComfyUI-NLF-Minimal", "ComfyUI-HyperFlow-H3", "ComfyUI-sol-attn",
    "ComfyUI-CrossViewWarp", "comfyui_controlnet_aux", "ComfyUI-H3-AudioRefine", "ComfyUI-WanAnimatePreprocess",
    "ComfyUI-Frame-Interpolation", "aicinema-live-preview", "aicinema_audio_lock",
}
# Left out of the vendored copy: pictures and videos that only illustrate a pack's README or examples.
MEDIA_SUFFIXES = (".gif", ".mp4", ".webm", ".mov", ".avi")
DOC_DIRS = {"examples", "example", "docs", "doc", "readme_images", "screenshots"}


def git(repo: Path, *args: str) -> str:
    done = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, encoding="utf-8")
    return done.stdout.strip() if done.returncode == 0 else ""


def describe_pack(pack: Path) -> dict:
    entry: dict = {"name": pack.name, "required": pack.name in REQUIRED_PACKS, "size_mb": round(sum(f.stat().st_size for f in pack_files(pack)) / 2**20, 1)}
    if not (pack / ".git").exists():
        entry["source"] = "copy"
        return entry
    remote = git(pack, "remote", "get-url", "origin")
    # A pack whose repository has since been deleted or renamed can only come from this machine.
    reachable = bool(remote) and subprocess.run(["git", "ls-remote", "--exit-code", remote, "HEAD"],
                                                capture_output=True, timeout=60).returncode == 0
    entry.update(
        source="git",
        remote_reachable=reachable,
        remote=remote,
        commit=git(pack, "rev-parse", "HEAD"),
        modified_files=[line[3:] for line in git(pack, "status", "--porcelain").splitlines()
                        if "__pycache__" not in line],
    )
    return entry


def vendor_files(pack: Path):
    """The files of a pack worth keeping in the repository: its code and runtime data, not its illustrations."""
    for path in pack_files(pack):
        rel = path.relative_to(pack)
        if path.suffix.lower() in MEDIA_SUFFIXES:
            continue
        if any(part.lower() in DOC_DIRS for part in rel.parts[:-1]) and path.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp"):
            continue
        yield path


def pack_files(pack: Path):
    for path in pack.rglob("*"):
        if (path.is_file() and not (SKIP_DIRS & set(path.relative_to(pack).parts))
                and path.suffix.lower() not in WEIGHT_SUFFIXES):
            yield path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--comfyui", required=True, help="the ComfyUI folder that contains custom_nodes/")
    parser.add_argument("--zip", help="write the non-git packs and this project's own packs into this zip")
    parser.add_argument("--vendor", help="copy the required packs that cannot be cloned into this folder (the repository's "
                                         "comfyui_nodes/third_party), replacing what is there")
    args = parser.parse_args()

    comfy = Path(args.comfyui)
    nodes_dir = comfy / "custom_nodes"
    if not nodes_dir.is_dir():
        print(f"no custom_nodes folder under {comfy}", file=sys.stderr)
        return 1

    packs = [describe_pack(p) for p in sorted(nodes_dir.iterdir())
             if p.is_dir() and p.name not in SKIP_DIRS]
    setup = {
        "comfyui": {
            "remote": git(comfy, "remote", "get-url", "origin"),
            "commit": git(comfy, "rev-parse", "HEAD"),
            "local_commits_over_origin_master": git(comfy, "log", "origin/master..HEAD", "--oneline").splitlines(),
            "uncommitted_files": git(comfy, "status", "--porcelain").splitlines(),
        },
        "custom_nodes": packs,
    }
    version_file = comfy / "comfyui_version.py"
    if version_file.is_file():
        setup["comfyui"]["version"] = version_file.read_text(encoding="utf-8").split('"')[-2]

    out = ROOT / "tools" / "comfyui_setup"
    (out / "patches").mkdir(parents=True, exist_ok=True)
    (out / "setup.json").write_text(json.dumps(setup, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    written = 0
    for pack in packs:
        if pack["source"] != "git" or not pack["modified_files"]:
            continue
        diff = git(nodes_dir / pack["name"], "diff", "HEAD")
        if diff:
            (out / "patches" / f"{pack['name']}.patch").write_text(diff + "\n", encoding="utf-8")
            written += 1

    # The Python packages the node packs import (torch build, triton, sageattention, ...).
    venv_python = comfy / ".venv" / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
    if venv_python.is_file():
        frozen = subprocess.run([str(venv_python), "-m", "pip", "freeze"], capture_output=True, text=True)
        if frozen.returncode == 0:
            # A wheel installed from a local file cannot be fetched on another machine, and its
            # path names the author's folders: keep the package name as a comment instead.
            lines = [f"# local wheel, install your own build: {line.split(' @ ')[0]}" if " @ file:///" in line else line
                     for line in frozen.stdout.splitlines()]
            (out / "requirements.txt").write_text(os.linesep.join(lines) + os.linesep, encoding="utf-8")

    # Packs with no git history, plus git packs whose repository is gone: the zip is their only source.
    copies = [p["name"] for p in packs
              if p["source"] == "copy" or (p["source"] == "git" and not p.get("remote_reachable", True))]
    gone = [p["name"] for p in packs if p["source"] == "git" and not p.get("remote_reachable", True)]
    if gone:
        print(f"repository no longer reachable, bundled instead: {', '.join(gone)}")
    print(f"{len(packs)} packs: {sum(p['source'] == 'git' for p in packs)} git, {len(copies)} copies; "
          f"{written} patch file(s) written to tools/comfyui_setup/patches/")

    if args.vendor:
        dest = Path(args.vendor)
        take = [n for n in copies if n in REQUIRED_PACKS and n not in OWN_PACKS]
        if dest.exists():
            import shutil
            shutil.rmtree(dest)
        total = 0
        for name in take:
            for path in vendor_files(nodes_dir / name):
                target = dest / name / path.relative_to(nodes_dir / name)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(path.read_bytes())
                total += path.stat().st_size
        print(f"vendored {len(take)} pack(s), {total / 2**20:.1f} MB, into {dest}: {', '.join(take)}")

    if args.zip:
        with zipfile.ZipFile(args.zip, "w", zipfile.ZIP_DEFLATED) as bundle:
            for name in copies:
                for path in pack_files(nodes_dir / name):
                    bundle.write(path, Path("custom_nodes") / path.relative_to(nodes_dir))
        print(f"zip of {len(copies)} non-git pack(s): {args.zip}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
