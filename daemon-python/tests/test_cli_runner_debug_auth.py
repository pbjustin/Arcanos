from __future__ import annotations

import json
import logging
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from arcanos import cli_runner
from arcanos.config import Config
from tests.credential_observation import assert_no_credential_material


@pytest.fixture(autouse=True)
def isolate_debug_mode_logger(monkeypatch, request):
    logger_name = f"{cli_runner.DEBUG_MODE_LOGGER_NAME}.{request.node.name}"
    logger = logging.getLogger(logger_name)
    original_state = (
        logger.level,
        logger.propagate,
        logger.disabled,
        list(logger.filters),
    )
    monkeypatch.setattr(cli_runner, "DEBUG_MODE_LOGGER_NAME", logger_name)

    yield

    for handler in list(logger.handlers):
        handler.close()
        logger.removeHandler(handler)
    logger.setLevel(original_state[0])
    logger.propagate = original_state[1]
    logger.disabled = original_state[2]
    logger.filters[:] = original_state[3]
    logging.Logger.manager.loggerDict.pop(logger_name, None)


def _write_command(path: Path, token: str, command: str = "exit") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"token": token, "command": command}), encoding="utf-8")


def _console_output(cli: MagicMock) -> str:
    return "\n".join(str(call.args[0]) for call in cli.console.print.call_args_list)


def test_default_command_file_uses_token_independent_random_suffix(
    monkeypatch, tmp_path
) -> None:
    monkeypatch.delenv(cli_runner.DEBUG_MODE_COMMAND_FILE_ENV, raising=False)
    monkeypatch.setattr(
        cli_runner.secrets, "token_hex", lambda _size: "0123456789abcdef"
    )

    path = cli_runner._resolve_command_file_path(tmp_path)

    assert path == tmp_path / "debug_cmd_0123456789abcdef.json"


def test_explicit_command_file_path_behavior_is_preserved(
    monkeypatch, tmp_path
) -> None:
    debug_dir = tmp_path / "debug"
    monkeypatch.setenv(cli_runner.DEBUG_MODE_COMMAND_FILE_ENV, "nested/commands.json")
    monkeypatch.setattr(
        cli_runner.secrets,
        "token_hex",
        lambda _size: (_ for _ in ()).throw(
            AssertionError("random suffix should not be generated")
        ),
    )

    relative_path = cli_runner._resolve_command_file_path(debug_dir)

    assert relative_path == debug_dir / "nested/commands.json"

    absolute_path = tmp_path / "explicit-commands.json"
    monkeypatch.setenv(cli_runner.DEBUG_MODE_COMMAND_FILE_ENV, str(absolute_path))
    assert cli_runner._resolve_command_file_path(debug_dir) == absolute_path


def test_configured_debug_token_is_absent_from_console_log_stderr_and_path(
    monkeypatch,
    tmp_path,
    capsys,
) -> None:
    credential = "".join(("opaque", "-configured-", "credential-marker"))
    suffix = "fedcba9876543210"
    debug_dir = tmp_path / cli_runner.DEBUG_MODE_DIR_NAME
    command_path = debug_dir / f"debug_cmd_{suffix}.json"
    _write_command(command_path, credential)

    monkeypatch.setattr(Config, "LOG_DIR", tmp_path)
    monkeypatch.setenv(cli_runner.DEBUG_MODE_TOKEN_ENV, credential)
    monkeypatch.delenv(cli_runner.DEBUG_MODE_COMMAND_FILE_ENV, raising=False)
    monkeypatch.setattr(cli_runner.secrets, "token_hex", lambda _size: suffix)

    cli = MagicMock()
    cli.console.is_terminal = False
    cli_runner.run_debug_mode(cli)

    captured = capsys.readouterr()
    log_text = (debug_dir / "debug_log.txt").read_text(encoding="utf-8")
    assert_no_credential_material(
        credential,
        command_path,
        _console_output(cli),
        log_text,
        captured.out,
        captured.err,
    )
    assert command_path.exists() is False
    cli._stop_daemon_service.assert_called_once_with()


def test_generated_debug_token_is_only_delivered_to_interactive_console(
    monkeypatch,
    tmp_path,
    capsys,
) -> None:
    credential = "".join(("opaque", "-generated-", "credential-marker"))
    suffix = "0011223344556677"
    debug_dir = tmp_path / cli_runner.DEBUG_MODE_DIR_NAME
    command_path = debug_dir / f"debug_cmd_{suffix}.json"
    _write_command(command_path, credential)

    monkeypatch.setattr(Config, "LOG_DIR", tmp_path)
    monkeypatch.delenv(cli_runner.DEBUG_MODE_TOKEN_ENV, raising=False)
    monkeypatch.delenv(cli_runner.DEBUG_MODE_COMMAND_FILE_ENV, raising=False)
    monkeypatch.setattr(cli_runner.secrets, "token_urlsafe", lambda _size: credential)
    monkeypatch.setattr(cli_runner.secrets, "token_hex", lambda _size: suffix)

    cli = MagicMock()
    cli.console.is_terminal = True
    cli_runner.run_debug_mode(cli)

    console_output = _console_output(cli)
    if console_output.count(credential) != 1:
        raise AssertionError(
            "generated token was not delivered exactly once to the interactive console"
        )
    captured = capsys.readouterr()
    log_text = (debug_dir / "debug_log.txt").read_text(encoding="utf-8")
    assert_no_credential_material(
        credential,
        command_path,
        log_text,
        captured.out,
        captured.err,
    )
    assert command_path.exists() is False
    cli._stop_daemon_service.assert_called_once_with()


