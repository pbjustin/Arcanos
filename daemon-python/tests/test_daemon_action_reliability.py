"""Deterministic feedback regressions for daemon execution adapters."""

from __future__ import annotations

from pathlib import Path
import io
import time
import hashlib
import subprocess
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from arcanos import cli_daemon
from arcanos.action_plan_execution_runner import ActionPlanExecutionRunner
from arcanos.cli import daemon_ops
from arcanos.cli_types import DaemonCommand
from arcanos.local_agent.runner import sanitize_handler_output
from arcanos.agentic.history_db import HistoryDB
from arcanos.agentic.policy_guard import PolicyGuard
from arcanos.cli import local_bridge
from arcanos.local_agent import handlers
from arcanos.local_agent import patch_handler
from arcanos.agentic.patch_orchestrator import PatchOrchestrator
from arcanos.config import Config
from rich.console import Console


def test_bridge_postapply_permission_error_reports_failure_after_actual_mutation(
    tmp_path, monkeypatch,
):
    root = tmp_path / "workspace"
    root.mkdir()
    subprocess.run(["git", "init", "--quiet", str(root)], check=True, capture_output=True)
    monkeypatch.setenv("ARCANOS_CLI_SANDBOX_ROOT", str(root))
    monkeypatch.setattr(Config, "HISTORY_DB_PATH", tmp_path / "history.db")
    monkeypatch.setattr(Config, "PATCH_BACKUP_DIR", tmp_path / "backups")
    target = root / "sample.txt"
    target.write_bytes(b"old\n")
    patch = "diff --git a/sample.txt b/sample.txt\n--- a/sample.txt\n+++ b/sample.txt\n@@ -1 +1 @@\n-old\n+new\n"
    original_run = patch_handler.run_bounded_process
    original_validation = patch_handler._validate_patch_targets
    observed = {"applied": False, "permission_raised": False}

    def apply_and_observe(argv, **kwargs):
        result = original_run(argv, **kwargs)
        if "apply" in argv:
            assert result.exit_code == 0
            assert target.read_bytes() == b"new\n"
            observed["applied"] = True
        return result

    def reject_after_apply(*args, **kwargs):
        if observed["applied"] and not observed["permission_raised"]:
            observed["permission_raised"] = True
            raise PermissionError(
                "Authorization: Token example-postapply-credential\n"
                "<vbl sev3>private postapply diagnostic"
            )
        return original_validation(*args, **kwargs)

    monkeypatch.setattr(patch_handler, "run_bounded_process", apply_and_observe)
    monkeypatch.setattr(patch_handler, "_validate_patch_targets", reject_after_apply)
    audit = MagicMock()
    monkeypatch.setattr(local_bridge, "log_audit_event", audit)
    monkeypatch.setattr(patch_handler, "log_audit_event", audit)
    bridge = local_bridge.LocalBridge(port=0)
    job = local_bridge.BridgePatchJob(
        "fixture-patch-audit", patch, "fixture-proposal", 5, str(root),
        local_bridge._BridgeJobLifecycle(time.monotonic() + 10),
    )
    bridge.jobs.put(job)
    bridge.jobs.put(None)

    bridge._worker_loop()

    _, result = job.lifecycle.snapshot()
    assert observed == {"applied": True, "permission_raised": True}
    assert target.read_bytes() == b"new\n"
    assert result["status"] == "error"
    assert result["ok"] is False and result["exitCode"] is None
    assert set(result) == {
        "ok", "status", "stdout", "stderr", "exitCode", "durationMs",
        "truncated", "auditId",
    }
    events = [call.args[0] for call in audit.call_args_list]
    assert events.count("daemon.patch.recovery_registered") == 1
    assert events.count("daemon.patch.failed") == 1
    assert "daemon.patch.denied" not in events
    assert "daemon.patch.applied" not in events
    assert "example-postapply-credential" not in repr(audit.call_args_list) + repr(result)
    assert "private postapply diagnostic" not in repr(audit.call_args_list) + repr(result)
    rows = HistoryDB().recent_patches()
    assert len(rows) == 1 and rows[0].status == "failed"
    assert Path(rows[0].backups["sample.txt"]).read_bytes() == b"old\n"


