"""Tests for patch orchestrator behavior without interactive confirmation."""

from __future__ import annotations

import io

from rich.console import Console

from arcanos.agentic.history_db import HistoryDB
from arcanos.agentic.patch_orchestrator import PatchOrchestrator
from arcanos.agentic.policy_guard import PolicyGuard


def test_patch_orchestrator_denies_patch_without_tty(monkeypatch, tmp_path) -> None:
    """Patch proposals should be denied when stdin is non-interactive."""

    history = HistoryDB(db_path=tmp_path / "history.db")
    guard = PolicyGuard(history)
    console = Console(file=io.StringIO(), force_terminal=False, width=120)
    orchestrator = PatchOrchestrator(console, history, guard)

    class _NonTtyStdin:
        @staticmethod
        def isatty() -> bool:
            return False

    monkeypatch.setattr("arcanos.agentic.patch_orchestrator.sys.stdin", _NonTtyStdin())

    patch_text = "\n".join(
        [
            "diff --git a/sample.txt b/sample.txt",
            "index 1111111..2222222 100644",
            "--- a/sample.txt",
            "+++ b/sample.txt",
            "@@ -1 +1 @@",
            "-old",
            "+new",
        ]
    )

    result = orchestrator.apply_with_approval("test-session", patch_text, summary="test patch")

    assert result.ok is False
    assert result.error == "non_interactive_confirmation_unavailable"


def test_patch_orchestrator_blocks_secret_patch_without_printing_or_storing_raw(monkeypatch, tmp_path) -> None:
    history = HistoryDB(db_path=tmp_path / "history.db")
    guard = PolicyGuard(history)
    output = io.StringIO()
    console = Console(file=output, force_terminal=False, width=120)
    orchestrator = PatchOrchestrator(console, history, guard)

    patch_text = "\n".join(
        [
            "diff --git a/.env b/.env",
            "--- a/.env",
            "+++ b/.env",
            "@@ -1 +1 @@",
            "-OLD=1",
            "+OPENAI_API" + "_KEY=placeholder-redaction-value",
        ]
    )

    result = orchestrator.apply_with_approval("test-session", patch_text, summary="secret patch")

    assert result.ok is False
    assert result.error == "patch_targets_secret_file"
    assert "placeholder-redaction-value" not in output.getvalue()

    import sqlite3

    with sqlite3.connect(str(tmp_path / "history.db")) as conn:
        stored_patch, patch_hash = conn.execute("SELECT patch_text, patch_sha256 FROM patches LIMIT 1").fetchone()

    assert "placeholder-redaction-value" not in stored_patch
    assert "+[redacted added line]" in stored_patch
    assert patch_hash


def test_patch_orchestrator_requires_exact_hash_confirmation(monkeypatch, tmp_path) -> None:
    history = HistoryDB(db_path=tmp_path / "history.db")
    guard = PolicyGuard(history)
    console = Console(file=io.StringIO(), force_terminal=False, width=120)
    orchestrator = PatchOrchestrator(console, history, guard)

    class _TtyStdin:
        @staticmethod
        def isatty() -> bool:
            return True

    monkeypatch.setattr("arcanos.agentic.patch_orchestrator.sys.stdin", _TtyStdin())
    monkeypatch.setattr("builtins.input", lambda _prompt="": "wrong-hash")

    patch_text = "\n".join(
        [
            "diff --git a/sample.txt b/sample.txt",
            "--- a/sample.txt",
            "+++ b/sample.txt",
            "@@ -1 +1 @@",
            "-old",
            "+new",
        ]
    )

    result = orchestrator.apply_with_approval("test-session", patch_text, summary="safe patch")

    assert result.ok is False
    assert result.error == "patch_hash_mismatch"
