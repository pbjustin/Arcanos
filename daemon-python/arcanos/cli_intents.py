"""
Intent detection helpers for CLI routing.
"""

from __future__ import annotations

import re
from typing import Optional, Mapping, Tuple, Sequence


def detect_domain_intent(
    message: str,
    domain_keywords: Mapping[str, Sequence[str]],
) -> Optional[str]:
    """
    Purpose: Determine a domain hint based on keyword presence.
    Inputs/Outputs: message string + domain_keywords mapping; returns domain label or None.
    Edge cases: Returns None when message is empty or no keywords match.
    """
    normalized_message = (message or "").lower()
    if not normalized_message:
        # //audit assumption: empty message has no intent; risk: false positive; invariant: return None; strategy: guard.
        return None

    for domain, keywords in domain_keywords.items():
        # //audit assumption: keyword list may be empty; risk: no matches; invariant: safe iteration; strategy: any() check.
        if any(keyword in normalized_message for keyword in keywords):
            return domain

    return None


def detect_run_see_intent(
    text: str,
    run_patterns: Sequence[str],
    camera_pattern: str,
    screen_pattern: str,
) -> Optional[Tuple[str, Optional[str]]]:
    """
    Purpose: Detect run/see intents from natural language input.
    Inputs/Outputs: raw text + patterns; returns ("run", command), ("see_screen", None), ("see_camera", None), or None.
    Edge cases: Returns None for empty or unsupported inputs.
    """
    normalized = (text or "").strip()
    if not normalized:
        # //audit assumption: empty input has no intent; risk: false positives; invariant: None; strategy: return None.
        return None

    for pattern in run_patterns:
        match = re.search(pattern, normalized, re.IGNORECASE)
        if match:
            # //audit assumption: regex groups contain command; risk: missing command; invariant: command extracted; strategy: use last group.
            command = (match.groups()[-1] or "").strip()
            command = re.sub(r"\s+(for me|please)$", "", command, flags=re.IGNORECASE).strip()
            if command:
                # //audit assumption: command is non-empty; risk: accidental empty run; invariant: return run intent; strategy: return tuple.
                return ("run", command)

    if re.search(camera_pattern, normalized, re.IGNORECASE):
        # //audit assumption: camera keywords imply camera intent; risk: false match; invariant: camera route; strategy: return camera intent.
        return ("see_camera", None)

    if re.search(screen_pattern, normalized, re.IGNORECASE):
        # //audit assumption: screen keywords imply screen intent; risk: false match; invariant: screen route; strategy: return screen intent.
        return ("see_screen", None)

    return None


def truncate_for_tts(text: str, max_chars: int = 600) -> str:
    """
    Purpose: Trim text for TTS playback to avoid overly long responses.
    Inputs/Outputs: text and max_chars; returns a shortened string.
    Edge cases: Returns empty string for blank input; uses sentence boundary when possible.
    """
    normalized = (text or "").strip()
    if not normalized:
        # //audit assumption: empty text should not be spoken; risk: confusing output; invariant: empty string; strategy: return empty.
        return ""

    if len(normalized) <= max_chars:
        # //audit assumption: short text safe for TTS; risk: none; invariant: original text; strategy: return original.
        return normalized

    snippet = normalized[:max_chars]
    last_sentence = max(snippet.rfind("."), snippet.rfind("!"), snippet.rfind("?"))
    if last_sentence > 0:
        # //audit assumption: sentence boundary improves clarity; risk: mid-sentence cut; invariant: end at punctuation; strategy: trim to boundary.
        snippet = snippet[: last_sentence + 1].strip()
    else:
        # //audit assumption: no sentence boundary; risk: abrupt cut; invariant: trimmed length; strategy: keep max_chars slice.
        snippet = snippet.strip()

    if snippet.endswith("..."):
        return snippet
    return f"{snippet}..."
