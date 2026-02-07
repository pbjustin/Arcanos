"""
CLI mid-layer: post-processing of model responses before display.

Strips system/audit artifacts from fine-tuned model output and reshapes
it into natural, ChatGPT-like language.  This is the Python equivalent
of src/services/midLayerTranslator.ts for CLI-side responses.

Design guarantees:
- Does NOT add new information
- Does NOT fix wrong answers
- Only removes system voice, preserves correctness, reshapes tone
"""

from __future__ import annotations

import re
from typing import Optional

# ────────────────────────────────────────────
# Intent detection
# ────────────────────────────────────────────

_INTENT_PATTERNS: dict[str, list[re.Pattern[str]]] = {
    "greeting": [
        re.compile(r"^(hi|hello|hey|sup|yo|what'?s up|howdy|good (morning|afternoon|evening))\b", re.I),
    ],
    "code": [
        re.compile(r"\b(code|function|class|script|debug|error|bug|compile|import|export|npm|pip|git)\b", re.I),
        re.compile(r"```"),
    ],
    "fact": [
        re.compile(r"\b(what is|who is|when did|where is|how many|how much|define|what are)\b", re.I),
    ],
    "story": [
        re.compile(r"\b(tell me about|explain|describe|walk me through|story|history of)\b", re.I),
    ],
    "advice": [
        re.compile(r"\b(should i|how do i|how can i|best way to|recommend|suggest|help me|tips)\b", re.I),
    ],
}

_INTENT_ORDER = ["greeting", "code", "fact", "story", "advice"]


def _detect_intent(text: str) -> str:
    for intent in _INTENT_ORDER:
        for pat in _INTENT_PATTERNS[intent]:
            if pat.search(text):
                return intent
    return "default"


# ────────────────────────────────────────────
# System-line indicators (whole line removed)
# ────────────────────────────────────────────

_SYSTEM_LINE_INDICATORS: list[re.Pattern[str]] = [
    re.compile(r"transaction type", re.I),
    re.compile(r"included modules", re.I),
    re.compile(r"active session id", re.I),
    re.compile(r"clearance level", re.I),
    re.compile(r"initiated by.*(?:frontend cli|backend|daemon)", re.I),
    re.compile(r"session_boot", re.I),
    re.compile(r"logic_engine", re.I),
    re.compile(r"goals_processor", re.I),
    re.compile(r"audit_trace", re.I),
    re.compile(r"boot_snapshot", re.I),
    re.compile(r"pattern_\d{5,}", re.I),
    re.compile(r"memory_shell_\d", re.I),
    re.compile(r"audit.?safe", re.I),
    re.compile(r"kernel rule set", re.I),
    re.compile(r"resilience patch", re.I),
    re.compile(r"fallback handler", re.I),
    re.compile(r"rollback handler", re.I),
    re.compile(r"session lock fallback", re.I),
    re.compile(r"logic dispatch", re.I),
    re.compile(r"goal articulation", re.I),
    re.compile(r"routing stages", re.I),
    re.compile(r"source verification", re.I),
    re.compile(r"reasoning path", re.I),
    re.compile(r"compliance status", re.I),
    re.compile(r"security measures applied", re.I),
    re.compile(r"all systems\s*✅", re.I),
    re.compile(r"integrity is a system", re.I),
    re.compile(r"auditable final response", re.I),
    re.compile(r"audited,?\s*finalized response", re.I),
    re.compile(r"memory patterns and reinforced", re.I),
    re.compile(r"system integrity checks", re.I),
    re.compile(r"modular memory system", re.I),
    re.compile(r"persisted via", re.I),
    re.compile(r"verified via", re.I),
    re.compile(r"interpreted and enforced", re.I),
    re.compile(r"log entry:\s*\d", re.I),
    re.compile(r"🧠v\d"),
    # Extra patterns for fine-tuned model artifacts
    re.compile(r"^🧠\s*ARCANOS", re.I),
    re.compile(r"^\[SYSTEM\b", re.I),
    re.compile(r"^---\s*DIAGNOSTIC", re.I),
    re.compile(r"memory update", re.I),
    re.compile(r"memory entry", re.I),
    re.compile(r"session state", re.I),
    re.compile(r"context reinforcement", re.I),
    re.compile(r"response classification", re.I),
    re.compile(r"priority:\s*(low|medium|high|critical)", re.I),
    re.compile(r"tags?:\s*\[", re.I),
    re.compile(r"module:\s*ARCANOS", re.I),
    re.compile(r"status:\s*(active|complete|pending|verified)", re.I),
    re.compile(r"confidence:\s*\d", re.I),
    re.compile(r"hallucination.?resistant", re.I),
    re.compile(r"\bHRC\b.*(?:STRICT|LENIENT|SILENTFAIL)", re.I),
    re.compile(r"\bCLEAR\s*2\.0\b", re.I),
    re.compile(r"audit engine", re.I),
    re.compile(r"integrity check", re.I),
    re.compile(r"retrieval context", re.I),
    re.compile(r"linked memory", re.I),
    re.compile(r"deduplicated", re.I),
    re.compile(r"reinforcement cycle", re.I),
]

