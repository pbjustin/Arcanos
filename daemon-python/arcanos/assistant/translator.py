"""Prepare complete answer text and approval-gated proposals for the CLI."""

from __future__ import annotations

from dataclasses import dataclass
from typing import List

from ..cli_midlayer import translate as _midlayer_translate
from ..agentic.proposals import (
    PatchProposal,
    CommandProposal,
    extract_patch_blocks,
    extract_command_blocks,
)


@dataclass
class TranslationResult:
    """Approved display text and proposals; extraction grants no execution rights."""

    message: str
    should_show: bool
    patches: List[PatchProposal]
    commands: List[CommandProposal]
    raw: str


def translate_response(
    user_message: str,
    raw_response_text: str,
    *,
    source: str = "backend",
    debug: bool = False,
    suppress_proposals_in_display: bool = False,
) -> TranslationResult:
    """Filter before proposal extraction, preserving the complete approved answer.

    The legacy suppression flag remains accepted for caller compatibility.
    Proposal extraction can represent only part of a shell example, so removing
    the source block would silently discard instructions and qualifications.
    """
    raw = raw_response_text if isinstance(raw_response_text, str) else ""
    translated, should_show = _midlayer_translate(
        user_message=user_message,
        response_text=raw,
        source=source,
        debug=debug,
    )
    return TranslationResult(
        message=translated,
        should_show=should_show,
        patches=extract_patch_blocks(translated) if should_show else [],
        commands=extract_command_blocks(translated) if should_show else [],
        raw=raw,
    )
