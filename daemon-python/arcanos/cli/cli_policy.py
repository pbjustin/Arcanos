from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from arcanos.debug import log_audit_event

BIDI_CONTROL_PATTERN = re.compile(r"[\u202A-\u202E\u2066-\u2069]")
_DEFAULT_IGNORABLE_CODE_POINT_RANGES = (
    r"\u00AD\u034F\u061C\u115F-\u1160\u17B4-\u17B5\u180B-\u180F"
    r"\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164"
    r"\uFE00-\uFE0F\uFEFF\uFFA0\uFFF0-\uFFF8"
    r"\U0001BCA0-\U0001BCA3\U0001D173-\U0001D17A"
    r"\U000E0000-\U000E0FFF"
)
DEFAULT_IGNORABLE_CODE_POINT_PATTERN = re.compile(
    rf"[{_DEFAULT_IGNORABLE_CODE_POINT_RANGES}]"
)
UNSAFE_GIT_PATH_CONTROL_PATTERN = re.compile(
    # Preserve the established Git-path compatibility contract; output
    # normalization separately removes the full default-ignorable set above.
    r"[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\u202A-\u202E\u2066-\u2069]"
)
_C1_CONTROL_STRING_INTRODUCERS = frozenset((0x90, 0x98, 0x9D, 0x9E, 0x9F))
_TERMINAL_SEQUENCE_BOUNDARIES = frozenset(
    ("\t", "\n", "\r", "\x85", "\u2028", "\u2029")
)
_GIT_C_ESCAPE_BYTES = {
    '"': ord('"'),
    "\\": ord("\\"),
    "a": 0x07,
    "b": 0x08,
    "t": 0x09,
    "n": 0x0A,
    "v": 0x0B,
    "f": 0x0C,
    "r": 0x0D,
}
DEFAULT_POLICY_PATH = Path(__file__).resolve().parents[3] / "config" / "cli-policy.json"
_POLICY_CACHE: dict[str, Any] | None = None
_POLICY_CACHE_KEY: tuple[str, int, int] | None = None
_MAX_STRUCTURED_ASSIGNMENT_DEPTH = 64
_ASSIGNMENT_PADDING_PATTERN = (
    r"[\u0009-\u000D\u001C-\u0020\u0085\u00A0\u1680\u2000-\u200A"
    r"\u2028\u2029\u202F\u205F\u3000\uFEFF]*"
)


@dataclass(frozen=True)
class CommandDecision:
    allowed: bool
    cwd: str
    timeout_ms: int
    reason: str | None = None
    matched_pattern: str | None = None


@dataclass(frozen=True)
class PatchDecision:
    allowed: bool
    reason: str | None
    patch_hash: str
    files: list[str]
    added_lines: int
    removed_lines: int
    redacted_preview: str


def load_cli_policy() -> dict[str, Any]:
    global _POLICY_CACHE, _POLICY_CACHE_KEY
    policy_path = Path(os.environ.get("ARCANOS_CLI_POLICY_PATH") or DEFAULT_POLICY_PATH)
    policy_stat = policy_path.stat()
    cache_key = (str(policy_path.resolve()), policy_stat.st_mtime_ns, policy_stat.st_size)
    if _POLICY_CACHE is not None and _POLICY_CACHE_KEY == cache_key:
        return _POLICY_CACHE

    raw = policy_path.read_text(encoding="utf-8")
    policy = json.loads(raw)
    log_audit_event(
        "daemon.policy.loaded",
        policy_path=str(policy_path),
        version=policy.get("version"),
        policy_hash=hashlib.sha256(raw.encode("utf-8")).hexdigest(),
        allow_prefix_count=len(policy.get("commandPolicy", {}).get("allowPrefixes") or []),
        deny_pattern_count=len(policy.get("commandPolicy", {}).get("denyPatterns") or []),
    )
    _POLICY_CACHE = policy
    _POLICY_CACHE_KEY = cache_key
    return policy


def is_secret_path(candidate_path: str, policy: dict[str, Any] | None = None) -> bool:
    """Return whether a repository-relative path is denied by the shared secret-file policy."""

    normalized_path = str(candidate_path or "").replace("\\", "/")
    while normalized_path.startswith("./"):
        normalized_path = normalized_path[2:]
    loaded_policy = policy or load_cli_policy()
    return any(
        re.search(pattern, normalized_path, re.IGNORECASE) is not None
        for pattern in loaded_policy.get("patchPolicy", {}).get("secretPathPatterns") or []
    )


