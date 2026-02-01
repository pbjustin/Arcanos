"""
Configuration constants for CLI intent detection.
Re-exported from cli_config for backward compatibility.
"""

from .cli_config import (
    CAMERA_INTENT_PATTERN,
    DOMAIN_KEYWORDS,
    RUN_COMMAND_PATTERNS,
    SCREEN_INTENT_PATTERN,
)

__all__ = [
    "CAMERA_INTENT_PATTERN",
    "DOMAIN_KEYWORDS",
    "RUN_COMMAND_PATTERNS",
    "SCREEN_INTENT_PATTERN",
]
