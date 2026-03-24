"""
Response translator / interpreter for Arcanos CLI.

This sits *after* the backend /ask call and *before* rendering to the user.

Goals:
- Strip backend/system artifacts (leverages cli_midlayer.translate)
- Extract actionable proposals (patches + commands) from raw text
- Optionally suppress proposal payloads from the displayed assistant message

Design guarantees:
- Does NOT add new information
- Does NOT "fix" wrong answers
- Only restructures/filters presentation
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List, Optional, Tuple

from ..cli_midlayer import translate as _midlayer_translate
from ..agentic.proposals import (
    PatchProposal,
    CommandProposal,
    extract_patch_blocks,
    extract_command_blocks,
)

# Patch tokens (backend recommended)
_PATCH_TOKEN_RE = re.compile(r"---patch\.start---\s*\n.*?\n---patch\.end---\s*", re.DOTALL)

# Markdown fences
_DIFF_FENCE_RE = re.compile(r"```diff[^\n]*\n.*?```", re.DOTALL)
_BASH_FENCE_RE = re.compile(r"```bash[^\n]*\n.*?```", re.DOTALL)

# Diff line patterns for raw diff blocks
_DIFF_LINE_OK = re.compile(
    r"^(diff --git |index |--- |\+\+\+ |@@|[ +-]|\\ No newline at end of file|old mode|new mode|deleted file mode|new file mode|similarity index|rename from|rename to)"
)


@dataclass
class TranslationResult:
    """Translated result ready for CLI display + action handling."""
    message: str
    should_show: bool
    patches: List[PatchProposal]
    commands: List[CommandProposal]
    raw: str


def _strip_command_sections(text: str) -> str:
    """Remove simple 'Command:' suggestion blocks from display (keeps other content)."""
    lines = text.splitlines()
    out: list[str] = []
    i = 0
    while i < len(lines):
        if lines[i].strip().lower() == "command:" and i + 1 < len(lines):
            # Skip "Command:" line + the command line
            i += 2
            # Optionally skip a 'Reason:' header + one line of reason
            if i < len(lines) and lines[i].strip().lower() == "reason:":
                i += 1
                if i < len(lines):
                    i += 1
            continue
        out.append(lines[i])
        i += 1
    return "\n".join(out)


def _strip_raw_git_diff_blocks(text: str) -> str:
    """Remove raw 'diff --git' blocks from display."""
    lines = text.splitlines()
    out: list[str] = []
    i = 0
    while i < len(lines):
        if lines[i].startswith("diff --git "):
            i += 1
            while i < len(lines) and _DIFF_LINE_OK.match(lines[i]):
                i += 1
            continue
        out.append(lines[i])
        i += 1
    return "\n".join(out)


def _strip_proposals_from_display(text: str) -> str:
    """Remove patch + command payloads so the user doesn't see them twice."""
    # Remove explicit patch token blocks
    text = _PATCH_TOKEN_RE.sub("", text)

    # Remove diff/code fences used for patch proposals
    text = _DIFF_FENCE_RE.sub("", text)

    # Remove bash blocks used for command proposals
    text = _BASH_FENCE_RE.sub("", text)

    # Remove raw git diff blocks (best-effort)
    text = _strip_raw_git_diff_blocks(text)

    # Remove simple Command: blocks
    text = _strip_command_sections(text)

    # Normalize whitespace
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text


def translate_response(
    user_message: str,
    raw_response_text: str,
    *,
    source: str = "backend",
    debug: bool = False,
    suppress_proposals_in_display: bool = True,
) -> TranslationResult:
    """Translate raw assistant output into user-facing text + proposals.

    Parameters
    ----------
    suppress_proposals_in_display:
        When True, removes patch/command payloads from the displayed assistant message.
        The CLI can still present them as separate approval-gated proposals.
    """
    raw = raw_response_text or ""
    patches = extract_patch_blocks(raw)
    commands = extract_command_blocks(raw)

    display_text = raw
    if suppress_proposals_in_display:
        display_text = _strip_proposals_from_display(display_text)

    translated, should_show = _midlayer_translate(
        user_message=user_message,
        response_text=display_text,
        source=source,
        debug=debug,
    )

    return TranslationResult(
        message=translated,
        should_show=should_show and bool(translated.strip()),
        patches=patches,
        commands=commands,
        raw=raw,
    )
