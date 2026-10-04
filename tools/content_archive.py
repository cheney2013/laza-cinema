"""Record film content files in a SQLite archive instead of git.

Content (prompts, previs scenes, set scripts, scene configs) is kept out of the
repository by the ``# >>> content`` block in .gitignore. This tool finds every
file on disk matched by that block and upserts it into
``backend/workspaces/content_archive.db``:

- text files: path, sha256, size, mtime and the full text
- media / binary files: path, sha256, size, mtime only (no bytes stored)

Generated media (the ``# >>> generated media`` block: renders, extracted
frames, trimmed clips, normalised audio, built .blend sets, backups) is not
recorded at all. Rows for files that are gone, or that have become generated,
are dropped from content_files; the text history of past versions is kept.

Usage:
    python tools/content_archive.py            # archive / refresh
    python tools/content_archive.py --list     # show what is recorded
    python tools/content_archive.py --restore backend/previs/<file>_prompt.txt
"""
from __future__ import annotations

import argparse
import hashlib
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "backend" / "workspaces" / "content_archive.db"

MEDIA_EXTS = {
    ".blend", ".fbx", ".obj", ".glb", ".npz", ".npy",
    ".png", ".jpg", ".jpeg", ".webp", ".exr",
    ".mp4", ".mov", ".webm", ".mkv",
    ".wav", ".mp3", ".flac", ".m4a", ".ogg",
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS content_files (
    path        TEXT PRIMARY KEY,   -- repo-relative, forward slashes
    kind        TEXT NOT NULL,      -- 'text' or 'media'
    sha256      TEXT NOT NULL,
    size        INTEGER NOT NULL,
    mtime       REAL NOT NULL,
    content     TEXT,               -- NULL for media: only the path is kept
    archived_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS content_history (
    path        TEXT NOT NULL,
    sha256      TEXT NOT NULL,
    content     TEXT,
    archived_at REAL NOT NULL,
    PRIMARY KEY (path, sha256)
);
"""


def gitignore_block(name: str) -> list[str]:
    lines = (ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
    try:
        start = lines.index(f"# >>> {name}") + 1
        end = lines.index(f"# <<< {name}")
    except ValueError:
        sys.exit(f".gitignore has no '# >>> {name}' block")
    return lines[start:end]


def matching_files(patterns: list[str]) -> set[str]:
    """Files on disk, tracked or not, that the given ignore patterns match."""
    with tempfile.NamedTemporaryFile("w", suffix=".ignore", delete=False,
                                     encoding="utf-8") as fh:
        fh.write("\n".join(patterns) + "\n")
        exclude = fh.name
    try:
        out = subprocess.run(
            ["git", "-c", "core.quotepath=off", "ls-files", "-z", "-o", "-c",
             "-i", f"--exclude-from={exclude}"],
            cwd=ROOT, capture_output=True, check=True,
        ).stdout.decode("utf-8")
    finally:
        os.unlink(exclude)
    return {p for p in out.split("\0") if p}


def content_files() -> list[str]:
    files = (matching_files(gitignore_block("content"))
             - matching_files(gitignore_block("generated media")))
    return sorted(p for p in files
                  if (ROOT / p).is_file() and "__pycache__" not in p)


def read_text(path: Path) -> str | None:
    if path.suffix.lower() in MEDIA_EXTS:
        return None
    data = path.read_bytes()
    if b"\0" in data[:8192]:
        return None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


def archive(conn: sqlite3.Connection) -> None:
    now = time.time()
    counts = {"text": 0, "media": 0, "changed": 0}
    known = {p: (sha, size, mtime, kind) for p, sha, size, mtime, kind in conn.execute(
        "SELECT path, sha256, size, mtime, kind FROM content_files")}
    current = content_files()
    for rel in current:
        path = ROOT / rel
        st = path.stat()
        prev = known.get(rel)
        # Same size and mtime as recorded: do not rehash.
        if prev and prev[1] == st.st_size and prev[2] == st.st_mtime:
            counts[prev[3]] += 1
            continue
        sha = hashlib.sha256(path.read_bytes()).hexdigest()
        text = read_text(path)
        kind = "media" if text is None else "text"
        counts[kind] += 1
        if prev and prev[0] == sha:
            conn.execute("UPDATE content_files SET mtime=? WHERE path=?",
                         (st.st_mtime, rel))
            continue
        counts["changed"] += 1
        conn.execute(
            "INSERT OR REPLACE INTO content_files VALUES (?,?,?,?,?,?,?)",
            (rel, kind, sha, st.st_size, st.st_mtime, text, now))
        if text is not None:
            conn.execute(
                "INSERT OR IGNORE INTO content_history VALUES (?,?,?,?)",
                (rel, sha, text, now))
    stale = sorted(set(known) - set(current))
    conn.executemany("DELETE FROM content_files WHERE path=?", [(p,) for p in stale])
    conn.execute("DELETE FROM content_history WHERE content IS NULL")
    conn.commit()
    if stale:
        conn.execute("VACUUM")
    print(f"text {counts['text']}, media {counts['media']}, "
          f"new or changed {counts['changed']}, dropped {len(stale)} -> {DB_PATH}")


def record_text(rel: str) -> None:
    """Record one text file now, without scanning the whole content block.

    The canvas MCP server calls this after writing a node's prompt back to its
    file, so an edit made from a cloud session lands in the archive as well as
    on disk."""
    rel = rel.replace("\\", "/")
    path = ROOT / rel
    text = path.read_text(encoding="utf-8")
    st = path.stat()
    sha = hashlib.sha256(path.read_bytes()).hexdigest()
    now = time.time()
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.executescript(SCHEMA)
        conn.execute("INSERT OR REPLACE INTO content_files VALUES (?,?,?,?,?,?,?)",
                     (rel, "text", sha, st.st_size, st.st_mtime, text, now))
        conn.execute("INSERT OR IGNORE INTO content_history VALUES (?,?,?,?)",
                     (rel, sha, text, now))
        conn.commit()
    finally:
        conn.close()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--restore", metavar="PATH",
                    help="write a text file back from the archive")
    args = ap.parse_args()

    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(SCHEMA)

    if args.list:
        for path, kind, size in conn.execute(
                "SELECT path, kind, size FROM content_files ORDER BY path"):
            print(f"{kind:5} {size:>10}  {path}")
    elif args.restore:
        rel = args.restore.replace("\\", "/")
        row = conn.execute(
            "SELECT kind, content FROM content_files WHERE path=?",
            (rel,)).fetchone()
        if not row:
            sys.exit(f"not in archive: {rel}")
        if row[0] != "text":
            sys.exit(f"media is recorded by path only: {rel}")
        target = ROOT / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(target.name + ".restore_tmp")
        tmp.write_text(row[1], encoding="utf-8", newline="")
        os.replace(tmp, target)
        print(f"restored {rel}")
    else:
        archive(conn)


if __name__ == "__main__":
    main()
