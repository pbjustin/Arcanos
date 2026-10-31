from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Any, Optional

from ..config import Config
from ..assistant.translator import translate_response
from ..cli.cli_policy import redact_output
from ..cli.idempotency import command_fingerprint
from ..cli import run_ops, ui_ops
from ..voice_boundary import Persona
from .history_db import HistoryDB
from .patch_orchestrator import PatchOrchestrator
from .policy_guard import PolicyGuard
from .repo_indexer import build_repo_index, to_context_payload


@dataclass
class ToolResult:
    kind: str  # patch|command
    ok: bool
    detail: dict[str, Any]


def _format_followup(results: list[ToolResult]) -> str:
    lines = ["Tool results:"]
    for r in results:
        detail = {"action_type": r.kind, "ok": r.ok, **r.detail}
        lines.append(redact_output(json.dumps(detail, ensure_ascii=False), apply_truncation=False))
    lines.append("Continue with the next step. If no further action is needed, say DONE.")
    return "\n".join(lines)


def _contains_high_risk_shell_tokens(command: str) -> bool:
    """Purpose: detect high-risk shell chaining/injection tokens in LLM-proposed commands."""
    risky_tokens = ("&&", "||", ";", "|", "`", "$(", "${", "<(", ">(", "\n", "\r", "&", ">", "<")
    lowered = command.lower()
    return any(token in lowered for token in risky_tokens)


def run_agentic_loop(cli: Any, user_message: str, *, domain: Optional[str], from_debug: bool) -> None:
    """Multi-step loop: ask backend -> detect proposals -> request approval -> execute -> send tool results back.

    Notes:
    - We translate raw backend output for a clean, assistant-like UX.
    - Complete approved answers remain visible alongside approval-gated proposals.
    """
    history = HistoryDB()
    guard = PolicyGuard(history)
    orchestrator = PatchOrchestrator(cli.console, history, guard)

    root_user_message = user_message
    prompt = user_message

    for _ in range(max(1, int(Config.AGENT_MAX_STEPS))):
        # Call backend for this step (return_result=True avoids recursion / streaming UX)
        convo = cli.handle_ask(
            prompt,
            route_override="backend",
            speak_response=False,
            return_result=True,
            from_debug=from_debug,
        )
        if convo is None:
            return
        response_text = getattr(convo, "response_text", None)

        # Translate and extract proposals.
        tr = translate_response(
            root_user_message,
            response_text,
            source="backend",
            debug=from_debug,
            suppress_proposals_in_display=False,
            presentation=getattr(convo, "presentation", None),
        )
        ui_ops.speak_to_user(
            cli,
            response_text,
            persona=Persona.CALM,
            user_text=root_user_message,
            memory=cli.memory,
            debug_voice=from_debug,
            filtered_text=tr.message if tr.should_show else None,
        )
        if not isinstance(response_text, str) or not response_text:
            return

        history.log_message(cli.instance_id, "user", prompt)
        history.log_message(cli.instance_id, "assistant", tr.message if tr.should_show else "")

        patches = tr.patches
        commands = tr.commands

        if not patches and not commands:
            return

        results: list[ToolResult] = []

        for p in patches:
            res = orchestrator.apply_with_approval(
                cli.instance_id, p.patch_text, summary="assistant proposed patch",
                dry_run=lambda: getattr(cli, "dry_run", False) is True,
            )
            results.append(ToolResult("patch", res.ok, {
                "action_id": res.rollback_id, "rollback_id": res.rollback_id,
                "files": res.files, "error": res.error,
                "status": getattr(res, "status", "succeeded" if res.ok else "blocked"),
                "approval_status": "approved" if getattr(res, "approved", False) else (
                    "denied" if getattr(res, "status", "") == "denied" else "unapproved"
                ),
                "workspace_changed": getattr(res, "workspace_changed", None),
                "return_code": getattr(res, "exit_code", None),
            }))

        for c in commands:
            command = c.command
            action_id = command_fingerprint("agentic-command", {"command": command})
            display_command = redact_output(command)
            cli.console.print("\n[bold]=== ARCANOS COMMAND PROPOSAL ===[/bold]")
            cli.console.print(f"Command:\n{display_command}\nReason: {redact_output(c.reason)}", markup=False)
            cli.console.print("[dim]Safety: policy checked, explicit confirmation required, output redacted in history.[/dim]")
            if _contains_high_risk_shell_tokens(command):
                # //audit assumption: agentic commands should be single-step and non-chained; risk: prompt-injected multi-command execution; invariant: high-risk shell token commands are blocked; strategy: deny and require manual rewrite.
                reason = "High-risk shell chaining token detected in command proposal"
                cli.console.print(f"[red]Blocked:[/red] {reason}")
                results.append(ToolResult("command", False, {"action_id": action_id, "command": display_command, "status": "blocked", "approval_status": "unapproved", "error": reason, "workspace_changed": False}))
                continue
            is_safe, reason = cli.terminal.is_command_safe(command)
            if not is_safe:
                cli.console.print(f"Blocked: {redact_output(reason or 'command blocked by terminal policy')}", markup=False)
                results.append(ToolResult("command", False, {"action_id": action_id, "command": display_command, "status": "blocked", "approval_status": "unapproved", "error": redact_output(reason or "command blocked by terminal policy"), "workspace_changed": False}))
                continue

            execution = run_ops.handle_run(
                cli, command, return_result=True, timeout_seconds=Config.REQUEST_TIMEOUT,
            )
            results.append(ToolResult("command", execution["ok"], {"command": display_command, **execution}))

        prompt = _format_followup(results)
        if getattr(cli, "dry_run", False) is True:
            # Dry-run proposals must not launch Git for an audit snapshot.
            continue
        # snapshot state for audit/replay
        try:
            import subprocess
            from pathlib import Path

            repo_index_context: dict[str, Any] = {}
            if hasattr(cli, "_build_backend_metadata"):
                # //audit assumption: metadata builder may be unavailable or return non-dict values; risk: snapshot serialization failure; invariant: repo index snapshot remains JSON-serializable; handling strategy: default to empty dict when metadata is unusable.
                metadata = cli._build_backend_metadata()
                if isinstance(metadata, dict) and isinstance(metadata.get("repoIndex"), dict):
                    repo_index_context = metadata["repoIndex"]
            if not repo_index_context and Config.REPO_INDEX_ENABLED:
                try:
                    repo_index_context = to_context_payload(build_repo_index())
                except Exception as error:
                    # //audit assumption: repo index failures are non-fatal for loop continuity; risk: silent context loss; invariant: operator sees degraded mode; strategy: print warning and continue with empty context.
                    cli.console.print(redact_output(f"Warning: Failed to build repo index; continuing without it. Error: {error}"), markup=False)
                    repo_index_context = {}

            repo_root = Path(repo_index_context.get("repoRoot") or Path.cwd())
            git_head = ""
            try:
                git_head = subprocess.check_output(["git","rev-parse","HEAD"], cwd=str(repo_root), text=True).strip()
            except Exception:
                git_head = ""
            config_flags = {
                "agentic": Config.AGENTIC_ENABLED,
                "maxSteps": Config.AGENT_MAX_STEPS,
                "repoIndex": Config.REPO_INDEX_ENABLED,
            }
            history.log_snapshot(
                cli.instance_id,
                git_head=git_head,
                repo_root=str(repo_root),
                config=config_flags,
                repo_index=repo_index_context,
            )
        except Exception:
            pass


