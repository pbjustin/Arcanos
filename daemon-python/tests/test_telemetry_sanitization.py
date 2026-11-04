"""Telemetry and debug logging sanitization tests."""

from __future__ import annotations

import logging
import json
import ast
import base64
import io
import time
from types import SimpleNamespace

import pytest

from arcanos.debug.logging import JsonLogFormatter
from arcanos.utils.telemetry import sanitize_sensitive_data


JOB_READ_CAPABILITY = "v1." + "a" * 42 + "_"


@pytest.mark.parametrize("control", [
    "\u200b", "\u200d", "\u2060", "\u00ad", "\ufe0f", "\U000E0100",
], ids=["zero-width-space", "joiner", "word-joiner", "soft-hyphen", "variation-selector", "supplementary-selector"])
@pytest.mark.parametrize("sink", ["telemetry-file", "debug-json", "debug-text", "interactive-error"])
def test_default_ignorable_capability_is_private_in_actual_consumers(
    monkeypatch, tmp_path, control, sink,
):
    """Invisible decoration cannot reveal a recoverable credential at real sinks."""
    from arcanos import cli_runner, telemetry
    from rich.console import Console

    capability = "v1." + base64.urlsafe_b64encode(bytes(range(32))).decode().rstrip("=")
    decorated = capability[:15] + control + capability[15:]
    message = f"Lookup failed for {decorated}; HTTP 500; no task was completed."
    if sink == "telemetry-file":
        monkeypatch.setattr(telemetry.Config, "TELEMETRY_DIR", tmp_path)
        monkeypatch.setattr(telemetry, "SENTRY_AVAILABLE", False)
        instance = telemetry.Telemetry.__new__(telemetry.Telemetry)
        instance.enabled, instance.session_id, instance.user_id = True, "synthetic-session", "synthetic-user"
        instance.track_event("synthetic_failure", {"error": message, "status": 500})
        written = (tmp_path / "events.log").read_text(encoding="utf-8")
        shown = ast.literal_eval(written)["properties"]["error"]
    elif sink == "debug-json":
        output = io.StringIO()
        handler = logging.StreamHandler(output)
        handler.setFormatter(JsonLogFormatter())
        logger = logging.Logger("synthetic-ignorable-json")
        logger.addHandler(handler)
        logger.error("%s", message)
        shown = json.loads(output.getvalue())["message"]
    elif sink == "debug-text":
        path = tmp_path / "debug-mode.log"
        logger = cli_runner._build_debug_logger(path)
        try:
            logger.error("%s", message)
            for handler in logger.handlers:
                handler.flush()
            shown = path.read_text(encoding="utf-8")
        finally:
            for handler in list(logger.handlers):
                handler.close()
                logger.removeHandler(handler)
    else:
        def fail_conversation(*args):
            raise RuntimeError(message)

        output = io.StringIO()
        cli = SimpleNamespace(
            console=Console(file=output, width=1000, color_system=None),
            show_welcome=lambda: None, handle_ask=fail_conversation,
            _append_activity=lambda *args: None, _stop_daemon_service=lambda: None,
        )
        inputs = iter(["synthetic input", "exit"])
        monkeypatch.setattr(cli_runner, "install_completion", lambda: None)
        monkeypatch.setattr("builtins.input", lambda *args: next(inputs))
        monkeypatch.setattr(cli_runner.Config, "TELEMETRY_ENABLED", False)
        cli_runner.run_interactive_mode(cli)
        shown = output.getvalue()

    assert capability not in shown.replace(control, "")
    assert decorated not in shown
    assert "Lookup failed for [REDACTED]; HTTP 500; no task was completed." in shown


@pytest.mark.parametrize("control", ["\u200b", "\u200d", "\u2060", "\u00ad", "\ufe0f", "\U000E0100"])
def test_shared_capability_redaction_preserves_benign_unicode_and_identifier_boundaries(control):
    from arcanos.utils.text import redact_job_read_capabilities

    capability = "v1." + base64.urlsafe_b64encode(bytes(range(32))).decode().rstrip("=")
    decorated = capability[:15] + control + capability[15:]
    prose = f"Échec 🛡️ 👨‍👩‍👧; keep a{control}b unchanged. "
    message = prose + f"Lookup failed for {decorated}; HTTP 500."
    assert redact_job_read_capabilities(message) == prose + "Lookup failed for [REDACTED]; HTTP 500."
    for larger in ("prefix" + decorated, decorated + "suffix", capability + control + "x"):
        assert redact_job_read_capabilities(prose + larger) == prose + larger
    encoded = json.dumps({"error": message}, ensure_ascii=True)
    assert json.loads(redact_job_read_capabilities(encoded))["error"] == prose + "Lookup failed for [REDACTED]; HTTP 500."


