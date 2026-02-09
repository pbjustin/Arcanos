from __future__ import annotations

import threading
import time

from .backend_client import BackendRequestError
from .cli_types import DaemonCommand
from .config import Config
from .error_handler import logger as error_logger


_PLACEHOLDER_TOKENS = {"REPLACE_WITH_BACKEND_TOKEN", ""}

# Timing constants for daemon background threads
_INITIAL_HEARTBEAT_DELAY_S = 2       # Stagger first heartbeat to avoid race with command poll
_MAX_BACKOFF_S = 120                 # Maximum backoff time (2 minutes) for rate-limited requests
_MAX_BACKOFF_EXPONENT = 4            # Cap exponential backoff at 2^4 = 16x the base interval


def start_daemon_threads(self) -> None:
    """
    Purpose: Launch daemon background threads for heartbeat and polling.
    Inputs/Outputs: None; starts threads when backend is configured.
    Edge cases: Returns early when already running, backend missing, or token is placeholder.
    """
    if self._daemon_running:
        return

    if not self.backend_client:
        return

    # Skip daemon threads when the backend token is an obvious placeholder —
    # unauthenticated heartbeat/poll requests will just get 429'd.
    if (Config.BACKEND_TOKEN or "") in _PLACEHOLDER_TOKENS:
        error_logger.info(
            "[DAEMON] Skipping daemon threads: BACKEND_TOKEN is not configured."
        )
        return

    self._daemon_running = True

    # Start heartbeat thread
    self._heartbeat_thread = threading.Thread(
        target=self._heartbeat_loop,
        daemon=True,
        name="daemon-heartbeat"
    )
    self._heartbeat_thread.start()

    # Start command polling thread
    self._command_poll_thread = threading.Thread(
        target=self._command_poll_loop,
        daemon=True,
        name="daemon-command-poll"
    )
    self._command_poll_thread.start()


def heartbeat_loop(self) -> None:
    """
    Purpose: Background thread that sends periodic heartbeats.
    Inputs/Outputs: None; communicates with backend while running.
    Edge cases: Applies backoff on 429 responses and stops on shutdown.
    """
    # Stagger the first heartbeat so it doesn't race with command poll on startup.
    time.sleep(_INITIAL_HEARTBEAT_DELAY_S)
    last_request_time = time.time()
    consecutive_429_count = 0

    while self._daemon_running:
        try:
            if not self.backend_client:
                break
                
            uptime = time.time() - self.start_time
            request_start = time.time()
            time_since_last = request_start - last_request_time

            # Send heartbeat via backend client
            response = self.backend_client._make_request(
                "POST",
                "/api/daemon/heartbeat",
                json={
                    "clientId": self.client_id,
                    "instanceId": self.instance_id,
                    "version": Config.VERSION,
                    "uptime": uptime,
                    "routingMode": "http",
                    "stats": {}
                }
            )
            
            request_duration = time.time() - request_start
            last_request_time = time.time()
            status_code = response.status_code
            retry_after = response.headers.get("Retry-After")

            if status_code == 429:
                consecutive_429_count += 1
                # 429 = rate limit; back off and log as warning (not connection failure)
                backoff_time = min(_MAX_BACKOFF_S, self._heartbeat_interval * (2 ** min(consecutive_429_count, _MAX_BACKOFF_EXPONENT)))
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

        except Exception as e:
            consecutive_429_count = 0
            error_logger.error(f"[DAEMON] Heartbeat error: {e}")

        # Wait for next heartbeat
        time.sleep(self._heartbeat_interval)


