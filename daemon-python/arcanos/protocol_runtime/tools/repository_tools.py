"""Read-only repository tools for protocol-bound workspace inspection."""

from __future__ import annotations

import os
from pathlib import Path, PurePosixPath
import re
import threading
import time
from typing import Any, Iterable

from ...cli.cli_policy import (
    is_secret_path,
    parse_patch_paths,
    redact_output,
    strip_unsafe_output_controls,
)
from ...local_agent.process_runner import (
    ProcessCancelledError,
    run_bounded_process,
)
from ...local_agent.secure_fs import (
    has_link_or_reparse_component,
    open_workspace_file,
)
from ...local_agent.workspace_registry import is_secret_workspace_path
from ..schema_loader import resolve_repository_root

DEFAULT_FILE_READ_MAX_BYTES = 65536
DEFAULT_LIST_LIMIT = 200
DEFAULT_LIST_DEPTH = 1
DEFAULT_SEARCH_LIMIT = 50
DEFAULT_SEARCH_MAX_FILE_BYTES = 262144
DEFAULT_SEARCH_TIMEOUT_MS = 30000
MAX_SEARCH_SCANNED_BYTES = 64 * 1024 * 1024
MAX_SEARCH_SCANNED_FILES = 10000
DEFAULT_LOG_LIMIT = 20
DEFAULT_DIFF_MAX_BYTES = 131072
MAX_DIFF_BYTES = 524288
DEFAULT_DIFF_CONTEXT_LINES = 3
DEFAULT_GIT_TIMEOUT_MS = 30000
DEFAULT_GIT_OUTPUT_MAX_CHARS = 1048576
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
GIT_REVISION_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$")
GIT_SECRET_PATHSPECS = (
    ":(exclude,icase,glob)**/.env",
    ":(exclude,icase,glob)**/.env.*",
    ":(exclude,icase,glob)**/.npmrc",
    ":(exclude,icase,glob)**/.pypirc",
    ":(exclude,icase,glob)**/.netrc",
    ":(exclude,icase,glob)**/.ssh/**",
    ":(exclude,icase,glob)**/id_rsa",
    ":(exclude,icase,glob)**/id_ed25519",
    ":(exclude,icase,glob)**/*secret*",
    ":(exclude,icase,glob)**/*token*",
    ":(exclude,icase,glob)**/*credential*",
    ":(exclude,icase,glob)**/*private_key*",
    ":(exclude,icase,glob)**/*private-key*",
    ":(exclude,icase,glob)**/*.pem",
    ":(exclude,icase,glob)**/*.key",
    ":(exclude,icase,glob)**/*.p12",
    ":(exclude,icase,glob)**/*.pfx",
)


def resolve_workspace_root(workspace_root: Path | str | None = None) -> Path:
    """Resolve the explicit workspace root for repo tools from env or the repository root."""

    configured_root = os.environ.get("ARCANOS_WORKSPACE_ROOT")
    if workspace_root is not None:
        resolved_workspace_root = Path(workspace_root).expanduser().resolve()
    elif configured_root:
        resolved_workspace_root = Path(configured_root).expanduser().resolve()
    else:
        resolved_workspace_root = resolve_repository_root()

    if not resolved_workspace_root.exists() or not resolved_workspace_root.is_dir():
        raise FileNotFoundError(
            f'Workspace root "{resolved_workspace_root}" does not exist or is not a directory.'
        )

    return resolved_workspace_root


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
                "railwayEnvironmentId": os.environ.get(
                    "ARCANOS_RAILWAY_ENVIRONMENT_ID"
                ),
                "railwayServiceId": os.environ.get("ARCANOS_RAILWAY_SERVICE_ID"),
                "railwayServiceName": os.environ.get("ARCANOS_RAILWAY_SERVICE_NAME"),
                "url": os.environ.get("ARCANOS_REMOTE_URL"),
            }
        )

    return {key: value for key, value in descriptor.items() if value is not None}


