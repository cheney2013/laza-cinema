"""Incremental reader for the relay log.

The watchers poll every couple of seconds, so re-reading the whole file each
time would grow more expensive as the log does. This keeps a byte offset and
seeks straight to the unread tail instead, which costs the same whether the log
holds fifty messages or fifty thousand.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Iterator


class RelayTail:
    """Yields messages appended since the last call."""

    def __init__(self, log: Path, start_at_end: bool = True) -> None:
        self.log = log
        self.offset = 0
        self._partial = ""
        if start_at_end and log.exists():
            self.offset = log.stat().st_size

    def _reset(self) -> None:
        self.offset = 0
        self._partial = ""

    def new_messages(self) -> Iterator[dict[str, Any]]:
        if not self.log.exists():
            self._reset()
            return

        try:
            size = self.log.stat().st_size
        except OSError:
            return

        if size < self.offset:  # truncated or recreated
            self._reset()
        if size == self.offset:
            return

        try:
            with self.log.open("rb") as fh:
                fh.seek(self.offset)
                chunk = fh.read()
                self.offset = fh.tell()
        except OSError:
            return

        # A write can land mid-line; hold the fragment until its newline arrives.
        text = self._partial + chunk.decode("utf-8", errors="replace")
        if text.endswith("\n"):
            self._partial = ""
        else:
            text, _, self._partial = text.rpartition("\n")

        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def addressed_to(msg: dict[str, Any], agent: str) -> bool:
    return msg.get("from") != agent and msg.get("to") in (agent, "all")


def relay_log() -> Path:
    root = Path(os.environ.get("RELAY_DIR", Path.home() / ".agent-relay"))
    return root / "messages.jsonl"
