"""Tests for remote workspace protocol tool scaffolding."""

from __future__ import annotations

from pathlib import Path

from arcanos.protocol_runtime.handlers import ProtocolRuntimeHandler
from arcanos.protocol_runtime.schema_loader import load_protocol_contract
from arcanos.protocol_runtime.state_store import InMemoryProtocolStateStore


def test_context_inspect_exposes_git_remote_metadata(monkeypatch, tmp_path: Path) -> None:
    """context.inspect returns remote source metadata when a git-backed remote is configured."""

    monkeypatch.setenv("ARCANOS_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setenv("ARCANOS_REMOTE_SOURCE_TYPE", "git")
    monkeypatch.setenv("ARCANOS_REMOTE_PROVIDER", "github")
    monkeypatch.setenv("ARCANOS_REMOTE_REPOSITORY", "pbjustin/Arcanos")
    monkeypatch.setenv("ARCANOS_REMOTE_REF", "refs/heads/main")
    monkeypatch.setenv("ARCANOS_REMOTE_URL", "https://github.com/pbjustin/Arcanos")
    handler = ProtocolRuntimeHandler(load_protocol_contract(), InMemoryProtocolStateStore())

    response = handler.handle_request(
        {
            "protocol": "arcanos-v1",
            "requestId": "req-context-remote",
            "command": "context.inspect",
            "context": {
                "environment": "remote",
                "cwd": str(tmp_path),
                "shell": "pwsh",
            },
            "payload": {
                "includeProject": True,
                "includeAvailableEnvironments": True,
            },
        }
    )

    assert response["ok"] is True
    assert response["data"]["environment"]["remoteSource"]["type"] == "git"
    assert response["data"]["project"]["remoteSource"]["repository"] == "pbjustin/Arcanos"
    assert response["data"]["availableEnvironments"][-1]["remoteSource"]["provider"] == "github"


def test_tool_describe_returns_repo_tool_schemas(monkeypatch, tmp_path: Path) -> None:
    """tool.describe returns shared input and output schemas for a repo tool."""

    monkeypatch.setenv("ARCANOS_WORKSPACE_ROOT", str(tmp_path))
    handler = ProtocolRuntimeHandler(load_protocol_contract(), InMemoryProtocolStateStore())

    response = handler.handle_request(
        {
            "protocol": "arcanos-v1",
            "requestId": "req-tool-describe",
            "command": "tool.describe",
            "payload": {
                "toolId": "repo.read_file",
            },
        }
    )

    assert response["ok"] is True
    assert response["data"]["tool"]["id"] == "repo.read_file"
    assert response["data"]["inputSchema"]["$id"].endswith("/repo.read_file.input.schema.json")
    assert response["data"]["outputSchema"]["$id"].endswith("/repo.read_file.output.schema.json")


def test_tool_invoke_lists_and_reads_from_bound_workspace(monkeypatch, tmp_path: Path) -> None:
    """tool.invoke can list and read files from the configured remote workspace root."""

    docs_directory = tmp_path / "docs"
    docs_directory.mkdir()
    readme_path = docs_directory / "README.md"
    readme_path.write_text("# Arcanos\nprotocol-first\n", encoding="utf-8")
    monkeypatch.setenv("ARCANOS_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setenv("ARCANOS_REMOTE_SOURCE_TYPE", "railway")
    monkeypatch.setenv("ARCANOS_RAILWAY_PROJECT_ID", "proj-123")
    monkeypatch.setenv("ARCANOS_RAILWAY_ENVIRONMENT_ID", "env-debug")
    monkeypatch.setenv("ARCANOS_RAILWAY_SERVICE_NAME", "ARCANOS V2")
    handler = ProtocolRuntimeHandler(load_protocol_contract(), InMemoryProtocolStateStore())

    list_response = handler.handle_request(
        {
            "protocol": "arcanos-v1",
            "requestId": "req-tool-list",
            "command": "tool.invoke",
            "payload": {
                "toolId": "repo.list",
                "input": {
                    "path": ".",
                    "depth": 2,
                },
            },
        }
    )
    read_response = handler.handle_request(
        {
            "protocol": "arcanos-v1",
            "requestId": "req-tool-read",
            "command": "tool.invoke",
            "payload": {
                "toolId": "repo.read_file",
                "input": {
                    "path": "docs/README.md",
                },
            },
        }
    )

    assert list_response["ok"] is True
    assert any(entry["path"] == "docs/README.md" for entry in list_response["data"]["result"]["entries"])
    assert list_response["data"]["result"]["truncated"] is False
    assert read_response["ok"] is True
    assert read_response["data"]["result"]["path"] == "docs/README.md"
    assert "protocol-first" in read_response["data"]["result"]["content"]


def test_tool_invoke_rejects_workspace_escape(monkeypatch, tmp_path: Path) -> None:
    """tool.invoke rejects relative path traversal outside the bound workspace root."""

    monkeypatch.setenv("ARCANOS_WORKSPACE_ROOT", str(tmp_path))
    handler = ProtocolRuntimeHandler(load_protocol_contract(), InMemoryProtocolStateStore())

    response = handler.handle_request(
        {
            "protocol": "arcanos-v1",
            "requestId": "req-tool-escape",
            "command": "tool.invoke",
            "payload": {
                "toolId": "repo.read_file",
                "input": {
                    "path": "../secret.txt",
                },
            },
        }
    )

    assert response["ok"] is False
    assert response["error"]["code"] == "invalid_request"
    assert "workspace root" in response["error"]["message"]
