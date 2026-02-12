import os
import shlex
import subprocess
from typing import Any


DEFAULT_SHELL_TIMEOUT_SECONDS = 15
DEFAULT_ALLOWED_COMMANDS = {"git", "ls", "pwd", "whoami", "cat"}


def _is_shell_action_enabled() -> bool:
    """
    Purpose: Read local policy for backend-provided shell action execution.
    Inputs/Outputs: None; returns True when shell actions are explicitly enabled.
    Edge cases: Missing env var defaults to False for fail-closed behavior.
    """
    return os.getenv("ARCANOS_V2_ALLOW_SHELL_ACTIONS", "false").strip().lower() == "true"


def _resolve_allowed_commands() -> set[str]:
    """
    Purpose: Resolve the local executable allowlist for shell actions.
    Inputs/Outputs: None; returns a set of command names.
    Edge cases: Empty env override falls back to DEFAULT_ALLOWED_COMMANDS.
    """
    configured = os.getenv("ARCANOS_V2_ALLOWED_COMMANDS", "")
    # //audit Assumption: allowlist should be locally controlled; risk: over-broad execution; invariant: non-empty allowlist; handling: fallback to conservative defaults.
    if not configured.strip():
        return set(DEFAULT_ALLOWED_COMMANDS)

    commands = {token.strip() for token in configured.split(",") if token.strip()}
    return commands if commands else set(DEFAULT_ALLOWED_COMMANDS)


def _parse_command(command: str) -> list[str]:
    """
    Purpose: Parse a backend-provided command into safe subprocess arguments.
    Inputs/Outputs: command string; returns parsed argument list.
    Edge cases: Raises ValueError for empty or malformed command strings.
    """
    # //audit Assumption: empty commands are invalid; risk: undefined execution behavior; invariant: at least one token; handling: reject with ValueError.
    if not command or not command.strip():
        raise ValueError("Command is empty.")

    try:
        command_args = shlex.split(command, posix=True)
    except ValueError as error:
        # //audit Assumption: malformed quoting can break parser; risk: command ambiguity; invariant: deterministic argv; handling: reject malformed input.
        raise ValueError(f"Command parsing failed: {error}") from error

    # //audit Assumption: parsed command must contain executable; risk: invalid subprocess invocation; invariant: len(argv) > 0; handling: reject.
    if not command_args:
        raise ValueError("Parsed command is empty.")

    return command_args


def run_shell(command: str) -> dict[str, Any]:
    """
    Purpose: Execute a backend-requested shell command under local safety policy.
    Inputs/Outputs: command string; returns structured stdout/stderr/return_code payload.
    Edge cases: Disabled policy, malformed commands, missing executables, and timeouts return structured errors.
    """
    # //audit Assumption: backend commands are untrusted; risk: remote code execution; invariant: explicit local opt-in; handling: fail closed unless enabled.
    if not _is_shell_action_enabled():
        return {
            "stdout": "",
            "stderr": "Shell actions are disabled by local policy.",
            "return_code": 126,
            "blocked": True,
        }

    try:
        command_args = _parse_command(command)
    except ValueError as error:
        return {
            "stdout": "",
            "stderr": str(error),
            "return_code": 2,
            "blocked": True,
        }

    allowed_commands = _resolve_allowed_commands()
    executable = command_args[0]
    # //audit Assumption: only explicitly allowed executables may run; risk: arbitrary process execution; invariant: executable in allowlist; handling: block otherwise.
    if executable not in allowed_commands:
        return {
            "stdout": "",
            "stderr": f"Command '{executable}' is not allowed by local policy.",
            "return_code": 126,
            "blocked": True,
        }

    try:
        result = subprocess.run(
            command_args,
            shell=False,
            capture_output=True,
            text=True,
            timeout=DEFAULT_SHELL_TIMEOUT_SECONDS,
        )
    except FileNotFoundError:
        # //audit Assumption: allowlisted binary may still be unavailable locally; risk: execution failure; invariant: error returned; handling: explicit not-found message.
        return {
            "stdout": "",
            "stderr": f"Executable not found: {executable}",
            "return_code": 127,
        }
    except subprocess.TimeoutExpired:
        # //audit Assumption: commands may hang; risk: client stall; invariant: bounded runtime; handling: timeout and return error.
        return {
            "stdout": "",
            "stderr": f"Command timed out after {DEFAULT_SHELL_TIMEOUT_SECONDS}s.",
            "return_code": 124,
        }

    return {
        "stdout": result.stdout,
        "stderr": result.stderr,
        "return_code": result.returncode,
    }