def list_repository_tree(tool_input: dict[str, Any]) -> dict[str, Any]:
    """List files and directories from the bound workspace root with deterministic ordering."""

    workspace_root = resolve_workspace_root()
    target_path, relative_path = resolve_workspace_path(
        workspace_root, tool_input.get("path", ".")
    )
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

        for child_path in sorted(
            directory.iterdir(),
            key=lambda candidate: (candidate.name.lower(), candidate.name),
        ):
            if _should_skip_path(child_path, include_hidden):
                continue
            if not _path_resolves_within_workspace(child_path, workspace_root):
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
            {
                key: value
                for key, value in entry.items()
                if key in {"name", "path", "entryType", "bytes"}
            }
            for entry in result["entries"]
        ],
        "truncated": result["truncated"],
    }


def read_repository_file(tool_input: dict[str, Any]) -> dict[str, Any]:
    """Read UTF-8 content from a file within the bound workspace root."""

    workspace_root = resolve_workspace_root()
    target_path, relative_path = resolve_workspace_path(
        workspace_root, tool_input["path"]
    )
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


def search_repository(
    tool_input: dict[str, Any],
    *,
    workspace_root: Path | str | None = None,
    timeout_ms: int = DEFAULT_SEARCH_TIMEOUT_MS,
    cancellation_event: threading.Event | None = None,
) -> dict[str, Any]:
    """Search text or symbol definitions across the workspace with bounded output."""

    workspace_root = resolve_workspace_root(workspace_root)
    query = str(tool_input["query"])
    options = tool_input.get("options") or {}
    search_type = str(options.get("type", "text"))
    include_hidden = bool(options.get("includeHidden", False))
    search_root, relative_root = resolve_workspace_path(
        workspace_root, options.get("path", ".")
    )
    if not search_root.exists():
        raise FileNotFoundError(f'Path "{relative_root}" was not found.')
    candidate_files: Iterable[Path] = _iter_search_files(
        search_root,
        include_hidden,
        workspace_root,
    )

    offset = int(options.get("offset", 0))
    limit = int(options.get("limit", DEFAULT_SEARCH_LIMIT))
    max_results = offset + limit + 1
    max_file_bytes = int(options.get("maxFileBytes", DEFAULT_SEARCH_MAX_FILE_BYTES))
    lowered_query = query.lower()
    matches: list[dict[str, Any]] = []
    searched_file_count = 0
    scanned_file_count = 0
    scanned_bytes = 0
    scan_truncated = False
    deadline = time.monotonic() + max(int(timeout_ms), 1) / 1000

    for candidate_path in candidate_files:
        if cancellation_event is not None and cancellation_event.is_set():
            raise ProcessCancelledError("Repository search was cancelled.")
        if (
            time.monotonic() >= deadline
            or scanned_file_count >= MAX_SEARCH_SCANNED_FILES
        ):
            scan_truncated = True
            break
        if len(matches) >= max_results:
            break
        try:
            relative_candidate = candidate_path.relative_to(workspace_root)
            with open_workspace_file(
                workspace_root,
                relative_candidate,
            ) as candidate_stream:
                candidate_size = os.fstat(candidate_stream.fileno()).st_size
                scanned_file_count += 1
                if candidate_size > max_file_bytes:
                    continue
                if scanned_bytes + candidate_size > MAX_SEARCH_SCANNED_BYTES:
                    scan_truncated = True
                    break
                scanned_bytes += candidate_size
                file_bytes = candidate_stream.read(max_file_bytes + 1)
        except (OSError, PermissionError, ValueError):
            continue
        if len(file_bytes) > max_file_bytes:
            continue
        if time.monotonic() >= deadline:
            scan_truncated = True
            break
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
                "preview": redact_output(
                    line.strip()[:240],
                    apply_truncation=False,
                ),
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
        "truncated": next_offset is not None or scan_truncated,
    }
    if next_offset is not None:
        result["nextOffset"] = next_offset
    return result