def test_generated_debug_token_is_not_revealed_when_console_is_redirected(
    monkeypatch,
    tmp_path,
    capsys,
) -> None:
    credential = "".join(("opaque", "-redirected-", "credential-marker"))
    monkeypatch.setattr(Config, "LOG_DIR", tmp_path)
    monkeypatch.delenv(cli_runner.DEBUG_MODE_TOKEN_ENV, raising=False)
    generate_debug_token = MagicMock(return_value=credential)
    monkeypatch.setattr(cli_runner.secrets, "token_urlsafe", generate_debug_token)

    cli = MagicMock()
    cli.console.is_terminal = False
    cli_runner.run_debug_mode(cli)

    captured = capsys.readouterr()
    assert_no_credential_material(
        credential,
        _console_output(cli),
        captured.out,
        captured.err,
    )
    if generate_debug_token.call_count != 0:
        raise AssertionError("debug token was generated for redirected output")
    if (tmp_path / cli_runner.DEBUG_MODE_DIR_NAME / "debug_log.txt").exists():
        raise AssertionError("redirected debug startup created an output log")
    cli._stop_daemon_service.assert_called_once_with()


def test_debug_token_provenance_uses_one_environment_read(
    monkeypatch,
    tmp_path,
    capsys,
) -> None:
    credential = "".join(("opaque", "-changing-env-", "credential-marker"))
    suffix = "2233445566778899"
    debug_dir = tmp_path / cli_runner.DEBUG_MODE_DIR_NAME
    command_path = debug_dir / f"debug_cmd_{suffix}.json"
    _write_command(command_path, credential)
    token_reads = 0

    def changing_get_env(name: str, default: str = "") -> str:
        nonlocal token_reads
        if name != cli_runner.DEBUG_MODE_TOKEN_ENV:
            return default
        token_reads += 1
        return "" if token_reads == 1 else credential

    monkeypatch.setattr(Config, "LOG_DIR", tmp_path)
    monkeypatch.setattr(cli_runner, "get_env", changing_get_env)
    monkeypatch.setattr(cli_runner.secrets, "token_hex", lambda _size: suffix)

    cli = MagicMock()
    cli.console.is_terminal = False
    cli_runner.run_debug_mode(cli)

    if token_reads != 1:
        raise AssertionError("debug token configuration was read more than once")
    captured = capsys.readouterr()
    assert_no_credential_material(
        credential,
        _console_output(cli),
        captured.out,
        captured.err,
    )
    cli._stop_daemon_service.assert_called_once_with()


def test_invalid_debug_token_is_rejected_without_being_logged(
    monkeypatch, tmp_path, capsys
) -> None:
    credential = "".join(("opaque", "-expected-", "credential-marker"))
    wrong_credential = "".join(("opaque", "-provided-", "credential-marker"))
    suffix = "8899aabbccddeeff"
    debug_dir = tmp_path / cli_runner.DEBUG_MODE_DIR_NAME
    command_path = debug_dir / f"debug_cmd_{suffix}.json"
    _write_command(command_path, wrong_credential, command="status")

    monkeypatch.setattr(Config, "LOG_DIR", tmp_path)
    monkeypatch.setenv(cli_runner.DEBUG_MODE_TOKEN_ENV, credential)
    monkeypatch.delenv(cli_runner.DEBUG_MODE_COMMAND_FILE_ENV, raising=False)
    monkeypatch.setattr(cli_runner.secrets, "token_hex", lambda _size: suffix)
    monkeypatch.setattr(cli_runner, "process_input", MagicMock())

    def enqueue_exit(_seconds: float) -> None:
        if not command_path.exists():
            _write_command(command_path, credential)

    monkeypatch.setattr(cli_runner.time, "sleep", enqueue_exit)

    cli = MagicMock()
    cli.console.is_terminal = False
    cli_runner.run_debug_mode(cli)

    assert cli_runner.process_input.call_count == 0
    captured = capsys.readouterr()
    log_text = (debug_dir / "debug_log.txt").read_text(encoding="utf-8")
    observable = (
        command_path,
        _console_output(cli),
        log_text,
        captured.out,
        captured.err,
    )
    assert_no_credential_material(credential, *observable)
    assert_no_credential_material(wrong_credential, *observable)
    assert "Rejected command due to invalid debug token." in log_text
