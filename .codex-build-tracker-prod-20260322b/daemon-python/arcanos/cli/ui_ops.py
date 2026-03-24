"""
User-interface rendering and speech operations for the CLI.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional, TYPE_CHECKING

from rich.markdown import Markdown
from rich.table import Table

from ..cli_ui import build_help_panel, build_stats_table
from ..config import Config
from ..voice_boundary import Persona, apply_voice_boundary
from ..cli_intents import truncate_for_tts
from .context import _UNSET_FILTER

if TYPE_CHECKING:
    from .cli import ArcanosCLI


def speak_to_user(
    cli: "ArcanosCLI",
    raw_text: str,
    *,
    persona: Persona,
    user_text: str,
    memory: Any,
    debug_voice: bool = False,
    filtered_text: Any = _UNSET_FILTER,
) -> Optional[str]:
    """
    Purpose: Apply voice boundary filtering and render safe markdown to the console.
    Inputs/Outputs: raw response text plus persona/user context; returns filtered response or None.
    Edge cases: Returns None when voice boundary suppresses output.
    """
    # //audit assumption: prefiltered text is optional optimization; risk: double-decay on repeated filtering; invariant: single boundary decision; strategy: honor caller-provided filtered text.
    filtered = filtered_text
    if filtered is _UNSET_FILTER:
        filtered = apply_voice_boundary(
            raw_text,
            persona=persona,
            user_text=user_text,
            memory=memory,
            debug_voice=debug_voice,
        )

    # //audit assumption: empty/None response should remain silent; risk: leakage via fallback print; invariant: print only safe non-empty text; strategy: guard before render.
    if filtered:
        cli.console.print()
        cli.console.print(Markdown(filtered))
        cli.console.print()

    return filtered


def render_system_state_table(cli: "ArcanosCLI", state_payload: Mapping[str, Any]) -> None:
    """
    Purpose: Render backend system state in deterministic table-only format.
    Inputs/Outputs: state payload mapping; prints rich table.
    Edge cases: Missing fields render as safe placeholders.
    """
    intent_payload = state_payload.get("intent") if isinstance(state_payload.get("intent"), Mapping) else {}
    routing_payload = state_payload.get("routing") if isinstance(state_payload.get("routing"), Mapping) else {}
    backend_payload = state_payload.get("backend") if isinstance(state_payload.get("backend"), Mapping) else {}
    freshness_payload = (
        state_payload.get("stateFreshness") if isinstance(state_payload.get("stateFreshness"), Mapping) else {}
    )

    table = Table(title="ARCANOS System State")
    table.add_column("Field", style="cyan", no_wrap=True)
    table.add_column("Value", style="green")

    table.add_row("mode", str(state_payload.get("mode", "unknown")))
    table.add_row("intent.intentId", str(intent_payload.get("intentId", "null")))
    table.add_row("intent.label", str(intent_payload.get("label", "null")))
    table.add_row("intent.status", str(intent_payload.get("status", "null")))
    table.add_row("intent.phase", str(intent_payload.get("phase", "null")))
    table.add_row("intent.confidence", str(intent_payload.get("confidence", 0.0)))
    table.add_row("intent.version", str(intent_payload.get("version", 0)))
    table.add_row("intent.lastTouchedAt", str(intent_payload.get("lastTouchedAt", "null")))
    table.add_row("routing.preferred", str(routing_payload.get("preferred", "unknown")))
    table.add_row("routing.lastUsed", str(routing_payload.get("lastUsed", "unknown")))
    table.add_row("routing.confidenceGate", str(routing_payload.get("confidenceGate", "unknown")))
    table.add_row("backend.connected", str(backend_payload.get("connected", False)))
    table.add_row("backend.registryAvailable", str(backend_payload.get("registryAvailable", False)))
    table.add_row("backend.lastHeartbeatAt", str(backend_payload.get("lastHeartbeatAt", "unknown")))
    table.add_row("freshness.intent", str(freshness_payload.get("intent", "unknown")))
    table.add_row("freshness.backend", str(freshness_payload.get("backend", "unknown")))
    table.add_row("generatedAt", str(state_payload.get("generatedAt", "unknown")))

    cli.console.print(table)


def handle_speak(cli: "ArcanosCLI") -> None:
    """
    Purpose: Replay last user-visible response through TTS.
    Inputs/Outputs: CLI instance; speaks response if available.
    Edge cases: Warns when no prior or no speakable response is available.
    """
    if not cli._last_response:
        # //audit assumption: no response captured yet; risk: confusing no-op; invariant: user receives explicit warning; strategy: print warning.
        cli.console.print("[yellow]Nothing to speak yet.[/yellow]")
        return

    truncated = truncate_for_tts(cli._last_response)
    if not truncated:
        # //audit assumption: truncated text can be empty after filtering; risk: silent speak call; invariant: no empty speak requests; strategy: warn and return.
        cli.console.print("[yellow]Nothing to speak yet.[/yellow]")
        return

    cli.audio.speak(truncated, wait=True)


def handle_stats(cli: "ArcanosCLI") -> None:
    """
    Purpose: Display usage statistics for current session.
    Inputs/Outputs: CLI instance; prints stats table.
    Edge cases: None.
    """
    stats = cli.memory.get_statistics()
    rate_stats = cli.rate_limiter.get_usage_stats()
    table = build_stats_table(
        stats=stats,
        rate_stats=rate_stats,
        max_requests_per_hour=Config.MAX_REQUESTS_PER_HOUR,
        max_tokens_per_day=Config.MAX_TOKENS_PER_DAY,
        max_cost_per_day=Config.MAX_COST_PER_DAY,
    )
    cli.console.print(table)


def handle_help(cli: "ArcanosCLI") -> None:
    """
    Purpose: Display CLI help text panel.
    Inputs/Outputs: CLI instance; prints help panel.
    Edge cases: None.
    """
    cli.console.print(build_help_panel())


def handle_clear(cli: "ArcanosCLI") -> None:
    """
    Purpose: Clear stored conversation history.
    Inputs/Outputs: CLI instance; clears memory conversations and prints confirmation.
    Edge cases: None.
    """
    cli.memory.clear_conversations()
    cli.console.print("[green]? Conversation history cleared[/green]")


def handle_reset(cli: "ArcanosCLI") -> None:
    """
    Purpose: Reset stored statistics after explicit user confirmation.
    Inputs/Outputs: CLI instance; mutates statistics state on affirmative input.
    Edge cases: No changes applied when user declines.
    """
    confirm = input("Reset all statistics? (y/n): ").lower().strip()
    if confirm == "y":
        # //audit assumption: destructive reset requires explicit yes; risk: accidental reset; invariant: reset only on affirmative confirmation; strategy: gate on 'y'.
        cli.memory.reset_statistics()
        cli.console.print("[green]? Statistics reset[/green]")


__all__ = [
    "handle_clear",
    "handle_help",
    "handle_reset",
    "handle_speak",
    "handle_stats",
    "render_system_state_table",
    "speak_to_user",
]
