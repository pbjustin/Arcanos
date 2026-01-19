"""
Media routing helpers for vision and voice commands.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence


BACKEND_ROUTE_KEYWORDS = {"backend", "deep", "cloud"}


@dataclass(frozen=True)
class VisionRouteDecision:
    """
    Purpose: Capture routing decision for vision commands.
    Inputs/Outputs: use_backend flag and use_camera flag.
    Edge cases: Defaults to backend_default when no keywords are present.
    """

    use_backend: bool
    use_camera: bool


@dataclass(frozen=True)
class VoiceRouteDecision:
    """
    Purpose: Capture routing decision for voice commands.
    Inputs/Outputs: use_backend flag.
    Edge cases: Defaults to backend_default when no keywords are present.
    """

    use_backend: bool


def parse_vision_route_args(args: Sequence[str], backend_default: bool) -> VisionRouteDecision:
    """
    Purpose: Determine whether vision requests should use backend or local processing.
    Inputs/Outputs: args sequence and backend_default flag; returns VisionRouteDecision.
    Edge cases: Unknown args are ignored; camera flag is optional.
    """
    normalized_args = [arg.strip().lower() for arg in args if arg.strip()]
    use_camera = "camera" in normalized_args
    use_backend = backend_default or any(arg in BACKEND_ROUTE_KEYWORDS for arg in normalized_args)

    # //audit assumption: backend_default can override args; risk: unexpected routing; invariant: explicit keyword enables backend; strategy: combine flags.
    return VisionRouteDecision(use_backend=use_backend, use_camera=use_camera)


def parse_voice_route_args(args: Sequence[str], backend_default: bool) -> VoiceRouteDecision:
    """
    Purpose: Determine whether voice transcription should use backend or local processing.
    Inputs/Outputs: args sequence and backend_default flag; returns VoiceRouteDecision.
    Edge cases: Unknown args are ignored.
    """
    normalized_args = [arg.strip().lower() for arg in args if arg.strip()]
    use_backend = backend_default or any(arg in BACKEND_ROUTE_KEYWORDS for arg in normalized_args)

    # //audit assumption: backend_default can override args; risk: unexpected routing; invariant: explicit keyword enables backend; strategy: combine flags.
    return VoiceRouteDecision(use_backend=use_backend)
