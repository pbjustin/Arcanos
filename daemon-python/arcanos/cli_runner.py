"""
CLI mode runners for ARCANOS.
"""

from __future__ import annotations

import logging
import os
import time
from typing import TYPE_CHECKING

from .cli_config import CAMERA_INTENT_PATTERN, RUN_COMMAND_PATTERNS, SCREEN_INTENT_PATTERN
from .cli_intents import detect_run_see_intent
from .error_handler import ErrorHandler

if TYPE_CHECKING:
    from .cli import ArcanosCLI


def run_debug_mode(cli: "ArcanosCLI") -> None:
    """
    Purpose: Run the CLI in non-interactive debug mode with file-based command input.
    Inputs/Outputs: CLI instance; reads commands from a file and logs output.
    Edge cases: Stops on "exit"/"quit" commands or fatal errors.
    """
    log_file_path = os.path.join(os.path.dirname(__file__), "debug_log.txt")
    cmd_file_path = os.path.join(os.path.dirname(__file__), "debug_cmd.in")

    cli.console.print("Daemon starting in robust debug mode...")
    cli.console.print(f"All output will be in: {log_file_path}")

    for handler in logging.root.handlers[:]:
        logging.root.removeHandler(handler)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(levelname)s - %(message)s",
        filename=log_file_path,
        filemode="w",
    )

    try:
        logging.info("Robust debug mode initialized.")
        logging.info("Command file to watch: %s", cmd_file_path)

        while True:
            # //audit assumption: command file presence indicates pending work; risk: missed command; invariant: poll loop; strategy: check file.
            if os.path.exists(cmd_file_path):
                try:
                    with open(cmd_file_path, "r", encoding="utf-8") as command_file:
                        user_input = command_file.read().strip()
                    os.remove(cmd_file_path)

                    logging.info("EXECUTING COMMAND: %s", user_input)
                    if user_input.lower() in ["exit", "quit"]:
                        # //audit assumption: exit commands should stop loop; risk: lingering process; invariant: break loop; strategy: stop.
                        logging.info("Exit command received. Shutting down.")
                        break

                    process_input(cli, user_input)
                    logging.info("COMMAND FINISHED: %s", user_input)
                except Exception as exc:
                    # //audit assumption: command processing can fail; risk: lost debug session; invariant: error logged; strategy: continue loop.
                    logging.error("Error in command processing loop: %s", exc, exc_info=True)

            time.sleep(1)
    except KeyboardInterrupt:
        logging.info("Debug mode interrupted by user.")
    except Exception as exc:
        logging.critical("A critical error occurred in the debug mode runner: %s", exc, exc_info=True)
    finally:
        logging.info("Stopping daemon service and shutting down.")
        cli._stop_daemon_service()
        logging.shutdown()


def run_interactive_mode(cli: "ArcanosCLI") -> None:
    """
    Purpose: Run the CLI in standard interactive mode.
    Inputs/Outputs: CLI instance; reads input from stdin and processes it.
    Edge cases: Exits cleanly on KeyboardInterrupt or "exit"/"quit"/"bye".
    """
    cli.show_welcome()
    try:
        while True:
            try:
                user_input = input("\n?? You: ").strip()
                if not user_input:
                    # //audit assumption: empty input is non-actionable; risk: busy loop; invariant: skip; strategy: continue.
                    continue

                if user_input.lower() in ["exit", "quit", "bye"]:
                    # //audit assumption: exit commands should quit; risk: user stuck; invariant: break loop; strategy: break.
                    cli.console.print("[cyan]?? Goodbye![/cyan]")
                    break

                process_input(cli, user_input)
            except KeyboardInterrupt:
                cli.console.print("\n[cyan]?? Goodbye![/cyan]")
                break
            except Exception as exc:
                # //audit assumption: interactive loop should survive errors; risk: crash; invariant: error surfaced; strategy: handle and continue.
                cli._last_error = str(exc) or type(exc).__name__
                cli._append_activity("error", cli._last_error)
                error_msg = ErrorHandler.handle_exception(exc, "main loop")
                cli.console.print(f"[red]{error_msg}[/red]")
    finally:
        cli._stop_daemon_service()


def process_input(cli: "ArcanosCLI", user_input: str) -> None:
    """
    Purpose: Parse and dispatch a single command or conversational input.
    Inputs/Outputs: CLI instance + user input string; triggers handlers.
    Edge cases: Falls back to natural conversation when no command matches.
    """
    parts = user_input.split(maxsplit=1)
    command = parts[0].lower()
    args = parts[1] if len(parts) > 1 else ""

    # //audit assumption: first token determines routing; risk: mis-parse; invariant: only one branch; strategy: if/elif chain.
    if command == "help":
        cli.handle_help()
    elif command in ["deep", "backend"]:
        # //audit assumption: backend requests need arguments; risk: empty prompt; invariant: warn; strategy: check args.
        if not args:
            cli.console.print("[red]No prompt provided for backend request.[/red]")
        else:
            cli.handle_ask(args, route_override="backend")
    elif command == "see":
        cli.handle_see(args.split())
    elif command == "voice":
        cli.handle_voice(args.split())
    elif command == "ptt":
        cli.handle_ptt()
    elif command == "run":
        cli.handle_run(args)
    elif command == "speak":
        cli.handle_speak()
    elif command == "stats":
        cli.handle_stats()
    elif command == "clear":
        cli.handle_clear()
    elif command == "reset":
        cli.handle_reset()
    elif command == "update":
        cli.handle_update()
    else:
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
