"""
Voice Boundary Layer (VBL) v3.0.

Purpose:
- Prevent internal system / audit / backend language from reaching users.
- Preserve a calm, confident, ChatGPT-like presence.
- Fail closed (silence > leakage).
"""

from __future__ import annotations

from enum import Enum
import random
import re
from typing import Any, Optional, Tuple


# =========================
# Personas (posture, not style)
# =========================


class Persona(Enum):
    """Conversation posture used for safe user-facing rewrites."""

    CALM = "calm"  # default
    DIRECT = "direct"  # minimal
    EXPLORATORY = "exploratory"


# =========================
# Severity Levels
# =========================


class Severity(Enum):
    """Severity for user-visible response safety filtering."""

    SEV_0 = 0  # normal conversation
    SEV_1 = 1  # light meta-awareness
    SEV_2 = 2  # system behavior
    SEV_3 = 3  # internal mechanics / audit
    SEV_4 = 4  # developer / debug only


# =========================
# Backend Auto-Label Support
# =========================
# Backend may prefix:
#   <vbl severity="3" />

VBL_TAG = re.compile(r'^<vbl severity="(\d)" />\n?', re.MULTILINE)


def extract_severity(text: str) -> Tuple[str, Optional[Severity]]:
    """
    Purpose: Parse and strip an optional backend-provided VBL severity prefix.
    Inputs/Outputs: raw text -> (clean text, optional Severity).
    Edge cases: Unknown severity digits are treated as no explicit severity.
    """
    match = VBL_TAG.match(text)
    # //audit assumption: VBL tag appears only at start; risk: mid-body false match; invariant: start-match only; strategy: use regex match.
    if not match:
        return text, None

    try:
        sev = Severity(int(match.group(1)))
    except ValueError:
        # //audit assumption: malformed severity should not crash; risk: leak via exception path; invariant: fail closed via classifier; strategy: drop explicit severity.
        sev = None
    clean = VBL_TAG.sub("", text)
    return clean, sev


# =========================
# Keyword Classification (fallback)
# =========================

SEVERITY_RULES = {
    Severity.SEV_4: [
        "traceback",
        "stack trace",
        "exception",
        "debug",
    ],
    Severity.SEV_3: [
        "audit",
        "retrieval",
        "session validation",
        "memory entry",
        "deduplicated",
        "logic trace",
        "confirmed",
        "linked",
        "suppressed",
    ],
    Severity.SEV_2: [
        "backend",
        "fallback",
        "rate limit",
        "tokens",
        "cost",
        "timeout",
    ],
    Severity.SEV_1: [
        "as a language model",
        "i am an ai",
        "system prompt",
        "i cannot remember",
    ],
}


def classify(text: str) -> Severity:
    """
    Purpose: Classify response severity using keyword rules when no explicit label exists.
    Inputs/Outputs: response text -> Severity enum.
    Edge cases: Defaults to SEV_0 when no markers are present.
    """
    lowered = text.lower()
    for severity, markers in SEVERITY_RULES.items():
        # //audit assumption: marker match implies severity bucket; risk: false positives; invariant: highest configured bucket wins by order; strategy: return first match.
        if any(marker in lowered for marker in markers):
            return severity
    return Severity.SEV_0


# =========================
# Persona-Aware Rewrites
# =========================

PERSONA_REWRITES = {
    Severity.SEV_2: {
        Persona.CALM: [
            "I’ve got this covered.",
            "I’ll take care of it.",
        ],
        Persona.DIRECT: [
            "Handled.",
        ],
        Persona.EXPLORATORY: [
            "I’ll handle this and we can keep going.",
        ],
    },
    Severity.SEV_1: {
        Persona.CALM: [
            "Here’s how I’m thinking about it.",
        ],
        Persona.DIRECT: [
            "Here’s the reasoning.",
        ],
        Persona.EXPLORATORY: [
            "Let’s think through this together.",
        ],
    },
}


def persona_rewrite(severity: Severity, persona: Persona) -> Optional[str]:
    """
    Purpose: Map severity + persona to a safe user-facing rewrite.
    Inputs/Outputs: Severity + Persona -> optional replacement text.
    Edge cases: Returns None when no rewrite exists for the pair.
    """
    options = PERSONA_REWRITES.get(severity, {}).get(persona)
    # //audit assumption: random choice is acceptable UX variation; risk: non-deterministic tests; invariant: options non-empty before choice; strategy: guard and choose.
    return random.choice(options) if options else None


