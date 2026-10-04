import asyncio
import json
import os
import sys
import secrets
import subprocess
import tempfile
from urllib.parse import quote
import time
import uuid
from pathlib import Path
from typing import Optional

from fastapi import (
    Cookie,
    FastAPI,
    File,
    Form,
    HTTPException,
    Request,
    Response,
    UploadFile,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse, StreamingResponse
from pydantic import BaseModel

from . import auth

# Bind address and port, read before the app is constructed because the CORS
# allow-list is built from them. 127.0.0.1 is the default on purpose: this
# console authenticates well enough for a machine you control and not for an
# open network.
UI_HOST = os.environ.get("RELAY_UI_HOST", "127.0.0.1")
UI_PORT = int(os.environ.get("RELAY_UI_PORT", "8777"))
from . import processes

app = FastAPI(title="Agent Relay UI")

# The page is served from this same origin, so no cross-origin access is needed.
# A wildcard here would let any site the user visits read the whole relay log and
# post messages to the bus, since a browser can reach 127.0.0.1 from any page.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[f"http://{UI_HOST}:{UI_PORT}", f"http://localhost:{UI_PORT}"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

RELAY_DIR = Path(os.environ.get("RELAY_DIR", Path.home() / ".agent-relay"))
LOG_FILE = RELAY_DIR / "messages.jsonl"
BASE_DIR = Path(__file__).resolve().parent
HTML_FILE = BASE_DIR / "index.html"
ATTACH_DIR = RELAY_DIR / "attachments"
CURSORS_FILE = RELAY_DIR / "cursors.json"
RECEIPTS_FILE = RELAY_DIR / "receipts.json"


def _load_json_file(path: Path) -> dict:
    if not path.exists():
        return {}
    for attempt in range(3):
        try:
            with path.open("r", encoding="utf-8") as f:
                return json.load(f)
        except (OSError, json.JSONDecodeError):
            time.sleep(0.01)
    return {}

# Only formats the model can actually decode. Accepting anything else would be
# worse than refusing it: the user would believe the image had been sent.
ALLOWED_IMAGE_TYPES = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/heic": "heic",
    "image/heif": "heif",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
}
ALLOWED_MEDIA_TYPES = ALLOWED_IMAGE_TYPES
MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024
MAX_ATTACHMENTS_PER_MESSAGE = 6


SIGNING_KEY = auth.load_signing_key()
PUBKEY_HEX = auth.public_key_hex(SIGNING_KEY)
LOGIN_TOKEN = auth.load_or_create_token()


class LoginRequest(BaseModel):
    token: str


class SendMessageRequest(BaseModel):
    text: str
    to: Optional[str] = "all"
    thread: Optional[str] = ""
    # Ids handed out by /api/upload. Deliberately outside the signed payload;
    # see the comment where the signature is produced.
    attachments: Optional[list[str]] = None


@app.get("/")
def get_index():
    if not HTML_FILE.exists():
        raise HTTPException(status_code=404, detail="index.html not found")
    response = FileResponse(HTML_FILE)
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return response


@app.get("/qrcode.min.js")
def get_qrcode_js():
    js_file = BASE_DIR / "qrcode.min.js"
    if not js_file.exists():
        raise HTTPException(status_code=404, detail="qrcode.min.js not found")
    return FileResponse(js_file, media_type="application/javascript")


@app.get("/api/messages")
def get_messages(relay_session: Optional[str] = Cookie(default=None)):
    _require_session(relay_session)
    if not LOG_FILE.exists():
        return {"messages": [], "cursors": {}, "receipts": {}}
    
    messages = []
    try:
        content = LOG_FILE.read_text(encoding="utf-8")
        msg_idx = 0
        for line in content.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                data = json.loads(line)
                data["_idx"] = msg_idx
                msg_idx += 1
                # Only a signature the UI server produced counts as the real human.
                # Anything else claiming from="user" was written straight to the log.
                data["verified"] = (
                    data.get("from") == "user" and auth.verify(data, PUBKEY_HEX)
                )
                messages.append(data)
            except json.JSONDecodeError:
                continue
    except OSError as e:
        raise HTTPException(status_code=500, detail=str(e))
    
    return {
        "messages": messages,
        "cursors": _load_json_file(CURSORS_FILE),
        "receipts": _load_json_file(RECEIPTS_FILE),
    }