def resolve_workspace_root(policy: dict[str, Any] | None = None) -> str:
    loaded_policy = policy or load_cli_policy()
    configured = (
        os.environ.get("ARCANOS_CLI_SANDBOX_ROOT")
        or os.environ.get("ARCANOS_WORKSPACE_ROOT")
        or os.getcwd()
    )
    default_root = loaded_policy.get("cwdSandbox", {}).get("defaultRoot") or "."
    root = Path(configured)
    if not root.is_absolute():
        root = Path.cwd() / root
    if default_root != ".":
        root = root / str(default_root)
    return str(root.resolve())


def evaluate_command_policy(command: str, cwd: str | None = None, timeout_ms: int | None = None) -> CommandDecision:
    policy = load_cli_policy()
    workspace_root = Path(resolve_workspace_root(policy)).resolve()
    requested = Path(cwd or workspace_root)
    if not requested.is_absolute():
        requested = workspace_root / requested
    requested = requested.resolve()

    default_timeout = int(policy.get("timeoutPolicy", {}).get("defaultMs") or 30000)
    max_timeout = int(policy.get("timeoutPolicy", {}).get("maxMs") or default_timeout)
    resolved_timeout = default_timeout if not timeout_ms or timeout_ms <= 0 else min(int(timeout_ms), max_timeout)

    if policy.get("cwdSandbox", {}).get("allowSubdirectoriesOnly", True):
        try:
            requested.relative_to(workspace_root)
        except ValueError:
            return CommandDecision(False, str(requested), resolved_timeout, "cwd_outside_workspace")

    if BIDI_CONTROL_PATTERN.search(command):
        return CommandDecision(False, str(requested), resolved_timeout, "command_contains_unsupported_control_character")

    for pattern in policy.get("commandPolicy", {}).get("denyPatterns") or []:
        if re.search(pattern, command, re.IGNORECASE):
            return CommandDecision(False, str(requested), resolved_timeout, "command_denied_by_policy", pattern)

    allow_prefixes = policy.get("commandPolicy", {}).get("allowPrefixes") or []
    normalized = command.strip().lower()
    if allow_prefixes and not any(
        normalized == prefix.strip().lower() or normalized.startswith(prefix.strip().lower() + " ")
        for prefix in allow_prefixes
    ):
        return CommandDecision(False, str(requested), resolved_timeout, "command_not_allowlisted")

    return CommandDecision(True, str(requested), resolved_timeout)


def command_to_argv(command: str) -> list[str]:
    return shlex.split(command, posix=os.name != "nt")


def _find_structured_assignment_end(value: str, start: int) -> int | None:
    closing_for = {"{": "}", "[": "]"}
    stack = [value[start]]
    in_string = False
    escaped = False

    for index in range(start + 1, len(value)):
        character = value[index]
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            continue

        if character == '"':
            in_string = True
        elif character in closing_for:
            if len(stack) >= _MAX_STRUCTURED_ASSIGNMENT_DEPTH:
                return None
            stack.append(character)
        elif character in ("}", "]"):
            if not stack or closing_for[stack[-1]] != character:
                return None
            stack.pop()
            if not stack:
                return index + 1

    return None


def _reject_nonstandard_json_constant(constant: str) -> None:
    raise ValueError(f"non-standard JSON constant: {constant}")


def _is_strict_json_assignment(value: str, start: int, end: int) -> bool:
    try:
        json.loads(
            value[start:end],
            parse_constant=_reject_nonstandard_json_constant,
            parse_float=str,
            parse_int=str,
        )
    except (ValueError, RecursionError):
        return False
    return True


def _find_assignment_token_end(value: str, start: int) -> int:
    index = start
    quote: str | None = None

    while index < len(value):
        character = value[index]
        if character == "`" or (character == "$" and value[index : index + 2] == "$("):
            return len(value)

        if quote is not None:
            if character == quote:
                quote = None
            elif quote == '"' and character == "\\":
                index += 2
                continue
            index += 1
            continue

        if character in "\t\n\r ":
            return index
        if character in ('"', "'"):
            quote = character
        elif character in ("\\", "^"):
            index += 2
            continue
        index += 1
    return len(value)


