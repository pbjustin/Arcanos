"""
CLI mode runners for ARCANOS.
"""

from __future__ import annotations

import json
import logging
import secrets
import sys
import time
from pathlib import Path
from typing import TYPE_CHECKING, Callable

from .cli_config import CAMERA_INTENT_PATTERN, RUN_COMMAND_PATTERNS, SCREEN_INTENT_PATTERN
from .cli_intents import detect_run_see_intent
from .completer import install_completion
from .config import Config
from .env import get_env
from .error_handler import ErrorHandler

if TYPE_CHECKING:
    from .cli import ArcanosCLI

DEBUG_MODE_LOGGER_NAME = "arcanos.cli.debug_mode"
DEBUG_MODE_DIR_NAME = "debug_mode"
DEBUG_MODE_POLL_SECONDS = 1.0
DEBUG_MODE_TOKEN_ENV = "ARCANOS_DEBUG_CMD_TOKEN"
DEBUG_MODE_COMMAND_FILE_ENV = "ARCANOS_DEBUG_CMD_FILE"
EXIT_COMMANDS = {"exit", "quit"}
CONFIRM_ACCEPT_VALUES = {"y", "yes"}


class UnknownSlashCommandError(ValueError):
    """
    Purpose: Signal that a slash-prefixed command is unknown and should fall back to chat.
    Inputs/Outputs: Inherits ValueError semantics; used for explicit control flow.
    Edge cases: Distinguishes unknown command routing from runtime command failures.
    """


def _allow_slash_run_command(cli: "ArcanosCLI", command: str) -> bool:
    """
    Purpose: Enforce security guardrails before running `/run` commands from chat-first mode.
    Inputs/Outputs: CLI instance and raw command text; returns True when execution is allowed.
    Edge cases: Blocks execution in non-interactive sessions when confirmation is required.
    """
    # //audit assumption: preflight safety checks must mirror terminal policy; risk: bypassing blacklist/whitelist; invariant: unsafe commands blocked; strategy: validate via terminal controller before execution.
    is_safe, reason = cli.terminal.is_command_safe(command)
    if not is_safe:
        cli.console.print(f"[red]{reason or 'Command blocked by security policy.'}[/red]")
        return False

    if not Config.CONFIRM_SENSITIVE_ACTIONS:
        # //audit assumption: operator explicitly disabled confirmations; risk: accidental command execution; invariant: config controls prompt behavior; strategy: skip prompt by policy.
        return True

    # //audit assumption: confirmation prompt requires interactive stdin; risk: non-tty auto-execution; invariant: block when prompt cannot be shown; strategy: reject non-tty runs.
    if not sys.stdin or not sys.stdin.isatty():
        cli.console.print("[red]/run blocked: confirmation required but no interactive terminal is available.[/red]")
        return False

    command_summary = _summarize_command(command)
    confirmation = input(f"Confirm /run command '{command_summary}'? (y/N): ").strip().lower()
    if confirmation not in CONFIRM_ACCEPT_VALUES:
        # //audit assumption: only explicit yes should execute; risk: accidental acceptance; invariant: default deny; strategy: require allowlist response.
        cli.console.print("[yellow]Cancelled /run command.[/yellow]")
        return False

    return True