# ────────────────────────────────────────────
# Structural/decorative line patterns
# ────────────────────────────────────────────

_STRUCTURAL_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"^[═─━\-]{3,}\s*$"),                       # decorative borders
    re.compile(r"^---\s*$"),                                 # horizontal rules
    re.compile(r"^#{1,3}\s*[🧠📋🔍📊🎯🛡️⚡✅❌🔒]"),    # emoji-headed sections
    re.compile(r"^[🧠📋🔍📊🎯🛡️⚡✅❌🔒]\s+[A-Z]"),     # emoji-led labels
    re.compile(r'^>\s*".*🧠'),                               # quoted system mottos
]

# ────────────────────────────────────────────
# Section markers
# ────────────────────────────────────────────

_SYSTEM_TAIL_MARKERS = [
    "### 🛡️ Audit Summary",
    "### Audit Summary",
    "🛡️ Audit Summary",
    "📊 COMPLIANCE STATUS",
    "🎯 STRUCTURED RECOMMENDATIONS",
    "---\n🧠",
]

_HUMAN_CONTENT_MARKERS = [
    "### 🧠 Answer",
    "### Answer",
    "### 📖 Narrative Output",
    "### Narrative Output",
    "**Response:**",
    "**Answer:**",
]

# ────────────────────────────────────────────
# Preamble patterns
# ────────────────────────────────────────────

_PREAMBLE_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"^understood\.?\s*", re.I),
    re.compile(r"^here is (?:your|the|my)\b.*?(?::|—|-)\s*", re.I),
    re.compile(r"^based on\b.*?(?::|—|-)\s*", re.I),
    re.compile(r"^certainly[,.]?\s*", re.I),
]

# ────────────────────────────────────────────
# Humanize replacements
# ────────────────────────────────────────────

_HUMANIZE_PAIRS = [
    (re.compile(r"\bIt is\b"), "It's"),
    (re.compile(r"\bit is\b"), "it's"),
    (re.compile(r"\bDo not\b"), "Don't"),
    (re.compile(r"\bdo not\b"), "don't"),
    (re.compile(r"\bCannot\b"), "Can't"),
    (re.compile(r"\bcannot\b"), "can't"),
    (re.compile(r"\bWill not\b"), "Won't"),
    (re.compile(r"\bwill not\b"), "won't"),
    (re.compile(r"\bI am\b"), "I'm"),
    (re.compile(r"\bYou are\b"), "You're"),
    (re.compile(r"\byou are\b"), "you're"),
    (re.compile(r"\bThey are\b"), "They're"),
    (re.compile(r"\bthey are\b"), "they're"),
]

_FILLER_PHRASES = re.compile(
    r"\b(it is important to note that|in conclusion,?|as an ai,?|as a language model,?)\b",
    re.I,
)

# ────────────────────────────────────────────
# Fallbacks when stripping removes everything
# ────────────────────────────────────────────

_INTENT_FALLBACKS: dict[str, str] = {
    "greeting": "Hey! What's on your mind?",
    "fact": "I'm not sure about that one. Could you give me a bit more context?",
    "code": "I'd be happy to help with that. Could you share more details about what you're working on?",
    "advice": "Good question! Can you tell me a bit more so I can give you a useful answer?",
    "story": "That's an interesting topic. What specifically would you like to know?",
    "default": "Hey, I'm here! What can I help you with?",
}


# ────────────────────────────────────────────
# Core translation pipeline
# ────────────────────────────────────────────


def _extract_human_content(text: str) -> str:
    """If known human-content markers exist, take content after them."""
    for marker in _HUMAN_CONTENT_MARKERS:
        idx = text.find(marker)
        if idx != -1:
            return text[idx + len(marker):].strip()
    return text


def _cut_system_tail(text: str) -> str:
    """Cut everything after system tail markers."""
    result = text
    for marker in _SYSTEM_TAIL_MARKERS:
        idx = result.find(marker)
        if idx != -1:
            result = result[:idx]
    return result.strip()


