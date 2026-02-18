"""
Idempotency helpers for CLI command execution.
"""

from __future__ import annotations

import hashlib
import json
import time
from typing import Any, Dict

DEFAULT_DEDUP_WINDOW_S = 2.0


def command_fingerprint(command_name: str, payload: Dict[str, Any]) -> str:
    """
    Purpose: Build a stable fingerprint for command deduplication.
    Inputs/Outputs: command name + payload dictionary; returns SHA-256 hash string.
    Edge cases: Produces stable output for dictionary key-order differences via sorted serialization.
    """
    serialized = json.dumps({"command": command_name, "payload": payload}, sort_keys=True)
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


class IdempotencyGuard:
    """
    Purpose: Reject duplicate command fingerprints within a short time window.
    Inputs/Outputs: accepts fingerprints and returns allow/deny decisions.
    Edge cases: Automatically purges expired fingerprints to prevent unbounded growth.
    """

    def __init__(self, window_seconds: float = DEFAULT_DEDUP_WINDOW_S):
        """
        Purpose: Initialize deduplication state.
        Inputs/Outputs: deduplication window seconds; initializes in-memory cache.
        Edge cases: Small windows still preserve exact-duplicate suppression during rapid retries.
        """
        self._seen_fingerprints: Dict[str, float] = {}
        self._window_seconds = window_seconds

    def check_and_record(self, fingerprint: str) -> bool:
        """
        Purpose: Validate and store a fingerprint if it is not a recent duplicate.
        Inputs/Outputs: fingerprint string; returns True when allowed, False when duplicate.
        Edge cases: Purges stale fingerprints before checking to avoid false duplicate denials.
        """
        now_monotonic = time.monotonic()
        self._purge_expired(now_monotonic)
        # //audit assumption: repeated fingerprint within active window indicates duplicate intent; failure risk: accidental replay execution; expected invariant: second execution denied during window; handling strategy: return False without mutating state.
        if fingerprint in self._seen_fingerprints:
            return False

        self._seen_fingerprints[fingerprint] = now_monotonic
        return True

    def _purge_expired(self, now_monotonic: float) -> None:
        """
        Purpose: Remove fingerprints that are older than the dedup window.
        Inputs/Outputs: current monotonic timestamp; mutates in-memory cache.
        Edge cases: No-op when cache is empty.
        """
        expired_fingerprints = [
            fingerprint
            for fingerprint, observed_at in self._seen_fingerprints.items()
            if now_monotonic - observed_at > self._window_seconds
        ]
        for fingerprint in expired_fingerprints:
            del self._seen_fingerprints[fingerprint]

    def reset(self) -> None:
        """
        Purpose: Clear all tracked fingerprints.
        Inputs/Outputs: no inputs; empties in-memory dedup cache.
        Edge cases: Safe to call repeatedly.
        """
        self._seen_fingerprints.clear()

