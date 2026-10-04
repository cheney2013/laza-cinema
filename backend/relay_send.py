import os
import sys
from pathlib import Path

if sys.platform == "win32":
    try:
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

os.environ["RELAY_AGENT"] = "antigravity"
sys.path.insert(0, str(Path(__file__).resolve().parent))
import relay_mcp_server

if len(sys.argv) < 3:
    print("Usage: python relay_send.py <to> <thread> <file_or_text>", file=sys.stderr)
    sys.exit(1)

to = sys.argv[1]
thread = sys.argv[2]
arg = sys.argv[3]

if Path(arg).is_file():
    text = Path(arg).read_text(encoding="utf-8-sig")
else:
    text = arg.lstrip("\ufeff")

status = sys.argv[4] if len(sys.argv) > 4 else ""

res = relay_mcp_server.send_message(text=text.strip(), to=to, thread=thread, status=status)
import json
print(json.dumps(res, ensure_ascii=False))

