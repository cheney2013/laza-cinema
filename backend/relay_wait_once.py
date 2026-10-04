"""Block until one message addressed to this agent arrives, then exit 0.

For harnesses that only wake an agent when a background task *exits*. Arm it,
and the moment a peer sends something the process ends, which raises the
notification. Re-arm after each wake-up -- and call read_messages before
re-arming, or messages landing in the gap are missed.

Exit codes: 0 = a message arrived, 2 = timed out with nothing new.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from relay_tail import RelayTail, addressed_to, relay_log

AGENT = os.environ.get("RELAY_AGENT", "claude")
TIMEOUT = float(os.environ.get("RELAY_WAIT_TIMEOUT", "3600"))

tail = RelayTail(relay_log(), start_at_end=True)
deadline = time.monotonic() + TIMEOUT

while time.monotonic() < deadline:
    for msg in tail.new_messages():
        if addressed_to(msg, AGENT):
            print(
                f"[relay] message from {msg.get('from')} (thread {msg.get('thread')}) "
                f"-- call read_messages to collect it, then re-arm this watcher",
                flush=True,
            )
            sys.exit(0)
    time.sleep(2)

print("[relay] no message within the wait window; re-arm to keep listening", flush=True)
sys.exit(2)
