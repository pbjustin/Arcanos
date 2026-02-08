"""Telemetry and debug logging sanitization tests."""

from __future__ import annotations

import logging

from arcanos.debug.logging import JsonLogFormatter
from arcanos.utils.telemetry import sanitize_sensitive_data


def test_sanitize_sensitive_data_redacts_key_and_value_patterns():
    """sanitize_sensitive_data should redact sensitive keys and token-like values."""

    payload = {
        "openai_api_key": "sk-1234567890abcdefghijklmnop",
        "note": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fake.token",
        "nested": {"connection": "postgres://user:password@example.com/db"},
    }

    sanitized = sanitize_sensitive_data(payload)

    assert str(sanitized["openai_api_key"]).startswith("[REDACTED")
    assert sanitized["note"] == "[REDACTED]"
    assert sanitized["nested"]["connection"] == "[REDACTED]"


def test_json_log_formatter_redacts_sensitive_extras():
    """JsonLogFormatter should sanitize secret-like fields before serialization."""

    formatter = JsonLogFormatter()
    record = logging.LogRecord(
        name="arcanos.debug_server",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg="debug request",
        args=(),
        exc_info=None,
    )
    record.path = "/debug/status?token=sk-abcdefghijklmnopqrstuvwxyz"
    record.request_id = "req_1"

    formatted = formatter.format(record)

    assert "sk-abcdefghijklmnopqrstuvwxyz" not in formatted
    assert "[REDACTED]" in formatted
