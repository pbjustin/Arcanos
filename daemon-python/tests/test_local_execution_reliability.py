"""Deterministic local command lifecycle regressions; no shell or provider calls."""

from __future__ import annotations

import io
from pathlib import Path
import tempfile
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from rich.console import Console

from arcanos.agentic import agent_loop
from arcanos.agentic.history_db import HistoryDB
from arcanos.agentic.policy_guard import PolicyGuard
from arcanos.agentic.proposals import CommandProposal
from arcanos.cli import execute, run_ops
from arcanos.cli.idempotency import IdempotencyGuard
from arcanos.cli.trust_state import TrustState
from arcanos.config import Config
from arcanos.terminal import TerminalController


@pytest.fixture
def local_cli(monkeypatch, tmp_path):
    history = HistoryDB(tmp_path / "history.sqlite3")
    output = io.StringIO()
    cli = SimpleNamespace(
        console=Console(file=output, force_terminal=False, width=200),
        instance_id="local-action-fixture",
        dry_run=False,
        _trust_state=TrustState.FULL,
        _idempotency_guard=IdempotencyGuard(window_seconds=60),
        _append_activity=MagicMock(),
        _confirm_action=MagicMock(return_value=True),
        terminal=MagicMock(),
        memory=MagicMock(),
    )
    cli.terminal.execute.return_value = ("done", "", 0)
    cli.terminal.is_command_safe.return_value = (True, None)
    monkeypatch.setattr(run_ops, "HistoryDB", lambda: history, raising=False)
    monkeypatch.setattr(run_ops.state, "recompute_trust_state", lambda _: None)
    return cli, history, output


def test_dry_run_is_proposed_and_never_dispatches(local_cli):
    cli, _history, _output = local_cli
    cli.dry_run = True
    result = run_ops.handle_run(cli, "echo fixture", return_result=True)
    cli.terminal.execute.assert_not_called()
    cli._confirm_action.assert_not_called()
    assert result["ok"] is False
    assert result["status"] == "proposed"
    assert result["workspace_changed"] is False


def test_safe_mode_command_is_blocked(local_cli):
    cli, history, _output = local_cli
    PolicyGuard(history).enable_safe_mode(cli.instance_id, "fixture")
    result = run_ops.handle_run(cli, "echo fixture", return_result=True)
    cli.terminal.execute.assert_not_called()
    assert result["status"] == "blocked"
    assert result["return_code"] is None


def test_denied_command_never_executes(local_cli):
    cli, _history, _output = local_cli
    cli._confirm_action.return_value = False
    result = run_ops.handle_run(cli, "echo fixture", return_result=True)
    cli.terminal.execute.assert_not_called()
    assert result["approval_status"] == "denied"
    assert result["status"] == "blocked"


@pytest.mark.parametrize("return_code", [0, 7])
def test_command_outcome_and_exit_code_are_truthful(local_cli, return_code):
    cli, _history, _output = local_cli
    cli.terminal.execute.return_value = ("output", "failure" if return_code else "", return_code)
    result = run_ops.handle_run(cli, "echo fixture", return_result=True)
    assert result["ok"] is (return_code == 0)
    assert result["return_code"] == return_code
    assert result["status"] == ("succeeded" if return_code == 0 else "failed")
    assert result["approval_status"] == "approved"
    assert result["action_type"] == "command"
    assert result["action_id"]


@pytest.mark.parametrize("terminal_result", [None, (None, None, None), (None, None, False)])
def test_unconfirmed_execution_cannot_report_success(local_cli, terminal_result):
    cli, _history, _output = local_cli
    cli.terminal.execute.return_value = terminal_result
    result = run_ops.handle_run(cli, "echo fixture", return_result=True)
    assert result["ok"] is False
    assert result["status"] == "failed"
    assert result["return_code"] is None


def test_command_error_is_explicit_and_does_not_disclose_exception(local_cli, capsys):
    cli, _history, output = local_cli
    secret = "sunshine"
    cli.terminal.execute.side_effect = OSError(f"Authorization: Token {secret}")
    result = run_ops.handle_run(cli, "echo fixture", return_result=True)
    assert result["ok"] is False
    assert result["status"] == "failed"
    assert result["return_code"] is None
    assert secret not in repr(result) + output.getvalue() + capsys.readouterr().out


def test_tool_output_is_redacted_before_return_or_display(local_cli):
    cli, _history, output = local_cli
    cli.terminal.execute.return_value = ("Authorization: Token sunshine", "password=orchard", 3)
    result = run_ops.handle_run(cli, "echo fixture", return_result=True)
    assert "sunshine" not in repr(result)
    assert "orchard" not in repr(result)
    cli._idempotency_guard.reset()
    run_ops.handle_run(cli, "echo fixture")
    assert "sunshine" not in output.getvalue()
    assert "orchard" not in output.getvalue()


