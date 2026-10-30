"""Disclosure boundary for answer text; never infer or rewrite task outcomes."""

from __future__ import annotations

from enum import Enum
import re
from typing import Any, Optional, Tuple

from .cli.cli_policy import redact_output


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
    r"|(?:logic trace|retrieval context|active session id|clearance level|"
    r"included modules|transaction type|session_boot|logic_engine|goals_processor|"
    r"kernel rule set|system routing details|modules involved|backend endpoint)\s*[:=]"
    r"|\[SYSTEM\b)",
    re.IGNORECASE,
)
_PRIVATE_JSON_KEY = re.compile(
    r'"(?:audit_trace|boot_snapshot|memory_shell_\w+)"\s*:', re.I
)
_DEBUG_RECORD = re.compile(r"^\s*(?:Traceback \(most recent call|Stack trace:)", re.I)
_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")


def classify(text: str) -> Severity:
    """Recognize legacy diagnostic records, not isolated diagnostic phrases."""
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
        if match:
            fence, fence_length = match[1][0], len(match[1])
            continue
        if line.startswith(("    ", "\t")):
            continue
        if _DEBUG_RECORD.match(line):
            return Severity.SEV_4
        if _PRIVATE_RECORD.match(line):
            return Severity.SEV_3
    return Severity.SEV_0


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
    # Normalize the inspection copy before recognizing disclosure metadata;
    # ANSI/zero-width decoration must not hide a private label or record key.
    inspection, severity = extract_severity(redact_output(text, apply_truncation=False))
    if severity in (Severity.SEV_3, Severity.SEV_4) or classify(inspection) in (
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