@pytest.mark.parametrize("kind", ["command", "patch"])
@pytest.mark.parametrize("policy_state", ["safe_mode", "unavailable"])
def test_bridge_policy_gate_denial_has_one_sanitized_audit(
    tmp_path, monkeypatch, kind, policy_state,
):
    monkeypatch.setenv("ARCANOS_CLI_SANDBOX_ROOT", str(tmp_path))
    monkeypatch.setenv("ARCANOS_CLI_BRIDGE_TOKEN", "synthetic-bridge-token")
    secret = "example-policy-credential"
    private = "synthetic-private-record"
    if policy_state == "safe_mode":
        history = HistoryDB(tmp_path / "history.db")
        PolicyGuard(history).enable_safe_mode("fixture", "operator enabled")
        monkeypatch.setattr(local_bridge, "HistoryDB", lambda: history)
    else:
        def unavailable_history():
            raise PermissionError(f"Authorization: Token {secret}\n<vbl sev3>{private}")
        monkeypatch.setattr(local_bridge, "HistoryDB", unavailable_history)
    audit = MagicMock()
    monkeypatch.setattr(local_bridge, "log_audit_event", audit)
    executor = MagicMock(side_effect=AssertionError("denied action must not execute"))
    monkeypatch.setattr(local_bridge.subprocess, "Popen", executor)
    monkeypatch.setattr(local_bridge, "apply_authorized_patch", executor)
    bridge = local_bridge.LocalBridge(port=0)
    job_type = local_bridge.BridgePatchJob if kind == "patch" else local_bridge.BridgeJob
    job = job_type(
        "bridge-fixture-audit", f"Authorization: Token {secret}\n<vbl sev3>{private}",
        "fixture-proposal", 1, str(tmp_path),
        local_bridge._BridgeJobLifecycle(time.monotonic() + 5),
    )
    bridge.jobs.put(job)
    bridge.jobs.put(None)

    bridge._worker_loop()

    phase, result = job.lifecycle.snapshot()
    assert phase == "finished"
    assert result["status"] == "blocked"
    assert result["ok"] is False
    assert result["exitCode"] is None
    assert set(result) == {
        "ok", "status", "stdout", "stderr", "exitCode", "durationMs",
        "truncated", "auditId",
    }
    executor.assert_not_called()
    audit.assert_called_once()
    assert audit.call_args.args == (f"daemon.{kind}.denied",)
    assert audit.call_args.kwargs["outcome"] == "blocked"
    assert audit.call_args.kwargs["audit_id"] == job.audit_id
    assert audit.call_args.kwargs["source"] == "local_bridge"
    assert secret not in repr(audit.call_args) + repr(result)
    assert private not in repr(audit.call_args) + repr(result)


@pytest.mark.parametrize(
    "completion,event,status,exit_code",
    [
        ("patch_permission", "daemon.patch.recovery_registered", "error", None),
        ("command_permission", "daemon.command.failed", "blocked", None),
        ("timeout", "daemon.command.timeout", "timeout", None),
        ("failed", "daemon.command.failed", "failed", 7),
        ("success", "daemon.command.completed", "completed", 0),
    ],
)
def test_bridge_other_completion_audits_are_not_duplicated_as_policy_denials(
    monkeypatch, completion, event, status, exit_code,
):
    audit = MagicMock()
    monkeypatch.setattr(local_bridge, "log_audit_event", audit)
    bridge = local_bridge.LocalBridge(port=0)
    private_output = "<vbl sev3>synthetic-private-record"
    credential_output = "Authorization: Token synthetic-credential"

    def execute(_job):
        local_bridge.log_audit_event(event, audit_id="fixture-audit")
        if completion.endswith("permission"):
            raise PermissionError(f"{credential_output}\n{private_output}")
        if completion == "timeout":
            raise TimeoutError(f"{credential_output}\n{private_output}")
        return credential_output, private_output, exit_code

    is_patch = completion == "patch_permission"
    monkeypatch.setattr(bridge, "_apply_patch" if is_patch else "_run_command", execute)
    job_type = local_bridge.BridgePatchJob if is_patch else local_bridge.BridgeJob
    job = job_type(
        "fixture-audit", "synthetic-payload", "fixture-proposal", 1, None,
        local_bridge._BridgeJobLifecycle(time.monotonic() + 5),
    )
    bridge.jobs.put(job)
    bridge.jobs.put(None)

    bridge._worker_loop()

    _, result = job.lifecycle.snapshot()
    if is_patch:
        assert audit.call_count == 2
        audit.assert_any_call(event, audit_id="fixture-audit")
        audit.assert_any_call(
            "daemon.patch.failed", audit_id="fixture-audit", error_type="PermissionError",
        )
    else:
        audit.assert_called_once_with(event, audit_id="fixture-audit")
    assert result["status"] == status
    assert result["exitCode"] == exit_code
    assert "synthetic-credential" not in repr(audit.call_args) + repr(result)
    assert "synthetic-private-record" not in repr(audit.call_args) + repr(result)