# =========================
# Meta-Intent Detection
# =========================

META_INTENT_TRIGGERS = [
    "why",
    "explain",
    "audit",
    "debug",
    "clarify",
    "what happened",
    "did you save",
]


def user_requested_meta(user_text: str) -> bool:
    """
    Purpose: Detect whether the user asked for meta/debug explanation.
    Inputs/Outputs: user message -> bool.
    Edge cases: Empty text returns False.
    """
    if not user_text:
        return False
    lowered = user_text.lower()
    return any(trigger in lowered for trigger in META_INTENT_TRIGGERS)


# =========================
# Confidence Decay Hook
# (caller supplies memory)
# =========================


def _read_reassure_counter(memory: Any) -> int:
    """
    Purpose: Read VBL reassurance counter from best-available memory API.
    Inputs/Outputs: memory adapter -> integer count.
    Edge cases: Non-integer stored values resolve to zero.
    """
    count = 0
    if hasattr(memory, "get_setting"):
        # //audit assumption: settings are available on memory store; risk: missing key; invariant: integer fallback; strategy: default to zero.
        raw_count = memory.get_setting("vbl_reassure_count", 0)
        if isinstance(raw_count, int):
            return raw_count
        return 0

    if hasattr(memory, "get_stat"):
        # //audit assumption: stat access may exist in alternate memory adapters; risk: unsupported key; invariant: integer fallback; strategy: default to zero.
        raw_count = memory.get_stat("vbl_reassure_count", 0)
        if isinstance(raw_count, int):
            return raw_count
    return count


def _write_reassure_counter(memory: Any, next_count: int) -> None:
    """
    Purpose: Persist VBL reassurance counter using the available memory API.
    Inputs/Outputs: memory adapter + next counter value -> None.
    Edge cases: If no known API is present, counter persistence is skipped.
    """
    if hasattr(memory, "set_setting"):
        # //audit assumption: settings write is durable enough for counter; risk: write failure; invariant: best-effort persistence; strategy: set setting.
        memory.set_setting("vbl_reassure_count", next_count)
        return

    if hasattr(memory, "increment_stat"):
        # //audit assumption: stat increment can emulate counter; risk: missing stat key in implementation; invariant: no crash; strategy: increment as fallback.
        memory.increment_stat("vbl_reassure_count")


def should_reassure(memory: Any, limit: int = 2) -> bool:
    """
    Purpose: Gate low-severity reassurance rewrites to avoid repetition.
    Inputs/Outputs: memory adapter + limit -> bool (allow reassurance).
    Edge cases: Missing memory adapter APIs defaults to allowing reassurance.
    """
    count = _read_reassure_counter(memory)
    # //audit assumption: reassurance spam should be capped; risk: repetitive responses; invariant: max limit respected; strategy: deny when count >= limit.
    if count >= limit:
        return False

    _write_reassure_counter(memory, count + 1)
    return True


# =========================
# The Voice Boundary (FINAL)
# =========================


def apply_voice_boundary(
    text: str,
    *,
    persona: Persona,
    user_text: str = "",
    memory: Any = None,
    debug_voice: bool = False,
) -> Optional[str]:
    """
    Purpose: Enforce the final user-facing boundary for assistant responses.
    Inputs/Outputs: raw text + persona/context flags -> safe text or None.
    Edge cases: Invalid/empty input returns None (fail closed).
    """
    # ---- Fail closed immediately ----
    # //audit assumption: non-string or empty payload is unsafe to render; risk: accidental leakage; invariant: return None; strategy: hard guard.
    if not text or not isinstance(text, str):
        return None

    # ---- Extract backend-provided severity ----
    text, explicit_severity = extract_severity(text)
    severity = explicit_severity or classify(text)

    # ---- Never leak internals ----
    if severity in (Severity.SEV_4, Severity.SEV_3):
        # //audit assumption: debug meta intent may require minimal acknowledgement; risk: internals exposure; invariant: bounded static response; strategy: explicit fixed string.
        if debug_voice and user_requested_meta(user_text):
            return "I already had the context, so nothing new needed saving."
        return None

    # ---- System / meta behavior ----
    if severity in (Severity.SEV_2, Severity.SEV_1):
        # //audit assumption: reassurance should decay over time; risk: repetitive phrasing; invariant: limit enforced when memory exists; strategy: conditional gate.
        if memory and not should_reassure(memory):
            return None
        return persona_rewrite(severity, persona)

    # ---- Normal conversation ----
    return text
