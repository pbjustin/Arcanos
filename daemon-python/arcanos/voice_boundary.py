"""Disclosure boundary for answer text; never infer or rewrite task outcomes."""

from __future__ import annotations

from enum import Enum
import json
import re
from typing import Any, Optional, Tuple

from .cli.cli_policy import iter_json_fields, redact_output, strip_unsafe_output_controls


class Persona(Enum):
    """Retained caller preference; presentation must preserve answer wording."""

    CALM = "calm"
    DIRECT = "direct"
    EXPLORATORY = "exploratory"
    FOCUSED = "focused"


class Severity(Enum):
    """Backend disclosure labels; levels three and four are private."""

    SEV_0 = 0
    SEV_1 = 1
    SEV_2 = 2
    SEV_3 = 3
    SEV_4 = 4


VBL_TAG = re.compile(r'^<vbl severity="([0-4])" />\r?\n?')


def extract_severity(text: str) -> Tuple[str, Optional[Severity]]:
    """Consume only the leading disclosure label; malformed labels fail closed."""
    match = VBL_TAG.match(text)
    if match:
        clean = text[match.end() :]
        if clean.lstrip().startswith("<vbl"):
            return "", Severity.SEV_4
        return clean, Severity(int(match[1]))
    if text.lstrip().startswith("<vbl"):
        return "", Severity.SEV_4
    return text, None


# Legacy raw diagnostic records remain private. Mentions in explanations and
# code examples are not disclosure labels. Do not classify ordinary failures
# (backend unavailable, session validation failed, no memory saved) as private.
_PRIVATE_RECORD = re.compile(
    r'^\s*(?:["\']?(?:audit_trace|boot_snapshot|memory_shell_\w+)["\']?\s*[:=]'
    r"|(?:active session id|session_boot|logic_engine|goals_processor)\s*[:=]"
    r"|\[SYSTEM\b)",
    re.IGNORECASE,
)
_PRIVATE_JSON_KEY = re.compile(
    r'"(?:audit_trace|boot_snapshot|memory_shell_\w+)"\s*:', re.I
)
_DEBUG_RECORD = re.compile(r"^\s*(?:Traceback \(most recent call|Stack trace:)", re.I)
_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")
_ANALYSIS_RECORD = re.compile(
    r"^\s*(?:GPT-[\w.-]+[ \t]+analysis:[ \t]*)?</?analysis_output(?:[ \t>]|$)",
    re.IGNORECASE,
)


def _has_private_analysis(text: str, user_text: str) -> bool:
    """Inspect analysis records, including decoded JSON keys and values, without unwrapping."""
    try:
        value = json.loads(text)
    except ValueError:
        pass
    except RecursionError:
        return True
    else:
        pending = [value]
        while pending:
            value = pending.pop()
            if isinstance(value, dict):
                pending.extend(value.keys())
                pending.extend(value.values())
            elif isinstance(value, list):
                pending.extend(value)
            elif isinstance(value, str) and _has_private_analysis(value, user_text):
                return True
        return False

    # Exact current-source text stays literal even when its JSON is incomplete.
    quoted = (
        q for unit in (text, text.strip())
        for q in (json.dumps(unit, ensure_ascii=False), f"'{unit}'", f"`{unit}`")
    )
    if isinstance(user_text, str) and any(q in user_text for q in quoted):
        return False

    fence = ""
    fence_length = 0
    for line in text.splitlines():
        match = _FENCE.match(line)
        if fence:
            if (
                match and match[1][0] == fence and len(match[1]) >= fence_length
                and not match[2].strip()
            ):
                fence = ""
            continue
        if match and (match[1][0] != "`" or "`" not in match[2]):
            fence, fence_length = match[1][0], len(match[1])
            continue
        if line.startswith(("    ", "\t")):
            continue
        if _ANALYSIS_RECORD.match(line):
            return True
        # Inspect complete scalars without repairing a malformed outer document.
        if line.lstrip().startswith(("{", "[", '"')):
            for token in re.finditer(r'"(?:\\.|[^"\\\r\n])*"', line):
                try:
                    value = json.loads(token[0])
                except ValueError:
                    continue
                if _has_private_analysis(value, user_text):
                    return True

    return False


def classify(text: str, user_text: str = "") -> Severity:
    """Recognize legacy diagnostic records, not isolated diagnostic phrases."""
    for name, _, _ in iter_json_fields(text):
        if re.fullmatch(r"audit_trace|boot_snapshot|memory_shell_\w+", name, re.I):
            return Severity.SEV_3
    fence = ""
    fence_length = 0
    for line in text.splitlines():
        # A serialized private record stays private when wrapped in a fence.
        # Quoted mentions in explanations/source strings are not record keys.
        if line.lstrip().startswith(("{", "[", '"')) and _PRIVATE_JSON_KEY.search(line):
            return Severity.SEV_3
        match = _FENCE.match(line)
        if fence:
            if (
                match
                and match[1][0] == fence
                and len(match[1]) >= fence_length
                and not match[2].strip()
            ):
                fence = ""
            continue
        if match and (match[1][0] != "`" or "`" not in match[2]):
            fence, fence_length = match[1][0], len(match[1])
            continue
        if line.startswith(("    ", "\t")):
            continue
        if _DEBUG_RECORD.match(line):
            return Severity.SEV_4
        if _PRIVATE_RECORD.match(line):
            return Severity.SEV_3
    return Severity.SEV_3 if _has_private_analysis(text, user_text) else Severity.SEV_0


def apply_voice_boundary(
    text: str,
    *,
    persona: Persona,
    user_text: str = "",
    memory: Any = None,
    debug_voice: bool = False,
) -> Optional[str]:
    """Keep approved content verbatim, redacting credentials without truncation.

    Persona, debug intent and reassurance history cannot change an outcome or
    grant access to private diagnostics. Speech shortening belongs to the caller.
    """
    if not isinstance(text, str) or not text.strip():
        return None
    # A rejected frame has no approved answer; a redaction placeholder cannot
    # stand in for the backend's complete response.
    if not strip_unsafe_output_controls(text):
        return None
    # Normalize the inspection copy before recognizing disclosure metadata;
    # ANSI/zero-width decoration must not hide a private label or record key.
    inspection, severity = extract_severity(redact_output(text, apply_truncation=False))
    if severity in (Severity.SEV_3, Severity.SEV_4) or classify(inspection, user_text) in (
        Severity.SEV_3,
        Severity.SEV_4,
    ):
        return None
    safe_text = redact_output(
        text, apply_truncation=False, preserve_literal_unicode=True
    )
    if severity is not None:
        safe_text, literal_severity = extract_severity(safe_text)
        if literal_severity != severity:
            return None
    return safe_text if safe_text.strip() else None


def sanitize_tool_output(text: str, *, apply_truncation: bool = True) -> str:
    """Protect local tool data without changing its separately reported outcome."""
    if not text or not text.strip():
        return ""
    approved = apply_voice_boundary(text, persona=Persona.CALM)
    if approved is None:
        return "[Tool output withheld]"
    return redact_output(approved, apply_truncation=apply_truncation)
