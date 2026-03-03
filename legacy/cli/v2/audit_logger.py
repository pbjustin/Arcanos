"""
v2 Trust Verification — Hash-Chained Audit Logger

Every audit event is chained to the previous via SHA-256 for tamper evidence.
Thread-safe via threading.Lock. Timestamp is computed inside the lock to
ensure hash-chain ordering matches temporal ordering.
"""

import hashlib
import json
import logging
import threading
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger("arcanos.v2.audit")

_lock = threading.RLock()  # reentrant to allow nested calls (though discouraged)
_previous_hash: str | None = None


def _deep_sort_keys(obj: Any) -> Any:
    """Recursively sort dictionary keys for deterministic hashing."""
    if obj is None or not isinstance(obj, (dict, list)):
        return obj
    if isinstance(obj, list):
        return [_deep_sort_keys(item) for item in obj]
    return {k: _deep_sort_keys(v) for k, v in sorted(obj.items())}


def log_event(event: dict[str, Any]) -> str:
    """
    Log an audit event with hash-chain integrity.
    Returns the computed chain hash.
    """
    global _previous_hash

    with _lock:
        # Timestamp inside the lock ensures ordering consistency
        timestamp = datetime.now(timezone.utc).isoformat()
        payload = {**event, "timestamp": timestamp}
        sorted_payload = _deep_sort_keys(payload)
        event_json = json.dumps(sorted_payload, default=str)

        hash_input = (_previous_hash or "") + event_json
        current_hash = hashlib.sha256(hash_input.encode("utf-8")).hexdigest()

        entry = {
            "event": payload,
            "chain_hash": current_hash,
            "prev_hash": _previous_hash,
        }

        logger.info(json.dumps(entry))
        _previous_hash = current_hash

    return current_hash


def reset_chain() -> None:
    """Reset the hash chain (for testing only)."""
    global _previous_hash
    with _lock:
        _previous_hash = None
