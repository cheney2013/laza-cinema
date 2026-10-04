"""Authentication and message signing for the relay UI.

Only a logged-in human may post to the bus, and their messages carry an Ed25519
signature. The signature matters because messages.jsonl is a shared append-only
file that every agent can write to: a plain "verified": true field, or an HMAC
whose key the agents would need in order to check it, could both be forged by
any agent. Only this server holds the private key, so a signed from="user"
message cannot be manufactured by an agent or by a web page.
"""

from __future__ import annotations

import json
import os
import secrets
import time
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

RELAY_DIR = Path(os.environ.get("RELAY_DIR", Path.home() / ".agent-relay"))
KEY_FILE = RELAY_DIR / "ui_signing_key"      # private, never leaves this process
PUBKEY_FILE = RELAY_DIR / "ui_pubkey.hex"    # public, agents read this to verify
TOKEN_FILE = RELAY_DIR / "ui_token.txt"      # login token for the human

SESSION_TTL = int(os.environ.get("RELAY_SESSION_TTL", 4 * 3600))
AUDIT_LOG = RELAY_DIR / "audit.log"

# Login throttling. A session here can post as the verified operator, and agents
# act on that as a human instruction, so guessing the token is worth an
# attacker's time in a way that guessing a normal app password is not.
MAX_FAILURES = 5
LOCKOUT_SECONDS = 900

_sessions: dict[str, float] = {}
_failures: dict[str, list[float]] = {}


def audit(event: str, **fields: object) -> None:
    """Append one line about something worth being able to reconstruct later."""
    try:
        RELAY_DIR.mkdir(parents=True, exist_ok=True)
        record = {"ts": time.time(), "at": time.strftime("%Y-%m-%d %H:%M:%S"), "event": event}
        record.update({k: v for k, v in fields.items()})
        with AUDIT_LOG.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + chr(10))
    except OSError:
        pass


def locked_out(client: str) -> float:
    """Seconds remaining before this client may try a token again."""
    recent = [t for t in _failures.get(client, []) if time.time() - t < LOCKOUT_SECONDS]
    _failures[client] = recent
    if len(recent) < MAX_FAILURES:
        return 0.0
    return LOCKOUT_SECONDS - (time.time() - recent[-MAX_FAILURES])


def record_failure(client: str) -> None:
    _failures.setdefault(client, []).append(time.time())


def clear_failures(client: str) -> None:
    _failures.pop(client, None)


def rotate_token() -> str:
    """Issue a new login token and drop every session opened with the old one."""
    token = secrets.token_urlsafe(24)
    TOKEN_FILE.write_text(token, encoding="utf-8")
    _restrict(TOKEN_FILE)
    _sessions.clear()
    audit("token_rotated")
    return token


def _restrict(path: Path) -> None:
    """Make a secret file owner-only where the platform supports it."""
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def load_signing_key() -> Ed25519PrivateKey:
    RELAY_DIR.mkdir(parents=True, exist_ok=True)
    if KEY_FILE.exists():
        return serialization.load_pem_private_key(KEY_FILE.read_bytes(), password=None)

    key = Ed25519PrivateKey.generate()
    KEY_FILE.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    _restrict(KEY_FILE)
    PUBKEY_FILE.write_text(public_key_hex(key), encoding="utf-8")
    return key


def public_key_hex(key: Ed25519PrivateKey) -> str:
    return key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    ).hex()


def load_or_create_token() -> str:
    """The login token. Generated once; the human reads it from the console."""
    RELAY_DIR.mkdir(parents=True, exist_ok=True)
    if TOKEN_FILE.exists():
        existing = TOKEN_FILE.read_text(encoding="utf-8").strip()
        if existing:
            return existing
    token = secrets.token_urlsafe(24)
    TOKEN_FILE.write_text(token, encoding="utf-8")
    _restrict(TOKEN_FILE)
    return token


def canonical_payload(msg: dict) -> bytes:
    """The exact bytes that get signed. Field order must never vary."""
    return json.dumps(
        {k: msg[k] for k in ("id", "ts", "from", "to", "thread", "text")},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")


def sign(msg: dict, key: Ed25519PrivateKey) -> str:
    return key.sign(canonical_payload(msg)).hex()


def verify(msg: dict, pubkey_hex: str) -> bool:
    sig = msg.get("sig")
    if not sig:
        return False
    try:
        pub = Ed25519PublicKey.from_public_bytes(bytes.fromhex(pubkey_hex))
        pub.verify(bytes.fromhex(sig), canonical_payload(msg))
        return True
    except Exception:
        return False


# One-time codes for handing a session to a phone. Typing a 32-character token
# on a touch keyboard is bad enough on its own, and a few mistyped attempts would
# trip the lockout meant for attackers.
OTT_TTL = 60.0
_one_time: dict[str, float] = {}


def issue_one_time() -> str:
    """A code that logs in exactly once, within the next minute."""
    now = time.time()
    for code, expiry in list(_one_time.items()):
        if expiry < now:
            del _one_time[code]
    code = secrets.token_urlsafe(32)
    _one_time[code] = now + OTT_TTL
    audit("ott_issued")
    return code


def redeem_one_time(code: str) -> bool:
    """Spend a code. Popping before checking means a replay finds nothing."""
    expiry = _one_time.pop(code, None)
    if expiry is None:
        audit("ott_rejected", reason="unknown or already used")
        return False
    if expiry < time.time():
        audit("ott_rejected", reason="expired")
        return False
    audit("ott_redeemed")
    return True


def open_session() -> str:
    sid = secrets.token_urlsafe(32)
    _sessions[sid] = time.time() + SESSION_TTL
    return sid


def session_valid(sid: str | None) -> bool:
    if not sid:
        return False
    expiry = _sessions.get(sid)
    if expiry is None:
        return False
    if expiry < time.time():
        _sessions.pop(sid, None)
        return False
    return True


def close_session(sid: str | None) -> None:
    if sid:
        _sessions.pop(sid, None)