@pytest.mark.parametrize("size", [13000, 16385])
def test_local_agent_owns_its_output_bound_and_reports_any_truncation(tmp_path, size):
    raw = "x" * size
    output, truncated = sanitize_handler_output(
        "git.diff", {"diff": raw, "bytes": size, "truncated": False},
        workspace_root=tmp_path,
    )
    if size < 16384:
        assert output["diff"] == raw
        assert truncated is False
    else:
        assert truncated is True
        assert output["diff"] != raw


@pytest.mark.parametrize("adapter", ["bridge", "local-agent"])
@pytest.mark.parametrize("partial_failure", [False, True])
def test_remote_patch_history_makes_success_and_partial_failure_rollback_addressable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, adapter: str, partial_failure: bool,
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    subprocess.run(["git", "init", "--quiet", str(root)], check=True, capture_output=True)
    monkeypatch.chdir(root)
    monkeypatch.setenv("ARCANOS_CLI_SANDBOX_ROOT", str(root))
    monkeypatch.setattr(Config, "PATCH_BACKUP_DIR", tmp_path / "backups")
    monkeypatch.setattr(Config, "HISTORY_DB_PATH", tmp_path / "history.db")
    target = root / "sample.txt"
    target.write_bytes(b"old\n")
    patch = "diff --git a/sample.txt b/sample.txt\n--- a/sample.txt\n+++ b/sample.txt\n@@ -1 +1 @@\n-old\n+new\n"
    patch_hash = hashlib.sha256(patch.encode()).hexdigest()
    if partial_failure:
        def fail_after_modification(*_args, **_kwargs):
            target.write_bytes(b"partially changed\n")
            raise OSError("synthetic interrupted patch")
        monkeypatch.setattr(patch_handler, "run_bounded_process", fail_after_modification)

    def execute():
        if adapter == "bridge":
            return local_bridge.LocalBridge(port=0)._apply_patch(SimpleNamespace(
                cwd=str(root), audit_id="bridge-audit-1", proposal_id="proposal-1",
                timeout=5, patch=patch,
            ))
        payload = {"patch": patch, "expectedPatchSha256": patch_hash}
        authorization = patch_handler.issue_patch_execution_authorization(payload, authorization_id="evidence-1")
        return handlers.execute_local_agent_action(
            "patch.apply", payload, root, 5000, mutation_authorization=authorization,
        )

    if partial_failure:
        with pytest.raises(OSError, match="synthetic interrupted patch"):
            execute()
    else:
        execute()

    history = HistoryDB()
    rows = history.recent_patches()
    assert len(rows) == 1
    assert rows[0].status == ("failed" if partial_failure else "applied")
    rollback_id = rows[0].rollback_id
    assert history.get_patch(rollback_id)["patch_sha256"] == patch_hash
    monkeypatch.setattr("arcanos.agentic.patch_orchestrator.sys.stdin", SimpleNamespace(isatty=lambda: True))
    monkeypatch.setattr("builtins.input", lambda *_: rollback_id)
    orchestrator = PatchOrchestrator(Console(file=io.StringIO()), history, PolicyGuard(history))
    assert orchestrator.rollback("operator", rollback_id)
    assert target.read_bytes() == b"old\n"
    assert history.get_patch(rollback_id)["status"] == "rolled_back"


def test_daemon_forwards_live_dry_run_control_to_local_agent_thread(monkeypatch: pytest.MonkeyPatch) -> None:
    cli = SimpleNamespace(_daemon_running=False, backend_client=None, dry_run=False)
    monkeypatch.setattr(daemon_ops.Config, "DAEMON_ACCESS_TOKEN", None)
    monkeypatch.setattr(daemon_ops.Config, "ACTION_PLAN_EXECUTION_PROTOCOL_V2_ENABLED", False)
    monkeypatch.setattr(daemon_ops.Config, "LOCAL_AGENT_ENABLED", True)
    thread = MagicMock()
    thread_factory = MagicMock(return_value=thread)
    monkeypatch.setattr(daemon_ops.threading, "Thread", thread_factory)

    daemon_ops.start_daemon_threads(cli)

    should_continue, dry_run = thread_factory.call_args.kwargs["args"]
    assert should_continue() is True
    assert dry_run() is False
    cli.dry_run = True
    assert dry_run() is True