@app.get("/api/stream")
async def sse_stream(
    request: Request,
    last_id: Optional[str] = None,
    relay_session: Optional[str] = Cookie(default=None),
):
    _require_session(relay_session)

    # Browser standard header Last-Event-ID takes precedence; query param as fallback
    client_last_id = request.headers.get("last-event-id") or last_id

    async def event_generator():
        # 1. Enforce 3s client reconnect interval across all mobile & desktop browsers
        yield "retry: 3000\n\n"

        # 2. Catch-up phase
        raw_bytes = b""
        lines = []
        if LOG_FILE.exists():
            try:
                raw_bytes = LOG_FILE.read_bytes()
                raw_text = raw_bytes.decode("utf-8", errors="replace")
                lines = [ln for ln in raw_text.splitlines() if ln.strip()]
            except OSError:
                raw_bytes = b""
                lines = []

        file_pos = len(raw_bytes)

        history_msgs = []
        for ln in lines:
            try:
                d = json.loads(ln)
                d["verified"] = (
                    d.get("from") == "user" and auth.verify(d, PUBKEY_HEX)
                )
                history_msgs.append(d)
            except json.JSONDecodeError:
                continue

        if client_last_id:
            idx = -1
            for i, m in enumerate(history_msgs):
                if m.get("id") == client_last_id:
                    idx = i
                    break
            if idx != -1:
                replay = history_msgs[idx + 1 :]
            else:
                # client_last_id not found: return only last 50 with truncated flag to avoid overwhelming mobile devices
                replay = history_msgs[-50:]
                if len(history_msgs) > 50:
                    yield 'event: notice\ndata: {"truncated": true}\n\n'
        else:
            # First connect without cursor: send up to last 100 messages
            replay = history_msgs[-100:]

        for m in replay:
            mid = m.get("id", "")
            payload = json.dumps(m, ensure_ascii=False)
            yield f"id: {mid}\nevent: message\ndata: {payload}\n\n"

        # 3. Live tail phase with byte-level newline boundary buffering
        byte_buf = b""
        last_ping = time.time()

        while True:
            if await request.is_disconnected():
                break

            now = time.time()
            if now - last_ping >= 15.0:
                last_ping = now
                yield ": ping\n\n"

            if LOG_FILE.exists():
                try:
                    curr_size = LOG_FILE.stat().st_size
                    if curr_size > file_pos:
                        with LOG_FILE.open("rb") as f:
                            f.seek(file_pos)
                            chunk = f.read()
                            file_pos = f.tell()

                        byte_buf += chunk

                        # Strict raw-byte newline boundary:
                        # 0x0A (\n) never tears multi-byte UTF-8 sequences
                        if b"\n" in byte_buf:
                            complete_bytes, byte_buf = byte_buf.rsplit(b"\n", 1)
                            for raw_line in complete_bytes.split(b"\n"):
                                raw_line = raw_line.strip()
                                if not raw_line:
                                    continue
                                try:
                                    line = raw_line.decode("utf-8")
                                    msg_obj = json.loads(line)
                                    msg_obj["verified"] = (
                                        msg_obj.get("from") == "user" and auth.verify(msg_obj, PUBKEY_HEX)
                                    )
                                    mid = msg_obj.get("id", "")
                                    payload = json.dumps(msg_obj, ensure_ascii=False)
                                    yield f"id: {mid}\nevent: message\ndata: {payload}\n\n"
                                except (UnicodeDecodeError, json.JSONDecodeError):
                                    continue
                    elif curr_size < file_pos:
                        file_pos = 0
                        byte_buf = b""
                except OSError:
                    pass

            await asyncio.sleep(0.1)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/status")
def get_agent_status(relay_session: Optional[str] = Cookie(default=None)):
    _require_session(relay_session)
    status_file = RELAY_DIR / "status.json"
    data = _load_json_file(status_file)
    return {
        "status": data,
        "collisions": _name_collisions(),
        "cursors": _load_json_file(CURSORS_FILE),
        "receipts": _load_json_file(RECEIPTS_FILE),
    }


