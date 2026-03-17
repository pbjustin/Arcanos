"""Workspace implementation diagnostics built on top of read-only repo inspection."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .repository_tools import resolve_workspace_root, search_repository
COMMAND_PROBES = (
    "task.create",
    "plan.generate",
    "tool.invoke",
    "exec.resume",
)
REPO_TOOL_PROBES = (
    "repo.listTree",
    "repo.readFile",
    "repo.search",
    "repo.getStatus",
    "repo.getLog",
)


def doctor_implementation(_tool_input: dict[str, Any]) -> dict[str, Any]:
    """Summarize whether the workspace exposes the expected implementation surface."""

    workspace_root = resolve_workspace_root()
    files_found = _collect_existing_paths(workspace_root)
    commands_detected = _collect_detected_terms(COMMAND_PROBES)
    repo_tools_detected = _collect_detected_terms(REPO_TOOL_PROBES)

    checks = [
        _build_exists_check(workspace_root, "packages/cli/src", "cli_package"),
        _build_exists_check(workspace_root, "packages/protocol/schemas/v1", "protocol_schemas_v1"),
        _build_exists_check(workspace_root, "daemon-python", "python_runtime"),
        {
            "name": "repo_tools",
            "status": "pass"
            if {"repo.listTree", "repo.readFile"}.issubset(set(repo_tools_detected))
            else "missing",
        },
        {
            "name": "key_commands",
            "status": "pass"
            if {"task.create", "plan.generate", "tool.invoke"}.issubset(set(commands_detected))
            else "missing",
        },
        _build_exists_check(
            workspace_root,
            "packages/protocol/schemas/v1/envelope.schema.json",
            "protocol_envelope",
        ),
        {
            "name": "exec_resume",
            "status": "pass" if "exec.resume" in commands_detected else "missing",
        },
    ]

    overall_status = "implemented" if all(check["status"] == "pass" for check in checks) else "partially_implemented"
    return {
        "status": overall_status,
        "checks": checks,
        "evidence": {
            "rootPath": str(workspace_root),
            "filesFound": files_found,
            "commandsDetected": commands_detected,
            "repoToolsDetected": repo_tools_detected,
        },
    }


def _build_exists_check(workspace_root: Path, relative_path: str, name: str) -> dict[str, str]:
    return {
        "name": name,
        "status": "pass" if (workspace_root / relative_path).exists() else "missing",
    }


def _collect_existing_paths(workspace_root: Path) -> list[str]:
    return [
        relative_path
        for relative_path in [
            "packages/cli/src",
            "packages/protocol/schemas/v1",
            "daemon-python",
            "packages/protocol/schemas/v1/envelope.schema.json",
        ]
        if (workspace_root / relative_path).exists()
    ]


def _collect_detected_terms(probes: tuple[str, ...]) -> list[str]:
    detected_terms: list[str] = []
    for probe in probes:
        result = search_repository(
            {
                "query": probe,
                "options": {
                    "path": ".",
                    "limit": 1,
                },
            }
        )
        if result["matches"]:
            detected_terms.append(probe)
    return detected_terms
