"""Enumerate and terminate the relay's own processes.

The console can show which processes are serving the bus and let the operator
end a duplicate, which is the remedy when two sessions answer to one agent name.

Termination is deliberately narrow: only a pid that this module itself just
found running a known relay script may be ended. Nothing here accepts a pid from
the caller as authority, so the endpoint cannot become a way to kill arbitrary
processes on the machine.
"""

from __future__ import annotations

import os
import re
import signal
import subprocess
import sys
from typing import Any

# Only processes running one of these are ever eligible to be listed or ended.
RELAY_SCRIPTS = ("relay_mcp_server.py", "relay_watch.py", "relay_wait_once.py")


def _windows_processes() -> list[dict[str, Any]]:
    ps = (
        "Get-CimInstance Win32_Process -Filter \"Name like '%python%'\" | "
        "Select-Object ProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress"
    )
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
            capture_output=True, text=True, timeout=15,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return []
    if not out:
        return []
    import json as _json
    try:
        data = _json.loads(out)
    except _json.JSONDecodeError:
        return []
    if isinstance(data, dict):
        data = [data]
    rows = []
    for item in data:
        cmd = item.get("CommandLine") or ""
        script = next((s for s in RELAY_SCRIPTS if s in cmd), None)
        if not script:
            continue
        agent = None
        m = re.search(r"RELAY_AGENT[=\s]+([A-Za-z0-9_.-]+)", cmd)
        if m:
            agent = m.group(1)
        rows.append({
            "pid": item.get("ProcessId"),
            "script": script,
            "agent": agent,
            "started": str(item.get("CreationDate") or ""),
            "self": item.get("ProcessId") == os.getpid(),
        })
    return rows


def _enrich(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Fill in the agent name and last activity from the relay's own records.

    RELAY_AGENT is set by the host that spawned the server, so it is not on the
    command line; the instance registry is where a server says who it answers to.
    A server too old to register simply has no name here, which is itself worth
    showing -- those are the ones that steal messages without announcing
    themselves.
    """
    import json as _json
    from pathlib import Path

    root = Path(os.environ.get("RELAY_DIR", Path.home() / ".agent-relay"))
    by_pid: dict[int, str] = {}
    inst = root / "instances"
    if inst.is_dir():
        for path in inst.glob("*.json"):
            try:
                info = _json.loads(path.read_text(encoding="utf-8"))
            except (OSError, _json.JSONDecodeError):
                continue
            if isinstance(info.get("pid"), int) and isinstance(info.get("agent"), str):
                by_pid[info["pid"]] = info["agent"]

    for row in rows:
        row["agent"] = by_pid.get(row["pid"])
        row["registered"] = row["pid"] in by_pid
        m = re.search(r"/Date\((\d+)", row.get("started") or "")
        row["started_at"] = int(m.group(1)) / 1000 if m else None
    return rows


def list_processes() -> list[dict[str, Any]]:
    if sys.platform == "win32":
        return _enrich(sorted(_windows_processes(), key=lambda r: (r["script"], r["pid"] or 0)))
    try:
        out = subprocess.run(["ps", "-eo", "pid,args"], capture_output=True,
                             text=True, timeout=15).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    rows = []
    for line in out.splitlines()[1:]:
        pid, _, args = line.strip().partition(" ")
        script = next((s for s in RELAY_SCRIPTS if s in args), None)
        if not script or not pid.isdigit():
            continue
        rows.append({"pid": int(pid), "script": script, "agent": None,
                     "started": "", "self": int(pid) == os.getpid()})
    return _enrich(sorted(rows, key=lambda r: (r["script"], r["pid"])))


def terminate(pid: int) -> dict[str, Any]:
    """End one relay process, but only if it is currently running relay code."""
    known = {row["pid"] for row in list_processes()}
    if pid not in known:
        return {"ok": False, "reason": "not a relay process"}
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError as exc:
        return {"ok": False, "reason": str(exc)}
    return {"ok": True, "pid": pid}