@pytest.mark.parametrize("private_output", [
    '<vbl severity="3" />\nprivate-record-fixture',
    'boot_snapshot={"records":["private-record-fixture"]}',
])
def test_private_tool_output_is_withheld_at_result_display_and_history(local_cli, private_output):
    cli, history, output = local_cli
    cli.terminal.execute.return_value = (private_output, "", 0)
    result = run_ops.handle_run(cli, "echo fixture", return_result=True)
    assert result["ok"] is True
    assert "private-record-fixture" not in repr(result)
    cli._idempotency_guard.reset()
    run_ops.handle_run(cli, "echo fixture")
    assert "private-record-fixture" not in output.getvalue()
    with history._conn() as connection:
        rows = connection.execute("SELECT stdout, stderr FROM commands").fetchall()
    assert "private-record-fixture" not in repr(rows)


def test_duplicate_delivery_does_not_execute_twice(local_cli):
    cli, _history, _output = local_cli
    first = run_ops.handle_run(cli, "echo fixture", return_result=True)
    second = run_ops.handle_run(cli, "echo fixture", return_result=True)
    assert first["ok"] is True
    assert second["ok"] is False
    assert second["status"] == "blocked"
    assert cli.terminal.execute.call_count == 1


def test_safe_mode_changed_during_confirmation_blocks_execution(local_cli):
    cli, history, _output = local_cli

    def approve(_message):
        PolicyGuard(history).enable_safe_mode(cli.instance_id, "changed during approval")
        return True

    cli._confirm_action.side_effect = approve
    result = run_ops.handle_run(cli, "echo fixture", return_result=True)
    cli.terminal.execute.assert_not_called()
    assert result["status"] == "blocked"


def test_dry_run_changed_during_confirmation_never_executes(local_cli):
    cli, _history, _output = local_cli

    def approve(_message):
        cli.dry_run = True
        return True

    cli._confirm_action.side_effect = approve
    result = run_ops.handle_run(cli, "echo fixture", return_result=True)
    cli.terminal.execute.assert_not_called()
    assert result["status"] == "proposed"


def test_changed_workspace_invalidates_command_approval(local_cli, monkeypatch, tmp_path):
    cli, _history, _output = local_cli

    def approve(_message):
        monkeypatch.chdir(tmp_path)
        return True

    cli._confirm_action.side_effect = approve
    result = run_ops.handle_run(cli, "echo fixture", return_result=True)
    cli.terminal.execute.assert_not_called()
    assert result["error"] == "command_approval_context_changed"


def test_missing_backend_authority_blocks_local_command(local_cli):
    cli, _history, _output = local_cli
    cli._trust_state = TrustState.DEGRADED
    result = run_ops.handle_run(cli, "echo fixture", return_result=True)
    cli.terminal.execute.assert_not_called()
    cli._confirm_action.assert_not_called()
    assert result["status"] == "blocked"
    assert result["error"] == "governance_denied"


def test_real_terminal_exception_reaches_sanitized_result_without_raw_logging(local_cli, monkeypatch, caplog):
    cli, _history, _output = local_cli
    cli.terminal = TerminalController()
    monkeypatch.setattr(cli.terminal, "_detect_shell", lambda: "powershell")
    monkeypatch.setattr(cli.terminal, "is_command_safe", lambda _command, **_kwargs: (True, None))
    monkeypatch.setattr("arcanos.terminal.subprocess.run", MagicMock(side_effect=OSError("Authorization: Token sunshine")))
    result = run_ops.handle_run(cli, "echo fixture", return_result=True)
    assert result["ok"] is False
    assert result["status"] == "failed"
    assert "sunshine" not in caplog.text + repr(result)


@pytest.mark.parametrize("completion,wrapper_exit,expected", [
    ("-7", 0, -7), ("7", 0, 7), ("0", 0, 0),
    ("", 0, None), ("", 9, None), ("invalid", 0, None),
])
def test_elevated_completion_retains_real_exit_or_unknown(local_cli, monkeypatch, tmp_path, completion, wrapper_exit, expected):
    cli, _, _ = local_cli
    terminal = TerminalController()
    cli.terminal = terminal
    monkeypatch.setattr(Config, "RUN_ELEVATED", True)
    monkeypatch.setattr(terminal, "_detect_shell", lambda: "powershell")
    monkeypatch.setattr(terminal, "is_command_safe", lambda *_args, **_kwargs: (True, None))
    monkeypatch.setattr(terminal, "_execute_elevated", lambda command, _shell, timeout: terminal._execute_elevated_windows(command, timeout))
    real_mkstemp = tempfile.mkstemp
    paths = {}
    def make_temp(*args, **kwargs):
        descriptor, path = real_mkstemp(*args, **kwargs, dir=tmp_path)
        paths[kwargs["prefix"]] = path
        return descriptor, path
    def wrapper(*_args, **_kwargs):
        Path(paths["arcanos_rc_"]).write_text(completion, encoding="utf-8")
        return SimpleNamespace(returncode=wrapper_exit)
    monkeypatch.setattr("arcanos.terminal.tempfile.mkstemp", make_temp)
    monkeypatch.setattr("arcanos.terminal.subprocess.run", wrapper)
    result = run_ops.handle_run(cli, "echo fixture", return_result=True)
    assert result["return_code"] == expected
    assert result["ok"] is (expected == 0)
    assert result["status"] == ("succeeded" if expected == 0 else "failed")
    assert not any(Path(path).exists() for path in paths.values())