def _is_pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if sys.platform == "win32":
        try:
            import ctypes
            kernel32 = ctypes.windll.kernel32
            handle = kernel32.OpenProcess(0x1000, False, pid)
            if not handle:
                return False
            exit_code = ctypes.c_ulong()
            res = kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code))
            kernel32.CloseHandle(handle)
            return bool(res and exit_code.value == 259)
        except Exception:
            return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _name_collisions() -> dict[str, list[int]]:
    """Agent names being served by more than one live process.

    Two sessions under one name share a mailbox and quietly steal each other's
    messages. Only the person at the keyboard can close the extra session, so the
    collision has to be visible in the console, not just to the agents.
    """
    instances_dir = RELAY_DIR / "instances"
    if not instances_dir.is_dir():
        return {}
    seen: dict[str, list[int]] = {}
    now = time.time()
    for path in list(instances_dir.glob("*.json")):
        try:
            info = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        pid = info.get("pid")
        if not isinstance(pid, int) or not _is_pid_alive(pid):
            path.unlink(missing_ok=True)
            continue
        if now - info.get("ts", 0) > 60:
            path.unlink(missing_ok=True)
            continue
        agent = info.get("agent")
        if isinstance(agent, str):
            seen.setdefault(agent, []).append(pid)
    return {a: sorted(p) for a, p in seen.items() if len(p) > 1}


class TerminateRequest(BaseModel):
    pid: int


@app.get("/api/processes")
def list_relay_processes(relay_session: Optional[str] = Cookie(default=None)):
    """Which processes are serving the bus right now."""
    _require_session(relay_session)
    return {"processes": processes.list_processes()}


@app.post("/api/processes/terminate")
def terminate_relay_process(
    req: TerminateRequest,
    request: Request,
    relay_session: Optional[str] = Cookie(default=None),
):
    """End one relay process. Authenticated, and only ever a relay process.

    The pid is checked against a fresh enumeration rather than trusted, so this
    cannot be turned into a way to kill anything else on the machine.
    """
    if not auth.session_valid(relay_session):
        raise HTTPException(status_code=401, detail="Not authenticated")
    # Reading the console from another device is reasonable; ending processes on
    # this machine from one is not, so a stolen session cannot reach this.
    if not _is_local(request):
        auth.audit("terminate_refused_remote", client=_client(request), pid=req.pid)
        raise HTTPException(
            status_code=403, detail="Ending processes is only allowed from this machine"
        )
    result = processes.terminate(req.pid)
    auth.audit("terminate", client=_client(request), pid=req.pid, ok=result.get("ok"))
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("reason", "failed"))
    return result


@app.get("/api/pubkey")
def get_pubkey():
    """Agents fetch this to verify that a from="user" message is genuine."""
    return {"algorithm": "ed25519", "public_key": PUBKEY_HEX}


@app.get("/api/session")
def get_session(relay_session: Optional[str] = Cookie(default=None)):
    return {"authenticated": auth.session_valid(relay_session)}


def _require_session(relay_session: Optional[str]) -> None:
    """Refuse anything that would disclose bus contents to a stranger.

    Applied unconditionally rather than only for remote callers. A rule that
    opens up for local requests would rest on the local check being right every
    time, and its failure mode is handing over the entire history -- the same
    check needed a proxy-header fix an hour after it was written.
    """
    if not auth.session_valid(relay_session):
        raise HTTPException(status_code=401, detail="Not authenticated")


def _atomic_write_bytes(path: Path, data: bytes) -> None:
    """Write through a temp file and rename, so no reader sees a half file."""
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def _client(request: Request) -> str:
    return request.client.host if request.client else "unknown"


# Headers a reverse proxy adds. Remote access is expected to arrive through one
# (tailscale serve, a tunnel), and to the socket that looks identical to someone
# sitting at the machine -- so their presence is what distinguishes the two.
_PROXY_HEADERS = ("x-forwarded-for", "x-forwarded-host", "x-real-ip", "forwarded")