@pytest.mark.parametrize("control", ["\u200b", "\u200d", "\u2060", "\u00ad", "\ufe0f", "\U000E0100"])
@pytest.mark.parametrize("sink", ["utility", "telemetry-file", "debug-extra"])
def test_exception_objects_cannot_hide_decorated_capabilities_in_repr(
    monkeypatch, tmp_path, control, sink,
):
    """Supported exception values stay private after repr escapes their Unicode."""
    from arcanos import telemetry

    capability = "v1." + base64.urlsafe_b64encode(bytes(range(32))).decode().rstrip("=")
    decorated = capability[:15] + control + capability[15:]
    message = f"Lookup failed for {decorated}; HTTP 500; no task was completed."
    error = RuntimeError(message)
    if sink == "utility":
        shown = sanitize_sensitive_data({"error": error})["error"]
    elif sink == "telemetry-file":
        monkeypatch.setattr(telemetry.Config, "TELEMETRY_DIR", tmp_path)
        monkeypatch.setattr(telemetry, "SENTRY_AVAILABLE", False)
        instance = telemetry.Telemetry.__new__(telemetry.Telemetry)
        instance.enabled, instance.session_id, instance.user_id = True, "synthetic-session", "synthetic-user"
        instance.track_event("synthetic_failure", {"error": error})
        shown = ast.literal_eval((tmp_path / "events.log").read_text(encoding="utf-8"))["properties"]["error"]
    else:
        output = io.StringIO()
        handler = logging.StreamHandler(output)
        handler.setFormatter(JsonLogFormatter())
        logger = logging.Logger("synthetic-exception-extra")
        logger.addHandler(handler)
        logger.error("Synthetic HTTP 500", extra={"diagnostic": error})
        shown = json.loads(output.getvalue())["diagnostic"]

    assert shown == repr(RuntimeError("Lookup failed for [REDACTED]; HTTP 500; no task was completed."))
    assert str(error) == message


@pytest.mark.parametrize("control", ["\u200b", "\u200d", "\u2060", "\u00ad", "\ufe0f", "\U000E0100"])
def test_encoded_ignorable_redaction_retains_benign_repr_and_larger_identifiers(control):
    from arcanos.utils.text import redact_job_read_capabilities

    capability = "v1." + base64.urlsafe_b64encode(bytes(range(32))).decode().rstrip("=")
    decorated = capability[:15] + control + capability[15:]
    prose = f"Échec 🛡️ 👨‍👩‍👧; keep a{control}b unchanged. "
    assert redact_job_read_capabilities(repr(RuntimeError(prose + decorated))) == repr(
        RuntimeError(prose + "[REDACTED]")
    )
    for larger in ("prefix" + decorated, decorated + "suffix", capability + control + "x"):
        literal = repr(RuntimeError(prose + larger))
        assert redact_job_read_capabilities(literal) == literal


@pytest.mark.parametrize("escaped", [r"\u200b", r"\U0000200D", r"\xad", r"\U000E0100"])
def test_escaped_ignorable_spans_do_not_decode_other_diagnostic_literals(escaped):
    from arcanos.utils.text import redact_job_read_capabilities

    capability = "v1." + base64.urlsafe_b64encode(bytes(range(32))).decode().rstrip("=")
    decorated = capability[:15] + escaped + capability[15:]
    benign = r"Keep \u0041 \x41 \UFFFFFFFF \U00110000 \U0000D800 \uZZZZ unchanged. "
    assert redact_job_read_capabilities(benign + decorated) == benign + "[REDACTED]"
    for larger in ("prefix" + decorated, decorated + "suffix"):
        assert redact_job_read_capabilities(benign + larger) == benign + larger
    encoded_larger = '"' + capability + r'\u0041"'
    assert redact_job_read_capabilities(encoded_larger) == encoded_larger


def test_malformed_quoted_diagnostics_have_bounded_cpu_growth():
    """Four times the input must not trigger quadratic retries of escaped quotes."""
    from arcanos.utils.text import redact_job_read_capabilities

    def measured_cpu(size):
        value = '"' + r'\"' * ((size - 2) // 2) + "\\"
        durations = []
        for _ in range(3):
            start = time.thread_time()
            assert redact_job_read_capabilities(value) == value
            durations.append(time.thread_time() - start)
        return sorted(durations)[1]

    small = measured_cpu(4000)
    large = measured_cpu(16000)
    # CPU time excludes scheduling delays; the floor allows coarse Windows clocks
    # and tiny linear scans, while 8x permits ample overhead for 4x more input.
    assert large <= max(8 * small, 0.1), (small, large)


@pytest.mark.parametrize("suffix", [
    '"' + r'\"' * 2000 + "\\",
    '"escaped\\\n' + '"unfinished\\',
    '"escaped\\\r' + '"unfinished\\',
    '"raw\n' + '"unfinished\\',
    '"raw\r' + '"unfinished\\',
])
def test_malformed_quoted_diagnostics_remain_safe_in_log_consumers(suffix):
    """Malformed text retains prose and classification without leaking capabilities."""
    message = f"Job lookup {JOB_READ_CAPABILITY}; HTTP 500; v1.0.0\n{suffix}"
    expected = message.replace(JOB_READ_CAPABILITY, "[REDACTED]")
    sanitized = sanitize_sensitive_data({"error": message, "status": 500})
    record = logging.LogRecord("arcanos.test", logging.ERROR, __file__, 1, message, (), None)
    displayed = json.loads(JsonLogFormatter().format(record))

    assert sanitized == {"error": expected, "status": 500}
    assert displayed["message"] == expected


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