@pytest.mark.parametrize("command", [
    "git statusx", "git status ; echo unauthorized", "git status && echo unauthorized",
    "git status | echo unauthorized", "git status $(echo unauthorized)",
])
def test_terminal_whitelist_cannot_authorize_a_different_command_or_chain(command):
    terminal = TerminalController()
    terminal.whitelist = ["git status"]
    assert terminal.is_command_safe(command)[0] is False


def test_terminal_whitelist_preserves_arguments_and_literal_quoted_punctuation(monkeypatch):
    terminal = TerminalController()
    monkeypatch.setattr(terminal, "_detect_shell", lambda: "powershell")
    terminal.whitelist = ["git status", "echo"]
    assert terminal.is_command_safe("git status --porcelain")[0] is True
    assert terminal.is_command_safe('echo "left;right&literal"')[0] is True
    assert terminal.is_command_safe("echo 'left;right&literal'")[0] is True


def test_cmd_single_quotes_cannot_hide_shell_chaining(monkeypatch):
    terminal = TerminalController()
    terminal.whitelist = ["echo"]
    monkeypatch.setattr(terminal, "_detect_shell", lambda: "cmd")
    assert terminal.is_command_safe("echo 'literal&echo unauthorized'")[0] is False


@pytest.mark.parametrize(("shell", "command"), [
    ("bash", r"echo \' ; echo unauthorized ; echo \'"),
    ("sh", r'echo \" ; echo unauthorized ; echo \"'),
    ("bash", 'echo \\" ; echo unauthorized #"'),
    ("bash", "echo \\' ; echo unauthorized #'"),
    ("bash", "echo \\\\' ; echo unauthorized ; echo '\\\\"),
    ("cmd", 'echo ^" & echo unauthorized ^"'),
    ("cmd", 'echo ^" & echo unauthorized "'),
    ("cmd", 'echo ^^" & echo unauthorized ^^"'),
    ("cmd", "echo ^' & echo unauthorized ^'"),
    ("powershell", 'echo `" ; echo unauthorized `"'),
])
def test_terminal_whitelist_escaped_quotes_cannot_hide_real_chaining(monkeypatch, shell, command):
    terminal = TerminalController()
    terminal.whitelist = ["echo"]
    monkeypatch.setattr(terminal, "_detect_shell", lambda: shell)
    assert terminal.is_command_safe(command)[0] is False


@pytest.mark.parametrize("shell", ["powershell", "pwsh"])
@pytest.mark.parametrize("command", [
    "Write-Output (Get-Date)",
    "Write-Output ((Get-Date))",
    "Write-Output @(Get-Date)",
])
def test_terminal_whitelist_blocks_unquoted_powershell_grouping(shell, command):
    terminal = TerminalController()
    terminal.whitelist = ["Write-Output"]
    assert terminal.is_command_safe(command, shell=shell)[0] is False


@pytest.mark.parametrize(("shell", "command"), [
    ("powershell", 'Write-Output "(Get-Date)"'),
    ("powershell", "Write-Output '(Get-Date)'"),
    ("pwsh", 'Write-Output "left(right)"'),
    ("pwsh", "Write-Output '$(Get-Date)'"),
    ("cmd", "echo (literal)"),
    ("cmd", 'echo "left(right)"'),
    ("bash", 'echo "(literal)"'),
    ("bash", "echo '(literal)'"),
    ("sh", 'echo "left(right)"'),
])
def test_terminal_whitelist_preserves_literal_parentheses(shell, command):
    terminal = TerminalController()
    terminal.whitelist = ["Write-Output", "echo"]
    assert terminal.is_command_safe(command, shell=shell)[0] is True


def test_action_plan_dry_run_never_executes(local_cli):
    cli, _history, _output = local_cli
    cli.dry_run = True
    result = run_ops.handle_action_plan_run(cli, "echo fixture", execution_identity="run-fixture")
    cli.terminal.execute_action_plan_command.assert_not_called()
    assert result == {"ok": False, "return_code": None, "error_category": "dry_run"}