def get_repository_status(
    _tool_input: dict[str, Any],
    *,
    workspace_root: Path | str | None = None,
    timeout_ms: int = DEFAULT_GIT_TIMEOUT_MS,
    cancellation_event: threading.Event | None = None,
) -> dict[str, Any]:
    """Return repository status using fixed, read-only git arguments."""

    workspace_root = resolve_workspace_root(workspace_root)
    if not ((workspace_root / ".git").exists() or (workspace_root / ".git").is_file()):
        return {
            "rootPath": str(workspace_root),
            "clean": True,
            "changes": [],
            "gitAvailable": False,
            "workspaceType": "deployed-artifact",
            "message": "Git metadata is not available in this production container.",
        }

    output = _run_git_readonly(
        workspace_root,
        [
            "status",
            "--porcelain=v1",
            "-z",
            "--branch",
            "--untracked-files=all",
            "--",
            ".",
            *GIT_SECRET_PATHSPECS,
        ],
        timeout_ms=timeout_ms,
        cancellation_event=cancellation_event,
        preserve_nul=True,
    )

    branch = None
    changes: list[dict[str, Any]] = []
    records = output.split("\x00")
    index = 0
    while index < len(records):
        record = records[index]
        index += 1
        if not record:
            continue
        if record.startswith("## "):
            branch_line = record[3:].strip()
            branch = branch_line.split("...", 1)[0]
            if branch == "HEAD (no branch)":
                branch = "detached"
            continue
        if len(record) < 3:
            continue
        index_status = record[0]
        worktree_status = record[1]
        payload = record[3:]
        original_path = None
        if (
            index_status in {"R", "C"}
            or worktree_status in {"R", "C"}
        ) and index < len(records):
            original_path = records[index]
            index += 1
        change_entry = {
            "path": _sanitize_repository_path(payload),
            "indexStatus": index_status,
            "workTreeStatus": worktree_status,
        }
        if original_path is not None:
            change_entry["originalPath"] = _sanitize_repository_path(original_path)
        if _is_denied_repository_path(payload) or (
            original_path is not None and _is_denied_repository_path(original_path)
        ):
            continue
        changes.append(change_entry)

    result: dict[str, Any] = {
        "rootPath": str(workspace_root),
        "branch": branch,
        "clean": len(changes) == 0,
        "changes": changes,
        "gitAvailable": True,
        "workspaceType": "git",
    }
    try:
        result["head"] = _run_git_readonly(
            workspace_root,
            ["rev-parse", "HEAD"],
            timeout_ms=timeout_ms,
            cancellation_event=cancellation_event,
        ).strip()
    except ValueError:
        result["message"] = "Git repository has no commits yet."
    return result


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
        preserve_nul=True,
    )

    commits: list[dict[str, Any]] = []
    for line in raw_output.splitlines():
        if not line.strip():
            continue
        commit_hash, short_hash, author_name, author_email, authored_at, subject = (
            line.split("\x1f", 5)
        )
        author_name = strip_unsafe_output_controls(author_name)
        author_email = strip_unsafe_output_controls(author_email)
        subject = strip_unsafe_output_controls(subject)
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


def get_repository_diff(
    tool_input: dict[str, Any],
    *,
    workspace_root: Path | str | None = None,
    timeout_ms: int = DEFAULT_GIT_TIMEOUT_MS,
    cancellation_event: threading.Event | None = None,
) -> dict[str, Any]:
    """Return a bounded git diff between two refs."""

    workspace_root = resolve_workspace_root(workspace_root)
    base = validate_git_revision(tool_input["base"], field_name="base")
    head = validate_git_revision(tool_input["head"], field_name="head")
    context_lines = int(tool_input.get("contextLines", DEFAULT_DIFF_CONTEXT_LINES))
    max_bytes = int(tool_input.get("maxBytes", DEFAULT_DIFF_MAX_BYTES))
    if not 0 <= context_lines <= 20:
        raise ValueError("contextLines must be between 0 and 20.")
    if not 1 <= max_bytes <= MAX_DIFF_BYTES:
        raise ValueError(f"maxBytes must be between 1 and {MAX_DIFF_BYTES}.")

    diff_text = _run_git_readonly(
        workspace_root,
        [
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            f"--unified={context_lines}",
            base,
            head,
            "--",
            ".",
            *GIT_SECRET_PATHSPECS,
        ],
        timeout_ms=timeout_ms,
        max_output_chars=max_bytes + 1,
        cancellation_event=cancellation_event,
    )
    diff_text = _filter_denied_diff_sections(diff_text)

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


