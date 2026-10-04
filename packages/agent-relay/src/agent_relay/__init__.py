"""A local message bus so several agent CLIs on one machine can talk.

Messages are appended to a shared JSONL log; each agent keeps its own read
cursor, so an agent only ever sees what it has not read yet. Nothing here does
network I/O or executes anything -- it moves text between processes.

Three entry points are installed:

    agent-relay-mcp     the MCP server an agent connects to
    agent-relay-ui      the web console a human reads and writes from
    agent-relay-watch   a blocking watcher that wakes an agent on new mail
"""

__version__ = "0.1.0"