def test_action_plan_safe_mode_never_executes(local_cli):
    cli, history, _output = local_cli
    PolicyGuard(history).enable_safe_mode(cli.instance_id, "fixture")
    result = run_ops.handle_action_plan_run(cli, "echo fixture", execution_identity="run-fixture")
    cli.terminal.execute_action_plan_command.assert_not_called()
    assert result == {"ok": False, "return_code": None, "error_category": "policy"}


def test_governed_nonzero_exit_is_a_failed_audit(monkeypatch):
    events = []
    monkeypatch.setattr(execute, "record", lambda event, **fields: events.append((event, fields)))
    assert execute.execute(
        "run", lambda: ("", "failed", 4), trust_state=TrustState.FULL,
        requires_confirmation=True, payload={},
    ) == ("", "failed", 4)
    assert "execute_success" not in [event for event, _ in events]
    assert ("execute_failed", {"command": "run", "trust": "FULL", "return_code": 4}) in events


def test_agentic_command_uses_local_controls_and_preserves_denial(local_cli, monkeypatch):
    cli, history, _output = local_cli
    cli._confirm_action.return_value = False
    cli.handle_ask = MagicMock(side_effect=[SimpleNamespace(response_text="Command:\necho fixture"), None])
    monkeypatch.setattr(agent_loop, "HistoryDB", lambda: history)
    monkeypatch.setattr(agent_loop.ui_ops, "speak_to_user", lambda *args, **kwargs: None)
    monkeypatch.setattr(Config, "AGENT_MAX_STEPS", 2)
    monkeypatch.setattr(Config, "REPO_INDEX_ENABLED", False)
    monkeypatch.setattr("builtins.input", lambda _prompt="": "yes")
    agent_loop.run_agentic_loop(cli, "show proposed command", domain=None, from_debug=False)
    cli.terminal.execute.assert_not_called()
    feedback = cli.handle_ask.call_args_list[1].args[0]
    assert "blocked" in feedback
    assert "denied" in feedback


def test_agentic_dry_run_does_not_execute_git_snapshot_or_index(local_cli, monkeypatch):
    cli, history, _output = local_cli
    cli.dry_run = True
    cli.handle_ask = MagicMock(side_effect=[SimpleNamespace(response_text="Command:\necho fixture"), None])
    cli._build_backend_metadata = MagicMock(return_value={})
    monkeypatch.setattr(agent_loop, "HistoryDB", lambda: history)
    monkeypatch.setattr(agent_loop.ui_ops, "speak_to_user", lambda *args, **kwargs: None)
    monkeypatch.setattr(Config, "AGENT_MAX_STEPS", 2)
    monkeypatch.setattr(Config, "REPO_INDEX_ENABLED", True)
    git_probe = MagicMock(return_value="fixture-head")
    repo_index = MagicMock(return_value={})
    monkeypatch.setattr("subprocess.check_output", git_probe)
    monkeypatch.setattr(agent_loop, "build_repo_index", repo_index)
    agent_loop.run_agentic_loop(cli, "show proposed command", domain=None, from_debug=False)
    cli.terminal.execute.assert_not_called()
    cli._build_backend_metadata.assert_not_called()
    git_probe.assert_not_called()
    repo_index.assert_not_called()


def test_agentic_approval_cannot_authorize_modified_proposal(local_cli, monkeypatch):
    cli, history, _output = local_cli
    proposal = CommandProposal("echo approved")
    cli.handle_ask = MagicMock(side_effect=[SimpleNamespace(response_text="fixture"), None])
    monkeypatch.setattr(agent_loop, "HistoryDB", lambda: history)
    monkeypatch.setattr(agent_loop, "translate_response", lambda *args, **kwargs: SimpleNamespace(
        should_show=True, message="fixture", patches=[], commands=[proposal],
    ))
    monkeypatch.setattr(agent_loop.ui_ops, "speak_to_user", lambda *args, **kwargs: None)
    monkeypatch.setattr(Config, "AGENT_MAX_STEPS", 2)
    monkeypatch.setattr(Config, "REPO_INDEX_ENABLED", False)
    monkeypatch.setattr(Config, "REQUEST_TIMEOUT", 47)
    monkeypatch.setattr("subprocess.check_output", lambda *_args, **_kwargs: "fixture-head")

    def approve(_message=""):
        proposal.command = "echo unapproved"
        return "yes"

    monkeypatch.setattr("builtins.input", approve)
    cli._confirm_action.side_effect = lambda message: approve(message) == "yes"
    agent_loop.run_agentic_loop(cli, "show proposed command", domain=None, from_debug=False)
    assert cli.terminal.execute.call_args.args[0] == "echo approved"
    assert cli.terminal.execute.call_args.kwargs["timeout"] == 47
