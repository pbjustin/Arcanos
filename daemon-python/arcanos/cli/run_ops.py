"""
Terminal command execution operations for the CLI.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping, Optional, TYPE_CHECKING

from .audit import record as audit_record
from .cli_policy import redact_output
from .execute import execute as governed_execute
from .governance import GovernanceError, assert_allowed
from .idempotency import command_fingerprint

from ..agentic.history_db import HistoryDB
from ..agentic.policy_guard import PolicyGuard
from ..config import Config
from ..voice_boundary import sanitize_tool_output
from . import state

if TYPE_CHECKING:
    from .cli import ArcanosCLI


def handle_run(
    cli: "ArcanosCLI",
    command: str,
    return_result: bool = False,
    *,
    activity_detail: Optional[str] = None,
    audit_payload: Optional[Mapping[str, Any]] = None,
    timeout_seconds: Optional[int] = None,
) -> Optional[dict]:
    """
    Purpose: Execute a terminal command through governance and idempotency guards.
    Inputs/Outputs: command string and return_result flag; prints output or returns structured result.
    Edge cases: Rejects empty commands and duplicate fingerprints.
    """
    # Capture the exact immutable operation before confirmation. A mutable
    # proposal or later configuration change cannot replace the approved action.
    command = str(command or "")
    cwd = str(Path.cwd().resolve())
    elevated = Config.RUN_ELEVATED
    fp = command_fingerprint("run", {"command": command, "cwd": cwd, "elevated": elevated})
    cli._append_activity("run", activity_detail if activity_detail is not None else f"command:{fp}")
    result: dict[str, Any] = {
        "ok": False, "action_id": fp, "action_type": "command",
        "approval_status": "unapproved", "status": "blocked",
        "return_code": None, "workspace_changed": False,
    }
    history = None
    guard = None

    def finish() -> Optional[dict]:
        if history is not None:
            try:
                history.log_command(
                    cli.instance_id, command, result["status"], result["return_code"],
                    result.get("stdout") or "", result.get("stderr") or "",
                )
            except Exception:
                # A persistence failure cannot rewrite an observed exit code.
                result["history_recorded"] = False
                result["warning"] = "The command outcome is retained, but local records are incomplete."
                try:
                    audit_record("command_history_failed", action_id=fp)
                except Exception:
                    pass
        if return_result:
            return result
        for key in ("stdout", "stderr", "error", "warning"):
            if result.get(key):
                cli.console.print(str(result[key]), markup=False)
        cli.console.print(f"Command {result['status']}; exit code: {result['return_code']}", markup=False)
        return None

    if not command.strip():
        result["error"] = "No command specified"
        return finish()
    if getattr(cli, "dry_run", False) is True:
        result.update(status="proposed", error="dry_run")
        return finish()
    try:
        state.recompute_trust_state(cli)
        assert_allowed("run", cli._trust_state, True)
        history = HistoryDB()
        guard = PolicyGuard(history)
        if guard.is_safe_mode():
            result["error"] = "safe mode is enabled (commands disabled)"
            return finish()
        is_safe, reason = cli.terminal.is_command_safe(command)
        if not is_safe:
            result["error"] = redact_output(reason or "command blocked by terminal policy")
            return finish()
        display_command = redact_output(command, apply_truncation=False)
        if cli._confirm_action(f"Run command in {cwd}?\n{display_command}") is not True:
            result.update(approval_status="denied", error="command_confirmation_denied")
            return finish()
        result["approval_status"] = "approved"
        # Recheck mutable execution controls after the operator has responded.
        if getattr(cli, "dry_run", False) is True:
            result.update(status="proposed", error="dry_run")
            return finish()
        if str(Path.cwd().resolve()) != cwd:
            result["error"] = "command_approval_context_changed"
            return finish()
        state.recompute_trust_state(cli)
        decision = guard.check_command(command)
        if not decision.allowed:
            result["error"] = redact_output(decision.reason)
            return finish()
        audit_record("retry_check", command="run", fingerprint=fp)
        if not cli._idempotency_guard.check_and_record(fp):
            audit_record("retry_duplicate_rejected", command="run", fingerprint=fp)
            result["error"] = "Duplicate command rejected"
            return finish()

        def _do_run():
            result.update(status="failed", workspace_changed=None)
            execute_kwargs: dict[str, Any] = {"elevated": elevated}
            if timeout_seconds is not None:
                execute_kwargs["timeout"] = timeout_seconds
            execution = cli.terminal.execute(command, **execute_kwargs)
            if not isinstance(execution, tuple) or len(execution) != 3:
                raise ValueError("unconfirmed_terminal_result")
            stdout, stderr, return_code = execution
            if isinstance(return_code, bool) or not isinstance(return_code, int):
                raise ValueError("unconfirmed_terminal_exit_code")
            return stdout, stderr, return_code

        stdout, stderr, return_code = governed_execute(
            "run",
            _do_run,
            trust_state=cli._trust_state,
            requires_confirmation=True,
            payload=dict(audit_payload) if audit_payload is not None else {"action_id": fp},
        )
        result.update(
            ok=return_code == 0, status="succeeded" if return_code == 0 else "failed",
            stdout=sanitize_tool_output(stdout or ""), stderr=sanitize_tool_output(stderr or ""),
            return_code=return_code,
        )
        if return_code != 0:
            result["error"] = "command_exited_nonzero"
        try:
            cli.memory.increment_stat("terminal_commands")
            if return_code == 0:
                guard.record_success()
            else:
                guard.record_failure(cli.instance_id, "command", {"action_id": fp, "return_code": return_code})
        except Exception as exc:
            result["bookkeeping_recorded"] = False
            result["warning"] = "The command outcome is retained, but local records are incomplete."
            try:
                audit_record("command_bookkeeping_failed", action_id=fp, error_type=type(exc).__name__)
            except Exception:
                pass
    except GovernanceError:
        result["error"] = "governance_denied"
    except Exception as exc:
        # Dependency exceptions can contain commands, credentials, or private
        # output. Keep categorical diagnostics and any already observed exit.
        result["error"] = f"command_{type(exc).__name__}"
        try:
            audit_record("command_failed", action_id=fp, error_type=type(exc).__name__)
        except Exception:
            pass
        if guard is not None and result["status"] == "failed" and result["return_code"] is None:
            try:
                guard.record_failure(cli.instance_id, "command", {"action_id": fp, "error_type": type(exc).__name__})
            except Exception:
                result["policy_recorded"] = False
    return finish()


def handle_action_plan_run(
    cli: "ArcanosCLI",
    command: str,
    *,
    execution_identity: str,
    timeout_seconds: Optional[int] = None,
) -> dict[str, Any]:
    """Run one assigned action while keeping commands and dependency errors out of diagnostics."""
    activity_detail = f"action-plan-execution:{execution_identity}"
    safe_payload = {
        "source": "action-plan-execution-v1",
        "run_id": execution_identity,
    }
    cli._append_activity("run", activity_detail)
    if getattr(cli, "dry_run", False) is True:
        return {"ok": False, "return_code": None, "error_category": "dry_run"}
    try:
        if not PolicyGuard(HistoryDB()).check_command(command).allowed:
            return {"ok": False, "return_code": None, "error_category": "policy"}
    except Exception:
        return {"ok": False, "return_code": None, "error_category": "policy"}
    fingerprint = command_fingerprint(
        "action-plan-execution",
        {"run_id": execution_identity},
    )
    audit_record(
        "retry_check",
        command="action-plan-execution",
        fingerprint=fingerprint,
    )
    if not cli._idempotency_guard.check_and_record(fingerprint):
        audit_record(
            "retry_duplicate_rejected",
            command="action-plan-execution",
            fingerprint=fingerprint,
        )
        return {"ok": False, "return_code": None, "error_category": "duplicate"}

    state.recompute_trust_state(cli)
    try:
        stdout, stderr, return_code = governed_execute(
            "run",
            lambda: cli.terminal.execute_action_plan_command(
                command,
                timeout=timeout_seconds or 30,
                elevated=Config.RUN_ELEVATED,
            ),
            trust_state=cli._trust_state,
            requires_confirmation=True,
            payload=safe_payload,
        )
        del stdout, stderr
        if isinstance(return_code, bool) or not isinstance(return_code, int):
            raise ValueError("unconfirmed_terminal_exit_code")
        return {"ok": return_code == 0, "return_code": return_code}
    except GovernanceError:
        category = "governance"
    except TimeoutError:
        category = "timeout"
    except PermissionError:
        category = "permission"
    except (TypeError, ValueError):
        category = "validation"
    except Exception:
        category = "execution"
    try:
        audit_record(
            "action_plan_execution_failed",
            command="action-plan-execution",
            run_id=execution_identity,
            error_category=category,
        )
    except Exception:
        pass
    return {"ok": False, "return_code": None, "error_category": category}


__all__ = ["handle_action_plan_run", "handle_run"]
