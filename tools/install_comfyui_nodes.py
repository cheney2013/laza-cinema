"""Install the ComfyUI custom node packs LAZA CINEMA STUDIO needs, from tools/comfyui_setup/setup.json.

  python tools/install_comfyui_nodes.py --comfyui C:\\ComfyUI [--bundle nodes_bundle.zip]

What it does, in order (each step is skipped when its result is already there, so a rerun is safe):
  1. copies this repository's own packs (comfyui_nodes/) into custom_nodes/
  2. clones every git pack at the commit setup.json records, and applies its patch from
     tools/comfyui_setup/patches/ when it has one
  3. copies the packs that have no git history (or whose repository is gone) from the repository's own
     comfyui_nodes/third_party, or from --bundle (a folder like it, or a zip made by
     tools/export_comfyui_setup.py --zip)

Only the packs the studio needs (setup.json "required") are installed; --all installs every pack the
working machine had, which includes layer-styling, panorama and other packs the studio never calls.
  4. installs each pack's own requirements.txt into ComfyUI's venv, holding torch, numpy and
     comfy-kitchen at the versions in tools/comfyui_setup/requirements.txt so a pack cannot
     replace the build ComfyUI runs on (--no-pip skips this)

Restart ComfyUI afterwards, then run tools/check_install.py. --dry-run only prints the plan.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SETUP = ROOT / "tools" / "comfyui_setup"
OWN_PACKS = ROOT / "comfyui_nodes"
# Packages a node pack's requirements must never move: the build ComfyUI itself runs on.
HELD = ("torch", "torchvision", "torchaudio", "numpy", "comfy-kitchen", "triton-windows", "triton")


def run(cmd: list[str], cwd: Path | None = None, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8", check=check)


def git_ok(pack: Path, *args: str) -> bool:
    return run(["git", *args], cwd=pack, check=False).returncode == 0


def apply_patch(pack: Path, patch: Path, dry: bool) -> str:
    """Apply a patch inside a pack; 'applied', 'already' (a reverse check passes) or 'FAILED'."""
    if git_ok(pack, "apply", "--reverse", "--check", str(patch)):
        return "already applied"
    if not git_ok(pack, "apply", "--check", str(patch)):
        return "FAILED (does not apply to this version)"
    if not dry:
        run(["git", "apply", str(patch)], cwd=pack)
    return "applied"


def held_constraints(tmp: Path) -> Path:
    """A pip constraints file pinning the held packages to the versions ComfyUI was built with."""
    lines = []
    freeze = SETUP / "requirements.txt"
    if freeze.is_file():
        for line in freeze.read_text(encoding="utf-8").splitlines():
            name = line.split("==")[0].strip().lower()
            if "==" in line and name in HELD:
                lines.append(line.strip().split("+")[0] if name.startswith("torch") else line.strip())
    path = tmp / "constraints.txt"
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--comfyui", required=True, help="the ComfyUI folder (the one that contains custom_nodes/)")
    parser.add_argument("--bundle", help="folder or zip with the packs that cannot be cloned (default: comfyui_nodes/third_party in this repository)")
    parser.add_argument("--all", action="store_true", help="install every pack in setup.json, not only the required ones")
    parser.add_argument("--python", help="ComfyUI's Python (default: <comfyui>/.venv)")
    parser.add_argument("--no-pip", action="store_true", help="do not install the packs' requirements")
    parser.add_argument("--dry-run", action="store_true", help="print what would happen, change nothing")
    args = parser.parse_args()

    comfy = Path(args.comfyui)
    nodes = comfy / "custom_nodes"
    if not nodes.is_dir():
        print(f"no custom_nodes folder under {comfy}: is that the ComfyUI folder?", file=sys.stderr)
        return 1
    if not shutil.which("git"):
        print("git is not on PATH", file=sys.stderr)
        return 1
    setup = json.loads((SETUP / "setup.json").read_text(encoding="utf-8"))
    packs = {p["name"]: p for p in setup["custom_nodes"]}
    dry = args.dry_run
    report: dict[str, list[str]] = {"installed": [], "present": [], "missing": [], "failed": []}

    def note(kind: str, text: str) -> None:
        report[kind].append(text)
        print(f"  [{kind}] {text}")

    bundle_path = Path(args.bundle) if args.bundle else (OWN_PACKS / "third_party")
    bundle = None            # a zip, or None when the packs come from a folder
    if bundle_path.is_file():
        bundle = zipfile.ZipFile(bundle_path)
        in_bundle = {Path(m).parts[1] for m in bundle.namelist() if m.startswith("custom_nodes/") and len(Path(m).parts) > 2}
    elif bundle_path.is_dir():
        in_bundle = {p.name for p in bundle_path.iterdir() if p.is_dir()}
    else:
        in_bundle = set()
    have_bundle = bool(in_bundle)

    def extract_from_bundle(name: str) -> None:
        if dry:
            return
        if bundle is None:
            shutil.copytree(bundle_path / name, nodes / name)
            return
        members = [m for m in bundle.namelist() if m.startswith(f"custom_nodes/{name}/")]
        with tempfile.TemporaryDirectory() as tmp:
            bundle.extractall(tmp, members)
            shutil.copytree(Path(tmp) / "custom_nodes" / name, nodes / name)

    def wanted_pack(pack: dict) -> bool:
        return args.all or pack.get("required", True)

    print("Own packs")
    for src in sorted(p for p in OWN_PACKS.iterdir() if p.is_dir() and p.name not in ("__pycache__", "third_party")):
        dest = nodes / src.name
        if dest.exists():
            note("present", src.name)
            continue
        if not dry:
            shutil.copytree(src, dest, ignore=shutil.ignore_patterns("__pycache__"))
        note("installed", f"{src.name} (copied from this repository)")

    print("Git packs")
    for name, pack in packs.items():
        if pack["source"] != "git" or not wanted_pack(pack):
            continue
        dest = nodes / name
        patch = SETUP / "patches" / f"{name}.patch"
        if dest.exists():
            here = run(["git", "rev-parse", "HEAD"], cwd=dest, check=False).stdout.strip()
            note("present", f"{name} at {here[:7] or 'no git'}" + ("" if here == pack["commit"] else f" (setup.json has {pack['commit'][:7]})"))
        else:
            if dry:
                note("installed", f"{name}: would clone {pack['remote']} at {pack['commit'][:7]}")
            else:
                done = run(["git", "clone", "-q", pack["remote"], str(dest)], check=False)
                if done.returncode == 0:
                    done = run(["git", "checkout", "-q", pack["commit"]], cwd=dest, check=False)
                if done.returncode != 0:
                    reason = done.stderr.strip().splitlines()[-1] if done.stderr.strip() else "git failed"
                    shutil.rmtree(dest, ignore_errors=True)
                    # The repository may be gone for good: the bundle carries those packs.
                    if name in in_bundle:
                        extract_from_bundle(name)
                        note("installed", f"{name} (from the bundle; clone failed: {reason})")
                    else:
                        note("failed", f"{name}: {reason}" + ("" if have_bundle else " (no bundle: pass --bundle)"))
                        continue
                else:
                    note("installed", f"{name} at {pack['commit'][:7]}")
        if patch.is_file() and dest.exists():
            result = apply_patch(dest, patch, dry)
            note("failed" if result.startswith("FAILED") else "present" if result == "already applied" else "installed",
                 f"{name}: patch {result}")

    print("Packs without git history")
    wanted = [n for n, p in packs.items() if p["source"] == "copy" and wanted_pack(p) and n not in {q.name for q in OWN_PACKS.iterdir() if q.name != "third_party"}]
    missing = [n for n in wanted if not (nodes / n).exists()]
    for name in wanted:
        if name not in missing:
            note("present", name)
        elif name in in_bundle:
            extract_from_bundle(name)
            note("installed", f"{name} (from the bundle)")
            patch = SETUP / "patches" / f"{name}.patch"
            if patch.is_file() and not dry:
                result = apply_patch(nodes / name, patch, dry)
                note("failed" if result.startswith("FAILED") else "installed", f"{name}: patch {result}")
        else:
            note("missing", f"{name}" + ("" if have_bundle else " (needs --bundle)"))

    if not args.no_pip and not dry:
        print("Python requirements")
        python = args.python or str(comfy / ".venv" / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python"))
        if not Path(python).is_file():
            print(f"  ComfyUI's Python not found at {python}; use --python or --no-pip")
        else:
            with tempfile.TemporaryDirectory() as tmp:
                constraints = held_constraints(Path(tmp))
                for name in sorted(packs):
                    req = nodes / name / "requirements.txt"
                    if not req.is_file():
                        continue
                    done = run([python, "-m", "pip", "install", "-q", "-r", str(req), "-c", str(constraints)], check=False)
                    if done.returncode == 0:
                        print(f"  [ok] {name}")
                    else:
                        tail = (done.stderr.strip().splitlines() or ["pip failed"])[-1]
                        note("failed", f"{name}: pip: {tail}")

    print(f"\n{len(report['installed'])} installed, {len(report['present'])} already there, "
          f"{len(report['missing'])} missing, {len(report['failed'])} failed" + (" (dry run)" if dry else ""))
    if report["missing"]:
        print("Missing packs have no git history: pass --bundle with a folder or zip made by export_comfyui_setup.py (--vendor / --zip).")
    if not dry:
        print("Restart ComfyUI, then run: python tools/check_install.py")
    return 1 if report["failed"] else 0


if __name__ == "__main__":
    sys.exit(main())
