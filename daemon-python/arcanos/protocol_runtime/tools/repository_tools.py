"""Read-only repository tools for remote protocol-bound workspaces."""

from __future__ import annotations

import os
from pathlib import Path, PurePosixPath
from typing import Any

from ..schema_loader import resolve_repository_root


DEFAULT_FILE_READ_MAX_BYTES = 65536
DEFAULT_LIST_MAX_ENTRIES = 200
DEFAULT_LIST_DEPTH = 1


def resolve_workspace_root() -> Path:
    """Resolve the explicit workspace root for repo tools from env or the repository root."""

    configured_root = os.environ.get("ARCANOS_WORKSPACE_ROOT")
    workspace_root = (
        Path(configured_root).expanduser().resolve()
        if configured_root
        else resolve_repository_root()
    )

    # //audit assumption: repo tools must stay inside one explicit workspace root. failure risk: a missing or invalid root would broaden filesystem access. invariant: only an existing directory can become the workspace root. handling: reject invalid roots before any tool reads from disk.
    if not workspace_root.exists() or not workspace_root.is_dir():
        raise FileNotFoundError(f'Workspace root "{workspace_root}" does not exist or is not a directory.')

    return workspace_root


def build_remote_source_descriptor(workspace_root: Path) -> dict[str, Any] | None:
    """Build remote source metadata for Git-backed or Railway-backed workspace bindings."""

    source_type = _resolve_remote_source_type()
    if source_type is None:
        return None

    descriptor: dict[str, Any] = {
        "type": source_type,
        "workspaceRoot": str(workspace_root),
    }

    if source_type == "git":
        descriptor.update(
            {
                "provider": os.environ.get("ARCANOS_REMOTE_PROVIDER") or "git",
                "repository": os.environ.get("ARCANOS_REMOTE_REPOSITORY"),
                "ref": os.environ.get("ARCANOS_REMOTE_REF"),
                "url": os.environ.get("ARCANOS_REMOTE_URL"),
            }
        )
    else:
        descriptor.update(
            {
                "provider": "railway",
                "railwayProjectId": os.environ.get("ARCANOS_RAILWAY_PROJECT_ID"),
                "railwayEnvironmentId": os.environ.get("ARCANOS_RAILWAY_ENVIRONMENT_ID"),
                "railwayServiceId": os.environ.get("ARCANOS_RAILWAY_SERVICE_ID"),
                "railwayServiceName": os.environ.get("ARCANOS_RAILWAY_SERVICE_NAME"),
                "url": os.environ.get("ARCANOS_REMOTE_URL"),
            }
        )

    return {key: value for key, value in descriptor.items() if value is not None}


def list_repository_entries(tool_input: dict[str, Any]) -> dict[str, Any]:
    """List files and directories from the bound workspace root with deterministic ordering."""

    workspace_root = resolve_workspace_root()
    target_path, relative_path = resolve_workspace_path(workspace_root, tool_input.get("path", "."))
    if not target_path.exists():
        raise FileNotFoundError(f'Path "{relative_path}" was not found.')
    if not target_path.is_dir():
        raise NotADirectoryError(f'Path "{relative_path}" is not a directory.')

    depth = int(tool_input.get("depth", DEFAULT_LIST_DEPTH))
    include_hidden = bool(tool_input.get("includeHidden", False))
    max_entries = int(tool_input.get("maxEntries", DEFAULT_LIST_MAX_ENTRIES))
    entries: list[dict[str, Any]] = []
    truncated = False

    def visit_directory(directory: Path, current_depth: int) -> None:
        nonlocal truncated

        for child_path in sorted(directory.iterdir(), key=lambda candidate: candidate.name.lower()):
            if not include_hidden and child_path.name.startswith("."):
                continue

            child_relative_path = child_path.relative_to(workspace_root).as_posix()
            entry: dict[str, Any] = {
                "name": child_path.name,
                "path": child_relative_path,
                "entryType": "directory" if child_path.is_dir() else "file",
            }
            if child_path.is_file():
                entry["bytes"] = child_path.stat().st_size
            entries.append(entry)

            # //audit assumption: large repository listings must fail closed into a bounded result set. failure risk: unbounded traversal could exhaust memory or leak excessive structure. invariant: returned listings stop at the configured entry cap. handling: mark the response truncated and stop descending once the cap is hit.
            if len(entries) >= max_entries:
                truncated = True
                return

            if child_path.is_dir() and current_depth < depth:
                visit_directory(child_path, current_depth + 1)
                if truncated:
                    return

    visit_directory(target_path, 1)
    return {
        "rootPath": str(workspace_root),
        "path": relative_path,
        "entries": entries,
        "truncated": truncated,
    }