def _redact_named_assignment(value: str, env_name: str, replacement: str) -> str:
    pattern = re.compile(
        rf"(?<![A-Za-z0-9_])({re.escape(env_name)}{_ASSIGNMENT_PADDING_PATTERN}="
        rf"{_ASSIGNMENT_PADDING_PATTERN})",
        re.IGNORECASE | re.ASCII,
    )
    redacted_parts: list[str] = []
    cursor = 0
    search_from = 0

    while match := pattern.search(value, search_from):
        assignment_start = match.end()
        if assignment_start >= len(value):
            search_from = match.end()
            continue

        assignment_end: int | None
        replacement_value = replacement
        first_character = value[assignment_start]
        if first_character in ("{", "["):
            assignment_end = _find_structured_assignment_end(value, assignment_start)
            if assignment_end is None or not _is_strict_json_assignment(
                value,
                assignment_start,
                assignment_end,
            ):
                redacted_parts.append(value[cursor : match.start()])
                redacted_parts.append(f"{match.group(1)}{replacement}")
                cursor = len(value)
                break
            assignment_end = _find_assignment_token_end(value, assignment_end)
        elif first_character in ('"', "'"):
            assignment_end = _find_assignment_token_end(value, assignment_start)
            replacement_value = f"{first_character}{replacement}{first_character}"
        else:
            assignment_end = _find_assignment_token_end(value, assignment_start)

        if assignment_end == assignment_start:
            search_from = match.end()
            continue

        redacted_parts.append(value[cursor : match.start()])
        redacted_parts.append(f"{match.group(1)}{replacement_value}")
        cursor = assignment_end
        search_from = assignment_end

    redacted_parts.append(value[cursor:])
    return "".join(redacted_parts)


