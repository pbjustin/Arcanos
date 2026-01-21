"""
Conversation routing and message building helpers for ARCANOS.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Mapping, Optional, Sequence


@dataclass(frozen=True)
class ConversationRouteDecision:
    """
    Purpose: Capture routing decision for a conversation message.
    Inputs/Outputs: route name, normalized message, and optional prefix used.
    Edge cases: route defaults to local when routing mode is invalid.
    """

    route: str
    normalized_message: str
    used_prefix: Optional[str]


_WORD_PATTERN = re.compile(r"[a-z0-9]+", re.IGNORECASE)


def _tokenize_message(message: str) -> list[str]:
    """
    Purpose: Tokenize a message into lowercase word tokens for intent checks.
    Inputs/Outputs: message string; returns list of lowercase tokens.
    Edge cases: Empty or non-alphanumeric messages yield an empty list.
    """
    # //audit assumption: message can be empty; risk: no tokens; invariant: list returned; strategy: regex tokenize.
    tokens = _WORD_PATTERN.findall(message)
    # //audit assumption: normalization safe; risk: locale edge cases; invariant: lowercase tokens; strategy: lower each token.
    return [token.lower() for token in tokens]


def _message_matches_backend_keywords(
    normalized_message: str,
    tokens: Sequence[str],
    keywords: Sequence[str]
) -> bool:
    """
    Purpose: Detect keyword intent for backend routing.
    Inputs/Outputs: normalized message, tokens, keywords; returns True when a keyword matches.
    Edge cases: Empty keyword list or message returns False.
    """
    if not normalized_message:
        # //audit assumption: empty message cannot match; risk: false positives; invariant: False; strategy: short-circuit.
        return False
    if not keywords:
        # //audit assumption: no keywords means no intent; risk: accidental routing; invariant: False; strategy: short-circuit.
        return False

    # //audit assumption: tokens may include mixed case; risk: mismatch; invariant: lowercase set; strategy: lower tokens.
    token_set = {token.lower() for token in tokens}
    # //audit assumption: message normalization needed for substring matching; risk: case mismatch; invariant: lowercase message; strategy: lower string.
    lowered_message = normalized_message.lower()
    for keyword in keywords:
        trimmed_keyword = keyword.strip().lower()
        if not trimmed_keyword:
            # //audit assumption: empty keyword ignored; risk: false match; invariant: skip; strategy: continue.
            continue
        if trimmed_keyword.isalnum():
            if trimmed_keyword in token_set:
                # //audit assumption: token match indicates intent; risk: false positive; invariant: backend match; strategy: return True.
                return True
        else:
            if trimmed_keyword in lowered_message:
                # //audit assumption: substring match indicates intent; risk: false positive; invariant: backend match; strategy: return True.
                return True

    # //audit assumption: no keyword matched; risk: backend not used; invariant: False; strategy: return False.
    return False


def should_auto_route_to_backend(
    normalized_message: str,
    auto_route_enabled: bool,
    auto_route_keywords: Sequence[str],
    auto_route_min_words: int
) -> bool:
    """
    Purpose: Decide whether to auto-route to backend based on heuristics.
    Inputs/Outputs: normalized message, auto flag, keywords, min word count; returns bool.
    Edge cases: Disabled auto routing or empty message returns False.
    """
    if not auto_route_enabled:
        # //audit assumption: auto routing disabled; risk: backend underused; invariant: False; strategy: short-circuit.
        return False
    if not normalized_message:
        # //audit assumption: empty message should not route; risk: invalid routing; invariant: False; strategy: short-circuit.
        return False
    if auto_route_min_words < 0:
        # //audit assumption: negative thresholds invalid; risk: misrouting; invariant: treat as disabled; strategy: clamp to 0.
        auto_route_min_words = 0

    tokens = _tokenize_message(normalized_message)
    # //audit assumption: word count supports length heuristic; risk: incorrect count; invariant: integer count; strategy: len(tokens).
    word_count = len(tokens)
    keyword_match = _message_matches_backend_keywords(normalized_message, tokens, auto_route_keywords)
    if keyword_match:
        # //audit assumption: keyword match sufficient; risk: false positives; invariant: backend route; strategy: return True.
        return True

    if auto_route_min_words > 0 and word_count >= auto_route_min_words:
        # //audit assumption: long prompts need deeper reasoning; risk: over-routing; invariant: backend route; strategy: return True.
        return True

    # //audit assumption: no heuristics matched; risk: backend not used; invariant: local route; strategy: return False.
    return False


def determine_conversation_route(
    user_message: str,
    routing_mode: str,
    deep_prefixes: Sequence[str],
    auto_route_enabled: bool,
    auto_route_keywords: Sequence[str],
    auto_route_min_words: int
) -> ConversationRouteDecision:
    """
    Purpose: Decide whether a message should use local or backend routing.
    Inputs/Outputs: user_message, routing_mode, deep_prefixes, auto routing settings; returns ConversationRouteDecision.
    Edge cases: Empty message stays local; invalid routing_mode defaults to local.
    """
    normalized_message = user_message.strip()
    if not normalized_message:
        # //audit assumption: empty messages should not route; risk: invalid routing; invariant: local route; strategy: return local.
        return ConversationRouteDecision(route="local", normalized_message=user_message, used_prefix=None)

    normalized_mode = routing_mode.strip().lower()
    if normalized_mode == "backend":
        # //audit assumption: backend mode forces backend route; risk: backend unavailable; invariant: backend route; strategy: return backend.
        return ConversationRouteDecision(route="backend", normalized_message=normalized_message, used_prefix=None)
    if normalized_mode == "local":
        # //audit assumption: local mode forces local route; risk: backend ignored; invariant: local route; strategy: return local.
        return ConversationRouteDecision(route="local", normalized_message=normalized_message, used_prefix=None)

    for prefix in deep_prefixes:
        trimmed_prefix = prefix.strip()
        if not trimmed_prefix:
            # //audit assumption: empty prefixes ignored; risk: false match; invariant: skip empty prefix; strategy: continue.
            continue
        if normalized_message.lower().startswith(trimmed_prefix.lower()):
            # //audit assumption: prefix indicates backend request; risk: accidental prefix usage; invariant: prefix stripped; strategy: strip prefix.
            stripped_message = normalized_message[len(trimmed_prefix):].strip()
            return ConversationRouteDecision(
                route="backend",
                normalized_message=stripped_message or normalized_message,
                used_prefix=trimmed_prefix
            )

    if should_auto_route_to_backend(
        normalized_message=normalized_message,
        auto_route_enabled=auto_route_enabled,
        auto_route_keywords=auto_route_keywords,
        auto_route_min_words=auto_route_min_words
    ):
        # //audit assumption: heuristics indicate backend use; risk: over-routing; invariant: backend route; strategy: return backend.
        return ConversationRouteDecision(route="backend", normalized_message=normalized_message, used_prefix=None)

    # //audit assumption: default hybrid behavior routes to local; risk: backend not used; invariant: local route; strategy: local default.
    return ConversationRouteDecision(route="local", normalized_message=normalized_message, used_prefix=None)


def build_conversation_messages(
    system_prompt: Optional[str],
    conversation_history: Sequence[Mapping[str, str]],
    user_message: str,
    max_history: int = 5
) -> list[dict[str, str]]:
    """
    Purpose: Build OpenAI-compatible message arrays from history and current input.
    Inputs/Outputs: system_prompt, conversation_history, user_message, max_history; returns list of role/content dicts.
    Edge cases: Skips history entries missing expected keys or non-string values.
    """
    messages: list[dict[str, str]] = []

    if system_prompt:
        # //audit assumption: system prompt optional; risk: missing prompt; invariant: include when provided; strategy: add system message.
        messages.append({"role": "system", "content": system_prompt})

    history_slice = list(conversation_history)[-max_history:] if max_history > 0 else []
    for entry in history_slice:
        user_text = entry.get("user") if isinstance(entry, Mapping) else None
        assistant_text = entry.get("ai") if isinstance(entry, Mapping) else None

        if isinstance(user_text, str) and user_text.strip():
            # //audit assumption: user history is valid string; risk: invalid history; invariant: include user text; strategy: append.
            messages.append({"role": "user", "content": user_text})
        if isinstance(assistant_text, str) and assistant_text.strip():
            # //audit assumption: assistant history is valid string; risk: invalid history; invariant: include assistant text; strategy: append.
            messages.append({"role": "assistant", "content": assistant_text})

    # //audit assumption: user message is required; risk: empty message; invariant: user message appended; strategy: append trimmed input.
    messages.append({"role": "user", "content": user_message})

    return messages
