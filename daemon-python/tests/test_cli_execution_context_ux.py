from __future__ import annotations

import json
import logging
import sys
from types import SimpleNamespace

from arcanos.cli import cli as cli_module
from arcanos.cli import ui_ops
from arcanos.config import Config


def test_execution_context_summary_warns_for_railway_runtime(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("RAILWAY_ENVIRONMENT_ID", "env-test")
    monkeypatch.setenv("ARCANOS_CLI_SANDBOX_ROOT", str(tmp_path))
    monkeypatch.setattr(Config, "BACKEND_URL", "https://example.invalid")
    monkeypatch.setattr(Config, "CONFIRM_SENSITIVE_ACTIONS", True)
    monkeypatch.setattr(Config, "RUN_ELEVATED", False)
    cli = SimpleNamespace(_daemon_running=True)

    summary = ui_ops.build_execution_context_summary(cli)

    assert summary["mode"] == "Production Runtime"
    assert summary["daemon"] == "Connected"
    assert summary["sandbox"] == str(tmp_path.resolve())
    assert summary["execution"] == "Confirmation required"
    assert summary["canAccessPersonalDesktop"] is False
    assert "your personal desktop" in summary["cannotAccess"]
    assert "Railway production runtime" in summary["environmentWarning"]


def test_execution_context_rendering_is_human_readable(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv("RAILWAY_ENVIRONMENT_ID", raising=False)
    monkeypatch.setenv("ARCANOS_CLI_BRIDGE_TOKEN", "test-token")
    monkeypatch.setenv("ARCANOS_CLI_BRIDGE_ENABLED", "true")
    monkeypatch.setenv("ARCANOS_CLI_SANDBOX_ROOT", str(tmp_path))
    monkeypatch.setattr(Config, "BACKEND_URL", None)
    monkeypatch.setattr(Config, "CONFIRM_SENSITIVE_ACTIONS", True)
    cli = SimpleNamespace(_daemon_running=True)

    summary = ui_ops.build_execution_context_summary(cli)

    assert summary["mode"] == "Local Desktop Daemon"
    assert summary["canAccessPersonalDesktop"] is True
    assert summary["localDesktopDaemonReady"] is True
    assert "raw secrets or environment variables" in summary["cannotAccess"]


def test_execution_context_does_not_infer_desktop_access_from_token_only(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv("RAILWAY_ENVIRONMENT_ID", raising=False)
    monkeypatch.setenv("ARCANOS_CLI_BRIDGE_TOKEN", "test-token")
    monkeypatch.delenv("ARCANOS_CLI_BRIDGE_ENABLED", raising=False)
    monkeypatch.setenv("ARCANOS_CLI_SANDBOX_ROOT", str(tmp_path))
    monkeypatch.setattr(Config, "BACKEND_URL", None)
    cli = SimpleNamespace(_daemon_running=False)

    summary = ui_ops.build_execution_context_summary(cli)

    assert summary["mode"] == "Disabled"
    assert summary["canAccessPersonalDesktop"] is False
    assert summary["localDesktopDaemonReady"] is False


def test_execution_context_uses_local_runtime_label_for_local_daemon(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv("RAILWAY_ENVIRONMENT_ID", raising=False)
    monkeypatch.delenv("ARCANOS_CLI_BRIDGE_ENABLED", raising=False)
    monkeypatch.delenv("ARCANOS_CLI_BRIDGE_TOKEN", raising=False)
    monkeypatch.setenv("ARCANOS_CLI_SANDBOX_ROOT", str(tmp_path))
    monkeypatch.setattr(Config, "BACKEND_URL", "http://127.0.0.1:3000")
    cli = SimpleNamespace(_daemon_running=True)

    summary = ui_ops.build_execution_context_summary(cli)

    assert summary["mode"] == "Local CLI Runtime"
    assert "local CLI runtime" in summary["canAccess"]
    assert "deployed runtime" not in summary["canAccess"]


def test_execution_context_detects_broad_git_allow_prefix() -> None:
    labels = ui_ops._capability_labels(["git"])

    assert "read-only git inspection" in labels


def test_execution_context_logs_policy_resolution_failure(monkeypatch, caplog) -> None:
    def _raise_policy_error() -> dict:
        raise RuntimeError("broken policy")

    monkeypatch.setattr(ui_ops, "load_cli_policy", _raise_policy_error)
    monkeypatch.setattr(Config, "BACKEND_URL", None)
    cli = SimpleNamespace(_daemon_running=False)

    with caplog.at_level(logging.WARNING, logger="arcanos"):
        summary = ui_ops.build_execution_context_summary(cli)

    assert summary["sandbox"] == "unknown"
    assert "Execution context policy resolution failed" in caplog.text


def test_context_json_does_not_start_full_cli(monkeypatch, capsys) -> None:
    def _raise_if_started() -> None:
        raise AssertionError("context --json must not start the full CLI runtime")

    monkeypatch.setattr(sys, "argv", ["arcanos", "context", "--json"])
    monkeypatch.setattr(cli_module, "ArcanosCLI", _raise_if_started)
    monkeypatch.setattr(Config, "BACKEND_URL", None)
    monkeypatch.setattr(Config, "CONFIRM_SENSITIVE_ACTIONS", True)
    monkeypatch.delenv("RAILWAY_ENVIRONMENT_ID", raising=False)
    monkeypatch.delenv("ARCANOS_CLI_BRIDGE_TOKEN", raising=False)

    cli_module.main()

    captured = capsys.readouterr()
    payload = json.loads(captured.out)
    assert captured.err == ""
    assert payload["mode"] == "Disabled"