def command_poll_loop(self) -> None:
    """
    Purpose: Background thread that polls the backend for commands.
    Inputs/Outputs: None; processes commands until shutdown.
    Edge cases: Applies backoff on 429 and stops on 401.
    """
    last_request_time = time.time()
    consecutive_429_count = 0

    while self._daemon_running:
        try:
            if not self.backend_client:
                break
                
            request_start = time.time()
            time_since_last = request_start - last_request_time

            # Poll for commands
            response = self.backend_client._make_request(
                "GET",
                f"/api/daemon/commands?instance_id={self.instance_id}"
            )
            
            request_duration = time.time() - request_start
            last_request_time = time.time()
            status_code = response.status_code
            retry_after = response.headers.get("Retry-After")

            if status_code == 200:
                consecutive_429_count = 0
                data = response.json()
                commands = data.get("commands", [])

                if commands:
                    # Process each command
                    command_ids = []
                    for cmd_data in commands:
                        try:
                            command = DaemonCommand(
                                id=cmd_data["id"],
                                name=cmd_data["name"],
                                payload=cmd_data["payload"],
                                issuedAt=cmd_data["issuedAt"]
                            )
                            # Call handler
                            self._handle_daemon_command(command)
                            command_ids.append(command.id)
                        except Exception as e:
                            error_logger.error(f"[DAEMON] Error handling command {cmd_data.get('id')}: {e}")

                    # Acknowledge processed commands
                    if command_ids:
                        try:
                            ack_response = self.backend_client._make_request(
                                "POST",
                                "/api/daemon/commands/ack",
                                json={
                                    "commandIds": command_ids,
                                    "instanceId": self.instance_id
                                }
                            )
                            if ack_response.status_code != 200:
                                error_logger.error(f"[DAEMON] Command ack failed: {ack_response.status_code}")
                        except Exception as e:
                            error_logger.error(f"[DAEMON] Command ack error: {e}")

            elif status_code == 401:
                consecutive_429_count = 0
                # Authentication failed, stop polling
                error_logger.warning("[DAEMON] Authentication failed, stopping command polling")
                break
            elif status_code == 429:
                consecutive_429_count += 1
                # 429 = rate limit; back off and log as warning (not connection failure)
                backoff_time = min(_MAX_BACKOFF_S, self._command_poll_interval * (2 ** min(consecutive_429_count, _MAX_BACKOFF_EXPONENT)))
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
                # Log error but continue
                error_logger.error(f"[DAEMON] Command poll failed: {response.status_code}")

        except BackendRequestError as e:
            consecutive_429_count = 0
            # Network/request error, log and continue
            error_logger.error(f"[DAEMON] Command poll request error: {e}")
        except Exception as e:
            consecutive_429_count = 0
            # Unexpected error, log and continue
            error_logger.error(f"[DAEMON] Command poll error: {e}")

        # Wait before next poll
        time.sleep(self._command_poll_interval)


def handle_daemon_command(self, command: DaemonCommand) -> None:
    """
    Handle daemon command from HTTP polling.
    Processes commands from the backend (ping, get_status, get_stats, notify).
    Commands are automatically acknowledged after processing.
    """
    command_name = command.name
    command_payload = command.payload or {}
    self._append_activity("command", f"{command_name}: {command_payload}")

    if command_name == "ping":
        # //audit assumption: ping should always succeed; risk: none; invariant: ok response; strategy: return pong payload.
        # Ping commands are handled silently (no response needed)
        pass

    elif command_name == "get_status":
        # //audit assumption: status can be shared; risk: information leakage; invariant: summary only; strategy: return minimal status.
        # Status is included in heartbeat, no action needed here
        pass

    elif command_name == "get_stats":
        # //audit assumption: stats can be shared; risk: sensitive data leakage; invariant: summary only; strategy: return stats.
        # Stats are included in heartbeat, no action needed here
        pass

    elif command_name == "run":
        # //audit assumption: run commands require explicit payload; risk: unsafe execution; invariant: command string required; strategy: validate and run.
        command_text = command_payload.get("command") if isinstance(command_payload, dict) else None
        if isinstance(command_text, str) and command_text.strip():
            self.handle_run(command_text.strip())
        else:
            # //audit assumption: missing command is invalid; risk: no-op; invariant: warning shown; strategy: notify.
            self.console.print("[yellow]Run command missing 'command' payload[/yellow]")

    elif command_name == "see":
        # //audit assumption: see payload optional; risk: invalid payload; invariant: default to screen; strategy: parse use_camera flag.
        use_camera = False
        if isinstance(command_payload, dict):
            use_camera = bool(command_payload.get("use_camera", False))
        self.handle_see(["camera"] if use_camera else [])

    elif command_name == "notify":
        # //audit assumption: notify payload may include message; risk: invalid payload; invariant: string message; strategy: validate.
        message = command_payload.get("message") if isinstance(command_payload, dict) else None
        if message and isinstance(message, str):
            self.console.print(f"[cyan]Backend message:[/cyan] {message}")
        else:
            self.console.print("[yellow]Notify command missing message[/yellow]")

    elif command_name == "action_plan":
        # ActionPlan orchestration: CLEAR 2.0 gated execution
        if isinstance(command_payload, dict):
            from .action_plan_handler import handle_action_plan
            handle_action_plan(
                plan_data=command_payload,
                console=self.console,
                backend_client=self.backend_client,
                instance_id=self.instance_id,
                run_handler=self.handle_run,
                confirm_prompt=lambda msg: self._confirm_action(msg),
            )
        else:
            self.console.print("[yellow]action_plan command missing payload[/yellow]")

    else:
        # //audit assumption: unsupported commands should be logged; risk: unexpected behavior; invariant: error logged; strategy: warn.
        self.console.print(f"[yellow]Unsupported command: {command_name}[/yellow]")


def stop_daemon_service(self) -> None:
    """
    Purpose: Stop background daemon threads safely.
    Inputs/Outputs: None; joins threads with a timeout.
    Edge cases: No-op when threads are not running.
    """
    self._daemon_running = False
    if self._heartbeat_thread:
        self._heartbeat_thread.join(timeout=5.0)
    if self._command_poll_thread:
        self._command_poll_thread.join(timeout=5.0)
