"""Read-only repository tools for protocol-bound workspace inspection."""

from __future__ import annotations

import os
from pathlib import Path, PurePosixPath
import re
import subprocess
from typing import Any, Iterable

from ..schema_loader import resolve_repository_root


DEFAULT_FILE_READ_MAX_BYTES = 65536
DEFAULT_LIST_LIMIT = 200
DEFAULT_LIST_DEPTH = 1
DEFAULT_SEARCH_LIMIT = 50
DEFAULT_SEARCH_MAX_FILE_BYTES = 262144
DEFAULT_LOG_LIMIT = 20
DEFAULT_DIFF_MAX_BYTES = 131072
DEFAULT_DIFF_CONTEXT_LINES = 3
IGNORE_DIRECTORY_NAMES = {
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    ".venv",
    "__pycache__",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "venv",
}
SYMBOL_LINE_PATTERN = re.compile(
    r"\b(class|def|function|interface|type|enum|const|let|var|export|async function)\b",
    re.IGNORECASE,
)


def resolve_workspace_root() -> Path:
    """Resolve the explicit workspace root for repo tools from env or the repository root."""

    configured_root = os.environ.get("ARCANOS_WORKSPACE_ROOT")
    workspace_root = (
        Path(configured_root).expanduser().resolve()
        if configured_root
        else resolve_repository_root()
    )

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


def list_repository_tree(tool_input: dict[str, Any]) -> dict[str, Any]:
    """List files and directories from the bound workspace root with deterministic ordering."""

    workspace_root = resolve_workspace_root()
    target_path, relative_path = resolve_workspace_path(workspace_root, tool_input.get("path", "."))
    if not target_path.exists():
        raise FileNotFoundError(f'Path "{relative_path}" was not found.')
    if not target_path.is_dir():
        raise NotADirectoryError(f'Path "{relative_path}" is not a directory.')

    depth = int(tool_input.get("depth", DEFAULT_LIST_DEPTH))
    include_hidden = bool(tool_input.get("includeHidden", False))
    offset = int(tool_input.get("offset", 0))
    limit = int(tool_input.get("limit", DEFAULT_LIST_LIMIT))
    max_results = offset + limit + 1
    entries: list[dict[str, Any]] = []

    def visit_directory(directory: Path, current_depth: int) -> None:
        if len(entries) >= max_results:
            return

        for child_path in sorted(directory.iterdir(), key=lambda candidate: (candidate.name.lower(), candidate.name)):
            if _should_skip_path(child_path, include_hidden):
                continue

            child_relative_path = child_path.relative_to(workspace_root).as_posix()
            entry: dict[str, Any] = {
                "name": child_path.name,
                "path": child_relative_path,
                "entryType": "directory" if child_path.is_dir() else "file",
                "depth": current_depth,
            }
            if child_path.is_file():
                entry["bytes"] = child_path.stat().st_size
            entries.append(entry)

            if len(entries) >= max_results:
                return

            if child_path.is_dir() and current_depth < depth:
                visit_directory(child_path, current_depth + 1)
                if len(entries) >= max_results:
                    return

    visit_directory(target_path, 1)
    sliced_entries = entries[offset : offset + limit]
    next_offset = offset + limit if len(entries) > offset + limit else None

    result = {
        "rootPath": str(workspace_root),
        "path": relative_path,
        "depth": depth,
        "offset": offset,
        "limit": limit,
        "entries": sliced_entries,
        "truncated": next_offset is not None,
    }
    if next_offset is not None:
        result["nextOffset"] = next_offset
    return result


