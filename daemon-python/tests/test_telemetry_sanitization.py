"""Telemetry and debug logging sanitization tests."""

from __future__ import annotations

import logging
import json
from types import SimpleNamespace

import pytest

from arcanos.debug.logging import JsonLogFormatter
from arcanos.utils.telemetry import sanitize_sensitive_data


JOB_READ_CAPABILITY = "v1." + "a" * 42 + "_"


@pytest.mark.parametrize("escaped", [False, True])
@pytest.mark.parametrize("last_character", ["_", "-"])
def test_telemetry_string_values_redact_job_capabilities_without_losing_diagnostics(escaped, last_character):
    from arcanos.telemetry import _sanitize_payload

    raw_capability = "v1." + "a" * 42 + last_character
    capability = raw_capability
    if escaped:
        capability = capability.replace("v1.", r"v\u0031.")
    message = f"Job lookup failed\n{raw_capability}; HTTP 500 job=synthetic-job; version v1.0.0"
    if escaped:
        message = json.dumps(message).replace(raw_capability, capability)
    payload = {"error": message, "nested": [{"detail": message}], "values": (message,)}

    for sanitize in (sanitize_sensitive_data, _sanitize_payload):
        result = sanitize(payload)
        assert result["error"] == message.replace(capability, "[REDACTED]")
        assert result["nested"][0]["detail"] == result["error"]
        assert result["values"][0] == result["error"]


def test_railway_message_and_telemetry_event_withhold_standalone_capability(monkeypatch, capsys):
    from arcanos.utils import telemetry

    message = f"Job lookup failed for {JOB_READ_CAPABILITY}; HTTP 500 job=synthetic-job"
    events = []
    monkeypatch.setattr(telemetry, "get_env", lambda key: "production" if key == "NODE_ENV" else None)
    monkeypatch.setattr(telemetry, "get_telemetry", lambda: SimpleNamespace(
        enabled=True, track_event=lambda name, properties: events.append((name, properties))
    ))

    telemetry.log_railway("error", message, {"status": 500})

    entry = json.loads(capsys.readouterr().out)
    expected = message.replace(JOB_READ_CAPABILITY, "[REDACTED]")
    assert entry["message"] == expected and entry["status"] == 500
    assert events[0][1]["message"] == expected


def test_actual_telemetry_file_and_exception_filter_redact_capabilities(monkeypatch, tmp_path):
    from arcanos import telemetry

    # Configuration tests reload Config; patch the reference bound by this consumer.
    monkeypatch.setattr(telemetry.Config, "TELEMETRY_DIR", tmp_path)
    monkeypatch.setattr(telemetry, "SENTRY_AVAILABLE", False)
    instance = telemetry.Telemetry.__new__(telemetry.Telemetry)
    instance.enabled, instance.session_id, instance.user_id = True, "synthetic-session", "synthetic-user"
    message = f"Job failed for {JOB_READ_CAPABILITY}; HTTP 500; v1.0.0"

    instance.track_event("synthetic_failure", {"error": message, "details": {JOB_READ_CAPABILITY: "HTTP 500"}})
    written = (tmp_path / "events.log").read_text(encoding="utf-8")
    filtered = instance._filter_event({"exception": {"values": [{"value": message}]}}, {})

    assert JOB_READ_CAPABILITY not in written
    assert "Job failed for [REDACTED]; HTTP 500; v1.0.0" in written
    assert filtered["exception"]["values"][0]["value"] == message.replace(JOB_READ_CAPABILITY, "[REDACTED]")


def test_track_event_redacts_exception_property_without_mutating_internal_error(monkeypatch, tmp_path):
    from arcanos import telemetry

    monkeypatch.setattr(telemetry.Config, "TELEMETRY_DIR", tmp_path)
    monkeypatch.setattr(telemetry, "SENTRY_AVAILABLE", False)
    instance = telemetry.Telemetry.__new__(telemetry.Telemetry)
    instance.enabled, instance.session_id, instance.user_id = True, "synthetic-session", "synthetic-user"
    error = RuntimeError(f"lookup {JOB_READ_CAPABILITY}; HTTP 500")
    instance.track_event("synthetic_failure", {
        "error": error, "status": 500, "retryable": False, "version": "v1.0.0",
    })

    written = (tmp_path / "events.log").read_text(encoding="utf-8")
    assert JOB_READ_CAPABILITY not in written
    assert "RuntimeError" in written and "HTTP 500" in written and "v1.0.0" in written
    assert str(error) == f"lookup {JOB_READ_CAPABILITY}; HTTP 500"


