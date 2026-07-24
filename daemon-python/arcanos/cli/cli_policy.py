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
ANSI_ESCAPE_PATTERN = re.compile(
    r"(?:\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\))|"
    r"\x9B[0-?]*[ -/]*[@-~])"
)
UNSAFE_OUTPUT_CONTROL_PATTERN = re.compile(
    r"[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\u202A-\u202E\u2066-\u2069]"
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


def redact_output(
    value: str,
    *,
    apply_truncation: bool = True,
    preserve_record_separators: bool = False,
) -> str:
    policy = load_cli_policy()
    replacement = policy.get("redactionPolicy", {}).get("replacement") or "[REDACTED]"
    redacted = value or ""
    for env_name in policy.get("redactionPolicy", {}).get("envNames") or []:
        pattern = re.compile(rf"\b({re.escape(str(env_name))}\s*=\s*)([\"']?)([^\s\"'`]+)([\"']?)", re.IGNORECASE)
        redacted = pattern.sub(rf"\1\2{replacement}\4", redacted)
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


def strip_unsafe_output_controls(
    value: str,
    *,
    preserve_record_separators: bool = False,
) -> str:
    """Remove terminal controls while preserving ordinary line formatting."""

    without_ansi = ANSI_ESCAPE_PATTERN.sub("", value or "")
    if not preserve_record_separators:
        return UNSAFE_OUTPUT_CONTROL_PATTERN.sub("", without_ansi)
    sentinel = "\uF8FF"
    while sentinel in without_ansi:
        sentinel += "\uF8FF"
    nul_sentinel = sentinel
    unit_separator_sentinel = sentinel + "\uF8FF"
    preserved = without_ansi.replace("\x00", nul_sentinel).replace(
        "\x1f",
        unit_separator_sentinel,
    )
    return (
        UNSAFE_OUTPUT_CONTROL_PATTERN.sub("", preserved)
        .replace(unit_separator_sentinel, "\x1f")
        .replace(nul_sentinel, "\x00")
    )


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
        if normalized.startswith("/") or re.match(r"^[A-Za-z]:", normalized) or normalized == ".." or "../" in normalized:
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
        or UNSAFE_OUTPUT_CONTROL_PATTERN.search(decoded)
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
