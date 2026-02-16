"""
Trust state definitions for CLI governance.
"""

from __future__ import annotations

from enum import Enum, auto


class TrustState(Enum):
    """Purpose: Represent runtime trust posture used by governance checks."""

    FULL = auto()
    DEGRADED = auto()
    UNSAFE = auto()

