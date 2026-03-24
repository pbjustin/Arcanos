"""
CLI audit logging utilities.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


def record(event_name: str, **fields: Any) -> None:
    """
    Purpose: Emit a structured audit event for CLI governance decisions.
    Inputs/Outputs: event_name plus arbitrary key/value fields; writes one serialized line to stdout.
    Edge cases: Accepts empty fields and still emits a valid event envelope.
    """
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "event": event_name,
        **fields,
    }
    # //audit assumption: stdout is the lowest-common-denominator audit sink; failure risk: missing file logger in constrained environments; expected invariant: event envelope is always emitted; handling strategy: print structured payload directly.
    print(f"[AUDIT] {entry}")

