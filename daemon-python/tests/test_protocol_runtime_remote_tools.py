"""Tests for remote workspace protocol tool scaffolding."""

from __future__ import annotations

import json
from pathlib import Path
import subprocess

from arcanos.protocol_runtime.handlers import ProtocolRuntimeHandler
from arcanos.protocol_runtime.schema_loader import load_protocol_contract
from arcanos.protocol_runtime.state_store import InMemoryProtocolStateStore


def _caller_context(tmp_path: Path, *, scopes: list[str] | None = None) -> dict[str, object]:
    return {
        "environment": "workspace",
        "cwd": str(tmp_path),
        "shell": "pwsh",
        "caller": {
            "id": "pytest",
            "type": "cli",
            "scopes": scopes or ["repo:read"],
        },
    }


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
                "toolId": "repo.readFile",
            },
        }
    )

    assert response["ok"] is True
    assert response["data"]["tool"]["id"] == "repo.readFile"
    assert response["data"]["inputSchema"]["$id"].endswith("/repo.readFile.input.schema.json")
    assert response["data"]["outputSchema"]["$id"].endswith("/repo.readFile.output.schema.json")


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
            "context": _caller_context(tmp_path),
            "payload": {
                "toolId": "repo.listTree",
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
            "context": _caller_context(tmp_path),
            "payload": {
                "toolId": "repo.readFile",
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
    assert read_response["data"]["result"]["range"] == [1, 2]


def test_tool_invoke_rejects_workspace_escape(monkeypatch, tmp_path: Path) -> None:
    """tool.invoke rejects relative path traversal outside the bound workspace root."""

    monkeypatch.setenv("ARCANOS_WORKSPACE_ROOT", str(tmp_path))
    handler = ProtocolRuntimeHandler(load_protocol_contract(), InMemoryProtocolStateStore())

    response = handler.handle_request(
        {
            "protocol": "arcanos-v1",
            "requestId": "req-tool-escape",
            "command": "tool.invoke",
            "context": _caller_context(tmp_path),
            "payload": {
                "toolId": "repo.readFile",
                "input": {
                    "path": "../secret.txt",
                },
            },
        }
    )

    assert response["ok"] is False
    assert response["error"]["code"] == "invalid_request"
    assert "workspace root" in response["error"]["message"]


def test_tool_invoke_requires_caller_metadata(monkeypatch, tmp_path: Path) -> None:
    """tool.invoke rejects repo access without caller metadata."""

    monkeypatch.setenv("ARCANOS_WORKSPACE_ROOT", str(tmp_path))
    readme_path = tmp_path / "README.md"
    readme_path.write_text("Arcanos\n", encoding="utf-8")
    handler = ProtocolRuntimeHandler(load_protocol_contract(), InMemoryProtocolStateStore())

    response = handler.handle_request(
        {
            "protocol": "arcanos-v1",
            "requestId": "req-tool-missing-caller",
            "command": "tool.invoke",
            "context": {
                "environment": "workspace",
                "cwd": str(tmp_path),
                "shell": "pwsh",
            },
            "payload": {
                "toolId": "repo.readFile",
                "input": {
                    "path": "README.md",
                },
            },
        }
    )

    assert response["ok"] is False
    assert response["error"]["code"] == "permission_denied"
    assert "caller metadata" in response["error"]["message"]


def test_tool_invoke_enforces_repo_read_scope(monkeypatch, tmp_path: Path) -> None:
    """tool.invoke rejects callers that do not carry the required repo scope."""

    monkeypatch.setenv("ARCANOS_WORKSPACE_ROOT", str(tmp_path))
    (tmp_path / "README.md").write_text("Arcanos\n", encoding="utf-8")
    handler = ProtocolRuntimeHandler(load_protocol_contract(), InMemoryProtocolStateStore())

    response = handler.handle_request(
        {
            "protocol": "arcanos-v1",
            "requestId": "req-tool-missing-scope",
            "command": "tool.invoke",
            "context": _caller_context(tmp_path, scopes=["tools:read"]),
            "payload": {
                "toolId": "repo.readFile",
                "input": {
                    "path": "README.md",
                },
            },
        }
    )

    assert response["ok"] is False
    assert response["error"]["code"] == "permission_denied"
    assert "requires scopes" in response["error"]["message"]


def test_tool_invoke_search_and_audit(monkeypatch, tmp_path: Path) -> None:
    """tool.invoke search returns deterministic matches and appends an audit record."""

    src_directory = tmp_path / "src"
    src_directory.mkdir()
    app_path = src_directory / "app.ts"
    app_path.write_text(
        "export function plan_generate() {\n  return 'task.create';\n}\n",
        encoding="utf-8",
    )
    audit_path = tmp_path / "protocol-audit.jsonl"
    monkeypatch.setenv("ARCANOS_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setenv("ARCANOS_PROTOCOL_AUDIT_LOG", str(audit_path))
    handler = ProtocolRuntimeHandler(load_protocol_contract(), InMemoryProtocolStateStore())

    response = handler.handle_request(
        {
            "protocol": "arcanos-v1",
            "requestId": "req-tool-search",
            "command": "tool.invoke",
            "context": _caller_context(tmp_path),
            "payload": {
                "toolId": "repo.search",
                "input": {
                    "query": "plan_generate",
                    "options": {
                        "type": "symbol",
                    },
                },
            },
        }
    )

    assert response["ok"] is True
    assert response["data"]["result"]["matches"][0]["path"] == "src/app.ts"
    assert response["data"]["result"]["matches"][0]["symbolKind"] in {"function", "export"}

    audit_lines = audit_path.read_text(encoding="utf-8").splitlines()
    assert len(audit_lines) == 1
    audit_entry = json.loads(audit_lines[0])
    assert audit_entry["requestId"] == "req-tool-search"
    assert audit_entry["toolId"] == "repo.search"
    assert audit_entry["caller"]["id"] == "pytest"
    assert audit_entry["ok"] is True


def test_tool_invoke_gets_status_log_and_diff(monkeypatch, tmp_path: Path) -> None:
    """tool.invoke exposes bounded, read-only git metadata for the workspace repo."""

    monkeypatch.setenv("ARCANOS_WORKSPACE_ROOT", str(tmp_path))
    subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.name", "Arcanos Test"], cwd=tmp_path, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "arcanos@example.com"], cwd=tmp_path, check=True, capture_output=True, text=True)
    tracked_path = tmp_path / "tracked.txt"
    tracked_path.write_text("one\n", encoding="utf-8")
    subprocess.run(["git", "add", "tracked.txt"], cwd=tmp_path, check=True, capture_output=True, text=True)
    subprocess.run(["git", "commit", "-m", "initial commit"], cwd=tmp_path, check=True, capture_output=True, text=True)
    base_ref = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=tmp_path,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    tracked_path.write_text("one\ntwo\n", encoding="utf-8")
    subprocess.run(["git", "add", "tracked.txt"], cwd=tmp_path, check=True, capture_output=True, text=True)
    subprocess.run(["git", "commit", "-m", "second commit"], cwd=tmp_path, check=True, capture_output=True, text=True)
    head_ref = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=tmp_path,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    (tmp_path / "untracked.txt").write_text("pending\n", encoding="utf-8")
    handler = ProtocolRuntimeHandler(load_protocol_contract(), InMemoryProtocolStateStore())

    status_response = handler.handle_request(
        {
            "protocol": "arcanos-v1",
            "requestId": "req-tool-status",
            "command": "tool.invoke",
            "context": _caller_context(tmp_path),
            "payload": {
                "toolId": "repo.getStatus",
                "input": {},
            },
        }
    )
    log_response = handler.handle_request(
        {
            "protocol": "arcanos-v1",
            "requestId": "req-tool-log",
            "command": "tool.invoke",
            "context": _caller_context(tmp_path),
            "payload": {
                "toolId": "repo.getLog",
                "input": {
                    "limit": 5,
                },
            },
        }
    )
    diff_response = handler.handle_request(
        {
            "protocol": "arcanos-v1",
            "requestId": "req-tool-diff",
            "command": "tool.invoke",
            "context": _caller_context(tmp_path),
            "payload": {
                "toolId": "repo.getDiff",
                "input": {
                    "base": base_ref,
                    "head": head_ref,
                },
            },
        }
    )

    assert status_response["ok"] is True
    assert status_response["data"]["result"]["clean"] is False
    assert any(change["path"] == "untracked.txt" for change in status_response["data"]["result"]["changes"])

    assert log_response["ok"] is True
    assert log_response["data"]["result"]["commits"][0]["subject"] == "second commit"
    assert log_response["data"]["result"]["commits"][1]["subject"] == "initial commit"

    assert diff_response["ok"] is True
    assert "tracked.txt" in diff_response["data"]["result"]["diff"]
    assert "@@" in diff_response["data"]["result"]["diff"]
