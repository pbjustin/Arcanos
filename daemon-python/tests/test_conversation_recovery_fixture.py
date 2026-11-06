"""Failure receipts from the actual native conversation acceptance fixture."""

import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys

import pytest


pytestmark = pytest.mark.skipif(os.name != "nt", reason="The fixture uses native Windows ConPTY")


@pytest.fixture
def ownership_fixture(tmp_path, monkeypatch):
    """Load the actual fixture with isolated profile paths and synthetic credentials."""
    repository = Path(__file__).resolve().parents[2]
    spec = importlib.util.spec_from_file_location(
        "conversation_recovery_multiprocess_acceptance",
        repository / "tests/fixtures/conversation_recovery_multiprocess.py",
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.syspath_prepend(str(repository / "daemon-python/scripts"))
    monkeypatch.setattr(sys, "argv", [str(module.__file__), "--daemon-root", str(repository / "daemon-python"),
                                      "--base-url", "http://127.0.0.1:9", "--sandbox", str(tmp_path),
                                      "--mode", "live"])
    for name in ("ARCANOS_GPT_ACCESS_TOKEN", "ARCANOS_DAEMON_ACCESS_TOKEN", "ARCANOS_CONTROL_PLANE_ACCESS_TOKEN"):
        monkeypatch.setenv(name, "synthetic-fixture-only-" + name.lower())
    from local_action_acceptance import common, conpty
    return module, common, conpty


def test_early_native_failure_emits_original_receipt_without_creating_history(ownership_fixture, tmp_path, monkeypatch, capsys):
    """A console launch failure remains visible even before any history tables exist."""
    module, _, conpty = ownership_fixture

    def failed_console(*args, **kwargs):
        """Fail before a real CLI can initialize SQLite or issue any HTTP request."""
        raise RuntimeError("Synthetic console launch failed before history initialization.")

    monkeypatch.setattr(conpty, "ConsoleProcess", failed_console)
    module.main()
    captured = capsys.readouterr()
    receipt = json.loads(captured.out)
    assert receipt["failure"] == {
        "type": "RuntimeError", "message": "Synthetic console launch failed before history initialization.",
    }
    assert receipt["actual_conpty_processes"] == 0
    assert receipt["history"] is None
    assert receipt["durable_successes"] is None
    assert receipt["history_failure"] is None
    assert receipt["credential_leaks"] is False
    assert captured.err == ""
    assert not (tmp_path / "shared-profile/history.db").exists()


@pytest.mark.parametrize("existing_history", [False, True])
def test_primary_failure_preserves_available_history_when_diagnostic_query_fails(
    ownership_fixture, tmp_path, monkeypatch, capsys, existing_history,
):
    """Missing first/second tables cannot mask failure or discard already-read evidence."""
    module, _, conpty = ownership_fixture
    profile = tmp_path / "shared-profile"
    profile.mkdir()
    with sqlite3.connect(profile / "history.db") as connection:
        if existing_history:
            connection.execute("CREATE TABLE conversation_deliveries(session_id,user_text,answer_text,tokens,cost,displayed)")
            connection.execute("INSERT INTO conversation_deliveries VALUES(?,?,?,?,?,?)",
                               ("fixture-session", "original question", "approved answer", 17, 0.0, 1))

    def failed_console(*args, **kwargs):
        """Produce the primary failure before the diagnostic SQLite reads."""
        raise RuntimeError("Synthetic console launch failure.")

    monkeypatch.setattr(conpty, "ConsoleProcess", failed_console)
    module.main()
    receipt = json.loads(capsys.readouterr().out)
    assert receipt["failure"] == {"type": "RuntimeError", "message": "Synthetic console launch failure."}
    assert receipt["durable_successes"] is None
    assert receipt["history_failure"] == {"type": "OperationalError", "message": "Recovery history evidence is unavailable."}
    if existing_history:
        assert len(receipt["history"]) == 1
        assert receipt["history"][0]["user"] == "original question"
        assert receipt["history"][0]["ai"] == "approved answer"
    else:
        assert receipt["history"] is None


def test_successful_console_path_still_rejects_missing_history(ownership_fixture, monkeypatch, capsys):
    """Receipt preservation must not turn a successful-looking run with bad SQL into success."""
    module, common, conpty = ownership_fixture

    class ObservedConsole:
        """Advance terminal observation only; deliberately never initialize SQLite."""

        returncode = 0
        transcript = "I can explain ideas and help you plan."

        def __init__(self, *args, **kwargs):
            pass

        def send(self, text):
            pass

        def wait(self, timeout):
            return 0

        def close(self):
            pass

    def observations(path):
        """Satisfy only the fixture's terminal progress checks without history evidence."""
        if path.name == "observations.jsonl":
            return [{"event": "accepted_response"}]
        return [{"event": "builtins.input"}, {"event": "builtins.input"}]

    monkeypatch.setattr(conpty, "ConsoleProcess", ObservedConsole)
    monkeypatch.setattr(common, "read_jsonl", observations)
    monkeypatch.setattr(module.time, "sleep", lambda _: None)
    with pytest.raises(sqlite3.OperationalError, match="no such table"):
        module.main()
    assert capsys.readouterr().out == ""


def test_corrupt_history_preserves_primary_console_failure(ownership_fixture, tmp_path, monkeypatch, capsys):
    """Corrupt diagnostic storage must not replace the original native-console failure."""
    module, _, conpty = ownership_fixture
    profile = tmp_path / "shared-profile"
    profile.mkdir()
    (profile / "history.db").write_bytes(b"Synthetic corrupt SQLite fixture")

    def failed_console(*args, **kwargs):
        """Fail before any child, request, or database initialization is attempted."""
        raise RuntimeError("Synthetic original console launch failure.")

    monkeypatch.setattr(conpty, "ConsoleProcess", failed_console)
    module.main()
    captured = capsys.readouterr()
    receipt = json.loads(captured.out)
    assert receipt["failure"] == {"type": "RuntimeError", "message": "Synthetic original console launch failure."}
    assert receipt["actual_conpty_processes"] == 0
    assert receipt["history"] is None and receipt["durable_successes"] is None
    assert receipt["history_failure"] == {"type": "DatabaseError", "message": "Recovery history evidence is unavailable."}
    assert receipt["credential_leaks"] is False
    assert captured.err == ""