@pytest.mark.parametrize("private_output", ["<vbl sev3>private record", "boot_snapshot: private record"])
def test_bridge_and_local_agent_withhold_private_tool_records(tmp_path: Path, private_output: str) -> None:
    stdout, stderr, _ = local_bridge._truncate_output(private_output, private_output)
    output, _ = sanitize_handler_output("git.diff", {"diff": private_output}, workspace_root=tmp_path)

    assert "private record" not in stdout
    assert "private record" not in stderr
    assert "private record" not in output["diff"]


@pytest.mark.parametrize("error,status", [(TimeoutError(), "timeout"), (RuntimeError(), "error")])
def test_bridge_worker_does_not_invent_an_exit_code_without_a_process_result(
    monkeypatch: pytest.MonkeyPatch, error: Exception, status: str
) -> None:
    bridge = local_bridge.LocalBridge(port=0)
    monkeypatch.setattr(bridge, "_run_command", MagicMock(side_effect=error))
    job = local_bridge.BridgeJob("audit-1", "git status", "proposal-1", 1, None,
                                 local_bridge._BridgeJobLifecycle(time.monotonic() + 5))
    bridge.jobs.put(job)
    bridge.jobs.put(None)

    bridge._worker_loop()

    _, result = job.lifecycle.snapshot()
    assert result["ok"] is False
    assert result["status"] == status
    assert result["exitCode"] is None


def test_bridge_failed_command_is_not_a_successful_audit_event(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(local_bridge, "HistoryDB", lambda: HistoryDB(tmp_path / "history.db"))
    monkeypatch.setenv("ARCANOS_CLI_SANDBOX_ROOT", str(tmp_path))
    process = SimpleNamespace(stdout=io.StringIO(""), stderr=io.StringIO("failure"), wait=lambda **_: 7)
    monkeypatch.setattr(local_bridge.subprocess, "Popen", lambda *_, **__: process)
    audit = MagicMock()
    monkeypatch.setattr(local_bridge, "log_audit_event", audit)

    _, stderr, exit_code = local_bridge.LocalBridge(port=0)._execute_bounded("git status", str(tmp_path), 1)

    assert exit_code == 7
    assert stderr == "failure"
    assert audit.call_args.args[0] == "daemon.command.failed"
    assert audit.call_args.kwargs["outcome"] == "failed"


@pytest.mark.parametrize("kind", ["command", "patch"])
def test_loopback_bridge_rechecks_persisted_safe_mode_before_execution(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kind: str
) -> None:
    history = HistoryDB(tmp_path / "history.db")
    PolicyGuard(history).enable_safe_mode("test", "operator enabled")
    monkeypatch.setattr(local_bridge, "HistoryDB", lambda: history, raising=False)
    monkeypatch.setenv("ARCANOS_CLI_SANDBOX_ROOT", str(tmp_path))
    bridge = local_bridge.LocalBridge(port=0)
    executor = MagicMock(side_effect=AssertionError("executor must not run in safe mode"))
    monkeypatch.setattr(local_bridge.subprocess, "Popen", executor)
    monkeypatch.setattr(local_bridge, "apply_authorized_patch", executor)

    with pytest.raises(PermissionError, match="safe mode"):
        if kind == "command":
            bridge._execute_bounded("git status", str(tmp_path), 1)
        else:
            bridge._apply_patch(SimpleNamespace(
                cwd=str(tmp_path), audit_id="patch-1", proposal_id="patch-proposal",
                timeout=1,
                patch="diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n",
            ))

    executor.assert_not_called()


@pytest.mark.parametrize("action", ["tests.run", "patch.apply"])
def test_local_agent_mutating_handlers_respect_persisted_safe_mode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, action: str
) -> None:
    history = HistoryDB(tmp_path / "history.db")
    PolicyGuard(history).enable_safe_mode("test", "operator enabled")
    monkeypatch.setattr(handlers, "HistoryDB", lambda: history, raising=False)
    executor = MagicMock(side_effect=AssertionError("mutating handler must not run in safe mode"))
    monkeypatch.setattr(handlers, "build_local_agent_handler_registry", lambda: {action: executor})
    payload = {"profile": "python-unit"} if action == "tests.run" else {
        "patch": "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n",
        "expectedPatchSha256": "a" * 64,
    }

    with pytest.raises(PermissionError, match="safe mode"):
        handlers.execute_local_agent_action(action, payload, tmp_path, 1000)
    executor.assert_not_called()