def test_sanitizers_render_opaque_keys_values_and_str_subclasses_safely():
    from arcanos.telemetry import _sanitize_payload

    class Diagnostic:
        def __repr__(self):
            return f"Diagnostic(lookup {JOB_READ_CAPABILITY}; HTTP 500)"

    class Unrepresentable:
        def __repr__(self):
            raise RuntimeError(f"cannot render {JOB_READ_CAPABILITY}")

    class DiagnosticText(str):
        def __repr__(self):
            return f"DiagnosticText({JOB_READ_CAPABILITY})"

    payload = {
        "status": 500, "elapsed": 1.5, "retryable": False, "optional": None,
        "text": DiagnosticText("version v1.0.0"), "opaque": Diagnostic(),
        "unrepresentable": Unrepresentable(), Diagnostic(): "HTTP 500",
        DiagnosticText("public-key"): "public value", Unrepresentable(): "unavailable key",
    }
    for sanitize in (sanitize_sensitive_data, _sanitize_payload):
        result = sanitize(payload)
        assert JOB_READ_CAPABILITY not in json.dumps(result)
        assert result["status"] == 500 and type(result["status"]) is int
        assert result["elapsed"] == 1.5 and type(result["elapsed"]) is float
        assert result["retryable"] is False and result["optional"] is None
        assert result["text"] == "version v1.0.0" and type(result["text"]) is str
        assert any(type(key) is str and key == "public-key" for key in result)
        assert result["unrepresentable"] == "<unrepresentable>"
        assert "Diagnostic(lookup [REDACTED]; HTTP 500)" in result


def test_actual_sentry_breadcrumb_uses_sanitized_event_name(monkeypatch, tmp_path):
    from arcanos import telemetry

    events = []
    monkeypatch.setattr(telemetry.Config, "TELEMETRY_DIR", tmp_path)
    monkeypatch.setattr(telemetry, "SENTRY_AVAILABLE", True)
    monkeypatch.setattr(telemetry, "sentry_sdk", SimpleNamespace(add_breadcrumb=lambda **event: events.append(event)))
    instance = telemetry.Telemetry.__new__(telemetry.Telemetry)
    instance.enabled, instance.session_id, instance.user_id = True, "synthetic-session", "synthetic-user"

    instance.track_event(f"lookup.{JOB_READ_CAPABILITY}", {"status": 500})

    assert len(events) == 1
    assert events[0]["category"] == "lookup.[REDACTED]"
    assert events[0]["message"] == "Event: lookup.[REDACTED]"


def test_sentry_initialization_error_keeps_diagnostic_without_capability(monkeypatch, capsys):
    from arcanos import telemetry

    def fail_initialization(**kwargs):
        raise RuntimeError(f"Synthetic initialization failed for {JOB_READ_CAPABILITY}; status=500")

    monkeypatch.setattr(telemetry, "sentry_sdk", SimpleNamespace(init=fail_initialization))
    instance = telemetry.Telemetry.__new__(telemetry.Telemetry)
    instance.enabled = True
    instance._init_sentry()

    shown = capsys.readouterr().out
    assert JOB_READ_CAPABILITY not in shown
    assert "Synthetic initialization failed for [REDACTED]; status=500" in shown
    assert not instance.enabled


def test_sanitize_sensitive_data_redacts_key_and_value_patterns():
    """sanitize_sensitive_data should redact sensitive keys and token-like values."""

    payload = {
        "openai_api_key": "sk-" + "1234567890abcdefghijklmnop",
        "note": "Bearer " + "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fake.token",
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
    record.path = "/debug/status?token=" + "sk-" + "abcdefghijklmnopqrstuvwxyz"
    record.request_id = "req_1"

    formatted = formatter.format(record)

    assert "sk-" + "abcdefghijklmnopqrstuvwxyz" not in formatted
    assert "[REDACTED]" in formatted