def _build_debug_logger(log_file_path: Path) -> logging.Logger:
    """
    Purpose: Build an isolated logger for debug mode without mutating the root logger.
    Inputs/Outputs: Log path; returns configured logger instance.
    Edge cases: Existing handlers are replaced to avoid duplicate lines across reruns.
    """
    logger = logging.getLogger(DEBUG_MODE_LOGGER_NAME)
    logger.setLevel(logging.INFO)
    logger.propagate = False

    for handler in list(logger.handlers):
        handler.close()
        logger.removeHandler(handler)

    handler = logging.FileHandler(log_file_path, mode="w", encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s - %(levelname)s - %(message)s"))
    logger.addHandler(handler)
    return logger


def _resolve_debug_token() -> str:
    """
    Purpose: Resolve debug command token from environment or generate a one-time token.
    Inputs/Outputs: Reads environment; returns token string.
    Edge cases: Empty env value falls back to generated token.
    """
    configured_token = (get_env(DEBUG_MODE_TOKEN_ENV, "") or "").strip()
    if configured_token:
        return configured_token
    return secrets.token_urlsafe(18)


def _resolve_command_file_path(debug_dir: Path, token: str) -> Path:
    """
    Purpose: Determine the command file location for debug mode.
    Inputs/Outputs: Debug directory and token; returns file path.
    Edge cases: Relative env path is resolved under debug_dir for portability.
    """
    configured_path = (get_env(DEBUG_MODE_COMMAND_FILE_ENV, "") or "").strip()
    if configured_path:
        path = Path(configured_path).expanduser()
        return path if path.is_absolute() else debug_dir / path
    return debug_dir / f"debug_cmd_{token[:12]}.json"


def _read_command_payload(cmd_file_path: Path, logger: logging.Logger) -> tuple[str, str] | None:
    """
    Purpose: Read and validate a tokenized command payload from disk.
    Inputs/Outputs: Command file path and logger; returns (token, command) or None.
    Edge cases: Rejects symlinks, non-JSON payloads, and empty commands.
    """
    if cmd_file_path.is_symlink():
        logger.warning("Rejected command payload because file is a symlink: %s", cmd_file_path)
        cmd_file_path.unlink(missing_ok=True)
        return None

    raw_payload = cmd_file_path.read_text(encoding="utf-8").strip()
    cmd_file_path.unlink(missing_ok=True)
    if not raw_payload:
        return None

    try:
        payload = json.loads(raw_payload)
    except json.JSONDecodeError:
        logger.warning("Rejected command payload because JSON parsing failed.")
        return None

    if not isinstance(payload, dict):
        logger.warning("Rejected command payload because payload is not a JSON object.")
        return None

    token = str(payload.get("token", "")).strip()
    command = str(payload.get("command", "")).strip()
    if not command:
        logger.warning("Rejected command payload because command is empty.")
        return None
    return token, command


def _summarize_command(command: str) -> str:
    """
    Purpose: Produce a safe command summary that avoids logging raw arguments.
    Inputs/Outputs: Raw command string; returns redacted summary.
    Edge cases: Empty commands map to placeholder marker.
    """
    parts = command.split(maxsplit=1)
    if not parts:
        return "<empty>"
    if len(parts) == 1:
        return parts[0]
    return f"{parts[0]} <args:{len(parts[1])} chars>"


def _build_command_handlers(cli: "ArcanosCLI", args: str) -> dict[str, Callable[[], None]]:
    """
    Purpose: Build a command-to-handler dispatch table for direct CLI commands.
    Inputs/Outputs: CLI instance and argument string; returns handler map.
    Edge cases: Argument parsing stays command-specific via lightweight lambdas.
    """
    return {
        "help": cli.handle_help,
        "see": lambda: cli.handle_see(args.split()),
        "voice": lambda: cli.handle_voice(args.split()),
        "ptt": cli.handle_ptt,
        "run": lambda: cli.handle_run(args),
        "speak": cli.handle_speak,
        "stats": cli.handle_stats,
        "clear": cli.handle_clear,
        "reset": cli.handle_reset,
        "update": cli.handle_update,
    }


def run_debug_mode(cli: "ArcanosCLI") -> None:
    """
    Purpose: Run the CLI in non-interactive debug mode with file-based command input.
    Inputs/Outputs: CLI instance; reads commands from a file and logs output.
    Edge cases: Stops on "exit"/"quit" commands or fatal errors.
    """
    debug_dir = Config.LOG_DIR / DEBUG_MODE_DIR_NAME
    debug_dir.mkdir(parents=True, exist_ok=True)

    debug_token = _resolve_debug_token()
    log_file_path = debug_dir / "debug_log.txt"
    cmd_file_path = _resolve_command_file_path(debug_dir, debug_token)
    logger = _build_debug_logger(log_file_path)

    cli.console.print("Daemon starting in authenticated debug mode...")
    cli.console.print(f"All output will be in: {log_file_path}")
    cli.console.print(f"Command file path: {cmd_file_path}")
    cli.console.print('Command payload format: {"token":"...","command":"..."}')
    if get_env(DEBUG_MODE_TOKEN_ENV):
        cli.console.print(f"Using debug token from {DEBUG_MODE_TOKEN_ENV}.")
    else:
        cli.console.print(f"[yellow]Generated one-time debug token:[/yellow] {debug_token}")

    try:
        logger.info("Authenticated debug mode initialized.")
        logger.info("Command file to watch: %s", cmd_file_path)

        while True:
            # //audit assumption: command file presence indicates pending work; risk: missed command; invariant: poll loop; strategy: check file.
            if cmd_file_path.exists():
                try:
                    payload = _read_command_payload(cmd_file_path, logger)
                    if not payload:
                        time.sleep(DEBUG_MODE_POLL_SECONDS)
                        continue
                    provided_token, user_input = payload

                    if provided_token != debug_token:
                        logger.warning("Rejected command due to invalid debug token.")
                        time.sleep(DEBUG_MODE_POLL_SECONDS)
                        continue

                    safe_summary = _summarize_command(user_input)
                    logger.info("EXECUTING COMMAND: %s", safe_summary)
                    if user_input.lower() in EXIT_COMMANDS:
                        # //audit assumption: exit commands should stop loop; risk: lingering process; invariant: break loop; strategy: stop.
                        logger.info("Exit command received. Shutting down.")
                        break

                    process_input(cli, user_input)
                    logger.info("COMMAND FINISHED: %s", safe_summary)
                except Exception as exc:
                    # //audit assumption: command processing can fail; risk: lost debug session; invariant: error logged; strategy: continue loop.
                    logger.error("Error in command processing loop: %s", exc, exc_info=True)

            time.sleep(DEBUG_MODE_POLL_SECONDS)
    except KeyboardInterrupt:
        logger.info("Debug mode interrupted by user.")
    except Exception as exc:
        logger.critical("A critical error occurred in the debug mode runner: %s", exc, exc_info=True)
    finally:
        logger.info("Stopping daemon service and shutting down.")
        cli._stop_daemon_service()
        for handler in list(logger.handlers):
            handler.close()
            logger.removeHandler(handler)


def run_interactive_mode(cli: "ArcanosCLI") -> None:
    """
    Purpose: Run the CLI in chat-first interactive mode.
    Inputs/Outputs: CLI instance; reads input from stdin and processes it.
    Edge cases: Exits cleanly on KeyboardInterrupt or "exit"/"quit"/"bye".
    """
    install_completion()
    cli.show_welcome()
    try:
        while True:
            try:
                user_input = input("> ").strip()
                if not user_input:
                    continue

                lower_input = user_input.lower()
                if lower_input in ("exit", "quit", "bye") or lower_input in ("/exit", "/quit", "/bye"):
                    cli.console.print("[cyan]See you later![/cyan]")
                    break

                if user_input.startswith("/"):
                    # Slash command: strip the "/" and dispatch
                    command_text = user_input[1:]
                    if command_text:
                        try:
                            _dispatch_command(cli, command_text)
                        except UnknownSlashCommandError:
                            # Unknown slash command — fall back to chat
                            cli.handle_ask(user_input)
                else:
                    # Chat-first: everything without "/" goes straight to conversation
                    cli.handle_ask(user_input)
            except (KeyboardInterrupt, EOFError):
                cli.console.print("\n[cyan]See you later![/cyan]")
                break
            except Exception as exc:
                cli._last_error = str(exc) or type(exc).__name__
                cli._append_activity("error", cli._last_error)
                error_msg = ErrorHandler.handle_exception(exc, "main loop")
                cli.console.print(f"[red]{error_msg}[/red]")
    finally:
        cli._stop_daemon_service()


def _dispatch_command(cli: "ArcanosCLI", command_text: str) -> None:
    """
    Purpose: Dispatch a slash command (without the leading '/').
    Inputs/Outputs: CLI instance + command text; raises if command is unknown.
    Edge cases: 'deep'/'backend' commands require arguments.
    """
    parts = command_text.split(maxsplit=1)
    command = parts[0].lower()
    args = parts[1] if len(parts) > 1 else ""

    if command in ("deep", "backend"):
        if not args:
            cli.console.print("[red]No prompt provided for backend request.[/red]")
        else:
            cli.handle_ask(args, route_override="backend")
        return

    if command == "run":
        # //audit assumption: slash-run is sensitive; risk: command misuse; invariant: require safety preflight + optional confirmation; strategy: guard before execution.
        if not args:
            cli.console.print("[red]No command specified for /run.[/red]")
            return
        if _allow_slash_run_command(cli, args):
            cli.handle_run(args)
        return

    handlers = _build_command_handlers(cli, args)
    handler = handlers.get(command)
    if handler:
        handler()
        return

    # Unknown slash command — raise typed error so caller can fall back to chat
    raise UnknownSlashCommandError(f"Unknown command: {command}")


def process_input(cli: "ArcanosCLI", user_input: str) -> None:
    """
    Purpose: Parse and dispatch a single command or conversational input.
    Inputs/Outputs: CLI instance + user input string; triggers handlers.
    Edge cases: Falls back to natural conversation when no command matches.
    """
    parts = user_input.split(maxsplit=1)
    if not parts:
        return
    command = parts[0].lower()
    args = parts[1] if len(parts) > 1 else ""

    # //audit assumption: backend requests need arguments; risk: empty prompt; invariant: warn; strategy: check args.
    if command in ["deep", "backend"]:
        # //audit assumption: backend requests need arguments; risk: empty prompt; invariant: warn; strategy: check args.
        if not args:
            cli.console.print("[red]No prompt provided for backend request.[/red]")
        else:
            cli.handle_ask(args, route_override="backend")
        return

    handlers = _build_command_handlers(cli, args)
    handler = handlers.get(command)
    if handler:
        handler()
        return

    # //audit assumption: fallback routes use intent parsing; risk: misclassification; invariant: either intent or chat; strategy: parse then default.
    intent = detect_run_see_intent(
        user_input,
        RUN_COMMAND_PATTERNS,
        CAMERA_INTENT_PATTERN,
        SCREEN_INTENT_PATTERN,
    )
    # //audit assumption: intent detection returns tuple or None; risk: false negatives; invariant: fallback to chat; strategy: branch on intent.
    if intent:
        intent_name, intent_payload = intent
        if intent_name == "run" and intent_payload:
            # //audit assumption: run intent with payload should execute command; risk: empty payload; invariant: execute when present; strategy: guard.
            cli.handle_run(intent_payload)
        elif intent_name == "see_screen":
            cli.handle_see([])
        elif intent_name == "see_camera":
            cli.handle_see(["camera"])
        else:
            cli.handle_ask(user_input)
    else:
        cli.handle_ask(user_input)
