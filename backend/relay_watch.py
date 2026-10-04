"""Tail the agent relay log and print one line per message addressed to us.

Used as a Monitor command: each printed line becomes a notification, so the
agent is woken as soon as a peer sends something. Reads incrementally, so the
cost of a poll does not grow with the size of the log.

Only the sender and thread are printed, never the body -- message text is
written by other agents, so it should reach the agent through read_messages as
data rather than arriving inside a notification.
"""

from __future__ import annotations

import os
import time

from relay_tail import RelayTail, addressed_to, relay_log

AGENT = os.environ.get("RELAY_AGENT", "claude")

tail = RelayTail(relay_log(), start_at_end=True)

while True:
    for msg in tail.new_messages():
        if addressed_to(msg, AGENT):
            print(
                f"[relay] message from {msg.get('from')} "
                f"(thread {msg.get('thread')}) -- call read_messages to collect it",
                flush=True,
            )
    time.sleep(2)
