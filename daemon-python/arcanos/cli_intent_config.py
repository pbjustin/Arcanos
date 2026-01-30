"""
Configuration constants for CLI intent detection.
"""

DOMAIN_KEYWORDS: dict[str, list[str]] = {
    "backstage:booker": [
        "book",
        "booking",
        "match",
        "wrestling",
        "wwe",
        "aew",
        "wrestler",
        "storyline",
        "event",
    ],
    "backstage": ["book", "booking", "match", "wrestling", "wwe", "aew"],
    "tutor": ["tutor", "teach", "learn", "lesson", "education", "study"],
    "arcanos:tutor": ["tutor", "teach", "learn", "lesson"],
    "gaming": ["game", "gaming", "play", "player"],
    "arcanos:gaming": ["game", "gaming"],
    "research": ["research", "study", "analyze", "investigate"],
}

RUN_COMMAND_PATTERNS: list[str] = [
    r"^\s*(run|execute)\s+(.+)$",
    r"^\s*(can you|could you|please)\s+run\s+(.+)$",
    r"^\s*(run|execute)\s+the\s+command\s+(.+)$",
]

CAMERA_INTENT_PATTERN = (
    r"\b(see\s+(my\s+)?camera|look\s+at\s+(my\s+)?camera|webcam|take\s+a\s+(photo|picture))\b"
)

SCREEN_INTENT_PATTERN = (
    r"\b(see\s+(my\s+)?screen|look\s+at\s+(my\s+)?screen|what('?s| is)\s+on\s+(my\s+)?screen|"
    r"show\s+(me\s+)?my\s+screen|screenshot|take\s+a\s+screenshot|capture\s+(my\s+)?screen|"
    r"analyze\s+(my\s+)?screen)\b"
)