def redact_output(
    value: str,
    *,
    apply_truncation: bool = True,
    preserve_record_separators: bool = False,
) -> str:
    policy = load_cli_policy()
    replacement = policy.get("redactionPolicy", {}).get("replacement") or "[REDACTED]"
    redacted = strip_unsafe_output_controls(
        value or "",
        preserve_record_separators=preserve_record_separators,
    )
    for env_name in policy.get("redactionPolicy", {}).get("envNames") or []:
        redacted = _redact_named_assignment(redacted, str(env_name), replacement)
    redacted = re.sub(r"\bBearer\s+[A-Za-z0-9._~+/=-]{12,}", f"Bearer {replacement}", redacted, flags=re.IGNORECASE)
    redacted = re.sub(r"\bsk-[A-Za-z0-9_-]{12,}\b", replacement, redacted)
    redacted = re.sub(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b", replacement, redacted)
    redacted = re.sub(r"\brwy_[A-Za-z0-9_=-]{20,}\b", replacement, redacted, flags=re.IGNORECASE)
    redacted = re.sub(r"\b[A-Za-z][A-Za-z0-9+.-]*://[^\s\"'`]*:[^\s\"'`@]+@[^\s\"'`]+", replacement, redacted)
    redacted = re.sub(
        r"\b((?:token|secret|password|api[_-]?key|authorization|cookie)\s*=\s*)([\"']?)[^\s\"'`]+([\"']?)",
        rf"\1\2{replacement}\3",
        redacted,
        flags=re.IGNORECASE,
    )
    redacted = re.sub(r"BEGIN [A-Z ]*PRIVATE KEY[\s\S]*?END [A-Z ]*PRIVATE KEY", replacement, redacted, flags=re.IGNORECASE)
    redacted = strip_unsafe_output_controls(
        redacted,
        preserve_record_separators=preserve_record_separators,
    )
    return truncate_output(redacted) if apply_truncation else redacted


def _is_c0_or_c1_control(character: str) -> bool:
    code_point = ord(character)
    return code_point <= 0x1F or 0x7F <= code_point <= 0x9F


def _is_unsafe_c0_or_c1_control(character: str) -> bool:
    code_point = ord(character)
    return (
        code_point <= 0x08
        or code_point in (0x0B, 0x0C)
        or 0x0E <= code_point <= 0x1F
        or 0x7F <= code_point <= 0x9F
    )


def _is_terminal_sequence_introducer(character: str) -> bool:
    code_point = ord(character)
    return (
        code_point == 0x1B
        or code_point == 0x9B
        or code_point in _C1_CONTROL_STRING_INTRODUCERS
    )


def _is_terminal_sequence_boundary(
    character: str,
    *,
    preserve_record_separators: bool,
) -> bool:
    return character in _TERMINAL_SEQUENCE_BOUNDARIES or (
        preserve_record_separators and character in ("\x00", "\x1f")
    )


def _consume_csi_sequence(
    value: str,
    start: int,
    *,
    preserve_record_separators: bool,
) -> int:
    index = start
    parsing_intermediates = False
    while index < len(value):
        character = value[index]
        if _is_terminal_sequence_boundary(
            character,
            preserve_record_separators=preserve_record_separators,
        ):
            return index
        if _is_c0_or_c1_control(character):
            if _is_terminal_sequence_introducer(character):
                return index
            index += 1
            continue
        code_point = ord(character)
        if not parsing_intermediates and 0x30 <= code_point <= 0x3F:
            index += 1
            continue
        if 0x20 <= code_point <= 0x2F:
            parsing_intermediates = True
            index += 1
            continue
        if 0x40 <= code_point <= 0x7E:
            return index + 1
        return len(value)
    return len(value)


def _consume_generic_escape_sequence(
    value: str,
    start: int,
    *,
    preserve_record_separators: bool,
) -> int:
    index = start
    while index < len(value):
        character = value[index]
        if _is_terminal_sequence_boundary(
            character,
            preserve_record_separators=preserve_record_separators,
        ):
            return index
        if _is_c0_or_c1_control(character):
            if _is_terminal_sequence_introducer(character):
                return index
            index += 1
            continue
        code_point = ord(character)
        if 0x20 <= code_point <= 0x2F:
            index += 1
            continue
        if 0x30 <= code_point <= 0x7E:
            return index + 1
        return len(value)
    return len(value)


def _consume_control_string(
    value: str,
    start: int,
    *,
    osc: bool,
    preserve_record_separators: bool,
) -> int:
    index = start
    while index < len(value):
        character = value[index]
        if _is_terminal_sequence_boundary(
            character,
            preserve_record_separators=preserve_record_separators,
        ):
            return index
        code_point = ord(character)
        if osc and code_point == 0x07:
            return index + 1
        if code_point == 0x9C:
            return index + 1
        if code_point == 0x1B:
            terminator_index = index + 1
            while terminator_index < len(value) and _is_c0_or_c1_control(
                value[terminator_index]
            ):
                if _is_terminal_sequence_boundary(
                    value[terminator_index],
                    preserve_record_separators=preserve_record_separators,
                ):
                    return terminator_index
                embedded_code_point = ord(value[terminator_index])
                if osc and embedded_code_point == 0x07:
                    return terminator_index + 1
                if embedded_code_point == 0x9C:
                    return terminator_index + 1
                terminator_index += 1
            if terminator_index < len(value) and value[terminator_index] == "\\":
                return terminator_index + 1
            index = terminator_index
            continue
        index += 1
    return len(value)


def _consume_escape_sequence(
    value: str,
    start: int,
    *,
    preserve_record_separators: bool,
) -> int:
    command_index = start + 1
    while command_index < len(value):
        if _is_terminal_sequence_boundary(
            value[command_index],
            preserve_record_separators=preserve_record_separators,
        ):
            return command_index
        if not _is_c0_or_c1_control(value[command_index]):
            break
        if _is_terminal_sequence_introducer(value[command_index]):
            return command_index
        command_index += 1
    if command_index >= len(value):
        return len(value)
    command = value[command_index]
    if command == "[":
        return _consume_csi_sequence(
            value,
            command_index + 1,
            preserve_record_separators=preserve_record_separators,
        )
    if command == "]":
        return _consume_control_string(
            value,
            command_index + 1,
            osc=True,
            preserve_record_separators=preserve_record_separators,
        )
    if command in ("P", "X", "^", "_"):
        return _consume_control_string(
            value,
            command_index + 1,
            osc=False,
            preserve_record_separators=preserve_record_separators,
        )
    return _consume_generic_escape_sequence(
        value,
        command_index,
        preserve_record_separators=preserve_record_separators,
    )


def _consume_terminal_sequence_at(
    value: str,
    start: int,
    *,
    preserve_record_separators: bool,
) -> int | None:
    code_point = ord(value[start])
    if code_point == 0x1B:
        return _consume_escape_sequence(
            value,
            start,
            preserve_record_separators=preserve_record_separators,
        )
    if code_point == 0x9B:
        return _consume_csi_sequence(
            value,
            start + 1,
            preserve_record_separators=preserve_record_separators,
        )
    if code_point in _C1_CONTROL_STRING_INTRODUCERS:
        return _consume_control_string(
            value,
            start + 1,
            osc=code_point == 0x9D,
            preserve_record_separators=preserve_record_separators,
        )
    return None


def strip_unsafe_output_controls(
    value: str,
    *,
    preserve_record_separators: bool = False,
) -> str:
    """Remove terminal controls while preserving ordinary line formatting."""

    normalized = DEFAULT_IGNORABLE_CODE_POINT_PATTERN.sub("", value or "")
    sanitized: list[str] = []
    index = 0
    while index < len(normalized):
        character = normalized[index]
        code_point = ord(character)
        terminal_sequence_end = _consume_terminal_sequence_at(
            normalized,
            index,
            preserve_record_separators=preserve_record_separators,
        )
        if terminal_sequence_end is not None:
            index = terminal_sequence_end
            continue
        if _is_unsafe_c0_or_c1_control(character):
            if preserve_record_separators and code_point in (0x00, 0x1F):
                sanitized.append(character)
            index += 1
            continue
        sanitized.append(character)
        index += 1
    return "".join(sanitized)


def truncate_output(value: str) -> str:
    policy = load_cli_policy()
    max_chars = int(policy.get("outputPolicy", {}).get("maxChars") or 12000)
    marker = policy.get("outputPolicy", {}).get("truncationMarker") or "\n[truncated]"
    if len(value or "") <= max_chars:
        return value or ""
    return f"{(value or '')[:max_chars]}{marker}"


def validate_patch_text(patch_text: str, cwd: str | None = None) -> PatchDecision:
    policy = load_cli_policy()
    patch_hash = hashlib.sha256((patch_text or "").encode("utf-8")).hexdigest()
    try:
        files = parse_patch_paths(patch_text or "")
    except ValueError:
        return PatchDecision(
            False,
            "patch_path_malformed",
            patch_hash,
            [],
            0,
            0,
            redact_patch_preview(patch_text or ""),
        )
    added = 0
    removed = 0
    for line in (patch_text or "").splitlines():
        if line.startswith("+") and not line.startswith("+++"):
            added += 1
        if line.startswith("-") and not line.startswith("---"):
            removed += 1
    preview = redact_patch_preview(patch_text or "")

    if "\x00" in (patch_text or ""):
        return PatchDecision(False, "patch_binary_not_allowed", patch_hash, files, added, removed, preview)
    if BIDI_CONTROL_PATTERN.search(patch_text or ""):
        return PatchDecision(False, "patch_contains_unsupported_control_character", patch_hash, files, added, removed, preview)
    if re.search(
        r"^(?:new file mode|new mode) 120000$",
        patch_text or "",
        re.MULTILINE,
    ):
        return PatchDecision(False, "patch_denied_by_policy", patch_hash, files, added, removed, preview)
    max_bytes = int(policy.get("patchPolicy", {}).get("maxBytes") or 200000)
    if len((patch_text or "").encode("utf-8")) > max_bytes:
        return PatchDecision(False, "patch_too_large", patch_hash, files, added, removed, preview)
    if not files:
        return PatchDecision(
            False,
            "patch_path_malformed",
            patch_hash,
            files,
            added,
            removed,
            preview,
        )
    for pattern in policy.get("patchPolicy", {}).get("denyContentPatterns") or []:
        if re.search(pattern, patch_text or "", re.IGNORECASE | re.MULTILINE):
            return PatchDecision(False, "patch_denied_by_policy", patch_hash, files, added, removed, preview)
    for file_path in files:
        normalized = file_path.replace("\\", "/")
        if (
            normalized.startswith("/")
            or any(":" in segment for segment in normalized.split("/"))
            or normalized == ".."
            or "../" in normalized
        ):
            return PatchDecision(False, "patch_path_outside_sandbox", patch_hash, files, added, removed, preview)
        if normalized == ".git" or normalized.startswith(".git/"):
            return PatchDecision(False, "patch_targets_git_metadata", patch_hash, files, added, removed, preview)
        if is_secret_path(normalized, policy):
            return PatchDecision(False, "patch_targets_secret_file", patch_hash, files, added, removed, preview)
        root = Path(cwd or resolve_workspace_root(policy)).resolve()
        candidate = root / normalized
        if candidate.is_symlink():
            return PatchDecision(False, "patch_symlink_not_allowed", patch_hash, files, added, removed, preview)
        target = candidate.resolve()
        try:
            target.relative_to(root)
        except ValueError:
            return PatchDecision(False, "patch_path_outside_sandbox", patch_hash, files, added, removed, preview)
        if target.exists() and target.is_symlink():
            return PatchDecision(False, "patch_symlink_not_allowed", patch_hash, files, added, removed, preview)
    return PatchDecision(True, None, patch_hash, files, added, removed, preview)


def parse_patch_paths(patch_text: str) -> list[str]:
    files: list[str] = []
    in_hunk = False
    for line in patch_text.splitlines():
        candidates: list[str] = []
        if line.startswith("diff --git "):
            in_hunk = False
            first_path, second_path = _parse_git_diff_paths(line[11:])
            candidates.extend(
                [
                    _strip_git_diff_prefix(first_path),
                    _strip_git_diff_prefix(second_path),
                ]
            )
        elif line.startswith("@@"):
            in_hunk = True
        elif not in_hunk and line.startswith(("--- ", "+++ ")):
            value = _parse_git_header_path(line[4:])
            if value != "/dev/null":
                candidates.append(_strip_git_diff_prefix(value))
        elif not in_hunk and line.startswith(
            ("rename from ", "rename to ", "copy from ", "copy to ")
        ):
            value = line.split(" ", 2)[2]
            candidates.append(_decode_git_path_field(value))
        for candidate in candidates:
            if candidate and candidate not in files:
                files.append(candidate)
    return files


def _parse_git_diff_paths(value: str) -> tuple[str, str]:
    first_token, offset = _consume_git_path_token(value, 0)
    second_token, offset = _consume_git_path_token(value, offset)
    if value[offset:].strip():
        raise ValueError("Git diff path header contains unexpected trailing data.")
    return (
        _decode_git_path_field(first_token),
        _decode_git_path_field(second_token),
    )


def _parse_git_header_path(value: str) -> str:
    token, offset = _consume_git_path_token(value, 0)
    remainder = value[offset:]
    if remainder and not remainder.startswith("\t"):
        raise ValueError("Git patch path header contains trailing data.")
    return _decode_git_path_field(token)


def _consume_git_path_token(value: str, offset: int) -> tuple[str, int]:
    while offset < len(value) and value[offset] in {" ", "\t"}:
        offset += 1
    if offset >= len(value):
        raise ValueError("Git patch path is missing.")
    start = offset
    if value[offset] != '"':
        while offset < len(value) and value[offset] not in {" ", "\t"}:
            offset += 1
        return value[start:offset], offset

    offset += 1
    while offset < len(value):
        if value[offset] == "\\":
            offset += 2
            continue
        if value[offset] == '"':
            return value[start : offset + 1], offset + 1
        offset += 1
    raise ValueError("Git patch path has an unterminated quote.")


def _decode_git_path_field(value: str) -> str:
    if not value:
        raise ValueError("Git patch path is empty.")
    if not value.startswith('"'):
        if '"' in value:
            raise ValueError("Git patch path has a malformed quote.")
        decoded = value
    else:
        if len(value) < 2 or not value.endswith('"'):
            raise ValueError("Git patch path has an unterminated quote.")
        encoded = bytearray()
        inner = value[1:-1]
        offset = 0
        while offset < len(inner):
            character = inner[offset]
            if character != "\\":
                encoded.extend(character.encode("utf-8"))
                offset += 1
                continue
            offset += 1
            if offset >= len(inner):
                raise ValueError("Git patch path has an incomplete escape.")
            escaped = inner[offset]
            if escaped in _GIT_C_ESCAPE_BYTES:
                encoded.append(_GIT_C_ESCAPE_BYTES[escaped])
                offset += 1
                continue
            if escaped not in "01234567":
                raise ValueError("Git patch path has an unsupported escape.")
            octal_digits = inner[offset : offset + 3]
            if len(octal_digits) != 3 or any(
                digit not in "01234567" for digit in octal_digits
            ):
                raise ValueError("Git patch path has a malformed octal escape.")
            octet = int(octal_digits, 8)
            if octet > 0xFF:
                raise ValueError("Git patch path octal escape is out of range.")
            encoded.append(octet)
            offset += 3
        try:
            decoded = encoded.decode("utf-8", errors="strict")
        except UnicodeDecodeError as error:
            raise ValueError("Git patch path is not valid UTF-8.") from error
    if (
        not decoded
        or UNSAFE_GIT_PATH_CONTROL_PATTERN.search(decoded)
        or BIDI_CONTROL_PATTERN.search(decoded)
    ):
        raise ValueError("Git patch path contains an unsupported character.")
    return decoded


def _strip_git_diff_prefix(value: str) -> str:
    return value[2:] if value.startswith(("a/", "b/")) else value


def redact_patch_preview(patch_text: str) -> str:
    lines: list[str] = []
    for line in (patch_text or "").splitlines():
        if line.startswith("+") and not line.startswith("+++"):
            lines.append("+[redacted added line]")
        else:
            lines.append(redact_output(line))
    return truncate_output("\n".join(lines))