def resolve_workspace_path(
    workspace_root: Path, candidate_path: Any
) -> tuple[Path, str]:
    """Resolve a user-supplied relative path within the allowed workspace root."""

    raw_relative_path = str(candidate_path or ".").replace("\\", "/")
    normalized_relative_path = (
        "."
        if raw_relative_path in {"", "."}
        else PurePosixPath(raw_relative_path).as_posix()
    )
    relative_parts = PurePosixPath(normalized_relative_path).parts

    if (
        normalized_relative_path.startswith("/")
        or re.match(r"^[A-Za-z]:/", normalized_relative_path)
        or ".." in relative_parts
    ):
        raise ValueError("Paths must stay within the bound workspace root.")
    if ".git" in relative_parts:
        raise ValueError("Paths inside .git are not exposed through repo tools.")
    if is_secret_path(normalized_relative_path):
        raise PermissionError("Secret files are not exposed through repo tools.")

    unresolved_target = workspace_root / normalized_relative_path
    if has_link_or_reparse_component(workspace_root, unresolved_target):
        raise ValueError("Symbolic-link paths are not exposed through repo tools.")
    target_path = unresolved_target.resolve()
    try:
        resolved_relative_path = target_path.relative_to(workspace_root)
    except ValueError as error:
        raise ValueError("Paths must stay within the bound workspace root.") from error
    resolved_relative = resolved_relative_path.as_posix()
    if ".git" in resolved_relative_path.parts:
        raise ValueError("Paths inside .git are not exposed through repo tools.")
    if is_secret_path(resolved_relative):
        raise PermissionError("Secret files are not exposed through repo tools.")

    allowed_roots = _resolve_allowed_roots(workspace_root)
    if not any(
        _is_relative_to(target_path, allowed_root) for allowed_root in allowed_roots
    ):
        raise ValueError(
            "Paths must stay within the configured allowed repository directories."
        )

    return target_path, (
        "."
        if normalized_relative_path == "."
        else target_path.relative_to(workspace_root).as_posix()
    )


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


def _iter_search_files(
    search_root: Path,
    include_hidden: bool,
    workspace_root: Path,
) -> Iterable[Path]:
    if search_root.is_file():
        if not _should_skip_path(
            search_root, include_hidden
        ) and _path_resolves_within_workspace(search_root, workspace_root):
            yield search_root
        return

    for root, directories, files in os.walk(search_root, followlinks=False):
        root_path = Path(root)
        directories[:] = [
            directory_name
            for directory_name in sorted(
                directories, key=lambda candidate: candidate.lower()
            )
            if not _should_skip_path(root_path / directory_name, include_hidden)
            and _path_resolves_within_workspace(
                root_path / directory_name, workspace_root
            )
        ]
        for file_name in sorted(files, key=lambda candidate: candidate.lower()):
            candidate_path = root_path / file_name
            if _should_skip_path(candidate_path, include_hidden):
                continue
            if not candidate_path.is_file():
                continue
            if not _path_resolves_within_workspace(candidate_path, workspace_root):
                continue
            yield candidate_path


def _should_skip_path(candidate_path: Path, include_hidden: bool) -> bool:
    if has_link_or_reparse_component(
        candidate_path.parent,
        candidate_path,
    ):
        return True
    if any(part in IGNORE_DIRECTORY_NAMES for part in candidate_path.parts):
        return True
    if _is_denied_repository_path(candidate_path.as_posix()):
        return True
    if not include_hidden and any(
        part.startswith(".") for part in candidate_path.parts
    ):
        return True
    return False