def read_repository_file(tool_input: dict[str, Any]) -> dict[str, Any]:
    """Read UTF-8 content from a file within the bound workspace root."""

    workspace_root = resolve_workspace_root()
    target_path, relative_path = resolve_workspace_path(workspace_root, tool_input["path"])
    if not target_path.exists():
        raise FileNotFoundError(f'Path "{relative_path}" was not found.')
    if not target_path.is_file():
        raise IsADirectoryError(f'Path "{relative_path}" is not a file.')

    content = target_path.read_text(encoding="utf-8", errors="replace")
    lines = content.splitlines(keepends=True)
    total_lines = len(lines)
    start_line = int(tool_input.get("startLine", 1))
    requested_end_line = int(tool_input.get("endLine", total_lines or 1))
    max_bytes = int(tool_input.get("maxBytes", DEFAULT_FILE_READ_MAX_BYTES))

    if requested_end_line < start_line:
        raise ValueError("endLine must be greater than or equal to startLine.")
    if total_lines > 0 and start_line > total_lines:
        raise ValueError("startLine must be within the file line range.")

    if total_lines == 0:
        return {
            "rootPath": str(workspace_root),
            "path": relative_path,
            "content": "",
            "encoding": "utf-8",
            "truncated": False,
            "startLine": 1,
            "endLine": 1,
            "totalLines": 0,
            "bytes": 0,
        }

    selected_lines = lines[start_line - 1 : min(requested_end_line, total_lines)]
    rendered_lines: list[str] = []
    rendered_bytes = 0
    actual_end_line = start_line
    truncated = False

    for offset, line in enumerate(selected_lines):
        encoded_line = line.encode("utf-8")
        if rendered_bytes + len(encoded_line) <= max_bytes:
            rendered_lines.append(line)
            rendered_bytes += len(encoded_line)
            actual_end_line = start_line + offset
            continue

        truncated = True
        if not rendered_lines and max_bytes > 0:
            partial_line = encoded_line[:max_bytes].decode("utf-8", errors="ignore")
            rendered_lines.append(partial_line)
            rendered_bytes = len(partial_line.encode("utf-8"))
            actual_end_line = start_line + offset
        break

    return {
        "rootPath": str(workspace_root),
        "path": relative_path,
        "content": "".join(rendered_lines),
        "encoding": "utf-8",
        "truncated": truncated,
        "startLine": start_line,
        "endLine": actual_end_line,
        "totalLines": total_lines,
        "bytes": rendered_bytes,
    }


def resolve_workspace_path(workspace_root: Path, candidate_path: Any) -> tuple[Path, str]:
    """Resolve a user-supplied relative path within the allowed workspace root."""

    raw_relative_path = str(candidate_path or ".").replace("\\", "/")
    normalized_relative_path = "." if raw_relative_path in {"", "."} else PurePosixPath(raw_relative_path).as_posix()
    relative_parts = PurePosixPath(normalized_relative_path).parts

    # //audit assumption: tool paths must remain relative to the workspace root. failure risk: absolute or parent-traversal paths would escape the bound repository. invariant: only normalized relative paths are accepted. handling: reject unsafe paths before resolving them on disk.
    if normalized_relative_path.startswith("/") or ".." in relative_parts:
        raise ValueError("Paths must stay within the bound workspace root.")

    target_path = (workspace_root / normalized_relative_path).resolve()
    try:
        target_path.relative_to(workspace_root)
    except ValueError as error:
        raise ValueError("Paths must stay within the bound workspace root.") from error

    return target_path, "." if normalized_relative_path == "." else target_path.relative_to(workspace_root).as_posix()


def _resolve_remote_source_type() -> str | None:
    configured_type = os.environ.get("ARCANOS_REMOTE_SOURCE_TYPE")
    if configured_type in {"git", "railway"}:
        return configured_type

    if any(
        os.environ.get(key)
        for key in (
            "ARCANOS_RAILWAY_PROJECT_ID",
            "ARCANOS_RAILWAY_ENVIRONMENT_ID",
            "ARCANOS_RAILWAY_SERVICE_ID",
            "ARCANOS_RAILWAY_SERVICE_NAME",
        )
    ):
        return "railway"

    if any(
        os.environ.get(key)
        for key in (
            "ARCANOS_REMOTE_REPOSITORY",
            "ARCANOS_REMOTE_REF",
            "ARCANOS_REMOTE_URL",
        )
    ):
        return "git"

    return None
