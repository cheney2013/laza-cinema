r"""CLI wrapper around backend/artifact_pruner.py.

    backend\.venv\Scripts\python tools\prune_artifacts.py            # dry run
    backend\.venv\Scripts\python tools\prune_artifacts.py --apply

The frontend calls the same logic through POST /prune-artifacts on page load;
this exists for inspecting or forcing a pass by hand.
"""
import argparse
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent / "backend"
sys.path.insert(0, str(BACKEND))

import artifact_pruner as ap                      # noqa: E402
from comfyui_client import COMFYUI_OUTPUT_DIR     # noqa: E402


def main() -> int:
    a = argparse.ArgumentParser()
    a.add_argument("--apply", action="store_true", help="actually delete (default: dry run)")
    a.add_argument("--min-age-minutes", type=int, default=ap.DEFAULT_MIN_AGE_MINUTES,
                   help="never touch files younger than this")
    args = a.parse_args()

    targets = [BACKEND / "uploads"]
    if COMFYUI_OUTPUT_DIR:
        targets.append(Path(COMFYUI_OUTPUT_DIR))

    res = ap.prune(BACKEND / "workspaces", targets, args.min_age_minutes, args.apply)
    paired = res["kept_with_pairs"] - res["referenced"]
    print(f"referenced by canvases : {res['referenced']} (+{paired} paired)")
    print(f"not ours (left alone)  : {res['left_alone']}")
    print(f"too new (<{args.min_age_minutes}m)      : {res['too_new']}")
    print(f"unreferenced           : {len(res['doomed'])}  ({res['bytes'] / 2**30:.2f} GiB)")
    for f in res["doomed"][:15]:
        print(f"    - {f.name}")
    if len(res["doomed"]) > 15:
        print(f"    ... and {len(res['doomed']) - 15} more")
    print("")
    if args.apply:
        print(f"deleted {res['deleted']} files, freed {res['bytes'] / 2**30:.2f} GiB")
    else:
        print("DRY RUN -- nothing deleted. Re-run with --apply to delete.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
