"""
Conversation routing and message building helpers for ARCANOS.
"""

from __future__ import annotations

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


def determine_conversation_route(
    user_message: str,
    routing_mode: str,
    deep_prefixes: Sequence[str]
) -> ConversationRouteDecision:
    """
    Purpose: Decide whether a message should use local or backend routing.
    Inputs/Outputs: user_message, routing_mode, deep_prefixes; returns ConversationRouteDecision.
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
