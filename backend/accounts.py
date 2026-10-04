"""Accounts for the studio: a username, a password, and a long-lived token.

Before this, identity was a random UUID that localStorage happened to keep
(`ai_cinema_user_id`), so "my projects" meant "projects made in this browser
profile" and cleared cache meant a new person. An account makes that identity
something the user can state and carry between browsers.

Registration is open on purpose -- this runs on the owner's own machine and on the
LAN/Tailscale addresses he opens it from, so the point is naming yourself, not
keeping anyone out. Passwords are still stored as PBKDF2 hashes rather than
plaintext, because people reuse passwords even on a toy login.

Tokens live a year so the browser does not ask again; logging out deletes the
one token it holds and leaves other devices signed in.

Note on scope: this module identifies the caller, it does not guard the API.
The generation endpoints stay open because the canvas MCP server and the
tools/*.py scripts call them with no token at all; putting a gate on them would
break the production line, and that is a separate decision from having accounts.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
import uuid
from pathlib import Path
from typing import Optional

_BACKEND_DIR = Path(__file__).parent
ACCOUNTS_FILE = _BACKEND_DIR / "workspaces" / "accounts.json"

PBKDF2_ITERATIONS = 200_000
SESSION_TTL = int(os.environ.get("AI_CINEMA_SESSION_TTL", 365 * 24 * 3600))

USERNAME_RE = re.compile(r"^[A-Za-z0-9_.\-一-鿿]{2,32}$")
MIN_PASSWORD = 4

# One process, several worker threads touching one file: without this two
# near-simultaneous registrations read the same store and the second write wins,
# silently dropping the first account.
_lock = threading.RLock()


class AuthError(Exception):
    """Something the caller did wrong; the message is shown to them verbatim."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


# ── Store ─────────────────────────────────────────────────────────────────────

def _empty_store() -> dict:
    return {"users": {}, "sessions": {}}


def _load() -> dict:
    try:
        with ACCOUNTS_FILE.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return _empty_store()
    if not isinstance(data, dict):
        return _empty_store()
    data.setdefault("users", {})
    data.setdefault("sessions", {})
    return data


def _save(store: dict) -> None:
    """Write via a temp file and os.replace -- a truncated accounts.json would
    log every account out and lose their passwords."""
    ACCOUNTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = ACCOUNTS_FILE.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(store, fh, ensure_ascii=False, indent=2)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, ACCOUNTS_FILE)


def _prune_sessions(store: dict) -> None:
    now = time.time()
    store["sessions"] = {
        token: s for token, s in store["sessions"].items()
        if isinstance(s, dict) and s.get("expires", 0) > now
    }


# ── Passwords ─────────────────────────────────────────────────────────────────

def _hash_password(password: str, salt: str, iterations: int = PBKDF2_ITERATIONS) -> str:
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt), iterations
    ).hex()


def _verify_password(password: str, record: dict) -> bool:
    try:
        expected = record["hash"]
        candidate = _hash_password(password, record["salt"], int(record.get("iterations", PBKDF2_ITERATIONS)))
    except (KeyError, ValueError):
        return False
    return hmac.compare_digest(expected, candidate)


# ── Public API ────────────────────────────────────────────────────────────────

def _public(record: dict) -> dict:
    return {
        "id": record["id"],
        "username": record["username"],
        "created": record.get("created"),
        "is_admin": bool(record.get("is_admin")),
    }


def _issue_token(store: dict, user_id: str) -> tuple[str, float]:
    token = secrets.token_urlsafe(32)
    expires = time.time() + SESSION_TTL
    store["sessions"][token] = {"user_id": user_id, "created": time.time(), "expires": expires}
    return token, expires


def is_admin(user_id: Optional[str]) -> bool:
    """Whether this account administers the studio.

    One thing hangs off it today: the asset library's unattributable files --
    everything on disk from before the origin ledger, plus anything dropped in
    by hand. Those belong to no project, so no ordinary account can be shown
    them without showing one person's renders to another; but somebody has to
    be able to clean them up, and that is the admin.
    """
    if not user_id:
        return False
    with _lock:
        store = _load()
        for record in store["users"].values():
            if record.get("id") == user_id:
                return bool(record.get("is_admin"))
    return False


def user_id_for(username: str) -> Optional[str]:
    """The id of the account with this username, or None."""
    with _lock:
        record = _load()["users"].get((username or "").strip().lower())
    return record.get("id") if record else None


