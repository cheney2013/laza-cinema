"""Say something when a peer on the relay goes quiet or disappears.

Tonight a peer ran out of quota and went offline. Nobody noticed for the best
part of an hour: I went on sending it work and waiting for replies, and the
human found out by opening its window and looking. A prompt-format fix sat
undone that whole time because it had been handed to an agent that was no
longer there.

The signals already existed and nothing was reading them:

  * `$RELAY_DIR/instances/<name>.<pid>.json` -- written while an agent's MCP
    server is running. Gone means the process is gone.
  * `$RELAY_DIR/status.json` -- each agent's last action and when. Old means
    the process may be up but is doing nothing.

Both matter and they fail differently: a crashed client loses its instance file
while its status entry sits there looking plausible, and a wedged client keeps
its instance file while its status goes stale. Watching only one of them misses
half the cases.

Prints one line per state change, so an idle bus is silent:

    RELAY_AGENT=claude python tools/peer_watch.py

Meant to run under a Monitor, where each line becomes a notification.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

ROOT = Path(os.environ.get("RELAY_DIR", Path.home() / ".agent-relay"))
SELF = os.environ.get("RELAY_AGENT", "claude")
STALE_AFTER = float(os.environ.get("PEER_STALE_MINUTES", "12")) * 60
POLL = 30.0

#: Names that are bookkeeping rather than agents.
IGNORE = {"unknown", "user", "all"}


def snapshot() -> dict[str, tuple[bool, float]]:
    """For each known peer: is its MCP server present, and how old is its last action."""
    live = set()
    inst = ROOT / "instances"
    if inst.is_dir():
        for f in inst.glob("*.json"):
            live.add(f.name.split(".", 1)[0])

    out: dict[str, tuple[bool, float]] = {}
    status = ROOT / "status.json"
    if status.is_file():
        try:
            data = json.loads(status.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return out
        now = time.time()
        for name, rec in data.items():
            if name in IGNORE or name == SELF:
                continue
            ts = rec.get("ts") or 0
            out[name] = (name in live, now - ts if ts else 1e9)
    for name in live:
        if name not in out and name not in IGNORE and name != SELF:
            out[name] = (True, 0.0)
    return out


def describe(name: str, present: bool, age: float) -> str:
    mins = age / 60
    if not present:
        return (f"[peer] {name} 的 MCP 进程不在了(最后活动 {mins:.0f} 分钟前)"
                f" —— 发给它的东西不会有人做")
    if age > STALE_AFTER:
        return f"[peer] {name} 进程还在,但已经 {mins:.0f} 分钟没有任何动作"
    return f"[peer] {name} 回来了"


def state_of(present: bool, age: float) -> str:
    if not present:
        return "gone"
    return "stale" if age > STALE_AFTER else "ok"


def main() -> None:
    seen: dict[str, str] = {}
    first = True
    while True:
        for name, (present, age) in snapshot().items():
            now = state_of(present, age)
            # Report the opening state too, so arming the watch answers the
            # question "is anyone actually there right now" without waiting for
            # a transition that may never come.
            if seen.get(name) != now:
                if not first or now != "ok":
                    print(describe(name, present, age), flush=True)
                seen[name] = now
        first = False
        time.sleep(POLL)


if __name__ == "__main__":
    main()
