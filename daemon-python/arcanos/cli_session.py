"""
Session context utilities for ARCANOS CLI conversation state.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

from .cli_config import SESSION_SUMMARY_MAX_CHARACTERS
from .voice_boundary import Persona


SESSION_INIT_TURN_THRESHOLD = 2
SESSION_REFINING_CONFIDENCE_THRESHOLD = 0.55
SESSION_CONFIDENCE_GAIN_ON_HIT = 0.30
SESSION_CONFIDENCE_DECAY_ON_MISS = 0.85
SESSION_GOAL_LOCK_MIN_TURNS = 2
SESSION_GOAL_LOCK_CONFIDENCE_THRESHOLD = 0.40

SESSION_SUMMARY_TURN_INTERVAL = 4
SESSION_SUMMARY_HISTORY_LIMIT = 6

SUMMARY_INJECTION_PATTERN = re.compile(
    r"(?i)\b("
    r"ignore|follow|instruction|system prompt|developer|role|assistant|tool call|"
    r"act as|you are|override|bypass|jailbreak"
    r")\b"
)
SUMMARY_REDACTED_FALLBACK = "Summary omitted due to instruction-like content."

PRECISE_INTENT_DOMAINS = {
    "research",
    "debug",
    "analysis",
    "review",
    "tutor",
    "arcanos:tutor",
}
CREATIVE_INTENT_DOMAINS = {"design", "brainstorm", "gaming", "arcanos:gaming"}

TONE_TO_PERSONA = {
    "neutral": Persona.CALM,
    "precise": Persona.FOCUSED,
    "creative": Persona.EXPLORATORY,
    "critical": Persona.DIRECT,
}


@dataclass
class SessionContext:
    """
    Purpose: Store per-session conversation routing context.
    Inputs/Outputs: session_id + session state fields; used by CLI to track progress.
    Edge cases: Optional fields default to None to signal absence of intent/goal.
    """

    session_id: str
    conversation_goal: Optional[str] = None
    current_intent: Optional[str] = None
    intent_confidence: float = 0.0
    phase: Literal["init", "active", "refining", "review"] = "init"
    tone: Literal["neutral", "precise", "creative", "critical"] = "neutral"
    turn_count: int = 0
    short_term_summary: Optional[str] = None
    last_summary_turn: int = 0


def infer_phase(turn_count: int, intent_confidence: float) -> str:
    """
    Purpose: Infer the high-level conversation phase from turn count and confidence.
    Inputs/Outputs: turn_count + intent_confidence; returns phase label string.
    Edge cases: Early turns stay in "init" even when confidence rises quickly.
    """
    # //audit assumption: early turns should default to init; risk: premature phase escalation; invariant: init until threshold; strategy: guard by turn count.
    if turn_count < SESSION_INIT_TURN_THRESHOLD:
        return "init"
    # //audit assumption: confidence threshold indicates refining; risk: misclassification; invariant: refining only when threshold met; strategy: compare to configured threshold.
    if intent_confidence >= SESSION_REFINING_CONFIDENCE_THRESHOLD:
        return "refining"
    # //audit assumption: all other cases are active; risk: mislabel; invariant: active fallback; strategy: default to active.
    return "active"


def infer_tone(intent: Optional[str]) -> str:
    """
    Purpose: Infer interaction tone from detected intent domain.
    Inputs/Outputs: Optional intent string; returns tone label.
    Edge cases: Unknown or missing intents default to "neutral".
    """
    # //audit assumption: missing intent implies neutral tone; risk: mismatch; invariant: neutral default; strategy: guard.
    if not intent:
        return "neutral"
    # //audit assumption: precise domains imply focused tone; risk: wrong mapping; invariant: precise set mapped to precise; strategy: membership check.
    if intent in PRECISE_INTENT_DOMAINS:
        return "precise"
    # //audit assumption: creative domains imply exploratory tone; risk: wrong mapping; invariant: creative set mapped to creative; strategy: membership check.
    if intent in CREATIVE_INTENT_DOMAINS:
        return "creative"
    # //audit assumption: unknown intents should not change tone; risk: unexpected tone shifts; invariant: neutral fallback; strategy: default.
    return "neutral"


def sanitize_summary_for_prompt(candidate_summary: str) -> Optional[str]:
    """
    Purpose: Sanitize auto-generated summary text before embedding it into the system prompt.
    Inputs/Outputs: Raw summary string; returns safe summary text or None.
    Edge cases: Empty summaries return None; instruction-like summaries are replaced with a safe fallback marker.
    """
    # //audit assumption: whitespace normalization is safe; risk: losing nuance; invariant: normalized single-line summary; strategy: collapse whitespace.
    normalized_summary = " ".join(candidate_summary.strip().split())
    # //audit assumption: empty summary should be ignored; risk: overwriting with empty; invariant: None returned on empty; strategy: guard.
    if not normalized_summary:
        return None

    # //audit assumption: markdown/control delimiters are low-signal for summary content; risk: delimiter-based instruction smuggling; invariant: keep plain-text summary; strategy: strip control delimiters.
    normalized_summary = normalized_summary.replace("`", "").replace("{", "").replace("}", "")

    # //audit assumption: instruction-like tokens indicate prompt-injection risk; risk: persistent role hijack via session summary; invariant: never embed unsafe summary text; strategy: replace with static fallback.
    if SUMMARY_INJECTION_PATTERN.search(normalized_summary):
        return SUMMARY_REDACTED_FALLBACK

    # //audit assumption: length cap prevents prompt bloat; risk: truncation of context; invariant: max chars enforced; strategy: slice to max length.
    return normalized_summary[:SESSION_SUMMARY_MAX_CHARACTERS]
