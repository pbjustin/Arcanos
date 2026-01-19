"""
Environment file helpers for reading and updating .env values.
"""

from __future__ import annotations

from pathlib import Path
from typing import Mapping, Sequence


class EnvFileError(RuntimeError):
    """
    Purpose: Structured error for .env file read/write failures.
    Inputs/Outputs: Message with file context; raised on I/O failure.
    Edge cases: Wraps OS errors to avoid silent failures.
    """


def load_env_lines(env_path: Path) -> list[str]:
    """
    Purpose: Load .env file lines for in-memory updates.
    Inputs/Outputs: env_path to read; returns list of lines (with line endings).
    Edge cases: Missing file returns empty list without raising.
    """
    try:
        return env_path.read_text(encoding="utf-8").splitlines(keepends=True)
    except FileNotFoundError:
        # //audit assumption: missing .env is acceptable; risk: first run; invariant: empty list; strategy: return [].
        return []
    except OSError as exc:
        # //audit assumption: I/O can fail; risk: inability to persist creds; invariant: error surfaced; strategy: raise EnvFileError.
        raise EnvFileError(f"Failed to read env file at {env_path}") from exc


def sanitize_env_value(raw_value: str) -> str:
    """
    Purpose: Sanitize environment values before writing to disk.
    Inputs/Outputs: raw_value string; returns sanitized string with newlines removed.
    Edge cases: Newline characters are stripped to prevent file corruption.
    """
    # //audit assumption: values should be single-line; risk: newline injection; invariant: no CR/LF; strategy: strip CR/LF.
    return raw_value.replace("\r", "").replace("\n", "")


def update_env_lines(existing_lines: Sequence[str], updates: Mapping[str, str]) -> list[str]:
    """
    Purpose: Apply key/value updates to existing .env lines.
    Inputs/Outputs: existing_lines and updates mapping; returns updated lines list.
    Edge cases: Preserves comments/unknown lines and appends missing keys.
    """
    updated_lines: list[str] = []
    seen_keys: set[str] = set()

    for line in existing_lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in line:
            # //audit assumption: non-key lines are preserved; risk: comment loss; invariant: line kept; strategy: append as-is.
            updated_lines.append(line)
            continue

        key_part, _value_part = line.split("=", 1)
        key = key_part.strip()
        if key in updates:
            # //audit assumption: key updates should overwrite; risk: stale credentials; invariant: update applied; strategy: replace line.
            sanitized_value = sanitize_env_value(updates[key])
            line_ending = "\n" if line.endswith("\n") else ""
            updated_lines.append(f"{key}={sanitized_value}{line_ending}")
            seen_keys.add(key)
        else:
            # //audit assumption: untouched keys remain; risk: unintended changes; invariant: line kept; strategy: append as-is.
            updated_lines.append(line)

    for key, value in updates.items():
        if key in seen_keys:
            # //audit assumption: already updated; risk: duplicate entries; invariant: single key entry; strategy: skip append.
            continue
        # //audit assumption: missing keys should be added; risk: lost config; invariant: key added; strategy: append new line.
        updated_lines.append(f"{key}={sanitize_env_value(value)}\n")

    return updated_lines


def write_env_lines(env_path: Path, lines: Sequence[str]) -> None:
    """
    Purpose: Persist updated .env lines to disk atomically.
    Inputs/Outputs: env_path target and lines to write; writes file in-place.
    Edge cases: Uses temp file and replaces to avoid partial writes.
    """
    temp_path = env_path.with_suffix(f"{env_path.suffix}.tmp")
    try:
        temp_path.write_text("".join(lines), encoding="utf-8")
        temp_path.replace(env_path)
    except OSError as exc:
        # //audit assumption: file writes can fail; risk: partial state; invariant: temp cleanup attempted; strategy: raise EnvFileError.
        try:
            if temp_path.exists():
                # //audit assumption: cleanup is safe; risk: leftover temp file; invariant: best-effort cleanup; strategy: delete temp.
                temp_path.unlink()
        except OSError:
            # //audit assumption: cleanup can fail; risk: leftover temp file; invariant: continue raising root error; strategy: ignore cleanup error.
            pass
        raise EnvFileError(f"Failed to write env file at {env_path}") from exc


def upsert_env_values(env_path: Path, updates: Mapping[str, str]) -> None:
    """
    Purpose: Read, update, and persist .env changes in one call.
    Inputs/Outputs: env_path and updates mapping; writes updated .env file.
    Edge cases: Missing file is created; I/O errors raise EnvFileError.
    """
    existing_lines = load_env_lines(env_path)
    updated_lines = update_env_lines(existing_lines, updates)
    write_env_lines(env_path, updated_lines)
