"""
Backend API response models for the ARCANOS daemon.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Generic, Mapping, Optional, TypeVar

T = TypeVar("T")


@dataclass(frozen=True)
class BackendRequestError(RuntimeError):
    """
    Purpose: Structured error for backend request failures.
    Inputs/Outputs: kind, message, optional status code/details, optional confirmation fields.
    Edge cases: details may be None for network or parsing errors; confirmation fields optional.
    """

    kind: str
    message: str
    status_code: Optional[int] = None
    details: Optional[str] = None
    confirmation_challenge_id: Optional[str] = None
    pending_actions: Optional[list[Mapping[str, Any]]] = None

    def __post_init__(self) -> None:
        # //audit assumption: exception message should be initialized; risk: missing error context; invariant: message stored; strategy: init base class.
        super().__init__(self.message)


@dataclass(frozen=True)
class BackendResponse(Generic[T]):
    """
    Purpose: Wrapper for backend responses with structured errors.
    Inputs/Outputs: ok flag, optional value, optional error.
    Edge cases: value is None when ok is False.
    """

    ok: bool
    value: Optional[T] = None
    error: Optional[BackendRequestError] = None


@dataclass(frozen=True)
class BackendChatResult:
    """
    Purpose: Parsed chat response from backend ask endpoint.
    Inputs/Outputs: response text, tokens, cost, and model.
    Edge cases: tokens and cost may be zero if backend omits usage.
    """

    response_text: str
    tokens_used: int
    cost_usd: float
    model: str


@dataclass(frozen=True)
class BackendVisionResult:
    """
    Purpose: Parsed vision response from backend vision endpoint.
    Inputs/Outputs: response text, tokens, cost, and model.
    Edge cases: tokens and cost may be zero if backend omits usage.
    """

    response_text: str
    tokens_used: int
    cost_usd: float
    model: str


@dataclass(frozen=True)
class BackendTranscriptionResult:
    """
    Purpose: Parsed transcription response from backend transcribe endpoint.
    Inputs/Outputs: transcription text and model name.
    Edge cases: text may be empty if backend returns no transcription.
    """

    text: str
    model: str
