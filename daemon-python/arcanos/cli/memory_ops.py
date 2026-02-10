"""
Memory write and summarization operations for the CLI runtime.
"""

from __future__ import annotations

from typing import Optional, TYPE_CHECKING

from ..cli_config import SESSION_SUMMARY_PROMPT, SESSION_SUMMARY_SYSTEM_PROMPT
from ..cli_session import (
    SESSION_SUMMARY_HISTORY_LIMIT,
    SESSION_SUMMARY_TURN_INTERVAL,
    sanitize_summary_for_prompt,
)

if TYPE_CHECKING:
    from .cli import ArcanosCLI


def update_short_term_summary(cli: "ArcanosCLI") -> None:
    """
    Purpose: Periodically refresh a short conversation summary used in prompt context.
    Inputs/Outputs: CLI instance; mutates session summary fields when refresh criteria pass.
    Edge cases: Skips refresh during init phase and when history/summary is empty.
    """
    # //audit assumption: summaries should refresh only after enough turns; risk: noisy/churned summaries each turn; invariant: throttled refresh cadence; strategy: guard with interval and phase.
    if (
        cli.session.turn_count - cli.session.last_summary_turn < SESSION_SUMMARY_TURN_INTERVAL
        or cli.session.phase == "init"
    ):
        return

    history = cli.memory.get_recent_conversations(limit=SESSION_SUMMARY_HISTORY_LIMIT)
    if not history:
        # //audit assumption: summary model requires recent history; risk: null summary updates; invariant: no summary update without history; strategy: return early.
        return

    summary, _, _ = cli.gpt_client.ask(
        user_message=SESSION_SUMMARY_PROMPT,
        system_prompt=SESSION_SUMMARY_SYSTEM_PROMPT,
        conversation_history=history,
    )

    if not summary:
        # //audit assumption: summarizer can return empty output; risk: stale context replacement with empty string; invariant: preserve previous summary on empty output; strategy: no-op.
        return

    sanitized_summary = sanitize_summary_for_prompt(summary)
    if not sanitized_summary:
        # //audit assumption: sanitized summary can become empty; risk: persisting blank summary; invariant: retain previous value when sanitization strips content; strategy: no-op.
        return

    cli.session.short_term_summary = sanitized_summary
    cli.session.last_summary_turn = cli.session.turn_count


def record_conversation_turn(
    cli: "ArcanosCLI",
    user_message: str,
    response_for_memory: str,
    tokens_used: int,
    cost_usd: float,
) -> None:
    """
    Purpose: Persist one conversation turn and update rate-limit counters.
    Inputs/Outputs: user/response text plus usage metrics; mutates memory and limiter state.
    Edge cases: Response may be empty when voice boundary suppresses content.
    """
    # //audit assumption: limiter must track every billed request; risk: quota drift; invariant: request usage recorded before persistence; strategy: record then persist.
    cli.rate_limiter.record_request(tokens_used, cost_usd)
    cli.memory.add_conversation(user_message, response_for_memory, tokens_used, cost_usd)


def remember_last_response(cli: "ArcanosCLI", response_for_user: Optional[str]) -> None:
    """
    Purpose: Store the most recent user-facing response for replay/TTS.
    Inputs/Outputs: optional response string; mutates CLI last-response field.
    Edge cases: Empty strings are preserved to mirror existing behavior.
    """
    cli._last_response = response_for_user


__all__ = ["record_conversation_turn", "remember_last_response", "update_short_term_summary"]