def list_repository_entries(tool_input: dict[str, Any]) -> dict[str, Any]:
    """Compatibility wrapper for the legacy repo.list tool contract."""

    result = list_repository_tree(tool_input)
    return {
        "rootPath": result["rootPath"],
        "path": result["path"],
        "entries": [
            {key: value for key, value in entry.items() if key in {"name", "path", "entryType", "bytes"}}
            for entry in result["entries"]
        ],
        "truncated": result["truncated"],
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
    requested_range = tool_input.get("range")
    if isinstance(requested_range, list) and len(requested_range) == 2:
        start_line = int(requested_range[0])
        requested_end_line = int(requested_range[1])
    else:
        start_line = int(tool_input.get("startLine", 1))
        requested_end_line = int(tool_input.get("endLine", total_lines or 1))
    max_bytes = int(tool_input.get("maxBytes", DEFAULT_FILE_READ_MAX_BYTES))

    if requested_end_line < start_line:
        raise ValueError("range end must be greater than or equal to the start line.")
    if total_lines > 0 and start_line > total_lines:
        raise ValueError("range start must be within the file line range.")

    if total_lines == 0:
        return {
            "rootPath": str(workspace_root),
            "path": relative_path,
            "content": "",
            "encoding": "utf-8",
            "truncated": False,
            "range": [1, 1],
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
        "range": [start_line, actual_end_line],
        "totalLines": total_lines,
        "bytes": rendered_bytes,
    }


def search_repository(tool_input: dict[str, Any]) -> dict[str, Any]:
    """Search text or symbol definitions across the workspace with bounded output."""

    workspace_root = resolve_workspace_root()
    query = str(tool_input["query"])
    options = tool_input.get("options") or {}
    search_type = str(options.get("type", "text"))
    include_hidden = bool(options.get("includeHidden", False))
    search_root, relative_root = resolve_workspace_path(workspace_root, options.get("path", "."))
    if not search_root.exists():
        raise FileNotFoundError(f'Path "{relative_root}" was not found.')
    if search_root.is_file():
        candidate_files: Iterable[Path] = [search_root]
    else:
        candidate_files = _iter_search_files(search_root, include_hidden)

    offset = int(options.get("offset", 0))
    limit = int(options.get("limit", DEFAULT_SEARCH_LIMIT))
    max_results = offset + limit + 1
    max_file_bytes = int(options.get("maxFileBytes", DEFAULT_SEARCH_MAX_FILE_BYTES))
    lowered_query = query.lower()
    matches: list[dict[str, Any]] = []
    searched_file_count = 0

    for candidate_path in candidate_files:
        if len(matches) >= max_results:
            break
        try:
            candidate_size = candidate_path.stat().st_size
        except OSError:
            continue
        if candidate_size > max_file_bytes:
            continue
        try:
            file_bytes = candidate_path.read_bytes()
        except OSError:
            continue
        if _is_binary_bytes(file_bytes):
            continue

        searched_file_count += 1
        text = file_bytes.decode("utf-8", errors="replace")
        for line_number, line in enumerate(text.splitlines(), start=1):
            line_to_match = line.lower()
            if lowered_query not in line_to_match:
                continue
            if search_type == "symbol" and not SYMBOL_LINE_PATTERN.search(line):
                continue
            column = line_to_match.index(lowered_query) + 1
            match = {
                "path": candidate_path.relative_to(workspace_root).as_posix(),
                "line": line_number,
                "column": column,
                "preview": line.strip()[:240],
            }
            symbol_kind = _detect_symbol_kind(line) if search_type == "symbol" else None
            if symbol_kind is not None:
                match["symbolKind"] = symbol_kind
            matches.append(match)
            if len(matches) >= max_results:
                break

    sliced_matches = matches[offset : offset + limit]
    next_offset = offset + limit if len(matches) > offset + limit else None
    result = {
        "rootPath": str(workspace_root),
        "query": query,
        "searchType": search_type,
        "offset": offset,
        "limit": limit,
        "searchedFileCount": searched_file_count,
        "matches": sliced_matches,
        "truncated": next_offset is not None,
    }
    if next_offset is not None:
        result["nextOffset"] = next_offset
    return result


def get_repository_status(_tool_input: dict[str, Any]) -> dict[str, Any]:
    """Return repository status using fixed, read-only git arguments."""

    workspace_root = resolve_workspace_root()
    output = _run_git_readonly(
        workspace_root,
        ["status", "--porcelain=v1", "--branch", "--untracked-files=all"],
    )

    branch = None
    changes: list[dict[str, Any]] = []
    for line in output.splitlines():
        if line.startswith("## "):
            branch_line = line[3:].strip()
            branch = branch_line.split("...", 1)[0]
            if branch == "HEAD (no branch)":
                branch = "detached"
            continue

        if len(line) < 3:
            continue

        index_status = line[0]
        worktree_status = line[1]
        payload = line[3:]
        original_path = None
        if " -> " in payload:
            original_path, payload = payload.split(" -> ", 1)
        change_entry = {
            "path": payload.replace("\\", "/"),
            "indexStatus": index_status,
            "workTreeStatus": worktree_status,
        }
        if original_path is not None:
            change_entry["originalPath"] = original_path.replace("\\", "/")
        changes.append(change_entry)

    return {
        "rootPath": str(workspace_root),
        "branch": branch,
        "head": _run_git_readonly(workspace_root, ["rev-parse", "HEAD"]).strip(),
        "clean": len(changes) == 0,
        "changes": changes,
    }


def get_repository_log(tool_input: dict[str, Any]) -> dict[str, Any]:
    """Return recent commit metadata with bounded pagination."""

    workspace_root = resolve_workspace_root()
    limit = int(tool_input.get("limit", DEFAULT_LOG_LIMIT))
    offset = int(tool_input.get("offset", 0))
    raw_output = _run_git_readonly(
        workspace_root,
        [
            "log",
            f"--max-count={limit + 1}",
            f"--skip={offset}",
            "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s",
        ],
    )

    commits: list[dict[str, Any]] = []
    for line in raw_output.splitlines():
        if not line.strip():
            continue
        commit_hash, short_hash, author_name, author_email, authored_at, subject = line.split("\x1f", 5)
        commits.append(
            {
                "hash": commit_hash,
                "shortHash": short_hash,
                "authorName": author_name,
                "authorEmail": author_email,
                "authoredAt": authored_at,
                "subject": subject,
            }
        )

    next_offset = offset + limit if len(commits) > limit else None
    result = {
        "rootPath": str(workspace_root),
        "head": _run_git_readonly(workspace_root, ["rev-parse", "HEAD"]).strip(),
        "offset": offset,
        "limit": limit,
        "commits": commits[:limit],
        "truncated": next_offset is not None,
    }
    if next_offset is not None:
        result["nextOffset"] = next_offset
    return result


def get_repository_diff(tool_input: dict[str, Any]) -> dict[str, Any]:
    """Return a bounded git diff between two refs."""

    workspace_root = resolve_workspace_root()
    base = str(tool_input["base"])
    head = str(tool_input["head"])
    context_lines = int(tool_input.get("contextLines", DEFAULT_DIFF_CONTEXT_LINES))
    max_bytes = int(tool_input.get("maxBytes", DEFAULT_DIFF_MAX_BYTES))

    diff_text = _run_git_readonly(
        workspace_root,
        [
            "diff",
            "--no-color",
            "--no-ext-diff",
            f"--unified={context_lines}",
            base,
            head,
        ],
    )

    encoded_diff = diff_text.encode("utf-8")
    truncated = len(encoded_diff) > max_bytes
    if truncated:
        diff_text = encoded_diff[:max_bytes].decode("utf-8", errors="ignore")
        encoded_diff = diff_text.encode("utf-8")

    return {
        "rootPath": str(workspace_root),
        "base": base,
        "head": head,
        "diff": diff_text,
        "bytes": len(encoded_diff),
        "truncated": truncated,
    }


def resolve_workspace_path(workspace_root: Path, candidate_path: Any) -> tuple[Path, str]:
    """Resolve a user-supplied relative path within the allowed workspace root."""

    raw_relative_path = str(candidate_path or ".").replace("\\", "/")
    normalized_relative_path = "." if raw_relative_path in {"", "."} else PurePosixPath(raw_relative_path).as_posix()
    relative_parts = PurePosixPath(normalized_relative_path).parts

    if normalized_relative_path.startswith("/") or ".." in relative_parts:
        raise ValueError("Paths must stay within the bound workspace root.")
    if ".git" in relative_parts:
        raise ValueError("Paths inside .git are not exposed through repo tools.")

    target_path = (workspace_root / normalized_relative_path).resolve()
    try:
        target_path.relative_to(workspace_root)
    except ValueError as error:
        raise ValueError("Paths must stay within the bound workspace root.") from error

    allowed_roots = _resolve_allowed_roots(workspace_root)
    if not any(_is_relative_to(target_path, allowed_root) for allowed_root in allowed_roots):
        raise ValueError("Paths must stay within the configured allowed repository directories.")

    return target_path, "." if normalized_relative_path == "." else target_path.relative_to(workspace_root).as_posix()


def _resolve_allowed_roots(workspace_root: Path) -> list[Path]:
    configured_directories = os.environ.get("ARCANOS_REPO_ALLOWED_DIRS", "").strip()
    if not configured_directories:
        return [workspace_root]

    allowed_roots: list[Path] = []
    for raw_directory in configured_directories.split(","):
        normalized_directory = raw_directory.strip()
        if not normalized_directory:
            continue
        allowed_path = (workspace_root / normalized_directory).resolve()
        if not allowed_path.exists() or not allowed_path.is_dir():
            continue
        if not _is_relative_to(allowed_path, workspace_root):
            continue
        allowed_roots.append(allowed_path)

    return allowed_roots or [workspace_root]


def _iter_search_files(search_root: Path, include_hidden: bool) -> Iterable[Path]:
    if search_root.is_file():
        yield search_root
        return

    for root, directories, files in os.walk(search_root):
        root_path = Path(root)
        directories[:] = [
            directory_name
            for directory_name in sorted(directories, key=lambda candidate: candidate.lower())
            if not _should_skip_path(root_path / directory_name, include_hidden)
        ]
        for file_name in sorted(files, key=lambda candidate: candidate.lower()):
            candidate_path = root_path / file_name
            if _should_skip_path(candidate_path, include_hidden):
                continue
            if not candidate_path.is_file():
                continue
            yield candidate_path


def _should_skip_path(candidate_path: Path, include_hidden: bool) -> bool:
    if any(part in IGNORE_DIRECTORY_NAMES for part in candidate_path.parts):
        return True
    if not include_hidden and any(part.startswith(".") for part in candidate_path.parts):
        return True
    return False


def _detect_symbol_kind(line: str) -> str | None:
    lowered_line = line.lower()
    for symbol_kind in ("class", "interface", "type", "enum", "function", "const", "let", "var", "def"):
        if re.search(rf"\b{re.escape(symbol_kind)}\b", lowered_line):
            return symbol_kind
    if "export " in lowered_line:
        return "export"
    return None


def _is_binary_bytes(file_bytes: bytes) -> bool:
    return b"\x00" in file_bytes[:4096]


def _run_git_readonly(workspace_root: Path, args: list[str]) -> str:
    if not ((workspace_root / ".git").exists() or (workspace_root / ".git").is_file()):
        raise ValueError(f'Workspace root "{workspace_root}" is not a git repository.')

    completed_process = subprocess.run(
        ["git", "-C", str(workspace_root), *args],
        capture_output=True,
        check=False,
        encoding="utf-8",
        errors="replace",
        shell=False,
        env={
            **os.environ,
            "GIT_PAGER": "cat",
            "LC_ALL": "C",
            "LANG": "C",
        },
    )
    if completed_process.returncode != 0:
        error_message = completed_process.stderr.strip() or completed_process.stdout.strip() or "git command failed"
        raise ValueError(error_message)
    return completed_process.stdout


def _is_relative_to(candidate_path: Path, parent_path: Path) -> bool:
    try:
        candidate_path.relative_to(parent_path)
        return True
    except ValueError:
        return False


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
