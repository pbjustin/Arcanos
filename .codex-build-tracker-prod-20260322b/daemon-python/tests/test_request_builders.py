"""Tests for OpenAI request builder payload contracts."""

from __future__ import annotations

from arcanos.openai.request_builders import (
    _normalize_content_to_text,
    build_responses_request,
)


def test_build_responses_request_maps_assistant_history_to_output_text() -> None:
    """Assistant history should be encoded as output_text for Responses API compatibility."""

    payload = build_responses_request(
        prompt="latest prompt",
        conversation_history=[
            {"user": "first question", "ai": "first answer"},
            {"user": "second question", "ai": "second answer"},
        ],
    )

    input_items = payload["input"]
    assistant_items = [item for item in input_items if item.get("role") == "assistant"]

    assert assistant_items, "Expected assistant history items to be present"
    assert all(
        entry["content"][0]["type"] == "output_text"
        for entry in assistant_items
    )


def test_normalize_content_to_text_accepts_output_text_parts() -> None:
    """Content normalization should include output_text entries when flattening content arrays."""

    normalized = _normalize_content_to_text(
        [
            {"type": "output_text", "text": "assistant reply"},
            {"type": "input_text", "text": "user prompt"},
        ]
    )

    assert normalized == "assistant reply\nuser prompt"


def test_build_responses_request_sanitizes_surrogate_characters() -> None:
    """Request builder should strip lone surrogates so JSON encoding cannot fail."""

    payload = build_responses_request(prompt="hello\udc8fworld")
    prompt_text = payload["input"][-1]["content"][0]["text"]

    assert "\udc8f" not in prompt_text
    prompt_text.encode("utf-8")