def _remove_system_lines(text: str) -> str:
    """Line-by-line filtering: remove system indicator lines, preserve code blocks."""
    lines = text.split("\n")
    kept: list[str] = []
    in_code_block = False

    for line in lines:
        stripped = line.strip()

        # Preserve code blocks entirely
        if stripped.startswith("```"):
            in_code_block = not in_code_block
            kept.append(line)
            continue
        if in_code_block:
            kept.append(line)
            continue

        # Keep blank lines
        if not stripped:
            kept.append(line)
            continue

        # Check structural patterns
        if any(p.search(stripped) for p in _STRUCTURAL_PATTERNS):
            continue

        # Check system line indicators
        if any(p.search(stripped) for p in _SYSTEM_LINE_INDICATORS):
            continue

        kept.append(line)

    # Collapse 3+ blank lines into 2
    result = "\n".join(kept)
    result = re.sub(r"\n{3,}", "\n\n", result)
    return result.strip()


def _strip_preamble(text: str) -> str:
    """Remove AI preamble phrases."""
    result = text
    for pattern in _PREAMBLE_PATTERNS:
        result = pattern.sub("", result, count=1)
    return result.strip()


def _humanize(text: str) -> str:
    """Make contractions and remove filler phrases for natural tone."""
    for pattern, replacement in _HUMANIZE_PAIRS:
        text = pattern.sub(replacement, text)
    text = _FILLER_PHRASES.sub("", text)
    # Collapse multiple spaces (but not newlines) to avoid breaking code blocks
    text = re.sub(r"[^\S\n]{2,}", " ", text)
    return text.strip()


def _finalize(text: str, intent: str) -> str:
    """Final shaping based on intent."""
    if not text:
        return ""

    if intent == "code":
        return text  # preserve formatting exactly

    if intent == "fact" and len(text) >= 200:
        paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
<<<<<<< HEAD
            if len(paragraphs) > 1:
                # Only truncate if extra paragraphs look like system/audit artifacts
                extra = "\n\n".join(paragraphs[1:])
                if any(p.search(extra) for p in _STRUCTURAL_PATTERNS) or any(
                    p.search(extra) for p in _SYSTEM_LINE_INDICATORS
                ):
                    return _capitalize(paragraphs[0])
            # Otherwise preserve all content
=======
>>>>>>> origin/main
        if paragraphs:
            return _capitalize(paragraphs[0])

    if intent == "greeting":
        sentences = re.findall(r"[^.!?]+[.!?]+", text)
<<<<<<< HEAD
        if len(sentences) > 3:
            # Only truncate if the extra sentences look like structural/system artifacts
            extra = "".join(sentences[2:]).strip()
            if any(p.search(extra) for p in _STRUCTURAL_PATTERNS) or any(
                p.search(extra) for p in _SYSTEM_LINE_INDICATORS
            ):
                return _capitalize("".join(sentences[:2]).strip())
=======
        if len(sentences) > 3:
            # Only truncate if the extra sentences look like structural/system artifacts
            extra = "".join(sentences[2:]).strip()
            if any(p.search(extra) for p in _STRUCTURAL_PATTERNS) or any(
                p.search(extra) for p in _SYSTEM_LINE_INDICATORS
            ):
                return _capitalize("".join(sentences[:2]).strip())
>>>>>>> origin/main

    return _capitalize(text)


def _capitalize(text: str) -> str:
    if not text:
        return ""
    return text[0].upper() + text[1:]


# ────────────────────────────────────────────
# Public API
# ────────────────────────────────────────────


def translate(
    user_message: str,
    response_text: str,
    *,
    source: str = "local",
    debug: bool = False,
) -> tuple[str, bool]:
    """Post-process a model response for CLI display.

    Parameters
    ----------
    source : str
        ``"local"`` for gpt-4.1-mini (passthrough) or ``"backend"``
        for Trinity pipeline output (full artifact stripping).

    Returns
    -------
    (translated_text, should_show)
        *translated_text* is the cleaned, human-facing response.
        *should_show* is ``False`` only when the entire response is
        empty after stripping.
    """
    if not response_text or not response_text.strip():
        return "", False

    # In debug mode, pass through raw output
    if debug:
        return response_text, True

    # Local gpt-4.1-mini responses are clean — pass through as-is
    if source == "local":
        return response_text.strip(), True

    # Backend / Trinity pipeline: full translation to strip narrative
    # structure, audit sections, and fine-tuned model artifacts
    intent = _detect_intent(user_message)
    text = response_text

    # Step 1: Extract human section if markers exist
    text = _extract_human_content(text)

    # Step 2: Cut off system tail sections
    text = _cut_system_tail(text)

    # Step 3: Remove system lines
    text = _remove_system_lines(text)

    # Step 4: Strip preamble
    text = _strip_preamble(text)

    # Step 5: If stripping removed everything, return a natural fallback
    if not text.strip():
        fallback = _INTENT_FALLBACKS.get(intent, _INTENT_FALLBACKS["default"])
        return fallback, True

    # Step 6: Humanize contractions
    text = _humanize(text)

    # Step 7: Shape by intent
    text = _finalize(text, intent)

    return text, True