def _is_local(request: Request) -> bool:
    """Whether the request really came from this machine, not through a proxy.

    Checking the socket address alone is not enough: behind `tailscale serve` or
    any tunnel, a request from the other side of the world arrives from
    127.0.0.1. Treating that as local would let exactly the remote caller this is
    meant to exclude end processes on the host.
    """
    if any(h in request.headers for h in _PROXY_HEADERS):
        return False
    return _client(request) in ("127.0.0.1", "::1", "localhost")


def _over_tls(request: Request) -> bool:
    """Whether the browser reached us over HTTPS.

    Marking the cookie Secure on a plain-HTTP visit makes the browser refuse to
    store it, which would lock the operator out of the local console -- so this
    follows the actual scheme rather than being switched on unconditionally.
    """
    forwarded = request.headers.get("x-forwarded-proto", "")
    return request.url.scheme == "https" or forwarded.split(",")[0].strip() == "https"


@app.post("/api/login")
def login(req: LoginRequest, request: Request, response: Response):
    client = _client(request)

    remaining = auth.locked_out(client)
    if remaining > 0:
        auth.audit("login_blocked", client=client, retry_in=int(remaining))
        raise HTTPException(
            status_code=429,
            detail=f"Too many failed attempts. Try again in {int(remaining // 60) + 1} min.",
        )

    # compare_digest keeps a wrong token from leaking its correct prefix by timing
    if not secrets.compare_digest(req.token.strip(), LOGIN_TOKEN):
        auth.record_failure(client)
        auth.audit("login_failed", client=client)
        raise HTTPException(status_code=401, detail="Invalid token")

    auth.clear_failures(client)
    auth.audit("login_ok", client=client)
    response.set_cookie(
        "relay_session",
        auth.open_session(),
        httponly=True,             # not readable from page scripts
        samesite="strict",         # not sent on requests started by another site
        secure=_over_tls(request),
        max_age=auth.SESSION_TTL,
    )
    return {"authenticated": True}


@app.post("/api/rotate-token")
def rotate_token(request: Request, relay_session: Optional[str] = Cookie(default=None)):
    """Issue a new login token, ending every current session including this one."""
    if not auth.session_valid(relay_session):
        raise HTTPException(status_code=401, detail="Not authenticated")
    if not _is_local(request):
        raise HTTPException(status_code=403, detail="Only available from this machine")
    global LOGIN_TOKEN
    LOGIN_TOKEN = auth.rotate_token()
    auth.audit("token_rotated_by", client=_client(request))
    # Returned once, here, because the operator has just proved they are at the
    # console; afterwards it only lives in the token file.
    return {"rotated": True, "token": LOGIN_TOKEN}


def _public_base_url() -> Optional[str]:
    """The address another device can actually reach this console at.

    The page cannot work this out for itself: viewed at 127.0.0.1 it would put
    that in the QR, which is useless to a phone. Asking tailscale what it is
    publishing beats hardcoding a hostname that changes with the tailnet and
    means nothing on another machine -- and when serve is off, saying so is
    better than pointing a camera at a dead address.
    """
    override = os.environ.get("RELAY_PUBLIC_URL")
    if override:
        return override.rstrip("/")

    for exe in (
        "C:/Program Files/Tailscale/tailscale.exe",
        "/usr/bin/tailscale",
        "tailscale",
    ):
        try:
            out = subprocess.run(
                [exe, "serve", "status"], capture_output=True, text=True, timeout=10
            ).stdout
        except (OSError, subprocess.SubprocessError):
            continue
        for line in out.splitlines():
            line = line.strip()
            if line.startswith("https://"):
                return line.split()[0].rstrip("/")
        break
    return None


@app.get("/api/public-url")
def get_public_url(relay_session: Optional[str] = Cookie(default=None)):
    _require_session(relay_session)
    return {"url": _public_base_url()}


@app.post("/api/ott/create")
def create_one_time_login(
    request: Request, relay_session: Optional[str] = Cookie(default=None)
):
    """Mint a code that signs one other device in, once, within a minute.

    Only issued to someone already signed in at this machine: the code is a
    credential, and rendering it as a QR on a remote screen would be handing it
    to whoever is looking at that screen.
    """
    _require_session(relay_session)
    if not _is_local(request):
        auth.audit("ott_refused_remote", client=_client(request))
        raise HTTPException(
            status_code=403, detail="Only available from this machine"
        )
    code = auth.issue_one_time()
    base = _public_base_url()
    return {
        "code": code,
        "expires_in": int(auth.OTT_TTL),
        # None when nothing is published externally, so the page can say the link
        # will not work rather than rendering one that quietly fails.
        "claim_url": f"{base}/api/ott/claim?code={quote(code)}" if base else None,
    }


