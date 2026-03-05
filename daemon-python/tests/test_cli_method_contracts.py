"""Tests for ARCANOS CLI class method wiring."""

from __future__ import annotations

from arcanos.cli.cli import ArcanosCLI


def test_arcanos_cli_exposes_expected_command_methods() -> None:
    """Core slash-command handlers and run loop should remain bound class methods."""

    expected_methods = [
        "handle_audit",
        "handle_intents",
        "handle_dryrun",
        "handle_feedback",
        "handle_safemode",
        "handle_speak",
        "handle_stats",
        "handle_help",
        "handle_clear",
        "handle_reset",
        "handle_update",
        "run",
    ]

    missing = [name for name in expected_methods if not hasattr(ArcanosCLI, name)]
    assert missing == []
