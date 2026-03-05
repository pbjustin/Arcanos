"""Tests for debug JSON log formatter behavior."""

from __future__ import annotations

import json
import logging

from arcanos.debug.logging import JsonLogFormatter


def test_json_log_formatter_preserves_custom_extra_fields() -> None:
    """Formatter should include non-standard LogRecord extras for telemetry queries."""

    formatter = JsonLogFormatter()
    record = logging.LogRecord(
        name="arcanos.debug_server",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg="audit.backend_chat_failure_telemetry",
        args=(),
        exc_info=None,
    )
    record.retry_outcome = "retry_failed"
    record.primary_payload_mode = "chat_completion:no_domain:metadata"
    record.primary_error_code = "AI_FAILURE"

    formatted = formatter.format(record)
    payload = json.loads(formatted)

    assert payload["retry_outcome"] == "retry_failed"
    assert payload["primary_payload_mode"] == "chat_completion:no_domain:metadata"
    assert payload["primary_error_code"] == "AI_FAILURE"
