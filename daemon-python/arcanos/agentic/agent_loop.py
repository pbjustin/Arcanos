from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

from rich.markdown import Markdown

from ..config import Config
from ..assistant.translator import translate_response
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
        if r.kind == "patch":
            lines.append(f"- patch ok={r.ok} rollback_id={r.detail.get('rollback_id')} files={r.detail.get('files')}")
        else:
            lines.append(f"- command ok={r.ok} rc={r.detail.get('return_code')} cmd={r.detail.get('command')}")
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
    - Patch/command proposals are extracted and (optionally) suppressed from the displayed message.
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
        if convo is None or not getattr(convo, "response_text", None):
            return

        response_text = convo.response_text

        # Translate and extract proposals.
        tr = translate_response(
            root_user_message,
            response_text,
            source="backend",
            debug=from_debug,
            suppress_proposals_in_display=True,
        )
        if tr.should_show and tr.message:
            cli.console.print("\n" + str(Markdown(tr.message)) + "\n")

        history.log_message(cli.instance_id, "user", prompt)
        history.log_message(cli.instance_id, "assistant", response_text)

        patches = tr.patches
        commands = tr.commands

        if not patches and not commands:
            return

        results: list[ToolResult] = []

        for p in patches:
            res = orchestrator.apply_with_approval(cli.instance_id, p.patch_text, summary="assistant proposed patch")
            results.append(ToolResult("patch", res.ok, {"rollback_id": res.rollback_id, "files": res.files, "error": res.error}))

        for c in commands:
            cli.console.print("\n[bold]=== ARCANOS COMMAND PROPOSAL ===[/bold]")
            cli.console.print(f"Command:\n{c.command}\nReason: {c.reason}")
            if _contains_high_risk_shell_tokens(c.command):
                # //audit assumption: agentic commands should be single-step and non-chained; risk: prompt-injected multi-command execution; invariant: high-risk shell token commands are blocked; strategy: deny and require manual rewrite.
                reason = "High-risk shell chaining token detected in command proposal"
                cli.console.print(f"[red]Blocked:[/red] {reason}")
                results.append(ToolResult("command", False, {"command": c.command, "blocked": reason}))
                continue
            is_safe, reason = cli.terminal.is_command_safe(c.command)
            if not is_safe:
                cli.console.print(f"[red]Blocked:[/red] {reason}")
                results.append(ToolResult("command", False, {"command": c.command, "blocked": reason}))
                continue

            ans = input("\nRun command? [y/N] ").strip().lower()
            if ans not in ("y", "yes"):
                results.append(ToolResult("command", False, {"command": c.command, "denied": True}))
                continue

            out, err, rc = cli.terminal.execute(
                c.command,
                timeout=Config.REQUEST_TIMEOUT,
                check_safety=True,
                elevated=Config.RUN_ELEVATED,
            )
            history.log_command(cli.instance_id, c.command, "success" if rc == 0 else "failed", rc, out or "", err or "")
            if rc == 0:
                guard.record_success()
            else:
                guard.record_failure(cli.instance_id, "command", {"command": c.command, "return_code": rc})
            cli.console.print(f"[green]Command finished[/green] rc={rc}")
            results.append(ToolResult("command", rc == 0, {"command": c.command, "return_code": rc, "stdout": out, "stderr": err}))

        prompt = _format_followup(results)
        # snapshot state for audit/replay
        try:
            import subprocess
            from pathlib import Path
            ctx = {}
            if Config.REPO_INDEX_ENABLED:
                try:
                    ctx = to_context_payload(build_repo_index())
                except Exception as error:
                    # //audit assumption: repo index failures are non-fatal for loop continuity; risk: silent context loss; invariant: operator sees degraded mode; strategy: print warning and continue with empty context.
                    cli.console.print(f"[yellow]Warning: Failed to build repo index; continuing without it. Error: {error}[/yellow]")
                    ctx = {}

            repo_root = Path(ctx.get("repoRoot") or Path.cwd())
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
            history.log_snapshot(cli.instance_id, git_head=git_head, repo_root=str(repo_root), config=config_flags, repo_index=ctx)
        except Exception:
            pass


