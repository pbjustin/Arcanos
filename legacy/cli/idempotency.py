import hashlib
import json
import time

# Default window: reject duplicate fingerprints within 2 seconds
DEFAULT_DEDUP_WINDOW_S = 2.0


def command_fingerprint(command: str, payload: dict) -> str:
    raw = json.dumps({"command": command, "payload": payload}, sort_keys=True)
    return hashlib.sha256(raw.encode()).hexdigest()


class IdempotencyGuard:
    """Session-scoped duplicate fingerprint rejection within a time window."""

    def __init__(self, window_seconds: float = DEFAULT_DEDUP_WINDOW_S):
        self._seen: dict[str, float] = {}
        self._window = window_seconds

    def check_and_record(self, fingerprint: str) -> bool:
        """Return True if fingerprint is new (allowed). False if duplicate within window."""
        now = time.monotonic()
        self._purge_expired(now)
        if fingerprint in self._seen:
            return False
        self._seen[fingerprint] = now
        return True

    def _purge_expired(self, now: float) -> None:
        """Remove fingerprints older than the dedup window."""
        expired = [fp for fp, ts in self._seen.items() if now - ts > self._window]
        for fp in expired:
            del self._seen[fp]

    def reset(self):
        self._seen.clear()
