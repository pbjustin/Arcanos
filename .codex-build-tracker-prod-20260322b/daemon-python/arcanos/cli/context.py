"""
CLI context models and helpers.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any, TYPE_CHECKING

from ..cli_session import TONE_TO_PERSONA
from ..voice_boundary import Persona

if TYPE_CHECKING:
    from .cli import ArcanosCLI


@dataclass(frozen=True)
class ConversationResult:
    """
    Purpose: Capture conversation result details for consistent processing.
    Inputs/Outputs: response text, tokens, cost, model, and source label.
    Edge cases: tokens and cost may be zero for backend responses without usage.
    """

    response_text: str
    tokens_used: int
    cost_usd: float
    model: str
    source: str


_UNSET_FILTER: object = object()


def get_or_create_instance_id(cli: "ArcanosCLI") -> str:
    """
    Purpose: Get or create persistent instance ID for this daemon installation.
    Inputs/Outputs: CLI instance; returns persistent UUID string.
    Edge cases: Creates and stores a new UUID when no prior value exists.
    """
    instance_id = cli.memory.get_setting("instance_id")
    if not instance_id:
        # //audit assumption: missing instance id should be generated once; risk: duplicate identities; invariant: persistent id exists after call; strategy: create UUID and store.
        instance_id = str(uuid.uuid4())
        cli.memory.set_setting("instance_id", instance_id)
        cli.console.print(f"[green]?[/green] Generated daemon instance ID: {instance_id[:8]}...")
    return instance_id


def resolve_persona(cli: "ArcanosCLI") -> Persona:
    """
    Purpose: Resolve active voice persona from session tone.
    Inputs/Outputs: CLI instance with session tone; returns Persona enum.
    Edge cases: Falls back to calm persona for unknown tones.
    """
    # //audit assumption: unknown tones can occur during migrations; risk: invalid persona mapping; invariant: valid persona returned; strategy: default to calm.
    return TONE_TO_PERSONA.get(cli.session.tone, Persona.CALM)


__all__ = ["ConversationResult", "_UNSET_FILTER", "get_or_create_instance_id", "resolve_persona"]
