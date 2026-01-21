"""
OpenAI API key validation helpers.
"""

from __future__ import annotations

from typing import Optional

_PLACEHOLDER_TOKENS = (
    "sk-your-api-key-here",
    "sk-your-key-here",
    "sk-your-api-key",
    "sk-your-key",
    "your-api-key",
    "your_api_key",
    "your-key",
    "sk-...",
    "openai_api_key"
)

_PLACEHOLDER_MARKERS = (
    "{{",
    "}}",
    "${",
    "<",
    ">",
    "..."
)


def is_openai_api_key_placeholder(value: Optional[str]) -> bool:
    """
    Purpose: Detect whether an OpenAI API key value is a placeholder or template token.
    Inputs/Outputs: value string (optional); returns True when placeholder-like.
    Edge cases: None or whitespace-only values return True.
    """
    if value is None:
        # //audit assumption: missing value should be treated as placeholder; risk: false positives; invariant: bool return; strategy: return True.
        return True

    # //audit assumption: trimming whitespace avoids false negatives; risk: unintended trimming; invariant: keys should not include spaces; strategy: strip.
    trimmed_value = value.strip()
    if not trimmed_value:
        # //audit assumption: empty values are invalid; risk: missing key; invariant: placeholder flagged; strategy: return True.
        return True

    # //audit assumption: placeholder matches are case-insensitive; risk: false positives; invariant: comparisons normalized; strategy: lower().
    normalized_value = trimmed_value.lower()

    for token in _PLACEHOLDER_TOKENS:
        if token in normalized_value:
            # //audit assumption: known tokens indicate placeholders; risk: none; invariant: placeholder flagged; strategy: return True.
            return True

    for marker in _PLACEHOLDER_MARKERS:
        if marker in trimmed_value:
            # //audit assumption: template markers indicate placeholders; risk: none; invariant: placeholder flagged; strategy: return True.
            return True

    # //audit assumption: value lacks placeholder markers; risk: invalid key slips through; invariant: return False; strategy: accept.
    return False


def normalize_openai_api_key(value: Optional[str]) -> Optional[str]:
    """
    Purpose: Normalize OpenAI API key by trimming and filtering placeholder values.
    Inputs/Outputs: value string (optional); returns cleaned key or None when missing/placeholder.
    Edge cases: None, whitespace, or placeholder values return None.
    """
    if value is None:
        # //audit assumption: missing value stays missing; risk: none; invariant: None returned; strategy: return None.
        return None

    # //audit assumption: trimming whitespace is safe; risk: unintended trimming; invariant: key should not include spaces; strategy: strip.
    trimmed_value = value.strip()
    if not trimmed_value:
        # //audit assumption: empty value invalid; risk: missing key; invariant: None returned; strategy: return None.
        return None

    if is_openai_api_key_placeholder(trimmed_value):
        # //audit assumption: placeholder value invalid; risk: invalid key used; invariant: None returned; strategy: return None.
        return None

    return trimmed_value
