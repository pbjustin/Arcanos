"""
CLI audit logging utilities.
"""

from __future__ import annotations

from datetime import datetime, timezone
import json
from typing import Any

from .cli_policy import redact_output
from ..voice_boundary import sanitize_tool_output


def _redact_fields(value: Any) -> Any:
    if isinstance(value, str):
        return sanitize_tool_output(value)
    if isinstance(value, dict):
        return {str(_redact_fields(key)): _redact_fields(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_redact_fields(item) for item in value]
    return value


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
    serialized = json.dumps(_redact_fields(entry), ensure_ascii=False, default=str)
    print(f"[AUDIT] {redact_output(serialized, apply_truncation=False)}")