@app.get("/api/ott/claim")
def claim_one_time_login(code: str, request: Request):
    """Trade a one-time code for a session, then get the code out of the URL.

    The redirect is not cosmetic: a URL carrying a credential ends up in history
    and in anything the page later links to. The code is single-use and expires
    in a minute, and the browser lands on a plain address with no secret in it.
    """
    ok = auth.redeem_one_time(code)
    response = RedirectResponse(url="/", status_code=302)
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Cache-Control"] = "no-store"
    if not ok:
        auth.audit("ott_claim_failed", client=_client(request))
        return response  # lands on the lock screen, says nothing about why
    auth.audit("ott_claim_ok", client=_client(request))
    response.set_cookie(
        "relay_session",
        auth.open_session(),
        httponly=True,
        samesite="strict",
        secure=_over_tls(request),
        max_age=auth.SESSION_TTL,
    )
    return response


@app.post("/api/logout")
def logout(response: Response, relay_session: Optional[str] = Cookie(default=None)):
    auth.close_session(relay_session)
    response.delete_cookie("relay_session")
    return {"authenticated": False}


def _attachment_meta(att_id: str) -> Optional[dict]:
    """Metadata for one stored image, or None if the id is unknown.

    The id also has to be safe to put in a path: it arrives from the client and
    is concatenated into a filename.
    """
    if not att_id or not all(c in "0123456789abcdef" for c in att_id):
        return None
    meta_file = ATTACH_DIR / f"{att_id}.json"
    if not meta_file.is_file():
        return None
    try:
        return json.loads(meta_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


@app.post("/api/upload")
async def upload_attachment(
    file: UploadFile = File(...),
    original: Optional[UploadFile] = File(default=None),
    name: str = Form(default=""),
    w: int = Form(default=0),
    h: int = Form(default=0),
    relay_session: Optional[str] = Cookie(default=None),
):
    """Store one image and return the id that /api/send refers to.

    `file` is the copy the model will see: the browser has already scaled it to a
    long edge of 1568px, which is where the API stops charging for extra pixels.
    `original` is kept only so a human can click through to the full-size image,
    so the two are stored separately and never substituted for each other.
    """
    _require_session(relay_session)

    ct = (file.content_type or "").lower()
    ext = ALLOWED_MEDIA_TYPES.get(ct)
    if ext is None:
        fn = (file.filename or "").lower()
        if fn.endswith(".mp4"): ext, ct = "mp4", "video/mp4"
        elif fn.endswith(".webm"): ext, ct = "webm", "video/webm"
        elif fn.endswith(".mov"): ext, ct = "mov", "video/quicktime"
        elif fn.endswith(".png"): ext, ct = "png", "image/png"
        elif fn.endswith(".jpg") or fn.endswith(".jpeg"): ext, ct = "jpg", "image/jpeg"
        elif fn.endswith(".webp"): ext, ct = "webp", "image/webp"
    if ext is None:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported media type: {file.content_type or 'unknown'}",
        )

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty upload")
    if len(data) > MAX_ATTACHMENT_BYTES:
        raise HTTPException(status_code=413, detail="File exceeds 100MB limit")

    ATTACH_DIR.mkdir(parents=True, exist_ok=True)
    att_id = uuid.uuid4().hex[:12]
    _atomic_write_bytes(ATTACH_DIR / f"{att_id}.{ext}", data)

    orig_ext = None
    if original is not None:
        orig_ct = (original.content_type or "").lower()
        candidate = ALLOWED_MEDIA_TYPES.get(orig_ct)
        if candidate is None:
            fn = (original.filename or "").lower()
            if fn.endswith(".mp4"): candidate = "mp4"
            elif fn.endswith(".webm"): candidate = "webm"
            elif fn.endswith(".mov"): candidate = "mov"
        orig_data = await original.read()
        if candidate and orig_data and len(orig_data) <= MAX_ATTACHMENT_BYTES:
            _atomic_write_bytes(ATTACH_DIR / f"{att_id}.orig.{candidate}", orig_data)
            orig_ext = candidate

    meta = {
        "id": att_id,
        "mime": (file.content_type or "").lower(),
        "ext": ext,
        "name": (name or file.filename or "image")[:120],
        "w": max(0, w),
        "h": max(0, h),
        "bytes": len(data),
        "has_original": orig_ext is not None,
        "orig_ext": orig_ext,
        "ts": time.time(),
    }
    _atomic_write_bytes(
        ATTACH_DIR / f"{att_id}.json",
        json.dumps(meta, ensure_ascii=False).encode("utf-8"),
    )
    return meta


