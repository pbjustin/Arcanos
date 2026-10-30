"""Prepare approved answer text for display without rewriting its meaning."""

from __future__ import annotations

import re

from .voice_boundary import Persona, Severity, apply_voice_boundary, extract_severity
from .cli.cli_policy import redact_output, strip_unsafe_output_controls

# Compatibility with legacy backend answer/audit envelopes. Only whole section
# headings outside code are structural; ordinary mentions are answer content.
_PRIVATE_SECTION = re.compile(
    r"^(?:#{1,6}\s+)?(?:(?:🛡\ufe0f?|🛑|📊)\s*)?"
    r"(?:Audit Summary|System Routing Details|COMPLIANCE STATUS)\s*:?\s*$",
    re.IGNORECASE,
)
_ANSWER_SECTION = re.compile(
    r"^#{1,6}\s+(?:[🧠🧰📖]\s*)?(?:Answer|Narrative Output)\s*$",
    re.IGNORECASE,
)
_HEADING = re.compile(r"^(#{1,6})\s+\S")
_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")


def _strip_private_sections(text: str) -> str:
    """Remove legacy private sections, preserving every retained line verbatim."""
    kept: list[str] = []
    answer_headings: set[int] = set()
    fence = ""
    fence_length = 0
    private_level: int | None = None
    removed_private = False

    for line in text.splitlines(keepends=True):
        content = strip_unsafe_output_controls(line.rstrip("\r\n"))
        fence_match = _FENCE.match(content)
        if fence:
            if private_level is None:
                kept.append(line)
            if (
                fence_match
                and fence_match[1][0] == fence
                and len(fence_match[1]) >= fence_length
                and not fence_match[2].strip()
            ):
                fence = ""
            continue
        if fence_match:
            fence, fence_length = fence_match[1][0], len(fence_match[1])
            if private_level is None:
                kept.append(line)
            continue

        # Indented examples are content, including apparent section labels.
        if content.startswith(("    ", "\t")):
            if private_level is None:
                kept.append(line)
            continue

        heading = _HEADING.match(content)
        if private_level is not None and heading and len(heading[1]) <= private_level:
            private_level = None
        if _PRIVATE_SECTION.fullmatch(content):
            private_level = len(heading[1]) if heading else 6
            removed_private = True
            continue
        if private_level is None:
            if _ANSWER_SECTION.fullmatch(content):
                answer_headings.add(len(kept))
            kept.append(line)

    if not removed_private:
        return text
    # Legacy envelopes used a dedicated Answer header. Do not remove such
    # headings from ordinary Markdown answers that had no private envelope.
    return "".join(
        line for index, line in enumerate(kept) if index not in answer_headings
    ).strip("\r\n")


def translate(
    user_message: str,
    response_text: str,
    *,
    source: str = "local",
    debug: bool = False,
) -> tuple[str, bool]:
    """Return complete safe answer text and whether it can be displayed.

    Source/debug flags remain compatible with callers; neither bypasses the
    disclosure boundary. The backend owns wording, structure and task outcomes.
    """
    if not isinstance(response_text, str) or not response_text.strip():
        return "", False
    # Validate the complete frame before removing any legacy private sections.
    if not strip_unsafe_output_controls(response_text):
        return "", False

    _, severity = extract_severity(redact_output(response_text, apply_truncation=False))
    if severity in (Severity.SEV_3, Severity.SEV_4):
        return "", False
    text = _strip_private_sections(response_text)
    approved = apply_voice_boundary(text, persona=Persona.CALM, user_text=user_message)
    return (approved, True) if approved else ("", False)
