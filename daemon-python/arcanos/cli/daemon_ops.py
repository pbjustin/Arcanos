"""
Daemon heartbeat, polling, and command lifecycle operations.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from typing import TYPE_CHECKING

from ..backend_client import BackendRequestError
from ..cli_types import DaemonCommand
from ..config import Config
from ..error_handler import logger as error_logger
from . import backend_ops

if TYPE_CHECKING:
    from .cli import ArcanosCLI


_PLACEHOLDER_TOKENS = {"REPLACE_WITH_BACKEND_TOKEN", ""}

_INITIAL_HEARTBEAT_DELAY_S = 2
_MAX_BACKOFF_S = 120
_MAX_BACKOFF_EXPONENT = 4


def start_daemon_threads(cli: "ArcanosCLI") -> None:
    """
    Purpose: Launch daemon background threads for heartbeat and command polling.
    Inputs/Outputs: CLI instance; starts daemon threads when backend/token are valid.
    Edge cases: Returns early when already running, backend missing, or token placeholder.
    """
    if cli._daemon_running:
        return

    generic_ready = bool(
        cli.backend_client
        and (Config.BACKEND_TOKEN or "") not in _PLACEHOLDER_TOKENS
    )
    execution_ready = bool(Config.ACTION_PLAN_EXECUTION_PROTOCOL_V2_ENABLED)
    local_agent_ready = bool(Config.LOCAL_AGENT_ENABLED)
    if not generic_ready and not execution_ready and not local_agent_ready:
        # //audit assumption: placeholder tokens cannot authenticate; risk: repeated 429/noise; invariant: skip thread startup with placeholder token; strategy: guard and log once.
        error_logger.info("[DAEMON] Skipping daemon threads: BACKEND_TOKEN is not configured.")
        return

    cli._daemon_running = True

    if generic_ready:
        cli._heartbeat_thread = threading.Thread(target=cli._heartbeat_loop, daemon=True, name="daemon-heartbeat")
        cli._heartbeat_thread.start()

        cli._command_poll_thread = threading.Thread(
            target=cli._command_poll_loop,
            daemon=True,
            name="daemon-command-poll",
        )
        cli._command_poll_thread.start()

    if execution_ready:
        from ..action_plan_execution_runner import action_plan_execution_loop

        cli._action_plan_execution_thread = threading.Thread(
            target=action_plan_execution_loop,
            args=(cli,),
            daemon=True,
            name="action-plan-execution-poll",
        )
        cli._action_plan_execution_thread.start()

    if local_agent_ready:
        from ..local_agent.runner import local_agent_execution_loop

        cli._local_agent_execution_thread = threading.Thread(
            target=local_agent_execution_loop,
            args=(lambda: cli._daemon_running,),
            daemon=True,
            name="local-agent-execution-poll",
        )
        cli._local_agent_execution_thread.start()


def heartbeat_loop(cli: "ArcanosCLI") -> None:
    """
    Purpose: Background thread that sends periodic heartbeats to backend.
    Inputs/Outputs: CLI instance; runs until daemon service stops.
    Edge cases: Applies exponential backoff for HTTP 429 responses.
    """
    time.sleep(_INITIAL_HEARTBEAT_DELAY_S)
    last_request_time = time.time()
    consecutive_429_count = 0

    while cli._daemon_running:
        try:
            if not cli.backend_client:
                break

            uptime = time.time() - cli.start_time
            request_start = time.time()
            _time_since_last = request_start - last_request_time

            response = backend_ops.request_daemon_heartbeat(cli, uptime=uptime)

            _request_duration = time.time() - request_start
            last_request_time = time.time()
            status_code = response.status_code
            retry_after = response.headers.get("Retry-After")

            if status_code == 429:
                consecutive_429_count += 1
                backoff_time = min(
                    _MAX_BACKOFF_S,
                    cli._heartbeat_interval * (2 ** min(consecutive_429_count, _MAX_BACKOFF_EXPONENT)),
                )
                if retry_after:
                    try:
                        backoff_time = max(backoff_time, int(retry_after))
                    except ValueError:
                        pass
                error_logger.warning(
                    "[DAEMON] Heartbeat rate limited (429); backing off %ds (Retry-After respected)",
                    backoff_time,
                )
                time.sleep(backoff_time)
                continue
            elif status_code != 200:
                consecutive_429_count = 0
                error_logger.error(f"[DAEMON] Heartbeat failed: {response.status_code}")
            else:
                consecutive_429_count = 0

        except Exception as exc:
            consecutive_429_count = 0
            error_logger.error(f"[DAEMON] Heartbeat error: {exc}")

        time.sleep(cli._heartbeat_interval)


def command_poll_loop(cli: "ArcanosCLI") -> None:
    """
    Purpose: Background thread that polls backend command queue and dispatches commands.
    Inputs/Outputs: CLI instance; runs until stopped or backend auth fails.
    Edge cases: Applies exponential backoff for HTTP 429 responses.
    """
    last_request_time = time.time()
    consecutive_429_count = 0

    while cli._daemon_running:
        try:
            if not cli.backend_client:
                break

            request_start = time.time()
            _time_since_last = request_start - last_request_time

            response = backend_ops.request_daemon_commands(cli)

            _request_duration = time.time() - request_start
            last_request_time = time.time()
            status_code = response.status_code
            retry_after = response.headers.get("Retry-After")

            if status_code == 200:
                consecutive_429_count = 0
                data = response.json()
                commands = data.get("commands", [])

                if commands:
                    command_ids = []
                    for cmd_data in commands:
                        try:
                            command = DaemonCommand(
                                id=cmd_data["id"],
                                name=cmd_data["name"],
                                payload=cmd_data["payload"],
                                issuedAt=cmd_data["issuedAt"],
                            )
                            handled = cli._handle_daemon_command(command)
                            if handled is not False:
                                command_ids.append(command.id)
                        except Exception as exc:
                            error_logger.error(f"[DAEMON] Error handling command {cmd_data.get('id')}: {exc}")

                    if command_ids:
                        try:
                            ack_response = backend_ops.acknowledge_daemon_commands(cli, command_ids)
                            if ack_response.status_code != 200:
                                error_logger.error(f"[DAEMON] Command ack failed: {ack_response.status_code}")
                        except Exception as exc:
                            error_logger.error(f"[DAEMON] Command ack error: {exc}")

            elif status_code == 401:
                consecutive_429_count = 0
                # //audit assumption: backend auth failure invalidates daemon polling; risk: unauthorized request loop; invariant: polling stops on 401; strategy: break loop.
                error_logger.warning("[DAEMON] Authentication failed, stopping command polling")
                break
            elif status_code == 429:
                consecutive_429_count += 1
                backoff_time = min(
                    _MAX_BACKOFF_S,
                    cli._command_poll_interval * (2 ** min(consecutive_429_count, _MAX_BACKOFF_EXPONENT)),
                )
                if retry_after:
                    try:
                        backoff_time = max(backoff_time, int(retry_after))
                    except ValueError:
                        pass
                error_logger.warning(
                    "[DAEMON] Command poll rate limited (429); backing off %ds (Retry-After respected)",
                    backoff_time,
                )
                time.sleep(backoff_time)
                continue
            else:
                consecutive_429_count = 0
                error_logger.error(f"[DAEMON] Command poll failed: {response.status_code}")

        except BackendRequestError as exc:
            consecutive_429_count = 0
            error_logger.error(f"[DAEMON] Command poll request error: {exc}")
        except Exception as exc:
            consecutive_429_count = 0
            error_logger.error(f"[DAEMON] Command poll error: {exc}")

        time.sleep(cli._command_poll_interval)


def handle_daemon_command(cli: "ArcanosCLI", command: DaemonCommand) -> bool:
    """
    Purpose: Handle daemon commands delivered from backend polling.
    Inputs/Outputs: typed daemon command; dispatches command side effects.
    Edge cases: Unsupported or malformed payloads emit warnings and no-op safely.
    """
    command_name = command.name
    command_payload = command.payload or {}
    activity_detail = (
        command_name
        if command_name == "action_plan"
        else f"{command_name}: {command_payload}"
    )
    cli._append_activity("command", activity_detail)

    if command_name == "ping":
        pass

    elif command_name == "get_status":
        pass

    elif command_name == "get_stats":
        pass

    elif command_name == "run":
        command_text = command_payload.get("command") if isinstance(command_payload, dict) else None
        proposal_id = command_payload.get("proposalId") if isinstance(command_payload, dict) else None
        if isinstance(command_text, str) and command_text.strip():
            cwd = os.path.realpath(os.getcwd())
            expected_proposal_id = _hash_command_proposal(command_text.strip(), cwd)
            if proposal_id != expected_proposal_id:
                cli.console.print("[yellow]Run command rejected: proposalId mismatch or missing[/yellow]")
                return True
            cli.handle_run(command_text.strip())
        else:
            cli.console.print("[yellow]Run command missing 'command' payload[/yellow]")

    elif command_name == "see":
        use_camera = False
        if isinstance(command_payload, dict):
            use_camera = bool(command_payload.get("use_camera", False))
        cli.handle_see(["camera"] if use_camera else [])

    elif command_name == "notify":
        message = command_payload.get("message") if isinstance(command_payload, dict) else None
        if message and isinstance(message, str):
            cli.console.print(f"[cyan]Backend message:[/cyan] {message}")
        else:
            cli.console.print("[yellow]Notify command missing message[/yellow]")

    elif command_name == "action_plan":
        if not Config.ACTION_PLAN_LEGACY_CHARACTERIZATION_TEST_SEAM:
            cli.console.print(
                "[yellow]Legacy action_plan command refused: dedicated execution assignment required[/yellow]"
            )
            return False
        if isinstance(command_payload, dict):
            from ..action_plan_handler import handle_action_plan

            handle_action_plan(
                plan_data=command_payload,
                console=cli.console,
                backend_client=cli.backend_client,
                instance_id=cli.instance_id,
                run_handler=cli.handle_run,
                confirm_prompt=lambda msg: cli._confirm_action(msg),
            )
        else:
            cli.console.print("[yellow]action_plan command missing payload[/yellow]")

    else:
        cli.console.print(f"[yellow]Unsupported command: {command_name}[/yellow]")

    return True


def _hash_command_proposal(command_text: str, cwd: str) -> str:
    payload = json.dumps(
        {"kind": "command", "command": command_text, "cwd": cwd},
        separators=(",", ":"),
    )
    return f"cli-{hashlib.sha256(payload.encode('utf-8')).hexdigest()[:16]}"


def stop_daemon_service(cli: "ArcanosCLI") -> None:
    """
    Purpose: Stop background daemon threads safely.
    Inputs/Outputs: CLI instance; joins heartbeat/poll threads with timeout.
    Edge cases: No-op when threads are absent.
    """
    cli._daemon_running = False
    if cli._heartbeat_thread:
        cli._heartbeat_thread.join(timeout=5.0)
    if cli._command_poll_thread:
        cli._command_poll_thread.join(timeout=5.0)
    execution_thread = getattr(cli, "_action_plan_execution_thread", None)
    if execution_thread:
        execution_thread.join(timeout=5.0)
    local_agent_thread = getattr(cli, "_local_agent_execution_thread", None)
    if local_agent_thread:
        local_agent_thread.join(timeout=5.0)


__all__ = [
    "command_poll_loop",
    "handle_daemon_command",
    "heartbeat_loop",
    "start_daemon_threads",
    "stop_daemon_service",
]