@app.get("/api/attachments/{att_id}")
def get_attachment(att_id: str, relay_session: Optional[str] = Cookie(default=None)):
    _require_session(relay_session)
    meta = _attachment_meta(att_id)
    if meta is None:
        raise HTTPException(status_code=404, detail="No such attachment")
    path = ATTACH_DIR / f"{att_id}.{meta['ext']}"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Attachment file missing")
    return FileResponse(path, media_type=meta.get("mime") or "image/png")


@app.get("/api/attachments/{att_id}/original")
def get_attachment_original(
    att_id: str, relay_session: Optional[str] = Cookie(default=None)
):
    """Full-size image for a human to click through to.

    Falls back to the scaled copy instead of 404ing, so the UI can always point a
    click somewhere without first asking whether an original was kept.
    """
    _require_session(relay_session)
    meta = _attachment_meta(att_id)
    if meta is None:
        raise HTTPException(status_code=404, detail="No such attachment")
    if meta.get("has_original"):
        path = ATTACH_DIR / f"{att_id}.orig.{meta['orig_ext']}"
        if path.is_file():
            return FileResponse(path)
    return get_attachment(att_id, relay_session)


def _media_roots() -> list[Path]:
    """Directories the console may serve files from, and nothing else.

    Set RELAY_MEDIA_ROOTS to a list separated by the platform path separator
    (";" on Windows, ":" elsewhere). The relay's own directory is always
    included, because that is where attachments live. Anything outside these
    roots is refused -- the containment check in get_local_media compares
    resolved paths rather than string prefixes, so a sibling directory whose
    name merely starts the same way cannot be reached.
    """
    roots = [RELAY_DIR.resolve()]
    for entry in os.environ.get("RELAY_MEDIA_ROOTS", "").split(os.pathsep):
        entry = entry.strip()
        if entry:
            try:
                roots.append(Path(entry).expanduser().resolve())
            except OSError:
                pass
    return roots


ALLOWED_MEDIA_ROOTS = _media_roots()

#: Relative paths handed to /api/local_media resolve against the first
#: configured root rather than against the process's working directory.
MEDIA_BASE = (ALLOWED_MEDIA_ROOTS[1] if len(ALLOWED_MEDIA_ROOTS) > 1
              else ALLOWED_MEDIA_ROOTS[0])

MEDIA_EXT_TO_TYPE = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}

@app.get("/api/local_media")
def get_local_media(path: str, relay_session: Optional[str] = Cookie(default=None)):
    _require_session(relay_session)
    try:
        p = Path(path)
        if not p.is_absolute():
            p = (MEDIA_BASE / p).resolve()
        else:
            p = p.resolve()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid path")
    if not p.is_file():
        raise HTTPException(status_code=404, detail="Media file not found")
    media_type = MEDIA_EXT_TO_TYPE.get(p.suffix.lower())
    if media_type is None:
        raise HTTPException(status_code=403, detail="Forbidden media format")
    if not any(p.is_relative_to(root) for root in ALLOWED_MEDIA_ROOTS):
        raise HTTPException(status_code=403, detail="Access denied outside allowed directories")
    return FileResponse(p, media_type=media_type)


AVATAR_DIR = RELAY_DIR / "avatars"
AVATAR_DIR.mkdir(parents=True, exist_ok=True)
REPO_AVATAR_DIR = Path(__file__).resolve().parent / "avatars"


