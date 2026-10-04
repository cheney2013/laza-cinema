"""Apply an edit to a file without risking the original.

Writing in place truncates the file the moment it is opened, so a failure part
way through leaves nothing behind -- which is exactly how a colleague's
uncommitted work was destroyed once. This encodes the new content first, writes
it to a temporary file beside the target, and only then swaps it in.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path


def read(path: str | Path) -> str:
    return Path(path).read_text(encoding="utf-8-sig")


def write(path: str | Path, content: str) -> None:
    path = Path(path)
    # Encode before touching the filesystem: a bad character fails here, while
    # the original file is still whole.
    data = content.encode("utf-8")

    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)  # atomic on the same filesystem
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def replace_once(path: str | Path, old: str, new: str) -> None:
    """Swap a single occurrence, refusing anything ambiguous."""
    s = read(path)
    count = s.count(old)
    if count != 1:
        raise ValueError(f"expected exactly one occurrence, found {count}")
    write(path, s.replace(old, new, 1))
