"""Copy this repo's ComfyUI custom nodes (comfyui_nodes/*) into ComfyUI.

    python tools/install_comfy_nodes.py            # install / update
    python tools/install_comfy_nodes.py --check    # say which are out of date

ComfyUI loads custom nodes only at start, so restart ComfyUI after an install.
The destination is COMFYUI_CUSTOM_NODES, else <COMFYUI_INPUT_DIR>/../custom_nodes.
"""
import argparse
import filecmp
import os
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "comfyui_nodes"


def dest_dir() -> Path:
    env = os.environ.get("COMFYUI_CUSTOM_NODES")
    if env:
        return Path(env)
    inp = os.environ.get("COMFYUI_INPUT_DIR", r"D:\ComfyUI-sage3\ComfyUI\input")
    return Path(inp).parent / "custom_nodes"


def differs(a: Path, b: Path) -> bool:
    if not b.is_dir():
        return True
    for f in a.rglob("*.py"):
        g = b / f.relative_to(a)
        if not g.is_file() or not filecmp.cmp(f, g, shallow=False):
            return True
    return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()
    dst = dest_dir()
    if not dst.is_dir():
        print(f"ComfyUI custom_nodes not found: {dst}")
        return 2
    stale = []
    for pkg in sorted(p for p in SRC.iterdir() if p.is_dir() and not p.name.startswith((".", "__"))):
        target = dst / pkg.name
        if differs(pkg, target):
            stale.append(pkg.name)
            if not args.check:
                shutil.copytree(pkg, target, dirs_exist_ok=True,
                                ignore=shutil.ignore_patterns("__pycache__"))
                print(f"installed {pkg.name} -> {target}")
        else:
            print(f"up to date {pkg.name}")
    if stale and args.check:
        print("out of date: " + ", ".join(stale))
        return 1
    if stale:
        print("Restart ComfyUI to load the changes.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
