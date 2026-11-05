"""Diagnostic output and terminal audits share one local registry observation."""

from __future__ import annotations

import pytest

from arcanos.cli import cli as cli_module, state, ui_ops
from .test_cli_diagnostic_audit import (
    CONTROL_TOKEN, DAEMON_TOKEN, GPT_TOKEN, _execution_events, diagnostic_cli,
)


def _expire_registry(cli, now):
    """Advance beyond elapsed authority and update the live trust state."""
    now[0] += cli._registry_cache_ttl_seconds + 1
    state.recompute_trust_state(cli)


@pytest.mark.parametrize("entrypoint", ["status", "ask_result", "ask_speech"])
@pytest.mark.parametrize("phase", ["after_read", "after_evidence"])
@pytest.mark.parametrize("available", [True, False], ids=["state_available", "state_unavailable"])
def test_diagnostic_observation_remains_coherent_across_expiry(
    diagnostic_cli, monkeypatch, capsys, entrypoint, phase, available,
):
    """Keep trust, registry freshness, terminal audit, and speech on one post-read observation."""
    cli, scenario, requests, now = diagnostic_cli
    scenario["state_status"] = 200 if available else 503
    if phase == "after_read":
        read = cli._read_diagnostic_state

        def read_then_expire():
            """Expire only after the canonical reader has completed its trust recomputation."""
            observation = read()
            now[0] += cli._registry_cache_ttl_seconds + 1
            return observation

        monkeypatch.setattr(cli, "_read_diagnostic_state", read_then_expire)
    else:
        build = ui_ops.build_system_status_evidence

        def build_then_expire(*args, **kwargs):
            """Change live trust after the evidence string has been constructed."""
            evidence = build(*args, **kwargs)
            _expire_registry(cli, now)
            return evidence

        monkeypatch.setattr(ui_ops, "build_system_status_evidence", build_then_expire)
    capsys.readouterr()

    if entrypoint == "status":
        assert cli.handle_status() is available
        text = cli.console.file.getvalue()
    else:
        result = cli.handle_ask(
            "Is ARCANOS healthy?", return_result=entrypoint == "ask_result",
            speak_response=entrypoint == "ask_speech",
        )
        if entrypoint == "ask_result":
            assert result.source == "diagnostic"
            assert result.tokens_used == result.cost_usd == 0
            text = result.response_text
        else:
            assert result is None
            text = cli.console.file.getvalue()
    stdout = capsys.readouterr().out
    events = _execution_events(stdout)
    trust_line = "Daemon trust (local): " + text.split("Daemon trust (local): ", 1)[1].splitlines()[0]
    registry_line = next(line for line in text.splitlines() if line.startswith("Daemon registry evidence (local):"))
    trust = trust_line.rsplit(" ", 1)[-1]
    assert (trust, registry_line) in (
        ("FULL", "Daemon registry evidence (local): valid and fresh"),
        ("DEGRADED", "Daemon registry evidence (local): stale or invalid"),
    ), (trust_line, registry_line)
    command = "status" if entrypoint == "status" else "ask"
    assert [(event["event"], event["command"]) for event in events] == [
        ("execute_attempt", command), ("execute_success" if available else "execute_failed", command),
    ]
    assert events[-1]["trust"] == trust, (trust_line, events[-1])
    assert all(event["source"] == "diagnostic" and event["operation"] == "status" for event in events)
    assert requests == [("get", "/system-state")]
    read_label = "Backend status read (observed)" if available else "Backend status read: unavailable"
    assert read_label in text
    for label in (
        "Backend dependency health", "Memory availability", "Memory consistency",
        "Audit-safe mode", "Intent tracking correctness", "Overall stability and risk",
    ):
        assert f"{label}: unknown" in text
    if entrypoint == "ask_speech":
        cli.audio.speak.assert_called_once()
        spoken = cli.audio.speak.call_args.args[0]
        assert trust_line in spoken
        assert registry_line in spoken
        assert "Overall stability and risk: unknown" in spoken
    else:
        cli.audio.speak.assert_not_called()
    cli.memory.add_conversation.assert_not_called()
    cli_module.memory_ops.record_conversation_turn.assert_not_called()
    cli_module.memory_ops.update_short_term_summary.assert_not_called()
    cli_module.local_ops.perform_local_conversation.assert_not_called()
    for private in (DAEMON_TOKEN, CONTROL_TOKEN, GPT_TOKEN, cli.instance_id, "Is ARCANOS healthy?"):
        assert private not in text + stdout


def test_status_terminal_audit_keeps_rendered_observation_after_table_work(
    diagnostic_cli, monkeypatch, capsys,
):
    """A live trust transition during table output cannot rewrite the completed observation."""
    cli, _, requests, now = diagnostic_cli
    render = ui_ops.render_system_state_table

    def render_then_expire(*args, **kwargs):
        """Simulate elapsed time and another local trust recomputation during table work."""
        render(*args, **kwargs)
        _expire_registry(cli, now)

    monkeypatch.setattr(ui_ops, "render_system_state_table", render_then_expire)
    capsys.readouterr()

    assert cli.handle_status() is True

    text = cli.console.file.getvalue()
    events = _execution_events(capsys.readouterr().out)
    assert "Daemon trust (local): FULL" in text
    assert "Daemon registry evidence (local): valid and fresh" in text
    assert cli._trust_state.name == "DEGRADED"
    assert events[-1]["event"] == "execute_success"
    assert events[-1]["trust"] == "FULL"
    assert requests == [("get", "/system-state")]