def set_admin(username: str, admin: bool = True) -> dict:
    """Grant or revoke admin. There is no endpoint for this on purpose: it is
    done on the machine that holds the accounts file, not over the network."""
    with _lock:
        store = _load()
        record = store["users"].get((username or "").strip().lower())
        if not record:
            raise AuthError(f"没有这个账号：{username}", status=404)
        record["is_admin"] = bool(admin)
        _save(store)
        return _public(record)


def register(username: str, password: str) -> dict:
    """Create an account and sign it in. Anyone may; the name must be free."""
    username = (username or "").strip()
    password = password or ""
    if not USERNAME_RE.match(username):
        raise AuthError("用户名需为 2-32 个字符，仅限中英文、数字、下划线、点和短横线")
    if len(password) < MIN_PASSWORD:
        raise AuthError(f"密码至少 {MIN_PASSWORD} 位")

    with _lock:
        store = _load()
        key = username.lower()
        if key in store["users"]:
            raise AuthError("该用户名已被使用", status=409)
        salt = secrets.token_bytes(16).hex()
        record = {
            "id": f"user_{uuid.uuid4().hex[:12]}",
            "username": username,
            "salt": salt,
            "hash": _hash_password(password, salt),
            "iterations": PBKDF2_ITERATIONS,
            "created": time.time(),
        }
        store["users"][key] = record
        _prune_sessions(store)
        token, expires = _issue_token(store, record["id"])
        _save(store)
    return {"token": token, "expires": expires, "user": _public(record)}


def login(username: str, password: str) -> dict:
    username = (username or "").strip()
    with _lock:
        store = _load()
        record = store["users"].get(username.lower())
        # Same message either way: which half was wrong is not the caller's business.
        if not record or not _verify_password(password or "", record):
            raise AuthError("用户名或密码不正确", status=401)
        _prune_sessions(store)
        token, expires = _issue_token(store, record["id"])
        _save(store)
    return {"token": token, "expires": expires, "user": _public(record)}


def login_without_password(username: str) -> dict:
    """A session for `username` with no password check.

    Only for the passwordless test account; main.auth_test_login decides who
    may call it (this machine, not forwarded, one configured name).
    """
    username = (username or "").strip()
    with _lock:
        store = _load()
        record = store["users"].get(username.lower())
        if not record:
            raise AuthError("账号不存在", status=404)
        if record.get("is_admin"):
            raise AuthError("管理员账号不能免密登录", status=403)
        _prune_sessions(store)
        token, expires = _issue_token(store, record["id"])
        _save(store)
    return {"token": token, "expires": expires, "user": _public(record)}


def resolve(token: Optional[str]) -> Optional[dict]:
    """The account behind a token, or None if it is unknown or expired."""
    if not token:
        return None
    with _lock:
        store = _load()
        session = store["sessions"].get(token)
        if not isinstance(session, dict) or session.get("expires", 0) <= time.time():
            return None
        for record in store["users"].values():
            if record.get("id") == session.get("user_id"):
                return _public(record)
    return None


def logout(token: Optional[str]) -> bool:
    """Drop one token. Other devices keep their own."""
    if not token:
        return False
    with _lock:
        store = _load()
        if token not in store["sessions"]:
            return False
        del store["sessions"][token]
        _prune_sessions(store)
        _save(store)
    return True


def change_password(token: Optional[str], old_password: str, new_password: str) -> None:
    """Change the password and drop every other session of that account."""
    if len(new_password or "") < MIN_PASSWORD:
        raise AuthError(f"新密码至少 {MIN_PASSWORD} 位")
    with _lock:
        store = _load()
        session = store["sessions"].get(token or "")
        if not isinstance(session, dict) or session.get("expires", 0) <= time.time():
            raise AuthError("尚未登录", status=401)
        user_id = session["user_id"]
        record = next((r for r in store["users"].values() if r.get("id") == user_id), None)
        if not record or not _verify_password(old_password or "", record):
            raise AuthError("原密码不正确", status=401)
        salt = secrets.token_bytes(16).hex()
        record["salt"] = salt
        record["hash"] = _hash_password(new_password, salt)
        record["iterations"] = PBKDF2_ITERATIONS
        store["sessions"] = {
            t: s for t, s in store["sessions"].items()
            if t == token or s.get("user_id") != user_id
        }
        _prune_sessions(store)
        _save(store)