@pytest.mark.parametrize("scheme", ["Token", "ApiKey", "OAuth", "Negotiate", "Custom"])
def test_local_agent_feedback_uses_existing_short_credential_protection(
    tmp_path: Path, scheme: str
) -> None:
    output, truncated = sanitize_handler_output(
        "git.diff",
        {
            "diff": f"Authorization: {scheme} sunshine\nThe command failed.\n",
            "bytes": 64,
            "truncated": False,
        },
        workspace_root=tmp_path,
    )

    assert "sunshine" not in output["diff"]
    assert "The command failed." in output["diff"]
    assert truncated is False


@pytest.mark.parametrize("dispatch", [daemon_ops.handle_daemon_command, cli_daemon.handle_daemon_command])
def test_backend_notification_does_not_display_credentials_or_markup(dispatch) -> None:
    cli = SimpleNamespace(console=MagicMock(), _append_activity=MagicMock())
    command = DaemonCommand(
        id="notification-1",
        name="notify",
        payload={"message": "Authorization: Token sunshine\n[link=https://example.test]failed[/link]"},
        issuedAt="2026-10-30T00:00:00Z",
    )

    assert dispatch(cli, command) is True

    displayed = repr(cli.console.print.call_args_list)
    assert "sunshine" not in displayed
    assert "failed" in displayed
    assert cli.console.print.call_args.kwargs.get("markup") is False


@pytest.mark.parametrize("dispatch", [daemon_ops.handle_daemon_command, cli_daemon.handle_daemon_command])
def test_daemon_command_requires_matching_proposal_in_both_adapters(dispatch) -> None:
    cli = SimpleNamespace(console=MagicMock(), _append_activity=MagicMock(), handle_run=MagicMock())
    command = DaemonCommand(
        id="run-1", name="run", payload={"command": "git status", "proposalId": "different-action"},
        issuedAt="2026-10-30T00:00:00Z",
    )

    dispatch(cli, command)

    cli.handle_run.assert_not_called()


def _submitted_action_result(execution):
    journal = MagicMock()
    runner = ActionPlanExecutionRunner(
        client=MagicMock(), journal=journal, expected_realm="local:test",
        executor_principal_id="principal", executor_instance_id="instance",
        assigned_agent_id="agent", console=MagicMock(),
        run_handler=MagicMock(return_value=execution), confirm_prompt=MagicMock(return_value=True),
        key_factory=lambda: "result-key",
    )
    runner._submit_pending = MagicMock()
    assignment = SimpleNamespace(
        capability="terminal.run", action_snapshot={"params": {"command": "git status"}},
        run_id="run-1", action_id="action-1", snapshot_id="snapshot-1", timeout_ms=1000,
    )
    runner._execute_and_submit(assignment)
    return journal.save_pending_result.call_args.kwargs["result"]


def test_action_plan_feedback_retains_confirmed_success_metadata_without_private_output() -> None:
    result = _submitted_action_result(
        {"ok": True, "return_code": 0, "stdout": "private command output", "stderr": ""}
    )

    assert result["outcome"] == "succeeded"
    assert result["output"] == {"return_code": 0, "status": "executed"}
    assert "private command output" not in repr(result)


@pytest.mark.parametrize("exit_code,category", [(7, "exit_7"), (-9, "exit_negative_9")])
def test_action_plan_feedback_preserves_failed_exit_in_existing_error_shape(exit_code, category) -> None:
    result = _submitted_action_result({"ok": False, "return_code": exit_code})

    assert result["outcome"] == "failed"
    assert result["error"]["category"] == category
    assert "output" not in result


@pytest.mark.parametrize("category", ["dry_run", "policy"])
def test_action_plan_feedback_preserves_blocked_or_proposed_reason(category) -> None:
    result = _submitted_action_result({"ok": False, "return_code": None, "error_category": category})

    assert result["outcome"] == "failed"
    assert result["error"]["category"] == category
    assert "output" not in result