def _detect_symbol_kind(line: str) -> str | None:
    lowered_line = line.lower()
    for symbol_kind in (
        "class",
        "interface",
        "type",
        "enum",
        "function",
        "const",
        "let",
        "var",
        "def",
    ):
        if re.search(rf"\b{re.escape(symbol_kind)}\b", lowered_line):
            return symbol_kind
    if "export " in lowered_line:
        return "export"
    return None


def _is_binary_bytes(file_bytes: bytes) -> bool:
    return b"\x00" in file_bytes[:4096]


def validate_git_revision(candidate: Any, *, field_name: str) -> str:
    """Validate a single Git revision without permitting option or path injection."""

    revision = str(candidate or "")
    if not GIT_REVISION_PATTERN.fullmatch(revision) or ".." in revision:
        raise ValueError(f"{field_name} must be a single safe Git revision.")
    return revision


def _run_git_readonly(
    workspace_root: Path,
    args: list[str],
    *,
    timeout_ms: int = DEFAULT_GIT_TIMEOUT_MS,
    max_output_chars: int = DEFAULT_GIT_OUTPUT_MAX_CHARS,
    cancellation_event: threading.Event | None = None,
    preserve_nul: bool = False,
) -> str:
    if not ((workspace_root / ".git").exists() or (workspace_root / ".git").is_file()):
        raise ValueError(f'Workspace root "{workspace_root}" is not a git repository.')

    completed_process = run_bounded_process(
        [
            "git",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "credential.helper=",
            "-C",
            str(workspace_root),
            *args,
        ],
        cwd=workspace_root,
        timeout_ms=timeout_ms,
        max_output_chars=max_output_chars,
        cancellation_event=cancellation_event,
        preserve_nul=preserve_nul,
    )
    if completed_process.exit_code != 0:
        error_message = (
            completed_process.stderr.strip()
            or completed_process.stdout.strip()
            or "git command failed"
        )
        raise ValueError(error_message)
    return completed_process.stdout


def _path_resolves_within_workspace(candidate_path: Path, workspace_root: Path) -> bool:
    try:
        resolved_path = candidate_path.resolve(strict=True)
    except OSError:
        return False
    return any(
        _is_relative_to(resolved_path, allowed_root)
        for allowed_root in _resolve_allowed_roots(workspace_root.resolve())
    )


def _is_relative_to(candidate_path: Path, parent_path: Path) -> bool:
    try:
        candidate_path.relative_to(parent_path)
        return True
    except ValueError:
        return False


def _is_denied_repository_path(candidate: str) -> bool:
    normalized = candidate.replace("\\", "/")
    return is_secret_path(normalized) or is_secret_workspace_path(Path(normalized))


def _filter_denied_diff_sections(diff_text: str) -> str:
    if not diff_text:
        return ""
    sections: list[list[str]] = []
    current_section: list[str] | None = None
    for line in diff_text.splitlines(keepends=True):
        if line.startswith("diff --git "):
            current_section = [line]
            sections.append(current_section)
            continue
        if current_section is None:
            if line.strip():
                raise PermissionError(
                    "Git diff output did not use the expected format."
                )
            continue
        current_section.append(line)

    allowed_sections: list[str] = []
    for section_lines in sections:
        section = "".join(section_lines)
        try:
            paths = parse_patch_paths(section)
        except ValueError as error:
            raise PermissionError("Git diff contained an unsafe path.") from error
        if not paths:
            raise PermissionError("Git diff did not identify a bounded path.")
        if any(_is_denied_repository_path(path) for path in paths):
            continue
        allowed_sections.append(section)
    return "".join(allowed_sections)


def _sanitize_repository_path(candidate: str) -> str:
    return strip_unsafe_output_controls(candidate.replace("\\", "/"))[:4_096]


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
