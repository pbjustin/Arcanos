from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping


@dataclass
class DaemonCommand:
    """Represents a command from the backend"""
    id: str
    name: str
    payload: Mapping[str, Any]
    issuedAt: str
