"""Tests for debug JSON log formatter behavior."""

from __future__ import annotations

import json
import logging
import io
import pytest

from arcanos.debug.logging import JsonLogFormatter, RedactingTextFormatter


JOB_READ_CAPABILITY = "v1." + "a" * 42 + "_"


@pytest.mark.parametrize("prefix,suffix", [
    ("\x9b31m", "\x9b0m"),
    ("\x1b[H", ""),
    ("\x1b[2J", ""),
])
def test_json_debug_log_withholds_csi_decorated_capability(prefix, suffix):
    from arcanos.utils.telemetry import sanitize_sensitive_string

    message = f"Job lookup {prefix}{JOB_READ_CAPABILITY}{suffix}; version v1.0.0"
    record = logging.LogRecord("synthetic", logging.ERROR, __file__, 1, "%s", (message,), None)
    payload = json.loads(JsonLogFormatter().format(record))

    for rendered in (payload["message"], sanitize_sensitive_string(message)):
        assert JOB_READ_CAPABILITY not in rendered
        assert rendered == "Job lookup [REDACTED]; version v1.0.0"


def test_json_formatter_protects_lazy_message_and_cached_exception_text():
    error = RuntimeError(f"Job failed for {JOB_READ_CAPABILITY}; status=500")
    record = logging.LogRecord(
        "synthetic", logging.ERROR, __file__, 1,
        "Lookup %s; version v1.0.0", (JOB_READ_CAPABILITY,),
        (type(error), error, error.__traceback__),
    )
    logging.Formatter().format(record)  # A previous handler can cache raw exception text.

    payload = json.loads(JsonLogFormatter().format(record))

    assert JOB_READ_CAPABILITY not in json.dumps(payload)
    assert payload["message"] == "Lookup [REDACTED]; version v1.0.0"
    assert "RuntimeError: Job failed for [REDACTED]; status=500" in payload["exc_info"]


def test_json_formatter_redacts_capability_metadata_key_and_tuple_value():
    record = logging.LogRecord("synthetic", logging.ERROR, __file__, 1, "Job lookup failed", (), None)
    record.__dict__[JOB_READ_CAPABILITY] = "HTTP 500"
    record.details = (f"lookup {JOB_READ_CAPABILITY}",)

    payload = json.loads(JsonLogFormatter().format(record))

    assert JOB_READ_CAPABILITY not in json.dumps(payload)
    assert payload["[REDACTED]"] == "HTTP 500"
    assert payload["details"] == ["lookup [REDACTED]"]


def test_json_handler_exception_extra_cannot_trigger_unredacted_logging_fallback(capsys):
    rendered = io.StringIO()
    handler = logging.StreamHandler(rendered)
    handler.setFormatter(JsonLogFormatter())
    logger = logging.Logger("synthetic-exception-extra")
    logger.addHandler(handler)
    error = RuntimeError(f"lookup {JOB_READ_CAPABILITY}; HTTP 500")

    logger.error("Job lookup %s; version v1.0.0", JOB_READ_CAPABILITY, extra={"error": error})

    stderr = capsys.readouterr().err
    assert JOB_READ_CAPABILITY not in stderr + rendered.getvalue()
    assert not stderr
    payload = json.loads(rendered.getvalue())
    assert payload["message"] == "Job lookup [REDACTED]; version v1.0.0"
    assert "RuntimeError" in payload["error"] and "HTTP 500" in payload["error"]
    assert str(error) == f"lookup {JOB_READ_CAPABILITY}; HTTP 500"


@pytest.mark.parametrize("formatter", [JsonLogFormatter, RedactingTextFormatter])
def test_log_write_failure_never_prints_original_capability_arguments(formatter, capsys):
    class FailingStream:
        def write(self, value):
            raise OSError("Synthetic write failure")

        def flush(self):
            pass

    handler = logging.StreamHandler(FailingStream())
    handler.setFormatter(formatter())
    logger = logging.Logger("synthetic-write-error")
    logger.addHandler(handler)
    logger.error("Job lookup %s; version v1.0.0", JOB_READ_CAPABILITY)

    failure = capsys.readouterr().err
    assert JOB_READ_CAPABILITY not in failure
    assert "OSError: Synthetic write failure" in failure
    assert "Job lookup [REDACTED]; version v1.0.0" in failure


@pytest.mark.parametrize("formatter", [JsonLogFormatter, RedactingTextFormatter])
def test_strict_utf8_log_sink_does_not_leak_capability_on_lone_surrogate(formatter, capsys):
    raw = io.BytesIO()
    stream = io.TextIOWrapper(raw, encoding="utf-8", errors="strict")
    handler = logging.StreamHandler(stream)
    handler.setFormatter(formatter())
    logger = logging.Logger("synthetic-utf8-error")
    logger.addHandler(handler)
    try:
        logger.error("Job lookup %s; version v1.0.0; %s", JOB_READ_CAPABILITY, "\ud800")
        failure = capsys.readouterr().err
        assert JOB_READ_CAPABILITY not in failure
        assert not failure
        shown = raw.getvalue().decode("utf-8")
        assert "Job lookup [REDACTED]; version v1.0.0" in shown
    finally:
        stream.close()


def test_error_handler_console_and_exception_message_protect_capability(monkeypatch):
    from arcanos.error_handler import ErrorHandler, logger

    message = f"Job failed for {JOB_READ_CAPABILITY}; status=500; v1.0.0"
    rendered = io.StringIO()
    handler = logging.StreamHandler(rendered)
    handler.setFormatter(logger.handlers[0].formatter)
    monkeypatch.setattr(logger, "handlers", [handler])

    error = RuntimeError(message)
    public_error = ErrorHandler.handle_exception(error, "synthetic")
    ErrorHandler.log_error(error, "synthetic-job")

    assert JOB_READ_CAPABILITY not in public_error + rendered.getvalue()
    assert message.replace(JOB_READ_CAPABILITY, "[REDACTED]") in public_error
    assert "RuntimeError" in rendered.getvalue() and "status=500" in rendered.getvalue()


def test_native_debug_runner_file_withholds_unstructured_exception_capability(tmp_path):
    from arcanos.cli_runner import _build_debug_logger

    path = tmp_path / "debug.log"
    logger = _build_debug_logger(path)
    try:
        try:
            raise RuntimeError(f"Job failed for {JOB_READ_CAPABILITY}; HTTP 500")
        except RuntimeError:
            logger.exception("Job lookup %s; version v1.0.0", JOB_READ_CAPABILITY)
    finally:
        for handler in list(logger.handlers):
            handler.close()
            logger.removeHandler(handler)

    displayed = path.read_text(encoding="utf-8")
    assert JOB_READ_CAPABILITY not in displayed
    assert "Job lookup [REDACTED]; version v1.0.0" in displayed
    assert "RuntimeError: Job failed for [REDACTED]; HTTP 500" in displayed


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
