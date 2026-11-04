"""Text normalization utilities shared across ARCANOS modules."""

from __future__ import annotations

import json
import re
from collections.abc import Iterator

_JOB_READ_CAPABILITY = re.compile(
    r"(?<![A-Za-z0-9_-])v1\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])"
)
_ANSI_CSI = re.compile(r"(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]")
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
_POTENTIAL_IGNORABLE_CODE_POINT = re.compile(
    rf"(?:{DEFAULT_IGNORABLE_CODE_POINT_PATTERN.pattern}|\\(?:u[0-9A-Fa-f]{{4}}|U[0-9A-Fa-f]{{8}}|x[0-9A-Fa-f]{{2}}))"
)


def _iter_json_string_spans(value: str) -> Iterator[tuple[int, int]]:
    """Scan quoted scalars once, without retrying quotes inside malformed text."""
    index = 0
    length = len(value)
    while index < length:
        if value[index] != '"':
            index += 1
            continue
        start = index
        index += 1
        while index < length:
            character = value[index]
            if character == '"':
                index += 1
                yield start, index
                break
            if character in "\r\n":
                index += 1
                break
            if character == "\\":
                index += 1
                if index == length:
                    break
                # Match the old lexical grouping: escaped LF ends a candidate;
                # escaped CR is consumed and left for json.loads to reject.
                if value[index] == "\n":
                    index += 1
                    break
            index += 1


def safe_text_repr(value: object) -> str:
    """Render opaque diagnostic data without truncation or a failing repr leak."""
    try:
        return str.__str__(repr(value))
    except Exception:
        return "<unrepresentable>"


def redact_job_read_capabilities(value: str, replacement: str = "[REDACTED]") -> str:
    """Redact complete job-read capabilities while retaining surrounding text.

    Base64URL identifier boundaries prevent matching part of a larger value.
    Inspect decorated text and decoded JSON strings without changing benign
    Unicode or escapes; only a credential-bearing span needs rewriting.
    """
    candidate = _ANSI_CSI.sub("", value)

    def redact_literal(text: str) -> str:
        def is_ignorable(match: re.Match[str]) -> bool:
            if len(match[0]) == 1:
                return True
            # Opaque diagnostic repr uses Python escapes, including \xad for
            # soft hyphens. Classify only this existing ignorable policy;
            # unrelated escaped literals are never decoded or rewritten.
            code_point = int(match[0][2:], 16)
            return code_point <= 0x10FFFF and bool(
                DEFAULT_IGNORABLE_CODE_POINT_PATTERN.fullmatch(chr(code_point))
            )

        inspection = _POTENTIAL_IGNORABLE_CODE_POINT.sub(
            lambda match: "" if is_ignorable(match) else match[0], text
        )
        if inspection == text:
            return _JOB_READ_CAPABILITY.sub(lambda _match: replacement, text)

        # Match identifier boundaries in the security view, then map only the
        # credential spans back to the original text. Unrelated emoji joiners,
        # selectors and other literal Unicode must remain byte-for-byte intact.
        ignored = (
            match for match in _POTENTIAL_IGNORABLE_CODE_POINT.finditer(text)
            if is_ignorable(match)
        )
        next_ignored = next(ignored, None)
        omitted = 0
        cursor = 0
        parts: list[str] = []
        for match in _JOB_READ_CAPABILITY.finditer(inspection):
            while next_ignored is not None and next_ignored.start() - omitted <= match.start():
                omitted += next_ignored.end() - next_ignored.start()
                next_ignored = next(ignored, None)
            start = match.start() + omitted
            while next_ignored is not None and next_ignored.start() - omitted < match.end():
                omitted += next_ignored.end() - next_ignored.start()
                next_ignored = next(ignored, None)
            end = match.end() + omitted
            parts.extend((text[cursor:start], replacement))
            cursor = end
        parts.append(text[cursor:])
        return "".join(parts)

    def redact_json_string(literal: str) -> str:
        """Inspect escaped scalar contents while leaving benign literals intact."""
        try:
            decoded = json.loads(literal)
        except ValueError:
            return redact_literal(literal)
        filtered = redact_job_read_capabilities(decoded, replacement)
        return json.dumps(filtered, ensure_ascii=True) if filtered != decoded else literal

    if "\\" in candidate:
        # Decode quoted scalars before checking boundaries: an escaped suffix
        # can make an apparent 43-character token part of a longer identifier.
        parts: list[str] = []
        cursor = 0
        for start, end in _iter_json_string_spans(candidate):
            parts.extend((redact_literal(candidate[cursor:start]), redact_json_string(candidate[start:end])))
            cursor = end
        parts.append(redact_literal(candidate[cursor:]))
        redacted = "".join(parts)
    else:
        redacted = redact_literal(candidate)
    return redacted if redacted != candidate else value


def sanitize_utf8_text(value: str) -> str:
    """
    Purpose: Normalize arbitrary strings into UTF-8 encodable text.
    Inputs/Outputs: raw text -> UTF-8-safe text.
    Edge cases: Replaces lone surrogate code points that cannot be encoded.
    """
    # //audit assumption: callers may pass malformed Unicode from external systems; risk: serialization crashes on lone surrogates; invariant: returned string always encodes with UTF-8; handling strategy: replace invalid code points during encode/decode normalization.
    return value.encode("utf-8", errors="replace").decode("utf-8")


__all__ = [
    "sanitize_utf8_text", "redact_job_read_capabilities", "safe_text_repr",
    "DEFAULT_IGNORABLE_CODE_POINT_PATTERN",
]
