r"""Give every unowned project an owner.

    backend\.venv\Scripts\python tools\assign_project_owner.py --username cy            # dry run
    backend\.venv\Scripts\python tools\assign_project_owner.py --username cy --apply

A project with no owner_user_id predates accounts or was made by an agent. Since
accounts only see their own projects (admins see all), such a project is hidden
from everyone but admins until it is handed to someone. This hands them all to
one account. Projects that already have an owner are left alone.
"""
import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent / "backend"
sys.path.insert(0, str(BACKEND))

import accounts                                   # noqa: E402

WORKSPACES = BACKEND / "workspaces"


def main() -> int:
    a = argparse.ArgumentParser()
    a.add_argument("--username", required=True, help="account that will own the unowned projects")
    a.add_argument("--apply", action="store_true", help="write the change (default: dry run)")
    args = a.parse_args()

    owner = accounts.user_id_for(args.username)
    if not owner:
        print(f"no such account: {args.username}", file=sys.stderr)
        return 1

    changed = 0
    for meta_path in sorted(WORKSPACES.glob("*/projects/*/meta.json")):
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        if meta.get("owner_user_id"):
            continue
        print(f"{'assign' if args.apply else 'would assign'} {meta.get('id', meta_path.parent.name)}"
              f"  {meta.get('name', '')}  -> {args.username}")
        if args.apply:
            meta["owner_user_id"] = owner
            tmp = meta_path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(meta_path)
        changed += 1
    print(f"{changed} project(s) {'assigned' if args.apply else 'unowned'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
