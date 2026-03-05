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