@app.get("/api/avatar/{who}")
def get_avatar(who: str):
    who = who.lower().strip()
    if who not in ("user", "claude", "antigravity"):
        raise HTTPException(status_code=400, detail="Invalid avatar identifier")

    for ext in ("png", "jpg", "jpeg", "webp"):
        p = AVATAR_DIR / f"{who}.{ext}"
        if p.is_file():
            return FileResponse(p, headers={"Cache-Control": "no-cache, must-revalidate"})

    svg_path = AVATAR_DIR / f"{who}.svg"
    if svg_path.is_file():
        return FileResponse(svg_path, media_type="image/svg+xml", headers={"Cache-Control": "no-cache, must-revalidate"})

    repo_svg = REPO_AVATAR_DIR / f"{who}.svg"
    if repo_svg.is_file():
        return FileResponse(repo_svg, media_type="image/svg+xml", headers={"Cache-Control": "no-cache, must-revalidate"})

    raise HTTPException(status_code=404, detail="Avatar not found")


@app.post("/api/avatar/upload")
async def upload_avatar(
    file: UploadFile = File(...),
    relay_session: Optional[str] = Cookie(default=None),
):
    _require_session(relay_session)
    ctype = (file.content_type or "").lower()
    if ctype not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=415, detail="Unsupported image format")

    data = await file.read()
    if not data or len(data) > 5 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Avatar image must be under 5MB")

    dest = AVATAR_DIR / "user.png"
    _atomic_write_bytes(dest, data)
    return {"ok": True, "url": f"/api/avatar/user?t={int(time.time())}"}


@app.post("/api/send")
def send_message(
    req: SendMessageRequest, relay_session: Optional[str] = Cookie(default=None)
):
    _require_session(relay_session)

    text = req.text.strip()

    attachments = []
    for att_id in (req.attachments or [])[:MAX_ATTACHMENTS_PER_MESSAGE]:
        meta = _attachment_meta(att_id)
        if meta is None:
            raise HTTPException(
                status_code=400, detail=f"Unknown attachment: {att_id}"
            )
        attachments.append(
            {
                "id": meta["id"],
                "mime": meta["mime"],
                "w": meta.get("w", 0),
                "h": meta.get("h", 0),
                "name": meta.get("name", "image"),
                "has_original": meta.get("has_original", False),
            }
        )

    # An image on its own is a complete message; only neither is empty.
    if not text and not attachments:
        raise HTTPException(status_code=400, detail="Message cannot be empty")

    RELAY_DIR.mkdir(parents=True, exist_ok=True)
    msg = {
        "id": uuid.uuid4().hex[:12],
        "ts": time.time(),
        "from": "user",
        "to": req.to or "all",
        "thread": req.thread or uuid.uuid4().hex[:8],
        "text": text,
    }
    msg["sig"] = auth.sign(msg, SIGNING_KEY)
    # Attached after signing on purpose. The canonical payload is a fixed set of
    # six fields agreed with every agent on the bus, and widening it here would
    # break verification on the other side. So attachments carry no proof of
    # origin: consumers must not present them as verified human content.
    if attachments:
        msg["attachments"] = attachments

    with LOG_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(msg, ensure_ascii=False) + chr(10))

    return {"success": True, "message": msg}


def main() -> None:
    """Run the console. Bound to 127.0.0.1 unless RELAY_UI_HOST says otherwise.

    Binding anywhere else exposes the console to the network, and its
    authentication is built for a machine you control: a pairing code, a
    session cookie, signed messages. Reach it from elsewhere over a private
    tunnel rather than by opening a port.
    """
    import uvicorn
    print("=" * 68)
    print(f"  Agent Relay UI  ->  http://{UI_HOST}:{UI_PORT}")
    print(f"  Login token: {LOGIN_TOKEN}")
    print(f"  (also stored in {auth.TOKEN_FILE})")
    if UI_HOST not in ("127.0.0.1", "localhost", "::1"):
        print(f"  WARNING: bound to {UI_HOST}, reachable from the network.")
    print("=" * 68)
    uvicorn.run(app, host=UI_HOST, port=UI_PORT, log_level="info")


if __name__ == "__main__":
    main()
