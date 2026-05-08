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


def redact_output(value: str) -> str:
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
    return truncate_output(redacted)


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
    files = parse_patch_paths(patch_text or "")
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
    max_bytes = int(policy.get("patchPolicy", {}).get("maxBytes") or 200000)
    if len((patch_text or "").encode("utf-8")) > max_bytes:
        return PatchDecision(False, "patch_too_large", patch_hash, files, added, removed, preview)
    for pattern in policy.get("patchPolicy", {}).get("denyContentPatterns") or []:
        if re.search(pattern, patch_text or "", re.IGNORECASE | re.MULTILINE):
            return PatchDecision(False, "patch_denied_by_policy", patch_hash, files, added, removed, preview)
    for file_path in files:
        normalized = file_path.replace("\\", "/")
        if normalized.startswith("/") or re.match(r"^[A-Za-z]:", normalized) or normalized == ".." or "../" in normalized:
            return PatchDecision(False, "patch_path_outside_sandbox", patch_hash, files, added, removed, preview)
        if normalized == ".git" or normalized.startswith(".git/"):
            return PatchDecision(False, "patch_targets_git_metadata", patch_hash, files, added, removed, preview)
        for pattern in policy.get("patchPolicy", {}).get("secretPathPatterns") or []:
            if re.search(pattern, normalized, re.IGNORECASE):
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
    for line in patch_text.splitlines():
        candidates: list[str] = []
        diff_match = re.match(r"^diff --git a/(.+?) b/(.+)$", line)
        header_match = re.match(r"^(?:---|\+\+\+) ([^\t ]+)", line)
        rename_match = re.match(r"^rename (?:from|to) (.+)$", line)
        if diff_match:
            candidates.extend([diff_match.group(1), diff_match.group(2)])
        elif header_match and header_match.group(1) != "/dev/null":
            value = header_match.group(1)
            candidates.append(value[2:] if value.startswith(("a/", "b/")) else value)
        elif rename_match:
            candidates.append(rename_match.group(1))
        for candidate in candidates:
            if candidate and candidate not in files:
                files.append(candidate)
    return files


def redact_patch_preview(patch_text: str) -> str:
    lines: list[str] = []
    for line in (patch_text or "").splitlines():
        if line.startswith("+") and not line.startswith("+++"):
            lines.append("+[redacted added line]")
        else:
            lines.append(redact_output(line))
    return truncate_output("\n".join(lines))
