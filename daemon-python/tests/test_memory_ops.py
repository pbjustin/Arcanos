"""Tests for CLI memory operation helpers."""

from __future__ import annotations

from unittest.mock import MagicMock

from arcanos.cli import memory_ops


def test_record_conversation_turn_sanitizes_surrogate_text() -> None:
    """Conversation persistence should sanitize lone surrogates before writing."""

    cli = MagicMock()
    cli.rate_limiter = MagicMock()
    cli.memory = MagicMock()

    memory_ops.record_conversation_turn(
        cli,
        user_message="hello\udc8fworld",
        response_for_memory="ok\udc8ftest",
        tokens_used=7,
        cost_usd=0.01,
    )

    cli.rate_limiter.record_request.assert_called_once_with(7, 0.01)
    add_call = cli.memory.add_conversation.call_args
    assert add_call is not None
    persisted_user = add_call.args[0]
    persisted_response = add_call.args[1]
    assert "\udc8f" not in persisted_user
    assert "\udc8f" not in persisted_response
